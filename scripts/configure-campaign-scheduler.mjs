// Preflight uses isolated temporary fixtures and rolls back every change.
// --apply installs the same verified schedule; it never creates a campaign.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Client } from 'pg';

const apply = process.argv.includes('--apply');
if (process.argv.slice(2).some(arg => !['--apply', '--preflight'].includes(arg)) ||
    apply && process.argv.includes('--preflight')) throw new Error('Use --preflight or --apply.');
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw new Error('Load the existing database environment before running this command.');
const db = new Client({ connectionString, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 30000 });
const report = { checkedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preflight', checks: 0,
    customerCampaignsCreated: 0, committed: false, rolledBack: false };
const jobName = 'tokko-campaign-delivery';
const workerUrl = 'https://tokkobeta.vercel.app/api/cron/campaign-scheduled';
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); report.checks++; }
try {
    const response = await fetch(workerUrl, { method: 'OPTIONS', redirect: 'manual', signal: AbortSignal.timeout(15000) });
    check(response.status, 204, 'The public worker must be deployed before its schedule is installed');
    await db.connect();
    const before = (await db.query('SELECT jobid,jobname,schedule,command,active FROM cron.job WHERE jobname=$1', [jobName])).rows;
    const extensions = (await db.query("SELECT extname,extversion FROM pg_extension WHERE extname IN ('pg_cron','pg_net')")).rows;
    if (apply) {
        await mkdir('.vercel/backups', { recursive: true });
        report.backup = `.vercel/backups/campaign-scheduler-${Date.now()}.json`;
        await writeFile(report.backup, JSON.stringify({ before, extensions }, null, 2));
    }
    await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='25s'; SET LOCAL lock_timeout='5s'");
    const sql = (await readFile('database/migration_campaign_worker_schedule.sql', 'utf8'))
        .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await db.query(sql);
    await db.query(sql);
    const jobs = (await db.query('SELECT jobid,jobname,schedule,command,active FROM cron.job WHERE jobname=$1', [jobName])).rows;
    check(jobs.length, 1, 'Repeated installation must retain exactly one named job');
    check(jobs[0].active, true, 'The campaign schedule is enabled');
    check(jobs[0].schedule, '* * * * *', 'Continuation runs every minute');
    assert.ok(jobs[0].command.includes(workerUrl)); report.checks++;
    assert.ok(!/CRON_SECRET|Authorization/i.test(jobs[0].command)); report.checks++;

    await db.query('SAVEPOINT fixtures');
    await db.query(`CREATE TEMP TABLE pages(id UUID, campaign_delivery_lease_until TIMESTAMPTZ,
        campaign_delivery_cooldown_until TIMESTAMPTZ);
        CREATE TEMP TABLE campaigns(id UUID,page_id UUID,is_loop BOOLEAN DEFAULT FALSE,status TEXT,
        background_delivery_enabled BOOLEAN DEFAULT TRUE,scheduled_at TIMESTAMPTZ,next_attempt_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW());
        CREATE TEMP TABLE campaign_recipients(campaign_id UUID,status TEXT,scheduled_at TIMESTAMPTZ);
        CREATE FUNCTION pg_temp.request_worker(url TEXT,timeout_milliseconds INTEGER) RETURNS BIGINT
        LANGUAGE SQL VOLATILE AS 'SELECT 1::BIGINT';
        INSERT INTO pg_temp.pages(id) VALUES('00000000-0000-4000-8000-000000000001');
        INSERT INTO pg_temp.campaigns(id,page_id,status) VALUES('00000000-0000-4000-8000-000000000002',
            '00000000-0000-4000-8000-000000000001','sending');`);
    const fixtureCommand = jobs[0].command.replaceAll('public.', 'pg_temp.')
        .replace('net.http_get', 'pg_temp.request_worker');
    assert.ok(!fixtureCommand.includes('public.') && !fixtureCommand.includes('net.http_get')); report.checks++;
    const dispatches = async () => (await db.query(fixtureCommand)).rowCount;
    check(await dispatches(), 1, 'An enabled immediate campaign continues without a browser');
    for (const status of ['draft', 'cancelled', 'completed', 'failed']) {
        await db.query('UPDATE pg_temp.campaigns SET status=$1', [status]);
        check(await dispatches(), 0, `${status} campaigns cannot be restarted by the schedule`);
    }
    await db.query("UPDATE pg_temp.campaigns SET status='sending',background_delivery_enabled=FALSE");
    check(await dispatches(), 0, 'Disabled background delivery remains disabled');
    await db.query("UPDATE pg_temp.campaigns SET background_delivery_enabled=TRUE,is_loop=TRUE");
    check(await dispatches(), 0, 'The one-time worker does not dispatch loop campaigns');
    await db.query("UPDATE pg_temp.campaigns SET is_loop=FALSE,next_attempt_at=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'Campaign retry windows remain in force');
    await db.query("UPDATE pg_temp.campaigns SET next_attempt_at=NULL; UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'Page and app cooldowns remain in force');
    await db.query("UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NULL,campaign_delivery_lease_until=NOW()+INTERVAL '1 minute'");
    check(await dispatches(), 0, 'An active Page worker is not interrupted by another dispatch');
    await db.query("UPDATE pg_temp.pages SET campaign_delivery_lease_until=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'An expired Page lease permits recovery');
    await db.query("UPDATE pg_temp.campaigns SET status='scheduled',scheduled_at=NOW()+INTERVAL '1 hour'");
    check(await dispatches(), 0, 'Future schedules are not started early');
    await db.query("UPDATE pg_temp.campaigns SET scheduled_at=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'A due campaign is dispatched');
    await db.query("UPDATE pg_temp.campaigns SET scheduled_at=NULL; INSERT INTO pg_temp.campaign_recipients VALUES('00000000-0000-4000-8000-000000000002','pending',NOW()+INTERVAL '1 hour')");
    check(await dispatches(), 0, 'Future recipient-level schedules remain queued');
    await db.query("UPDATE pg_temp.campaign_recipients SET scheduled_at=NOW()-INTERVAL '1 minute'");
    check(await dispatches(), 1, 'A due recipient-level schedule is dispatched');
    await db.query("UPDATE pg_temp.campaigns SET status='sending',background_delivery_enabled=FALSE");
    check(await dispatches(), 0, 'A recently updated scheduled worker is not reclaimed early');
    await db.query("UPDATE pg_temp.campaigns SET updated_at=NOW()-INTERVAL '11 minutes'");
    check(await dispatches(), 1, 'A stale scheduled worker can recover');
    await db.query('ROLLBACK TO SAVEPOINT fixtures');

    report.job = { id: jobs[0].jobid, name: jobName, schedule: jobs[0].schedule, active: jobs[0].active, workerUrl };
    if (apply) { await db.query('COMMIT'); report.committed = true; }
    else { await db.query('ROLLBACK'); report.rolledBack = true; }
    report.passed = true;
} catch (error) {
    await db.query('ROLLBACK').then(()=>{report.rolledBack=true;}).catch(()=>{});
    report.passed = false;
    report.error = { code: error.code || null, message: error.message };
    process.exitCode = 1;
} finally {
    await db.end();
    await mkdir('outputs', { recursive: true });
    await writeFile(`outputs/campaign-scheduler-${apply ? 'apply' : 'preflight'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
