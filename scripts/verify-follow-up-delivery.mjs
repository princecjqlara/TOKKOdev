import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const apply = process.argv.includes('--apply');
if (Number(apply) + Number(process.argv.includes('--preflight')) !== 1) throw Error('Choose --preflight or --apply');
const project = new URL(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const connection = new URL(process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL);
assert.ok(connection.hostname === `db.${project}.supabase.co` || decodeURIComponent(connection.username) === `postgres.${project}`, 'SQL target mismatch');
const db = new pg.Client({ connectionString: connection.toString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
const report = { project, apply, checks: 0, committed: false, fixturesRolledBack: false, customerMessagesSent: 0 };
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); report.checks++; }
async function rejects(sql, values) {
    await db.query('SAVEPOINT invalid_fixture');
    let code;
    try { await db.query(sql, values); } catch (error) { code = error.code; }
    await db.query('ROLLBACK TO SAVEPOINT invalid_fixture');
    check(code, '23514', 'Invalid delay must violate a check constraint');
}
try {
    await db.connect(); await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    const before = (await db.query('SELECT id,steps,cooldown_minutes,enabled FROM public.workflow_automations ORDER BY id')).rows;
    const constraints = (await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.workflow_automations'::regclass AND contype='c' ORDER BY conname")).rows;
    fs.mkdirSync('.vercel/backups', { recursive: true });
    report.backup = `.vercel/backups/follow-up-delay-${Date.now()}.json`;
    fs.writeFileSync(report.backup, JSON.stringify({ project, constraints }, null, 2), { mode: 0o600 });
    await db.query(fs.readFileSync('database/migration_follow_up_template_delays.sql', 'utf8'));
    await db.query('SAVEPOINT functional_fixtures');
    const page = randomUUID(), workflow = randomUUID();
    await db.query("INSERT INTO public.pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Follow-up verification','not-a-facebook-token')", [page, `fixture-${page}`]);
    const steps = [{ message_text: 'Fixture', delay_minutes: 11520, template_name: 'chosen_template', template_language: 'en_US', template_parameters: ['{{first_name}}'] }];
    await db.query("INSERT INTO public.workflow_automations(id,page_id,name,trigger_type,message_text,steps,cooldown_minutes) VALUES($1,$2,'Follow-up test','follow_up','Fixture',$3::jsonb,11520)", [workflow, page, JSON.stringify(steps)]);
    const stored = (await db.query('SELECT steps,cooldown_minutes FROM public.workflow_automations WHERE id=$1', [workflow])).rows[0];
    check(stored.steps, steps, 'Template metadata and full step delay survive storage');
    check(stored.cooldown_minutes, 11520, 'Eight-day first follow-up is accepted');
    await db.query('UPDATE public.workflow_automations SET cooldown_minutes=525600 WHERE id=$1', [workflow]);
    check((await db.query('SELECT cooldown_minutes FROM public.workflow_automations WHERE id=$1', [workflow])).rows[0].cooldown_minutes, 525600, '365-day bound is accepted');
    await rejects('UPDATE public.workflow_automations SET cooldown_minutes=525601 WHERE id=$1', [workflow]);
    await rejects('UPDATE public.workflow_automations SET cooldown_minutes=-1 WHERE id=$1', [workflow]);
    await db.query('ROLLBACK TO SAVEPOINT functional_fixtures'); report.fixturesRolledBack = true;
    check((await db.query('SELECT id,steps,cooldown_minutes,enabled FROM public.workflow_automations ORDER BY id')).rows, before, 'Existing workflows are unchanged');
    const after = (await db.query("SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.workflow_automations'::regclass AND contype='c' ORDER BY conname")).rows;
    check(after.filter(row => row.conname !== 'workflow_automations_cooldown_minutes_check'),
        constraints.filter(row => row.conname !== 'workflow_automations_cooldown_minutes_check'), 'Other workflow constraints are preserved');
    check(after.find(row => row.conname === 'workflow_automations_cooldown_minutes_check')?.definition.includes('525600'), true);
    await db.query(apply ? 'COMMIT' : 'ROLLBACK'); report.committed = apply; report.passed = true;
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    report.passed = false; report.error = { message: error.message, code: error.code }; process.exitCode = 1;
} finally {
    await db.end(); report.completedAt = new Date().toISOString();
    fs.writeFileSync(`.vercel/follow-up-delay-${apply ? 'applied' : 'preflight'}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
