// Restore required setup records after a cleanup. Run --preflight first;
// --apply commits only metadata after rollback-only functional checks pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const apply = process.argv.includes('--apply');
if (Number(apply) + Number(process.argv.includes('--preflight')) !== 1) throw Error('Choose --preflight or --apply');
const api = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
const connectionString = process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
const connection = new URL(connectionString), project = api.hostname.split('.')[0];
const claim = JSON.parse(Buffer.from(process.env.SUPABASE_SERVICE_ROLE_KEY.split('.')[1], 'base64url'));
assert.equal(claim.ref, project, 'API credential belongs to another database');
assert.ok(connection.hostname === `db.${project}.supabase.co` || decodeURIComponent(connection.username) === `postgres.${project}`, 'SQL connection belongs to another database');
const db = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 60000 });
const report = { project, mode: apply ? 'apply' : 'preflight', startedAt: new Date().toISOString(), checks: 0, committed: false, fixturesRolledBack: false, customerMessagesSent: 0 };
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function denied(sql, args = []) {
    await db.query('SAVEPOINT expected_denial'); let code;
    try { await db.query(sql, args); } catch (error) { code = error.code; }
    await db.query('ROLLBACK TO SAVEPOINT expected_denial'); check(code, '42501', 'End-user role must not run administrative tag repair');
}

