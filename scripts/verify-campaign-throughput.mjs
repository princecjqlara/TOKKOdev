// Exercise the throughput migration with actual PostgreSQL SQL in a local,
// disposable PGlite database. Uses the optional tooling from the scale check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const report = { checks: 0, customerMessagesSent: 0, productionWrites: 0 };
const check = (actual, expected) => { assert.deepEqual(actual, expected); report.checks++; };
const page = randomUUID(), otherPage = randomUUID(), owner = randomUUID(), otherOwner = randomUUID();
const acquire = async (pageId = page, worker = owner) =>
    (await db.query('SELECT * FROM acquire_page_campaign_delivery($1,$2)', [pageId, worker])).rows[0];
const release = async (limited = false, worker = owner) =>
    (await db.query('SELECT release_page_campaign_delivery($1,$2,$3) retry_at', [page, worker, limited])).rows[0];

try {
    await db.exec(`CREATE ROLE service_role;
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY, description TEXT);
        CREATE TABLE pages(id UUID PRIMARY KEY, campaign_delivery_owner UUID,
            campaign_delivery_lease_until TIMESTAMPTZ, campaign_delivery_cooldown_until TIMESTAMPTZ,
            campaign_delivery_rate_strikes INTEGER DEFAULT 0, campaign_delivery_last_rate_limit_at TIMESTAMPTZ);
        CREATE TABLE campaigns(id UUID PRIMARY KEY,page_id UUID,status TEXT,next_attempt_at TIMESTAMPTZ);`);
    await db.exec(await readFile(resolve('database/migration_campaign_delivery_throughput.sql'), 'utf8'));
    await db.exec(await readFile(resolve('database/migration_campaign_delivery_parallel.sql'), 'utf8'));
    const coordination = await readFile(resolve('database/migration_page_worker_coordination.sql'), 'utf8');
    const start = coordination.indexOf('CREATE OR REPLACE FUNCTION public.release_page_campaign_delivery(');
    const end = coordination.indexOf('$$;', start);
    assert.ok(start >= 0 && end > start);
    await db.exec(coordination.slice(start, end + 3));
    await db.query('INSERT INTO pages(id) VALUES($1),($2)', [page, otherPage]);
    for (const status of ['sending', 'scheduled', 'draft', 'cancelled']) {
        await db.query('INSERT INTO campaigns(id,page_id,status) VALUES($1,$2,$3)', [randomUUID(), page, status]);
    }
    check((await acquire()).batch_size, 100);
    check((await acquire(page, otherOwner)).acquired, false);
    check((await acquire(otherPage, otherOwner)).acquired, true);
    await release(false, otherOwner);
    check((await acquire(page, otherOwner)).acquired, false);
    await release();
    check((await acquire(page, otherOwner)).acquired, true);
    await release(false, otherOwner);

    // Throttle recovery remains shared across every caller for this Page.
    check((await acquire()).acquired, true);
    const firstLimit = await release(true);
    assert.ok(new Date(firstLimit.retry_at).getTime() > Date.now()); report.checks++;
    check((await acquire()).acquired, false);
    const campaigns = (await db.query('SELECT status,next_attempt_at FROM campaigns ORDER BY status')).rows;
    for (const row of campaigns) check(Boolean(row.next_attempt_at), ['sending', 'scheduled'].includes(row.status));
    await db.query("UPDATE pages SET campaign_delivery_cooldown_until=now()-interval '1 second' WHERE id=$1", [page]);
    check((await acquire()).batch_size, 2);
    const secondLimit = await release(true);
    assert.ok(new Date(secondLimit.retry_at).getTime() > new Date(firstLimit.retry_at).getTime()); report.checks++;
    await db.query("UPDATE pages SET campaign_delivery_cooldown_until=now()-interval '1 second' WHERE id=$1", [page]);
    check((await acquire()).batch_size, 1);
    await release();

    // A stale worker cannot block healthy sending forever. Capacity restores
    // only after the old throttle window has elapsed.
    await db.query(`UPDATE pages SET campaign_delivery_last_rate_limit_at=now()-interval '7 hours',
        campaign_delivery_owner=$2,campaign_delivery_lease_until=now()-interval '1 second' WHERE id=$1`, [page, otherOwner]);
    check((await acquire()).batch_size, 100);
    check((await db.query('SELECT campaign_delivery_rate_strikes strikes FROM pages WHERE id=$1', [page])).rows[0].strikes, 0);
    await release();
    await db.query("UPDATE pages SET campaign_delivery_last_rate_limit_at=now()-interval '7 hours',campaign_delivery_cooldown_until=now()+interval '1 minute' WHERE id=$1", [page]);
    check((await acquire()).acquired, false);
    for (const role of ['anon', 'authenticated', 'service_role']) {
        check((await db.query("SELECT has_function_privilege($1,'acquire_page_campaign_delivery(uuid,uuid)','EXECUTE') allowed", [role])).rows[0].allowed, role === 'service_role');
    }
    report.passed = true;
} catch (error) {
    report.passed = false;
    report.error = { code: error.code || error.name, message: error.message };
    process.exitCode = 1;
} finally {
    await db.close();
    console.log(JSON.stringify(report));
}
