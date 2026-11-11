// Verify stale-pacing recovery in a disposable local PostgreSQL database.
// No production records, Facebook requests, or real-time cooldown waits.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const report = { checks: 0, customerMessagesSent: 0, productionWrites: 0 };
const page = randomUUID(), owner = randomUUID(), otherOwner = randomUUID();
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
const acquire = async (worker = owner) => (await db.query(
    'SELECT * FROM acquire_page_campaign_delivery($1,$2)', [page, worker])).rows[0];
const state = async () => (await db.query('SELECT * FROM pages WHERE id=$1', [page])).rows[0];
const release = async () => db.query('SELECT release_page_campaign_delivery($1,$2,FALSE)', [page, owner]);
async function slowIdle(overrides = '') {
    await db.query(`UPDATE pages SET campaign_delivery_owner=NULL,campaign_delivery_lease_until=NULL,
        campaign_delivery_concurrency=1,campaign_delivery_interval_ms=5000,
        campaign_delivery_rate_strikes=5,
        campaign_delivery_feedback_at=NOW()-INTERVAL '2 hours',
        campaign_delivery_last_rate_limit_at=NOW()-INTERVAL '2 hours',
        campaign_delivery_cooldown_until=NOW()-INTERVAL '1 hour' WHERE id=$1`, [page]);
    if (overrides) await db.query(`UPDATE pages SET ${overrides.slice(1)} WHERE id=$1`, [page]);
}
try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY,description TEXT);
        CREATE TABLE pages(id UUID PRIMARY KEY,campaign_delivery_owner UUID,campaign_delivery_lease_until TIMESTAMPTZ,
            campaign_delivery_cooldown_until TIMESTAMPTZ,campaign_delivery_rate_strikes INTEGER DEFAULT 0,
            campaign_delivery_last_rate_limit_at TIMESTAMPTZ);
        CREATE TABLE campaigns(id UUID PRIMARY KEY,page_id UUID,status TEXT,next_attempt_at TIMESTAMPTZ);
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;`);
    await db.exec(await readFile('database/migration_campaign_delivery_adaptive.sql', 'utf8'));
    await db.exec(await readFile('database/migration_campaign_delivery_recovery_pace.sql', 'utf8'));
    await db.query('INSERT INTO pages(id) VALUES($1)', [page]);
    for (const status of ['sending', 'scheduled', 'draft', 'cancelled', 'completed']) {
        await db.query('INSERT INTO campaigns VALUES($1,$2,$3,NOW()+INTERVAL \'1 hour\')', [randomUUID(), page, status]);
    }
    await slowIdle();
    const before = await state();
    const campaigns = (await db.query('SELECT * FROM campaigns ORDER BY id')).rows;
    const migration = await readFile('database/migration_campaign_delivery_idle_probe.sql', 'utf8');
    await db.exec(migration); await db.exec(migration);
    check(await state(), before, 'Installing the migration does not reset Page state');
    check((await db.query('SELECT * FROM campaigns ORDER BY id')).rows, campaigns, 'Installing the migration preserves campaigns');

    check((await acquire()).batch_size, 5, 'Stale slow Pages resume at conservative default capacity');
    let saved = await state();
    check(saved.campaign_delivery_interval_ms, 100, 'Stale five-second spacing is replaced by default spacing');
    check(saved.campaign_delivery_rate_strikes, 5, 'Recent rate strikes remain available for real throttles');
    check(saved.campaign_delivery_cooldown_until, before.campaign_delivery_cooldown_until, 'The saved cooldown timestamp is preserved');
    check(saved.campaign_delivery_feedback_at > before.campaign_delivery_feedback_at, true, 'The new probe receives a fresh timestamp');
    check((await acquire(otherOwner)).acquired, false, 'Another worker cannot interrupt the probe');
    await release();

    for (const column of ['campaign_delivery_feedback_at', 'campaign_delivery_last_rate_limit_at', 'campaign_delivery_cooldown_until']) {
        await slowIdle();
        await db.query(`UPDATE pages SET ${column}=NOW()-INTERVAL '29 minutes' WHERE id=$1`, [page]);
        check((await acquire()).batch_size, 1, `Recent ${column} prevents restoring capacity`);
        check((await state()).campaign_delivery_interval_ms, 5000, 'Recent evidence preserves message spacing');
        await release();
    }
    await slowIdle();
    await db.query("UPDATE pages SET campaign_delivery_cooldown_until=NOW()+INTERVAL '1 minute' WHERE id=$1", [page]);
    const cooling = await state();
    check((await acquire()).acquired, false, 'A future provider cooldown always blocks sending');
    check(await state(), cooling, 'A rejected cooldown claim does not mutate pacing or leases');

    await slowIdle();
    await db.query("UPDATE pages SET campaign_delivery_owner=$2,campaign_delivery_lease_until=NOW()+INTERVAL '1 minute' WHERE id=$1", [page, otherOwner]);
    const busy = await state();
    check((await acquire()).acquired, false, 'A live lease prevents a probe even with stale feedback');
    check(await state(), busy, 'A live worker retains its exact state');

    await slowIdle(',campaign_delivery_concurrency=100,campaign_delivery_interval_ms=0');
    check((await acquire()).batch_size, 100, 'Healthy learned capacity survives idle time');
    check((await state()).campaign_delivery_interval_ms, 0, 'Healthy learned spacing survives idle time');
    await release();

    await slowIdle(',campaign_delivery_feedback_at=NULL,campaign_delivery_last_rate_limit_at=NULL');
    check((await acquire()).batch_size, 5, 'A Page with only an old inherited app cooldown can probe');
    await release();
    await slowIdle(',campaign_delivery_feedback_at=NULL,campaign_delivery_last_rate_limit_at=NULL');
    await db.query("UPDATE pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '5 minutes' WHERE id=$1", [page]);
    check((await acquire()).batch_size, 1, 'A recent inherited app cooldown cannot be bypassed');
    const recovering = (await db.query('SELECT report_page_campaign_delivery_feedback($1,$2) value', [page, owner])).rows[0].value;
    check(recovering.concurrency, 1, 'Shared recovery still caps concurrency');
    check(recovering.interval_ms, 5000, 'Shared recovery still enforces spacing');
    check(Date.parse(recovering.growth_after) - Date.parse(recovering.retry_at), 600_000, 'The ten-minute hold is retained');
    await release();

    // A newly saved slower budget must survive a restart after the probe.
    await slowIdle(); await acquire();
    await db.query('SELECT report_page_campaign_delivery_feedback($1,$2,1,2000)', [page, owner]);
    await release();
    check((await acquire()).batch_size, 1, 'A fresh slower budget survives the next worker');
    check((await state()).campaign_delivery_interval_ms, 2000, 'The probe does not reset each worker slice');
    await release();
    check((await db.query('SELECT * FROM campaigns ORDER BY id')).rows, campaigns, 'Probes never resume paused campaigns or change retry windows');
    for (const role of ['anon', 'authenticated', 'service_role']) {
        const allowed = (await db.query("SELECT has_function_privilege($1,'acquire_page_campaign_delivery(uuid,uuid)','EXECUTE') value", [role])).rows[0].value;
        check(allowed, role === 'service_role', 'Only server roles can acquire delivery');
    }
    report.passed = true;
} catch (error) {
    report.passed = false; report.error = { code: error.code || error.name, message: error.message }; process.exitCode = 1;
} finally { await db.close(); console.log(JSON.stringify(report)); }