async function smokeTest() {
    await db.query('SAVEPOINT functional_fixtures');
    await db.query("SET LOCAL app.historical_lead_repair='deterministic_only'");
    const page = randomUUID(), contact = randomUUID(), customTag = randomUUID(), campaign = randomUUID();
    await db.query("INSERT INTO public.pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Setup repair test','not-a-facebook-token')", [page, `test-${page}`]);
    let tags = (await db.query('SELECT id,name FROM public.ensure_page_default_tags($1) ORDER BY name', [page])).rows;
    check(tags.length, 2, 'New Pages receive two required tags');
    check((await db.query('SELECT id,name FROM public.ensure_page_default_tags($1) ORDER BY name', [page])).rows, tags, 'Repeated repairs reuse tag IDs');
    const paid = tags.find(tag => tag.name === 'Paid / Availed Service');
    await db.query("INSERT INTO public.contacts(id,page_id,psid,name) VALUES($1,$2,$3,'Setup test customer')", [contact, page, `test-${contact}`]);
    await db.query("INSERT INTO public.tags(id,name,owner_type,owner_id,page_id) VALUES($1,'Keep custom tag','page',$2,$2)", [customTag, page]);
    await db.query('INSERT INTO public.contact_tags(contact_id,tag_id) VALUES($1,$2),($1,$3)', [contact, paid.id, customTag]);
    await db.query("UPDATE public.tags SET is_default=FALSE,name='Paid / Availed Services' WHERE id=$1", [paid.id]);
    tags = (await db.query('SELECT id,name FROM public.ensure_page_default_tags($1) ORDER BY name', [page])).rows;
    check(tags.find(tag => tag.name === 'Paid / Availed Service')?.id, paid.id, 'Repair preserves a legacy paid-tag ID');
    check(await scalar('SELECT count(*)::int value FROM public.contact_tags WHERE contact_id=$1', [contact]), 2, 'Existing assignments survive repair');
    check(await scalar('SELECT count(*)::int value FROM public.tags WHERE id=$1', [customTag]), 1, 'Custom tags survive repair');
    await db.query('DELETE FROM public.tags WHERE owner_id=$1 AND is_default', [page]);
    check((await db.query('SELECT * FROM public.ensure_page_default_tags($1)', [page])).rowCount, 2, 'Missing built-in tags are recreated');
    check(await scalar('SELECT count(*)::int value FROM public.contact_tags WHERE contact_id=$1 AND tag_id=$2', [contact, customTag]), 1, 'Unrelated custom assignments survive recreation');
    await db.query('SET LOCAL ROLE service_role');
    check((await db.query('SELECT * FROM public.ensure_page_default_tags($1)', [page])).rowCount, 2, 'Server role can repair tags');
    await db.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) { await db.query(`SET LOCAL ROLE ${role}`); await denied('SELECT * FROM public.ensure_page_default_tags($1)', [page]); await db.query('RESET ROLE'); }

    const first = Date.now() - 86400000;
    const stage = async (id, label, value, offset) => scalar('SELECT public.apply_messenger_lead_stage($1,$2,$3,$4,$5,$6::timestamptz) value', [page, contact, id, label, value, new Date(first + offset * 1000).toISOString()]);
    check((await stage('test-qualified', 'Qualified', 'qualified', 0)).applied, true, 'Qualified event applies');
    check(await scalar('SELECT pipeline_stage value FROM public.contacts WHERE id=$1', [contact]), 'qualified');
    check((await stage('test-converted', 'Converted', 'converted', 1)).applied, true, 'Converted event applies');
    check((await stage('test-converted', 'Converted', 'converted', 1)).reason, 'duplicate', 'Event retries are idempotent');
    check((await stage('test-older', 'Qualified', 'qualified', 0)).reason, 'older_event', 'Older notices cannot regress the current stage');
    check(await scalar('SELECT pipeline_stage value FROM public.contacts WHERE id=$1', [contact]), 'converted');
    check((await stage('test-negative', 'Not Qualified', 'not_qualified', 2)).applied, true, 'Negative stage changes apply');
    check((await stage('test-order', 'Order Created', 'order_created', 3)).applied, true, 'Order notices apply');
    const histories = (await db.query("SELECT DISTINCT t.name FROM public.contact_tags ct JOIN public.tags t ON t.id=ct.tag_id WHERE ct.contact_id=$1 AND t.system_key IS NOT NULL ORDER BY t.name", [contact])).rows.map(row => row.name);
    check(histories, ['History: Converted', 'History: Not Qualified', 'History: Order Created', 'History: Qualified'], 'Stage history accumulates without losing earlier labels');
    await db.query("UPDATE public.contacts SET pipeline_stage='opted_out',pipeline_stage_source='manual',pipeline_stage_updated_at=now() WHERE id=$1", [contact]);
    check((await stage('test-before-manual', 'Qualified', 'qualified', 4)).reason, 'older_event', 'Manual decisions are preserved');
    check(await scalar('SELECT pipeline_stage value FROM public.contacts WHERE id=$1', [contact]), 'opted_out');

    check(await scalar('SELECT public.acquire_page_sync_lease($1,$2,60) value', [page, 'setup-owner']), true);
    check(await scalar('SELECT public.acquire_page_sync_lease($1,$2,60) value', [page, 'other-owner']), false, 'Concurrent syncs cannot acquire the same Page');
    check(await scalar('SELECT public.release_page_sync_lease($1,$2) value', [page, 'other-owner']), false, 'Another owner cannot release a sync lease');
    check(await scalar('SELECT public.release_page_sync_lease($1,$2) value', [page, 'setup-owner']), true);
    await db.query("INSERT INTO public.campaigns(id,page_id,name,status,total_recipients,audience_materialized_at) VALUES($1,$2,'Queue test','sending',1,now())", [campaign, page]);
    await db.query('INSERT INTO public.campaign_recipients(campaign_id,contact_id) VALUES($1,$2)', [campaign, contact]);
    const claimed = (await db.query('SELECT * FROM public.claim_campaign_recipients($1,1,NULL,FALSE)', [campaign])).rows;
    check(claimed.length, 1, 'Campaign recipient can be claimed');
    check((await db.query('SELECT * FROM public.claim_campaign_recipients($1,1,NULL,FALSE)', [campaign])).rows.length, 0, 'Active claims are not duplicated');
    check(await scalar('SELECT public.finish_campaign_recipient_batch($1,$2,$3::jsonb) value', [campaign, claimed[0].claim_token, JSON.stringify([{ contact_id: contact, success: true, error_message: null }])]), 1, 'Queue completion RPC works without sending a message');
    const progress = (await db.query('SELECT * FROM public.get_campaign_delivery_progress($1)', [campaign])).rows[0];
    check(Number(progress.sent_count), 1, 'Campaign totals match completed delivery');
    check(Number(progress.remaining_count), 0);
    await db.query('ROLLBACK TO SAVEPOINT functional_fixtures');
    check(await scalar('SELECT count(*)::int value FROM public.pages WHERE id=$1', [page]), 0, 'Fixture Page was rolled back');
    check(await scalar('SELECT count(*)::int value FROM public.contacts WHERE id=$1', [contact]), 0, 'Fixture contact was rolled back');
    report.fixturesRolledBack = true;
}

