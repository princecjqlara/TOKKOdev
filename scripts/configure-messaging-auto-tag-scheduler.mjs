// Install the auto-tag fallback without invoking Facebook or sending messages.
// --preflight rolls back the schedule and all fixtures. --apply backs up the
// existing named job and commits only after the same dispatch checks pass.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
assert.ok(args.length === 1 && ['--apply', '--preflight'].includes(args[0]), 'Choose --preflight or --apply');
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
assert.ok(connectionString, 'Load the existing database environment first');
const db = new Client({ connectionString, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 30000 });
const jobName = 'tokko-messaging-auto-tag';
const workerUrl = 'https://tokkobeta.vercel.app/api/cron/messaging-auto-tag';
const report = { checkedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preflight',
    checks: 0, committed: false, fixturesRolledBack: false, customerMessagesSent: 0, httpRequestsSent: 0 };
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
const jobState = async () => (await db.query(
    'SELECT jobid,jobname,schedule,command,active FROM cron.job WHERE jobname=$1', [jobName])).rows;

try {
    await db.connect();
    const before = await jobState();
    const claimBefore = (await db.query("SELECT pg_get_functiondef('public.claim_messaging_auto_tag_page(uuid,uuid)'::regprocedure) AS definition")).rows[0].definition;
    if (apply) {
        await mkdir('.vercel/backups', { recursive: true });
        report.backup = `.vercel/backups/messaging-auto-tag-scheduler-${Date.now()}.json`;
        await writeFile(report.backup, JSON.stringify({ checkedAt: report.checkedAt, before, claimBefore }, null, 2));
    }
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='25s'; SET LOCAL lock_timeout='5s'");
    const migration = (await readFile('database/migration_messaging_auto_tag_schedule.sql', 'utf8'))
        .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await db.query(migration);
    await db.query(migration);
    const jobs = await jobState();
    check(jobs.length, 1, 'Repeated installation retains exactly one named job');
    check(jobs[0].active, true, 'The fallback is enabled');
    check(jobs[0].schedule, '* * * * *', 'The scheduler checks once per minute');
    assert.ok(jobs[0].command.includes(workerUrl)); report.checks++;
    assert.ok(!/follow-up-automations|campaign-scheduled|Authorization|CRON_SECRET/.test(jobs[0].command)); report.checks++;
    // Parse/plan the installed command against the real schema without running
    // net.http_get. Functional checks below use only temporary tables and a stub.
    await db.query(`EXPLAIN ${jobs[0].command}`); report.checks++;

    await db.query('SAVEPOINT fixtures');
    await db.query(`CREATE TEMP TABLE pages(id UUID PRIMARY KEY,
        messaging_auto_tag_enabled BOOLEAN DEFAULT TRUE, messaging_auto_tag_attempted_at TIMESTAMPTZ,
        messaging_auto_tag_lease_until TIMESTAMPTZ, campaign_delivery_cooldown_until TIMESTAMPTZ,
        messaging_auto_tag_owner UUID, messaging_auto_tag_scan_started_at TIMESTAMPTZ,
        messaging_auto_tag_cursor TEXT, messaging_auto_tag_checked_at TIMESTAMPTZ DEFAULT NOW()-INTERVAL '7 days');
        CREATE TEMP TABLE contacts(page_id UUID,last_inbound_at TIMESTAMPTZ);
        CREATE TEMP TABLE quota_memberships(page_id UUID,scope TEXT,quota_key TEXT);
        CREATE TEMP TABLE campaign_shared_quota_cooldowns(scope TEXT,quota_key TEXT,retry_at TIMESTAMPTZ);
        CREATE FUNCTION pg_temp.campaign_page_quota_keys(p_page_id UUID)
        RETURNS TABLE(scope TEXT,quota_key TEXT) LANGUAGE SQL STABLE AS
        'SELECT scope,quota_key FROM pg_temp.quota_memberships WHERE page_id=p_page_id';
        CREATE FUNCTION pg_temp.request_worker(url TEXT,timeout_milliseconds INTEGER)
        RETURNS BIGINT LANGUAGE SQL VOLATILE AS 'SELECT 1::BIGINT';`);
    const command = jobs[0].command.replaceAll('public.', 'pg_temp.')
        .replaceAll('app_private.', 'pg_temp.').replace('net.http_get', 'pg_temp.request_worker');
    assert.ok(!/public\.|app_private\.|net\.http_get/.test(command)); report.checks++;
    const dispatches = async () => (await db.query(command)).rowCount;
    const page = randomUUID();
    await db.query('INSERT INTO pg_temp.pages(id) VALUES($1)', [page]);
    check(await dispatches(), 0, 'Pages with no contacts cannot trigger requests');
    await db.query("INSERT INTO pg_temp.contacts VALUES($1,NOW()-INTERVAL '8 days')", [page]);
    check(await dispatches(), 0, 'Old inbound contacts cannot trigger requests');
    await db.query("UPDATE pg_temp.contacts SET last_inbound_at=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'Future inbound timestamps cannot trigger requests');
    await db.query("UPDATE pg_temp.contacts SET last_inbound_at=NOW()-INTERVAL '1 hour'");
    check(await dispatches(), 1, 'An enabled Page with an unattempted recent inbound contact recovers');
    await db.query('UPDATE pg_temp.pages SET messaging_auto_tag_enabled=FALSE');
    check(await dispatches(), 0, 'Disabled auto-tag settings remain disabled');
    await db.query("UPDATE pg_temp.pages SET messaging_auto_tag_enabled=TRUE,messaging_auto_tag_attempted_at=NOW()-INTERVAL '4 minutes'");
    check(await dispatches(), 0, 'Healthy primary polling does not trigger fallback requests');
    await db.query("UPDATE pg_temp.pages SET messaging_auto_tag_attempted_at=NOW()-INTERVAL '5 minutes'");
    check(await dispatches(), 1, 'A Page recovers after the five-minute grace period');
    await db.query("UPDATE pg_temp.pages SET messaging_auto_tag_lease_until=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'An active worker lease prevents fallback dispatch');
    await db.query("UPDATE pg_temp.pages SET messaging_auto_tag_lease_until=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'An expired worker lease permits recovery');
    await db.query("UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'A Page cooldown remains in force');
    await db.query("UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'An expired Page cooldown permits recovery');
    await db.query("INSERT INTO pg_temp.quota_memberships VALUES($1,'app','shared')", [page]);
    await db.query("INSERT INTO pg_temp.campaign_shared_quota_cooldowns VALUES('app','shared',NOW()+INTERVAL '1 minute')");
    check(await dispatches(), 0, 'A shared application cooldown prevents fallback dispatch');
    await db.query("UPDATE pg_temp.campaign_shared_quota_cooldowns SET retry_at=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'An expired shared cooldown permits recovery');
    await db.query("INSERT INTO pg_temp.campaign_shared_quota_cooldowns VALUES('user','other',NOW()+INTERVAL '1 minute')");
    check(await dispatches(), 1, 'An unrelated user cooldown does not block a Page');
    await db.query("INSERT INTO pg_temp.quota_memberships VALUES($1,'user','other')", [page]);
    check(await dispatches(), 0, 'A related Facebook user cooldown is respected');
    await db.query("DELETE FROM pg_temp.quota_memberships WHERE scope='user'");
    await db.query("INSERT INTO pg_temp.quota_memberships VALUES($1,'business','123:messenger')", [page]);
    await db.query("INSERT INTO pg_temp.campaign_shared_quota_cooldowns VALUES('business','123:messenger',NOW()+INTERVAL '1 minute')");
    check(await dispatches(), 0, 'An observed related business cooldown is respected');
    await db.query('DELETE FROM pg_temp.quota_memberships; DELETE FROM pg_temp.campaign_shared_quota_cooldowns');
    for (let i = 0; i < 7; i++) {
        const next = randomUUID();
        await db.query('INSERT INTO pg_temp.pages(id) VALUES($1)', [next]);
        await db.query("INSERT INTO pg_temp.contacts VALUES($1,NOW()-INTERVAL '1 hour')", [next]);
    }
    check(await dispatches(), 3, 'A backlog dispatches at most three workers per tick');
    await db.query('UPDATE pg_temp.pages SET messaging_auto_tag_attempted_at=NOW()');
    check(await dispatches(), 0, 'Freshly attempted Pages leave the fallback idle');
    const claimDefinition = (await db.query("SELECT pg_get_functiondef('public.claim_messaging_auto_tag_page(uuid,uuid)'::regprocedure) AS definition")).rows[0].definition;
    const fixtureClaim = claimDefinition.replaceAll('public.', 'pg_temp.').replaceAll('app_private.', 'pg_temp.');
    assert.ok(!/public\.|app_private\./.test(fixtureClaim)); report.checks++;
    await db.query(fixtureClaim);
    await db.query("UPDATE pg_temp.pages SET messaging_auto_tag_attempted_at=NOW()-INTERVAL '6 minutes'");
    const claim = async pageId => (await db.query('SELECT id FROM pg_temp.claim_messaging_auto_tag_page($1,$2)', [randomUUID(), pageId])).rows;
    await db.query("INSERT INTO pg_temp.quota_memberships VALUES($1,'app','shared')", [page]);
    await db.query("INSERT INTO pg_temp.campaign_shared_quota_cooldowns VALUES('app','shared',NOW()+INTERVAL '1 minute')");
    check(await claim(page), [], 'The worker claim itself respects a shared cooldown without a Page cooldown');
    const other = (await claim(null))[0]?.id;
    assert.ok(other && other !== page); report.checks++;
    check(await claim(other), [], 'Concurrent requests cannot reclaim an active Page');
    await db.query("UPDATE pg_temp.campaign_shared_quota_cooldowns SET retry_at=NOW()-INTERVAL '1 minute'");
    check((await claim(page)).map(row => row.id), [page], 'A Page can be claimed after its shared cooldown expires');
    await db.query('UPDATE pg_temp.pages SET messaging_auto_tag_owner=NULL,messaging_auto_tag_lease_until=NULL WHERE id=$1', [page]);
    check(await claim(page), [], 'A released Page still observes the one-minute attempt interval');
    for (const role of ['anon', 'authenticated']) {
        check((await db.query("SELECT has_function_privilege($1,'public.claim_messaging_auto_tag_page(uuid,uuid)','EXECUTE') AS allowed", [role])).rows[0].allowed,
            false, `${role} cannot claim workers directly`);
    }
    check((await db.query("SELECT has_function_privilege('service_role','public.claim_messaging_auto_tag_page(uuid,uuid)','EXECUTE') AS allowed")).rows[0].allowed,
        true, 'The server retains access to Page claims');
    await db.query('ROLLBACK TO SAVEPOINT fixtures');
    report.fixturesRolledBack = true;
    report.job = { id: jobs[0].jobid, name: jobName, schedule: jobs[0].schedule, active: jobs[0].active, workerUrl };
    await db.query(apply ? 'COMMIT' : 'ROLLBACK');
    report.committed = apply;
    report.passed = true;
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    report.passed = false;
    report.error = { code: error.code || null, message: error.message };
    process.exitCode = 1;
} finally {
    await db.end();
    await mkdir('outputs', { recursive: true });
    await writeFile(`outputs/messaging-auto-tag-scheduler-${apply ? 'apply' : 'preflight'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
