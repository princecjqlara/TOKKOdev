// Read-only usage inventory. The explicit project guard prevents auditing the
// locally configured replacement project when the live app uses another one.
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function validateUsageAuditTarget(env, expectedProject) {
    if (!/^[a-z0-9]{20}$/.test(expectedProject || '')) throw Error('Supply --expected-project with the intended Supabase project reference.');
    let api, sql;
    const connectionString = env.DATABASE_POOLER_URL_6543 || env.DATABASE_POOLER_URL_5432 || env.DATABASE_URL;
    try {
        api = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? env.SUPABASE_URL);
        sql = new URL(connectionString);
    } catch { throw Error('Valid Supabase API and PostgreSQL connection settings are required.'); }
    if (api.hostname !== `${expectedProject}.supabase.co`) throw Error('The configured Supabase API host does not match --expected-project. No database queries were run.');
    if (!['postgres:', 'postgresql:'].includes(sql.protocol) || !(sql.hostname === `db.${expectedProject}.supabase.co` ||
        sql.hostname.endsWith('.pooler.supabase.com') && decodeURIComponent(sql.username) === `postgres.${expectedProject}`)) {
        throw Error('The PostgreSQL connection does not match --expected-project. No database queries were run.');
    }
    return { project: expectedProject, connectionString };
}

async function main() {
    const expected = process.argv[process.argv.indexOf('--expected-project') + 1];
    const { project, connectionString } = validateUsageAuditTarget(process.env, expected);
    const report = { project, startedAt: new Date().toISOString(), readOnly: true, dataDeleted: 0, connectionChanged: false, connected: false, passed: false, stage: 'connect' };
    const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000, query_timeout: 8000 });
    db.on('error', () => {});
    try {
        await db.connect();
        report.connected = true;
        report.stage = 'begin_read_only';
        await db.query('BEGIN READ ONLY');
        await db.query("SET LOCAL statement_timeout='8s'");
        report.stage = 'database_size';
        report.database = (await db.query('SELECT pg_database_size(current_database()) AS bytes, pg_size_pretty(pg_database_size(current_database())) AS size')).rows[0];
        report.stage = 'table_metadata';
        report.largestTables = (await db.query(`SELECT s.schemaname AS schema,s.relname AS table,
            pg_total_relation_size(s.relid) AS total_bytes,pg_relation_size(s.relid) AS heap_bytes,pg_indexes_size(s.relid) AS index_bytes,
            s.n_live_tup AS estimated_rows,s.n_dead_tup AS estimated_dead_rows,s.seq_scan,s.idx_scan,s.n_tup_ins,s.n_tup_upd,s.n_tup_del
            FROM pg_stat_user_tables s WHERE s.schemaname IN('public','app_private')
            ORDER BY pg_total_relation_size(s.relid) DESC LIMIT 30`)).rows;
        report.stage = 'connection_metadata';
        report.connections = (await db.query(`SELECT state,count(*)::int AS count FROM pg_stat_activity
            WHERE datname=current_database() AND backend_type='client backend' GROUP BY state`)).rows;
        report.stage = 'schedule_metadata';
        const cron = (await db.query("SELECT to_regclass('cron.job') IS NOT NULL AS available")).rows[0].available;
        if (cron) report.schedules = (await db.query('SELECT jobname,schedule,active FROM cron.job ORDER BY jobname LIMIT 50')).rows;
        await db.query('ROLLBACK');
        report.passed = true;
        report.stage = 'complete';
    } catch (error) {
        // Closing the client also ends its read-only transaction. Avoid issuing
        // another query when the connection or pool is already timing out.
        report.errorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code
            : /timeout|timed out/i.test(error.message || '') ? 'AUDIT_TIMEOUT' : 'AUDIT_CONNECTION_OR_QUERY_FAILED';
    } finally { await db.end().catch(() => {}); }
    await fs.mkdir('.vercel/usage-audit', { recursive: true });
    const receipt = `.vercel/usage-audit/${project}-${Date.now()}.json`;
    await fs.writeFile(receipt, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, receipt }));
    if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main().catch(() => { console.error('Usage audit refused: verify --expected-project and matching API/SQL settings. No cleanup was performed.'); process.exitCode = 1; });
}
