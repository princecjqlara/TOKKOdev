// Real concurrent PostgreSQL sessions against an isolated, disposable schema.
// Public tables are read only for definitions; no customer records or messages.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const connectionString = process.env.TOKKO_TEST_DATABASE_URL || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw Error('Set TOKKO_TEST_DATABASE_URL or DATABASE_POOLER_URL_5432.');
const config = { connectionString, ssl: process.env.TOKKO_TEST_NO_SSL === '1' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 15000 };
const admin = new Client(config), workers = Array.from({ length: 3 }, () => new Client(config));
const schema = `tokko_concurrency_test_${randomUUID().replaceAll('-', '')}`;
assert.match(schema, /^tokko_concurrency_test_[a-f0-9]{32}$/);
const campaign = randomUUID(), page = randomUUID();
let schemaOid, created = false, adminConnected = false;
const connectedWorkers = new Set();
const report = { checks: 0, workers: workers.length, syntheticRecipients: 1000, customerMessagesSent: 0, schemaRemoved: false };
const seen = new Set();
const check = (actual, expected) => { assert.deepEqual(actual, expected); report.checks++; };
async function concurrent(jobs) {
    const results = await Promise.allSettled(jobs);
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map(result => result.value);
}
async function claim(client, size) {
    return (await client.query(`SELECT * FROM ${schema}.claim_campaign_recipients($1,$2)`, [campaign, size])).rows;
}
async function finish(client, rows) {
    if (!rows.length) return;
    const results = rows.map(row => ({ contact_id: row.contact_id, success: true, error_message: null }));
    check((await client.query(`SELECT ${schema}.finish_campaign_recipient_batch($1,$2,$3::jsonb) value`,
        [campaign, rows[0].claim_token, JSON.stringify(results)])).rows[0].value, rows.length);
    for (const row of rows) { assert.ok(!seen.has(row.contact_id), 'Concurrent workers must not complete a recipient twice'); seen.add(row.contact_id); }
}
try {
    await admin.connect();
    adminConnected = true;
    await admin.query('BEGIN');
    await admin.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    schemaOid = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].oid;
    await admin.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC,anon,authenticated,service_role`);
    for (const table of ['contacts', 'campaigns', 'campaign_recipients', 'campaign_delivery_failures']) {
        await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (const signature of ['claim_campaign_recipients(uuid,integer,timestamp with time zone,boolean,interval)',
        'finish_campaign_recipient_batch(uuid,uuid,jsonb)', 'get_campaign_delivery_progress(uuid)']) {
        const source = (await admin.query('SELECT pg_get_functiondef($1::regprocedure) definition', [`public.${signature}`])).rows[0].definition;
        await admin.query(source.replaceAll('public.', `${schema}.`).replaceAll("search_path TO 'public'", `search_path TO '${schema}'`));
    }
    await admin.query(`INSERT INTO ${schema}.campaigns(id,page_id,name,message_text,status,total_recipients,audience_materialized_at)
        VALUES($1,$2,'Concurrency verification','Fixture only','sending',$3,now())`, [campaign, page, report.syntheticRecipients]);
    await admin.query(`INSERT INTO ${schema}.contacts(page_id,psid,name)
        SELECT $1,'fixture-'||n,'Synthetic '||n FROM generate_series(1,$2::int) n`, [page, report.syntheticRecipients]);
    await admin.query(`INSERT INTO ${schema}.campaign_recipients(campaign_id,contact_id,status)
        SELECT $1,id,'pending' FROM ${schema}.contacts`, [campaign]);
    await admin.query('COMMIT');
    await concurrent(workers.map(async client => {
        await client.connect();
        connectedWorkers.add(client);
        await client.query("SET statement_timeout='12s'; SET lock_timeout='5s'");
    }));

    // Keep all claim transactions open simultaneously, so SKIP LOCKED has to
    // skip real locks held by other connections rather than updated statuses.
    const batches = await concurrent(workers.map(async client => { await client.query('BEGIN'); return claim(client, 100); }));
    check(batches.map(rows => rows.length), [100, 100, 100]);
    check(new Set(batches.flat().map(row => row.contact_id)).size, 300);
    await concurrent(workers.map(async (client, index) => { await finish(client, batches[index]); await client.query('COMMIT'); }));

    // A crashed transaction releases its rows. Another worker must recover
    // those rows with a fresh token, while unrelated locked work can progress.
    await workers[0].query('BEGIN');
    const abandoned = await claim(workers[0], 10);
    await workers[1].query('BEGIN');
    const independent = await claim(workers[1], 10);
    check(new Set([...abandoned, ...independent].map(row => row.contact_id)).size, 20);
    await finish(workers[1], independent); await workers[1].query('COMMIT');
    await workers[0].query('ROLLBACK');
    await workers[2].query('BEGIN');
    const recovered = await claim(workers[2], 10);
    check(recovered.map(row => row.contact_id).sort(), abandoned.map(row => row.contact_id).sort());
    assert.notEqual(recovered[0].claim_token, abandoned[0].claim_token); report.checks++;
    await finish(workers[2], recovered); await workers[2].query('COMMIT');

    await concurrent(workers.map(async client => {
        for (let batch = 0; batch < 100; batch++) {
            await client.query('BEGIN');
            const rows = await claim(client, 37);
            if (!rows.length) { await client.query('COMMIT'); return; }
            await finish(client, rows); await client.query('COMMIT');
        }
        throw Error('Synthetic queue did not drain within the bounded test');
    }));
    check(seen.size, report.syntheticRecipients);
    const progress = (await admin.query(`SELECT * FROM ${schema}.get_campaign_delivery_progress($1)`, [campaign])).rows[0];
    check(progress, { sent_count: report.syntheticRecipients, failed_count: 0, remaining_count: '0' });
    report.passed = true;
} catch (error) {
    report.passed = false; report.error = { code: error.code || null, message: error.message }; process.exitCode = 1;
} finally {
    await Promise.allSettled(workers.map(async client => {
        if (connectedWorkers.has(client)) await client.query('ROLLBACK').catch(() => {});
        await client.end();
    }));
    if (adminConnected) await admin.query('ROLLBACK').catch(() => {});
    if (created) {
        try {
            const current = (await admin.query('SELECT oid FROM pg_namespace WHERE nspname=$1', [schema])).rows[0];
            if (current) { assert.equal(current.oid, schemaOid, 'Cleanup must target only the schema created by this run'); await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
            report.schemaRemoved = true;
        } catch (error) { report.cleanupError = error.code || error.name; report.passed = false; process.exitCode = 1; }
    }
    await admin.end(); console.log(JSON.stringify(report));
}
