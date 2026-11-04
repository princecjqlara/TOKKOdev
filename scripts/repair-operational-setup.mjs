// Restore required setup records after a cleanup. Run --preflight first;
// --apply commits only metadata after rollback-only functional checks pass.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

const apply = process.argv.includes('--apply');
if (Number(apply) + Number(process.argv.includes('--preflight')) !== 1) throw Error('Choose --preflight or --apply');
const api = new URL(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
assert.ok(api.protocol === 'https:' && api.hostname.endsWith('.supabase.co'), 'Expected a Supabase API host');
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_POOLER_URL_6543 || process.env.DATABASE_URL;
const connection = new URL(connectionString), project = api.hostname.split('.')[0];
const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(apiKey, 'A server API credential is required');
if (!apiKey.startsWith('sb_secret_')) {
    const claim = JSON.parse(Buffer.from(apiKey.split('.')[1], 'base64url'));
    assert.equal(claim.ref, project, 'API credential belongs to another database');
    assert.equal(claim.role, 'service_role', 'An administrative API credential is required');
}
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
    check(tags.length, 4, 'New Pages receive four lead-stage tags');
    check((await db.query('SELECT id,name FROM public.ensure_page_default_tags($1) ORDER BY name', [page])).rows, tags, 'Repeated repairs reuse tag IDs');
    const converted = tags.find(tag => tag.name === 'Converted');
    await db.query("INSERT INTO public.contacts(id,page_id,psid,name) VALUES($1,$2,$3,'Setup test customer')", [contact, page, `test-${contact}`]);
    await db.query("INSERT INTO public.tags(id,name,owner_type,owner_id,page_id) VALUES($1,'Keep custom tag','page',$2,$2)", [customTag, page]);
    await db.query('INSERT INTO public.contact_tags(contact_id,tag_id) VALUES($1,$2),($1,$3)', [contact, converted.id, customTag]);
    await db.query("UPDATE public.tags SET is_default=FALSE,name='Paid / Availed Services' WHERE id=$1", [converted.id]);
    tags = (await db.query('SELECT id,name FROM public.ensure_page_default_tags($1) ORDER BY name', [page])).rows;
    check(tags.find(tag => tag.name === 'Converted')?.id, converted.id, 'Converted reuses the legacy paid-tag ID');
    check(await scalar('SELECT count(*)::int value FROM public.contact_tags WHERE contact_id=$1', [contact]), 2, 'Existing assignments survive repair');
    check(await scalar('SELECT count(*)::int value FROM public.tags WHERE id=$1', [customTag]), 1, 'Custom tags survive repair');
    await db.query('DELETE FROM public.tags WHERE owner_id=$1 AND is_default', [page]);
    check((await db.query('SELECT * FROM public.ensure_page_default_tags($1)', [page])).rowCount, 4, 'Missing built-in tags are recreated');
    check(await scalar('SELECT count(*)::int value FROM public.contact_tags WHERE contact_id=$1 AND tag_id=$2', [contact, customTag]), 1, 'Unrelated custom assignments survive recreation');
    await db.query('SET LOCAL ROLE service_role');
    check((await db.query('SELECT * FROM public.ensure_page_default_tags($1)', [page])).rowCount, 4, 'Server role can repair tags');
    await db.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) { await db.query(`SET LOCAL ROLE ${role}`); await denied('SELECT * FROM public.ensure_page_default_tags($1)', [page]); await db.query('RESET ROLE'); }

    const owner = randomUUID();
    await db.query("UPDATE public.pages SET messaging_auto_tag_attempted_at=now()-interval '2 minutes' WHERE id=$1", [page]);
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [owner, page])).rowCount, 0, 'No polling without a recent inbound contact');
    await db.query("UPDATE public.contacts SET last_inbound_at=now()-interval '8 days' WHERE id=$1", [contact]);
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [owner, page])).rowCount, 0, 'Eight-day-old contacts do not trigger polling');
    await db.query("UPDATE public.contacts SET last_inbound_at=now()-interval '1 hour' WHERE id=$1", [contact]);
    await db.query('UPDATE public.pages SET messaging_auto_tag_enabled=FALSE WHERE id=$1', [page]);
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [owner, page])).rowCount, 0, 'Disabled auto-tag Pages are skipped');
    await db.query('UPDATE public.pages SET messaging_auto_tag_enabled=TRUE WHERE id=$1', [page]);
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [owner, page])).rowCount, 1, 'A recent contact makes a due Page eligible');
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [randomUUID(), page])).rowCount, 0, 'The worker lease prevents concurrent polling');
    await db.query('UPDATE public.pages SET messaging_auto_tag_owner=NULL,messaging_auto_tag_lease_until=NULL WHERE id=$1', [page]);
    check((await db.query('SELECT id FROM public.claim_messaging_auto_tag_page($1,$2)', [owner, page])).rowCount, 0, 'Releasing a lease cannot bypass the one-minute polling interval');

    await db.query(`INSERT INTO public.contact_tags(contact_id,tag_id)
        SELECT $1,id FROM public.ensure_page_default_tags($2)
        ON CONFLICT(contact_id,tag_id) DO NOTHING`, [contact, page]);
    await db.query(`INSERT INTO public.contact_tags(contact_id,tag_id)
        SELECT $1,id FROM public.ensure_page_default_tags($2)
        ON CONFLICT(contact_id,tag_id) DO NOTHING`, [contact, page]);
    check(await scalar('SELECT count(*)::int value FROM public.contact_tags WHERE contact_id=$1', [contact]), 5, 'Multiple stage tags accumulate once alongside a custom tag');
    const stageNames = (await db.query(`SELECT t.name FROM public.contact_tags ct JOIN public.tags t ON t.id=ct.tag_id
        WHERE ct.contact_id=$1 AND t.is_default ORDER BY t.name`, [contact])).rows.map(row => row.name);
    check(stageNames, ['Converted', 'Lost', 'Not Qualified', 'Qualified'], 'All four stage tags can coexist on one contact');
    const tag = (await db.query('SELECT id FROM public.tags WHERE owner_id=$1 AND is_default LIMIT 1', [page])).rows[0];
    await db.query("UPDATE public.tags SET color='#123456' WHERE id=$1", [tag.id]);
    check(await scalar('SELECT (updated_at IS NOT NULL) value FROM public.tags WHERE id=$1', [tag.id]), true, 'Tag edits have a working update timestamp');

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
    const credentialCheck = await fetch(new URL('/rest/v1/pages?select=id&limit=0', api), {
        headers: { apikey: apiKey, ...(apiKey.startsWith('sb_secret_') ? {} : { Authorization: `Bearer ${apiKey}` }) },
        signal: AbortSignal.timeout(10000)
    });
    assert.equal(credentialCheck.status, 200, 'Server credential must work on the target API');
    await db.connect(); await db.query('BEGIN'); await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='45s'");
    const users = (await db.query('SELECT id FROM public.users ORDER BY id')).rows;
    const memberships = (await db.query('SELECT user_id,page_id FROM public.user_pages ORDER BY user_id,page_id')).rows;
    const configBefore = (await db.query('SELECT * FROM public.tokko_account_config')).rows;
    const tagsBefore = (await db.query('SELECT * FROM public.tags ORDER BY id')).rows;
    const assignmentsBefore = (await db.query('SELECT * FROM public.contact_tags ORDER BY contact_id,tag_id')).rows;
    const pagesBefore = (await db.query('SELECT id,messaging_auto_tag_enabled,messaging_auto_tag_checked_at,messaging_auto_tag_cursor,messaging_auto_tag_scan_started_at FROM public.pages ORDER BY id')).rows;
    const definitions = (await db.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS privileges FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('ensure_page_default_tags','create_default_page_tags','claim_messaging_auto_tag_page')")).rows;
    const backup = `.vercel/backups/operational-setup-${Date.now()}.json`; fs.mkdirSync('.vercel/backups', { recursive: true });
    fs.writeFileSync(backup, JSON.stringify({ project, configBefore, tagsBefore, assignmentsBefore, pagesBefore, definitions }, null, 2), { mode: 0o600 }); report.backup = backup;
    await db.query(fs.readFileSync('database/migration_messaging_lead_stage_tags.sql', 'utf8'));
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
    check((await db.query('SELECT * FROM public.contact_tags ORDER BY contact_id,tag_id')).rows, assignmentsBefore, 'Existing contact-tag assignments are preserved');
    const tagsAfter = (await db.query('SELECT id,name FROM public.tags ORDER BY id')).rows;
    for (const original of tagsBefore) {
        const current = tagsAfter.find(tag => tag.id === original.id);
        const renamed = original.owner_type === 'page' && original.is_default &&
            ['Paid / Availed Service', 'Paid / Availed Services', 'Unqualified'].includes(original.name);
        check(current?.name, renamed ? original.name === 'Unqualified' ? 'Not Qualified' : 'Converted' : original.name, 'Existing tag IDs are retained');
    }
    const tags = (await db.query("SELECT p.id,count(t.id)::int AS count FROM public.pages p LEFT JOIN public.tags t ON t.owner_id=p.id AND t.owner_type='page' AND t.is_default AND t.name IN('Qualified','Not Qualified','Converted','Lost') GROUP BY p.id")).rows;
    check(tags.every(row => row.count === 4), true, 'Every Page has all four lead-stage tags');
    report.pagesVerified = tags.length; report.accountsPreserved = users.length; report.assignmentsPreserved = memberships.length;
    await db.query(apply ? 'COMMIT' : 'ROLLBACK'); report.committed = apply; report.passed = true; report.completedAt = new Date().toISOString();
} catch (error) { await db.query('ROLLBACK').catch(() => {}); report.passed = false; report.error = { message: error.message, code: error.code }; process.exitCode = 1; }
finally { await db.end(); fs.mkdirSync('.vercel/feature-repair', { recursive: true }); fs.writeFileSync(`.vercel/feature-repair/${apply ? 'applied' : 'preflight'}.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); }
