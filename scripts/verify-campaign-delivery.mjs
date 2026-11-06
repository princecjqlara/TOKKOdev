// Exercise deployed queue functions using synthetic data in an isolated schema.
// Every schema change and fixture is rolled back. No Facebook requests are made.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const connectionString = process.env.TOKKO_TEST_DATABASE_URL || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw Error('Set TOKKO_TEST_DATABASE_URL or DATABASE_POOLER_URL_5432.');
const db = new Client({ connectionString, ssl: process.env.TOKKO_TEST_NO_SSL === '1' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 20000 });
const schema = `tokko_delivery_test_${randomUUID().replaceAll('-', '')}`;
const recipients = 10005;
const signatures = [
    'create_filtered_tracked_bulk_campaign(uuid,uuid,text,text,text,text,text,uuid[],uuid[],uuid[],date,date,text,integer,integer)',
    'claim_campaign_recipients(uuid,integer,timestamp with time zone,boolean,interval)',
    'finish_campaign_recipient_batch(uuid,uuid,jsonb)',
    'get_campaign_delivery_progress(uuid)',
    'acquire_page_campaign_delivery(uuid,uuid)',
    'release_page_campaign_delivery(uuid,uuid,boolean)'
];
const report = { checks: 0, syntheticRecipients: recipients, batches: 0, customerMessagesSent: 0, rolledBack: false };
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); report.checks++; }
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function rejected(sql, args) {
    await db.query('SAVEPOINT expected_rejection');
    let errorCode;
    try { await db.query(sql, args); } catch (error) { errorCode = error.code; }
    await db.query('ROLLBACK TO SAVEPOINT expected_rejection');
    assert.ok(errorCode, 'Invalid or stale claim must be rejected'); report.checks++;
}

