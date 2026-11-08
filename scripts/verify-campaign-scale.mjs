// Real PostgreSQL SQL in a disposable local PGlite database. No network sends
// or production writes. Install the optional test tool under ignored outputs:
// npm install --prefix outputs/campaign-scale-tools --no-save --package-lock=false --ignore-scripts @electric-sql/pglite
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const recipients = Number(process.env.TOKKO_SCALE_RECIPIENTS || 2_000_005);
assert.ok(Number.isSafeInteger(recipients) && recipients >= 1005 && recipients <= 5_000_005);
const root = resolve('outputs/campaign-scale-runs');
const dataDir = resolve(root, `run-${randomUUID()}`);
assert.ok(dataDir.startsWith(root + sep));
await mkdir(root, { recursive: true });
let db;
const report = { syntheticRecipients: recipients, customerMessagesSent: 0, productionWrites: 0,
    batches: 0, checks: 0, maxClaimMs: 0, maxFinishMs: 0, localDatabaseRemoved: false };
const started = performance.now();
const check = (actual, expected) => { assert.deepEqual(actual, expected); report.checks++; };
const stage = (name, extra = {}) => console.log(JSON.stringify({ stage: name, elapsedSeconds: Math.round((performance.now() - started) / 1000), ...extra }));
async function functionSql(file, name) {
    const source = await readFile(resolve('database', file), 'utf8');
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    const end = source.indexOf('$$;', start);
    assert.ok(start >= 0 && end > start, `Missing SQL function ${name}`);
    return source.slice(start, end + 3);
}
try {
    db = await PGlite.create(dataDir);
    await db.exec(`CREATE SCHEMA extensions;
        CREATE TABLE pages(id UUID PRIMARY KEY, fb_page_id TEXT, access_token TEXT);
        CREATE TABLE contacts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(), page_id UUID, psid TEXT, name TEXT,
            best_contact_hour INTEGER, first_interaction_at TIMESTAMPTZ, last_interaction_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
        CREATE INDEX ON contacts(page_id,last_interaction_at DESC NULLS LAST,id);
        CREATE TABLE contact_tags(contact_id UUID,tag_id UUID,PRIMARY KEY(contact_id,tag_id));
        CREATE TABLE campaigns(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID,name TEXT,message_text TEXT,status TEXT,
            total_recipients INTEGER DEFAULT 0,sent_count INTEGER DEFAULT 0,failed_count INTEGER DEFAULT 0,created_by UUID,
            audience_mode TEXT,audience_materialized_at TIMESTAMPTZ,use_best_time BOOLEAN,is_loop BOOLEAN DEFAULT false,
            loop_status TEXT,use_ai_message BOOLEAN,template_name TEXT,template_language TEXT,recurrence TEXT DEFAULT 'none',
            created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE campaign_recipients(campaign_id UUID,contact_id UUID,status TEXT DEFAULT 'pending',claim_token UUID,
            claimed_at TIMESTAMPTZ,sent_at TIMESTAMPTZ,scheduled_at TIMESTAMPTZ,next_scheduled_at TIMESTAMPTZ,
            error_message TEXT,created_at TIMESTAMPTZ DEFAULT now(),PRIMARY KEY(campaign_id,contact_id));
        CREATE TABLE campaign_delivery_failures(campaign_id UUID,contact_id UUID,error_message TEXT,failed_at TIMESTAMPTZ,
            attempt_count INTEGER,PRIMARY KEY(campaign_id,contact_id));`);
    for (const [file, name] of [
        ['migration_million_contact_campaigns.sql', 'create_filtered_tracked_bulk_campaign'],
        ['migration_campaign_delivery_timeout_fix.sql', 'claim_campaign_recipients'],
        ['migration_compact_campaign_delivery_prepare.sql', 'finish_campaign_recipient_batch'],
        ['migration_campaign_delivery_timeout_fix.sql', 'get_campaign_delivery_progress']
    ]) await db.exec(await functionSql(file, name));
    const page = randomUUID(), actor = randomUUID();
    await db.query("INSERT INTO pages VALUES($1,'synthetic-page','fixture-only')", [page]);
    stage('generating synthetic contacts');
    // Generate identifiers in PostgreSQL: the application never allocates a
    // million-element contact array, and verification needs only one byte/row.
    await db.query(`INSERT INTO contacts(id,page_id,psid,name,last_interaction_at)
        SELECT ('00000000-0000-4000-8000-'||lpad(to_hex(n),12,'0'))::uuid,
            $1,'synthetic-'||n,'Fixture '||n,now()-n*interval '1 second'
        FROM generate_series(1,$2::int) n`, [page, recipients]);
    await db.exec('ANALYZE contacts');
    stage('materializing audience');
    const materializeAt = performance.now();
    const campaign = (await db.query(`SELECT * FROM create_filtered_tracked_bulk_campaign(
        $1,$2,'Million-contact verification','No real sends',NULL,NULL,NULL,'{}','{}','{}',NULL,NULL,'include',0,NULL)`, [page, actor])).rows[0];
    report.materializationMs = Math.round(performance.now() - materializeAt);
    check(campaign.recipient_count, recipients);
    check(campaign.total_matched, recipients);
    const id = campaign.campaign_id;
    await db.exec('ANALYZE campaign_recipients');
    const seen = new Uint8Array(recipients + 1);
    let sent = 0, failed = 0;
    const claim = async () => {
        const before = performance.now();
        const rows = (await db.query('SELECT * FROM claim_campaign_recipients($1,500)', [id])).rows;
        report.maxClaimMs = Math.max(report.maxClaimMs, Math.round(performance.now() - before));
        assert.ok(rows.length <= 500);
        return rows;
    };
    const finish = async rows => {
        const results = rows.map(row => {
            const n = Number(row.contact_psid.slice('synthetic-'.length));
            assert.equal(seen[n], 0, 'A completed recipient must not be claimed twice');
            const success = n % 997 !== 0;
            return { contact_id: row.contact_id, success, error_message: success ? null : 'Synthetic recipient unavailable' };
        });
        const before = performance.now();
        // Exercise partial checkpoints under one claim token as well as full
        // batches; the rolling sender persists fast recipients in groups of 50.
        const checkpointSize = report.batches % 100 === 0 ? 50 : 500;
        for (let offset = 0; offset < results.length; offset += checkpointSize) {
            const receipts = results.slice(offset, offset + checkpointSize);
            check((await db.query('SELECT finish_campaign_recipient_batch($1,$2,$3::jsonb) processed',
                [id, rows[0].claim_token, JSON.stringify(receipts)])).rows[0].processed, receipts.length);
        }
        report.maxFinishMs = Math.max(report.maxFinishMs, Math.round(performance.now() - before));
        for (const row of rows) {
            const n = Number(row.contact_psid.slice('synthetic-'.length));
            seen[n] = 1;
            if (n % 997 !== 0) sent++; else failed++;
        }
        report.batches++;
    };
    const progress = async () => {
        const value = (await db.query('SELECT * FROM get_campaign_delivery_progress($1)', [id])).rows[0];
        check(Number(value.sent_count), sent);
        check(Number(value.failed_count), failed);
        check(Number(value.remaining_count), recipients - sent - failed);
    };
    // Simulate two overlapping claims, a rolled-back worker and an expired
    // committed claim. Verify disjoint batches and rejection of stale tokens.
    const first = await claim(), second = await claim();
    check(new Set([...first, ...second].map(row => row.contact_id)).size, 1000);
    await finish(first); await finish(second);
    await db.exec('BEGIN');
    const abandoned = await claim();
    await db.exec('ROLLBACK');
    const recovered = await claim();
    check(recovered.map(row => row.contact_id), abandoned.map(row => row.contact_id));
    assert.notEqual(recovered[0].claim_token, abandoned[0].claim_token); report.checks++;
    await db.query("UPDATE campaign_recipients SET claimed_at=now()-interval '11 minutes' WHERE campaign_id=$1 AND claim_token=$2", [id, recovered[0].claim_token]);
    const expired = await claim();
    check(expired.map(row => row.contact_id), recovered.map(row => row.contact_id));
    await assert.rejects(db.query('SELECT finish_campaign_recipient_batch($1,$2,$3::jsonb)', [id, recovered[0].claim_token,
        JSON.stringify(recovered.map(row => ({ contact_id: row.contact_id, success: true })))])); report.checks++;
    await finish(expired);
    await progress();
    // A second invocation can open the same saved local database and continue
    // without rebuilding or resetting the remaining audience.
    await db.close(); db = await PGlite.create(dataDir);
    stage('resumed after worker restart', { processed: sent + failed });
    while (sent + failed < recipients) {
        const rows = await claim();
        assert.ok(rows.length, 'Unsent work must remain claimable');
        await finish(rows);
        if (report.batches % 100 === 0) {
            await progress();
            await db.exec('VACUUM (ANALYZE) campaign_recipients');
            stage('draining saved queue', { processed: sent + failed, remaining: recipients - sent - failed });
        }
    }
    check(sent + failed, recipients);
    check(seen.slice(1).every(value => value === 1), true);
    check((await claim()).length, 0);
    check(Number((await db.query('SELECT count(*) value FROM campaign_recipients WHERE campaign_id=$1', [id])).rows[0].value), 0);
    check(Number((await db.query('SELECT count(*) value FROM campaign_delivery_failures WHERE campaign_id=$1', [id])).rows[0].value), failed);
    await progress();
    report.sent = sent; report.failed = failed; report.passed = true;
} catch (error) {
    report.passed = false;
    report.error = { code: error.code || error.name, message: error.message };
    process.exitCode = 1;
} finally {
    if (db) await db.close().catch(() => {});
    // Only remove the unique local fixture directory created by this run.
    assert.ok(dataDir.startsWith(root + sep) && /^run-[a-f0-9-]{36}$/.test(dataDir.slice(root.length + 1)));
    await rm(dataDir, { recursive: true, force: true });
    report.localDatabaseRemoved = true;
    report.elapsedSeconds = Math.round((performance.now() - started) / 1000);
    console.log(JSON.stringify(report));
}
