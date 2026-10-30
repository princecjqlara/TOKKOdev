// Apply the account isolation finalizer to the configured database.
// Review shared database clients before running this administrative script.
// Permissions are backed up locally; smoke-test accounts are rolled back.
// Run: node --env-file=.env.local scripts/enable-team-accounts.mjs
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Client } from 'pg';
import { createClient } from '@supabase/supabase-js';

const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!connectionString || !url || !key) throw new Error('Configure the database connection and Supabase server credentials.');
const api = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const db = new Client({ connectionString, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
let committed = false;
let checks = 0;
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function denied(sql, args = []) {
    await db.query('SAVEPOINT expected_denial');
    let code;
    try { await db.query(sql, args); } catch (error) { code = error.code; }
    await db.query('ROLLBACK TO SAVEPOINT expected_denial');
    assert.equal(code, '42501', 'The unauthorized operation must be denied'); checks++;
}

async function smokeTest() {
    await db.query('SAVEPOINT account_smoke_test');
    const parent = randomUUID(), pageA = randomUUID(), pageB = randomUUID();
    const subject = `activation-check-${randomUUID()}`;
    const password = randomBytes(32).toString('base64url');
    const salt = randomBytes(24).toString('hex');
    const passwordHash = `scrypt-v1$${salt}$${scryptSync(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
    const firstEmail = `activation-${randomUUID()}@example.test`;
    const secondEmail = `activation-${randomUUID()}@example.test`;
    await db.query(`INSERT INTO public.users(id,email,name,facebook_id,account_kind) VALUES($1,$2,'Activation check parent',$3,'facebook')`, [parent, `activation-${parent}@example.test`, subject]);
    await db.query(`INSERT INTO public.tokko_auth_identities(provider,subject,user_id) VALUES('facebook',$1,$2)`, [subject, parent]);
    await db.query(`INSERT INTO public.pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Activation check Page A','not-a-facebook-token'),($3,$4,'Activation check Page B','not-a-facebook-token')`, [pageA, `test-${pageA}`, pageB, `test-${pageB}`]);
    await db.query(`INSERT INTO public.user_pages(user_id,page_id) VALUES($1,$2),($1,$3)`, [parent, pageA, pageB]);
    await db.query(`INSERT INTO public.tokko_page_managers(user_id,page_id,facebook_subject,authority_source) VALUES($1,$2,$4,'original'),($1,$3,$4,'original')`, [parent, pageA, pageB, subject]);
    await db.query('SET LOCAL ROLE service_role');
    assert.equal(await scalar('SELECT public.tokko_accounts_ready() value'), true); checks++;
    assert.equal(await scalar('SELECT public.tokko_is_parent_user($1,$2) value', [parent, subject]), true); checks++;
    const resolved = await db.query('SELECT * FROM public.tokko_resolve_facebook_user($1,$2,$3,NULL,$4)', [subject, `activation-${parent}@example.test`, 'Activation check parent', parent]);
    assert.equal(resolved.rows[0].user_id, parent); checks++;

    async function save({ email, pages, method = 'password', actor = parent, days = null, remove = null, request = randomUUID() }) {
        return scalar(`SELECT public.tokko_save_subaccount(p_actor=>$1,p_pages=>$2,p_email=>$3,p_name=>'Activation check member',
            p_request=>$4,p_fingerprint=>$5,p_setup_method=>$6,p_hash=>$7,p_encrypted=>'',p_password=>$8,
            p_expiry_set=>FALSE,p_expires_at=>NULL,p_lifetime_days=>$9,p_delete_after_expiry=>$10) value`,
        [actor, pages, email, request, `check-${request}`, method, randomUUID(), method === 'password' ? passwordHash : null, days, remove]);
    }
    const request = randomUUID();
    const first = await save({ email: firstEmail, pages: [pageA], request });
    assert.equal(first.passwordCreated, true); checks++;
    assert.deepEqual(await save({ email: firstEmail, pages: [pageA], request }), first); checks++;
    const second = await save({ email: secondEmail, pages: [pageA, pageB], days: 7, remove: true });
    assert.equal(second.passwordCreated, true); checks++;
    assert.notEqual(first.userId, second.userId); checks++;
    const assigned = await save({ email: firstEmail, pages: [pageB], method: 'existing' });
    assert.equal(assigned.userId, first.userId); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE user_id=$1', [first.userId]), 2); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE user_id IN($1,$2) AND page_id=$3', [first.userId, second.userId, pageA]), 2); checks++;
    const login = (await db.query('SELECT * FROM public.tokko_email_login_record($1)', [firstEmail])).rows[0];
    assert.equal(login?.id, first.userId); checks++;
    assert.ok(login.password_hash === passwordHash, 'Password provisioning must preserve the chosen credentials'); checks++;
    assert.equal(login.is_active && login.email_login_enabled && Boolean(login.email_verified_at), true); checks++;
    assert.equal(await scalar('SELECT expires_at IS NULL AND NOT delete_after_expiry value FROM public.users WHERE id=$1', [first.userId]), true); checks++;
    assert.equal(await scalar("SELECT expires_at>now()+interval '6 days' AND delete_after_expiry value FROM public.users WHERE id=$1", [second.userId]), true); checks++;
    assert.equal(await scalar('SELECT public.tokko_is_parent_user($1,$2) value', [first.userId, subject]), false); checks++;
    await denied(`SELECT public.tokko_save_subaccount($1,ARRAY[$2]::uuid[],$3,'Denied',$4,'denied','existing',$5,'',NULL,FALSE,NULL,NULL,NULL)`, [first.userId, pageA, secondEmail, randomUUID(), randomUUID()]);
    assert.equal(await scalar('SELECT public.tokko_set_subaccount_lifetime($1,$2,$3,TRUE,NULL,NULL,FALSE) value', [parent, [pageA], second.userId]), true); checks++;
    assert.equal(await scalar('SELECT expires_at IS NULL AND NOT delete_after_expiry value FROM public.users WHERE id=$1', [second.userId]), true); checks++;
    assert.equal(await scalar('SELECT public.tokko_revoke_member($1,$2,$3) value', [parent, pageA, first.userId]), true); checks++;
    assert.deepEqual((await db.query('SELECT page_id FROM public.user_pages WHERE user_id=$1', [first.userId])).rows.map(row => row.page_id), [pageB]); checks++;
    await db.query('RESET ROLE');
    for (const role of ['anon', 'authenticated']) {
        await db.query(`SET LOCAL ROLE ${role}`);
        await denied('SELECT id FROM public.users LIMIT 1');
        await denied('SELECT id FROM public.pages LIMIT 1');
        await denied('SELECT public.tokko_accounts_ready()');
        await db.query('RESET ROLE');
    }
    await db.query('ROLLBACK TO SAVEPOINT account_smoke_test');
    assert.equal(await scalar('SELECT count(*)::int value FROM public.users WHERE id=$1 OR email=ANY($2)', [parent, [firstEmail, secondEmail]]), 0); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM public.pages WHERE id=ANY($1)', [[pageA, pageB]]), 0); checks++;
}