try {
    await db.connect();
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    await db.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema}`);
    for (const table of ['pages', 'contacts', 'contact_tags', 'campaigns', 'campaign_recipients', 'campaign_delivery_failures']) {
        await db.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    for (const signature of signatures) {
        const source = (await db.query('SELECT pg_get_functiondef($1::regprocedure) definition', [`public.${signature}`])).rows[0].definition;
        const isolated = source.replaceAll('public.', `${schema}.`)
            .replaceAll("search_path TO 'public'", `search_path TO '${schema}'`)
            .replace(/SET statement_timeout TO '[^']*'/g, "SET statement_timeout TO '15s'");
        assert.ok(!isolated.includes('public.'), 'Functions must use only the isolated schema');
        await db.query(isolated);
        for (const role of ['anon', 'authenticated']) {
            check(await scalar('SELECT has_function_privilege($1,$2,\'EXECUTE\') value', [role, `public.${signature}`]), false,
                'End-user roles cannot execute the administrative delivery functions');
        }
    }

    const page = randomUUID(), otherPage = randomUUID(), actor = randomUUID();
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Synthetic Page','fixture-only'),($3,$4,'Other synthetic Page','fixture-only')",
        [page, `fixture-${page}`, otherPage, `fixture-${otherPage}`]);
    await db.query(`INSERT INTO contacts(page_id,psid,name,last_interaction_at)
        SELECT $1,'fixture-'||n,'Synthetic '||n,now()-n*interval '1 second' FROM generate_series(1,$2::int) n`, [page, recipients]);
    await db.query(`INSERT INTO contacts(page_id,psid,name,last_interaction_at)
        SELECT $1,'other-'||n,'Other '||n,now() FROM generate_series(1,17) n`, [otherPage]);

    async function create(options = {}) {
        return (await db.query(`SELECT * FROM ${schema}.create_filtered_tracked_bulk_campaign(
            $1,$2,'Synthetic verification','Fixture only',NULL,NULL,NULL,$3,$4,$5,NULL,NULL,'include',$6,$7)`,
        [page, actor, options.include || [], options.exclude || [], options.excludedContacts || [], options.offset || 0, options.limit ?? null])).rows[0];
    }
    async function claim(id, size = 500, due = null, includeUnscheduled = false) {
        return (await db.query(`SELECT * FROM ${schema}.claim_campaign_recipients($1,$2,$3,$4)`, [id, size, due, includeUnscheduled])).rows;
    }
    async function finish(id, rows, successful = true) {
        const results = rows.map((row, index) => ({ contact_id: row.contact_id, success: successful || index !== 0,
            error_message: successful || index !== 0 ? null : 'Synthetic recipient failure' }));
        check(await scalar(`SELECT ${schema}.finish_campaign_recipient_batch($1,$2,$3::jsonb) value`,
            [id, rows[0].claim_token, JSON.stringify(results)]), rows.length, 'Every claimed result is persisted');
    }

    const large = await create();
    check(large.recipient_count, recipients, 'All 10,005 recipients are materialized beyond the API row cap');
    check(large.total_matched, recipients, 'Audience totals are complete');
    check(await scalar('SELECT count(*)::int value FROM campaign_recipients r JOIN contacts c ON c.id=r.contact_id WHERE r.campaign_id=$1 AND c.page_id<>$2',
        [large.campaign_id, page]), 0, 'A campaign never includes another Page');
    const seen = new Set();
    let completed = 0, failures = 0;
    const first = await claim(large.campaign_id), second = await claim(large.campaign_id);
    check(first.length, 500, 'Claims respect the maximum batch size');
    check(second.length, 500, 'A second worker can claim the next batch');
    check(new Set([...first, ...second].map(row => row.contact_id)).size, 1000, 'Overlapping worker claims have disjoint recipients');
    await rejected(`SELECT ${schema}.finish_campaign_recipient_batch($1,$2,$3::jsonb)`,
        [large.campaign_id, randomUUID(), JSON.stringify(first.map(row => ({ contact_id: row.contact_id, success: true })))]);
    const claimedBatches = [first, second];
    for (let attempt = 0; attempt < 30; attempt++) {
        const rows = claimedBatches.shift() || await claim(large.campaign_id);
        if (!rows.length) break;
        for (const row of rows) { assert.ok(!seen.has(row.contact_id), 'Completed recipients must not be claimed again'); seen.add(row.contact_id); }
        await finish(large.campaign_id, rows, false);
        completed += rows.length; failures++;
        report.batches++;
        if (report.batches === 1) {
            await rejected(`SELECT ${schema}.finish_campaign_recipient_batch($1,$2,$3::jsonb)`,
                [large.campaign_id, rows[0].claim_token, JSON.stringify(rows.map(row => ({ contact_id: row.contact_id, success: true })))]);
        }
    }
    check(completed, recipients, 'Every synthetic recipient is consumed through continuation batches');
    check(seen.size, recipients, 'No recipient is duplicated while the queue drains');
    check(await scalar('SELECT count(*)::int value FROM campaign_recipients WHERE campaign_id=$1', [large.campaign_id]), 0,
        'One-time terminal rows leave the compact queue');
    const progress = (await db.query(`SELECT * FROM ${schema}.get_campaign_delivery_progress($1)`, [large.campaign_id])).rows[0];
    check(progress, { sent_count: recipients - failures, failed_count: failures, remaining_count: '0' }, 'Durable counters equal all persisted results');
    check(await scalar('SELECT count(*)::int value FROM campaign_delivery_failures WHERE campaign_id=$1', [large.campaign_id]), failures,
        'Recipient failures retain diagnostics without stopping the rest of the queue');
    check((await claim(large.campaign_id)).length, 0, 'Finished recipients are never sent by another invocation');

    const recovery = await create({ limit: 3 });
    const original = await claim(recovery.campaign_id, 3);
    await db.query("UPDATE campaign_recipients SET claimed_at=now()-interval '11 minutes' WHERE campaign_id=$1", [recovery.campaign_id]);
    const recovered = await claim(recovery.campaign_id, 3);
    check(recovered.length, 3, 'A crashed worker lease is recoverable');
    assert.notEqual(recovered[0].claim_token, original[0].claim_token); report.checks++;
    await rejected(`SELECT ${schema}.finish_campaign_recipient_batch($1,$2,$3::jsonb)`,
        [recovery.campaign_id, original[0].claim_token, JSON.stringify(original.map(row => ({ contact_id: row.contact_id, success: true })))]);
    await finish(recovery.campaign_id, recovered);

    const scheduled = await create({ limit: 3 });
    const scheduledIds = (await db.query('SELECT contact_id FROM campaign_recipients WHERE campaign_id=$1 ORDER BY contact_id', [scheduled.campaign_id])).rows.map(row => row.contact_id);
    await db.query("UPDATE campaign_recipients SET scheduled_at=now()-interval '1 minute' WHERE campaign_id=$1 AND contact_id=$2", [scheduled.campaign_id, scheduledIds[0]]);
    await db.query("UPDATE campaign_recipients SET scheduled_at=now()+interval '1 hour' WHERE campaign_id=$1 AND contact_id=$2", [scheduled.campaign_id, scheduledIds[1]]);
    const now = new Date().toISOString();
    const due = await claim(scheduled.campaign_id, 500, now);
    check(due.map(row => row.contact_id), [scheduledIds[0]], 'Future and unscheduled contacts are excluded from a due-only send');
    await finish(scheduled.campaign_id, due);
    const unscheduled = await claim(scheduled.campaign_id, 500, now, true);
    check(unscheduled.map(row => row.contact_id), [scheduledIds[2]], 'Campaign-level schedules can explicitly include unscheduled contacts');
    await finish(scheduled.campaign_id, unscheduled);
    check((await claim(scheduled.campaign_id, 500, now)).length, 0, 'Future recipients stay queued');
    const future = await claim(scheduled.campaign_id, 500, new Date(Date.now() + 2 * 3600000).toISOString());
    check(future.map(row => row.contact_id), [scheduledIds[1]], 'The final recipient becomes eligible at its scheduled time');
    await finish(scheduled.campaign_id, future);

    const includeTag = randomUUID(), excludeTag = randomUUID();
    await db.query("INSERT INTO contact_tags(contact_id,tag_id) SELECT id,$2 FROM contacts WHERE page_id=$1 AND substring(psid from 9)::int%2=0", [page, includeTag]);
    await db.query("INSERT INTO contact_tags(contact_id,tag_id) SELECT id,$2 FROM contacts WHERE page_id=$1 AND substring(psid from 9)::int%10=0", [page, excludeTag]);
    const excludedContact = await scalar("SELECT id value FROM contacts WHERE page_id=$1 AND psid='fixture-2'", [page]);
    const filtered = await create({ include: [includeTag], exclude: [excludeTag], excludedContacts: [excludedContact] });
    check(filtered.recipient_count, Math.floor(recipients / 2) - Math.floor(recipients / 10) - 1,
        'Include tags, excluded tags, and explicit exclusions retain the correct large audience');
    const slice = await create({ offset: 10000, limit: 1000 });
    check(slice.recipient_count, 5, 'The last audience slice is complete without crossing its boundary');

    const owner = randomUUID(), otherOwner = randomUUID();
    const acquired = (await db.query(`SELECT * FROM ${schema}.acquire_page_campaign_delivery($1,$2)`, [page, owner])).rows[0];
    check(acquired.acquired, true, 'One Page worker acquires the sending lease');
    check((await db.query(`SELECT * FROM ${schema}.acquire_page_campaign_delivery($1,$2)`, [page, otherOwner])).rows[0].acquired, false,
        'Another worker cannot send concurrently on the same Page');
    check((await db.query(`SELECT * FROM ${schema}.acquire_page_campaign_delivery($1,$2)`, [otherPage, otherOwner])).rows[0].acquired, true,
        'Another Page can make independent progress');
    await db.query(`SELECT ${schema}.release_page_campaign_delivery($1,$2,TRUE)`, [page, owner]);
    const cooling = (await db.query(`SELECT * FROM ${schema}.acquire_page_campaign_delivery($1,$2)`, [page, otherOwner])).rows[0];
    check(cooling.acquired, false, 'Meta throttling creates a shared Page cooldown');
    assert.ok(cooling.retry_at > new Date()); report.checks++;
    report.passed = true;
} catch (error) {
    report.passed = false;
    report.error = { code: error.code || null, message: error.message };
    process.exitCode = 1;
} finally {
    await db.query('ROLLBACK').then(() => { report.rolledBack = true; }).catch(() => {});
    await db.end();
    console.log(JSON.stringify(report));
}