try {
    await db.connect(); await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    const users = (await db.query('SELECT id FROM public.users ORDER BY id')).rows;
    const memberships = (await db.query('SELECT user_id,page_id FROM public.user_pages ORDER BY user_id,page_id')).rows;
    const configBefore = (await db.query('SELECT * FROM public.tokko_account_config')).rows;
    const tagsBefore = (await db.query('SELECT * FROM public.tags ORDER BY id')).rows;
    const definitions = (await db.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS privileges FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('ensure_page_default_tags','create_default_page_tags')")).rows;
    const backup = `.vercel/backups/operational-setup-${Date.now()}.json`; fs.mkdirSync('.vercel/backups', { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({ project, configBefore, tagsBefore, definitions }, null, 2), { mode: 0o600 }); report.backup = backup;
    await db.query(fs.readFileSync('database/migration_repair_default_page_tags.sql', 'utf8'));
    // Restore the missing singleton only. An explicitly disabled existing flag
    // is not overridden; the full isolation predicate must succeed before commit.
    await db.query('INSERT INTO public.tokko_account_config(id,enabled) VALUES(TRUE,TRUE) ON CONFLICT(id) DO NOTHING');
    check(await scalar('SELECT public.tokko_accounts_ready() value'), true, 'Readiness requires existing database and Storage isolation');
    const restored = await db.query(`INSERT INTO public.tokko_auth_identities(provider,subject,user_id)
        SELECT 'facebook',facebook_id,id FROM public.users WHERE facebook_id IS NOT NULL AND created_by IS NULL AND account_kind IN('legacy','facebook')
        ON CONFLICT DO NOTHING`); report.facebookBindingsRestored = restored.rowCount;
    check(await scalar(`SELECT count(*)::int value FROM public.users u WHERE u.facebook_id IS NOT NULL AND u.created_by IS NULL AND u.account_kind IN('legacy','facebook')
        AND NOT EXISTS(SELECT 1 FROM public.tokko_auth_identities i WHERE i.provider='facebook' AND i.subject=u.facebook_id AND i.user_id=u.id)`), 0, 'Stored Facebook identities retain their original user IDs');
    await smokeTest();
    check((await db.query('SELECT id FROM public.users ORDER BY id')).rows, users, 'Existing accounts are preserved');
    check((await db.query('SELECT user_id,page_id FROM public.user_pages ORDER BY user_id,page_id')).rows, memberships, 'Existing Page assignments are preserved');
    const tags = (await db.query("SELECT p.id,count(t.id)::int AS count FROM public.pages p LEFT JOIN public.tags t ON t.owner_id=p.id AND t.owner_type='page' AND t.is_default AND t.name IN('Paid / Availed Service','Unqualified') GROUP BY p.id")).rows;
    check(tags.every(row => row.count === 2), true, 'Every Page has both required default tags');
    report.pagesVerified = tags.length; report.accountsPreserved = users.length; report.assignmentsPreserved = memberships.length;
    await db.query(apply ? 'COMMIT' : 'ROLLBACK'); report.committed = apply; report.passed = true; report.completedAt = new Date().toISOString();
} catch (error) { await db.query('ROLLBACK').catch(() => {}); report.passed = false; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally { await db.end(); fs.mkdirSync('.vercel/feature-repair', { recursive: true }); fs.writeFileSync(`.vercel/feature-repair/${apply ? 'applied' : 'preflight'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