try {
    // Prove these API credentials can reach this database before changing grants.
    const preflight = await api.rpc('tokko_accounts_ready');
    if (preflight.error) throw new Error(`Account preflight failed: ${preflight.error.code}`);
    await db.connect(); await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s'");
    assert.equal(await scalar("SELECT rolbypassrls value FROM pg_roles WHERE rolname='service_role'"), true);
    const usersBefore = (await db.query('SELECT id FROM public.users')).rows;
    const grantsBefore = (await db.query('SELECT user_id,page_id FROM public.user_pages')).rows;
    const tables = (await db.query(`SELECT c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text privileges FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN('r','p','v','m') ORDER BY c.relname`)).rows;
    const functions = (await db.query(`SELECT p.oid::regprocedure::text signature,p.proacl::text privileges FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef ORDER BY 1`)).rows;
    const config = (await db.query('SELECT * FROM public.tokko_account_config')).rows;
    mkdirSync('.vercel/backups', { recursive: true });
    const backup = `.vercel/backups/team-account-activation-${Date.now()}.json`;
    writeFileSync(backup, JSON.stringify({ createdAt: new Date().toISOString(), tables, functions, config, userCount: usersBefore.length, assignmentCount: grantsBefore.length }, null, 2));
    await db.query(readFileSync(new URL('../database/migration_page_member_isolation.sql', import.meta.url), 'utf8'));
    assert.equal(await scalar('SELECT public.tokko_accounts_ready() value'), true);
    await smokeTest();
    const usersAfter = new Set((await db.query('SELECT id FROM public.users')).rows.map(row => row.id));
    const grantsAfter = new Set((await db.query('SELECT user_id,page_id FROM public.user_pages')).rows.map(row => `${row.user_id}:${row.page_id}`));
    assert.ok(usersBefore.every(row => usersAfter.has(row.id)), 'Existing account removed');
    assert.ok(grantsBefore.every(row => grantsAfter.has(`${row.user_id}:${row.page_id}`)), 'Existing assignment removed');
    assert.equal(await scalar("SELECT count(*)::int value FROM cron.job WHERE jobname='tokko-expired-subaccounts' AND active"), 1);
    await db.query('COMMIT'); committed = true;
    const result = await api.rpc('tokko_accounts_ready');
    assert.equal(result.error, null, 'PostgREST readiness failed after commit');
    assert.equal(result.data, true, 'The API must observe readiness after commit');
    console.log(JSON.stringify({ ready: true, smokeChecks: checks, usersPreserved: usersBefore.length, assignmentsPreserved: grantsBefore.length, testFixturesRolledBack: true, permissionBackup: backup }));
} catch (error) {
    console.error(JSON.stringify({ activationCommitted: committed, error: error.code || error.message }));
    process.exitCode = 1;
} finally { if (!committed) await db.query('ROLLBACK').catch(() => {}); await db.end(); }
