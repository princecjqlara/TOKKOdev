// Verify/install the connected-Page assignment migration against the configured
// database. Account fixtures run through the installed RPCs and are rolled back.
// No Facebook requests or account emails are sent.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Client } from 'pg';

const args = process.argv.slice(2);
assert.ok(args.length === 1 && ['--preflight', '--apply'].includes(args[0]), 'Choose --preflight or --apply');
const apply = args[0] === '--apply';
const connectionString = process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
assert.ok(connectionString, 'Load the existing database environment first');
const db = new Client({ connectionString, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 15000 });
const signature = 'public.tokko_assert_manager(uuid,uuid[])';
const report = { checkedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preflight',
    checks: 0, committed: false, fixturesRolledBack: false, emailsSent: 0, facebookRequestsSent: 0 };
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
const scalar = async (sql, values = []) => (await db.query(sql, values)).rows[0].value;
const definition = () => scalar('SELECT pg_get_functiondef($1::regprocedure) value', [signature]);
const inventory = async () => (await db.query(`SELECT
    (SELECT count(*)::int FROM public.users) users,
    (SELECT count(*)::int FROM public.pages) pages,
    (SELECT count(*)::int FROM public.user_pages) memberships,
    (SELECT count(*)::int FROM public.tokko_account_requests) requests,
    (SELECT count(*)::int FROM public.tokko_account_mail) mail`)).rows[0];

async function denied(sql, values = [], code = '42501') {
    await db.query('SAVEPOINT expected_denial');
    let actual;
    try { await db.query(sql, values); } catch (error) { actual = error.code; }
    await db.query('ROLLBACK TO SAVEPOINT expected_denial');
    await db.query('RELEASE SAVEPOINT expected_denial');
    check(actual, code, 'Unauthorized or conflicting account changes must be denied');
}

const parent = randomUUID(), pageA = randomUUID(), pageB = randomUUID(), foreign = randomUUID();
const subject = `assignment-check-${randomUUID()}`;
const email = `assignment-check-${randomUUID()}@example.test`;
const salt = randomBytes(24).toString('hex');
const password = randomBytes(32).toString('base64url');
const passwordHash = `scrypt-v1$${salt}$${scryptSync(password, salt, 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString('hex')}`;
async function seed() {
    await db.query(`INSERT INTO public.users(id,email,name,facebook_id,account_kind,is_active)
        VALUES($1,$2,'Assignment check parent',$3,'facebook',TRUE)`, [parent, `parent-${parent}@example.test`, subject]);
    await db.query(`INSERT INTO public.tokko_auth_identities(provider,subject,user_id) VALUES('facebook',$1,$2)`, [subject, parent]);
    for (const page of [pageA, pageB, foreign]) await db.query(`INSERT INTO public.pages(id,fb_page_id,name,access_token)
        VALUES($1,$2,'Assignment check Page','not-a-facebook-token')`, [page, `fixture-${page}`]);
    await db.query(`INSERT INTO public.user_pages(user_id,page_id,grant_source)
        VALUES($1,$2,'facebook_messaging'),($1,$3,'facebook')`, [parent, pageA, pageB]);
    await db.query(`INSERT INTO public.tokko_page_managers(user_id,page_id,facebook_subject,authority_source)
        VALUES($1,$2,$4,'original'),($1,$3,$4,'original')`, [parent, pageA, pageB, subject]);
}
function saveArgs({ actor = parent, pages = [pageA], memberEmail = email, request = randomUUID(),
    method = 'password', days = null, remove = null } = {}) {
    return [actor, pages, memberEmail, request, `check-${request}`, method,
        randomBytes(32).toString('hex'), method === 'password' ? passwordHash : null, days, remove];
}
const saveSql = `SELECT public.tokko_save_subaccount(p_actor=>$1,p_pages=>$2,p_email=>$3,p_name=>'Assignment check member',
    p_request=>$4,p_fingerprint=>$5,p_setup_method=>$6,p_hash=>$7,p_encrypted=>'',p_password=>$8,
    p_expiry_set=>FALSE,p_expires_at=>NULL,p_lifetime_days=>$9,p_delete_after_expiry=>$10) value`;

try {
    await db.connect(); await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query("SET LOCAL statement_timeout='12s'; SET LOCAL lock_timeout='3s'");
    check(await scalar("SELECT pg_try_advisory_xact_lock(hashtextextended('tokko-team-page-assignment-install',0)) value"),
        true, 'Only one installation can proceed');
    check(await scalar('SELECT public.tokko_accounts_ready() value'), true, 'Account isolation must already be enabled');
    const before = await inventory(), beforeDefinition = await definition();
    if (apply) {
        await mkdir('.vercel/backups', { recursive: true });
        report.backup = `.vercel/backups/team-page-assignment-${Date.now()}.json`;
        const permissions = (await db.query(`SELECT proacl::text FROM pg_proc WHERE oid=$1::regprocedure`, [signature])).rows[0];
        await writeFile(report.backup, JSON.stringify({ definition: beforeDefinition, permissions, inventory: before }, null, 2), { flag: 'wx' });
    }

    // Reproduce the installed behavior before applying the proposed migration.
    await db.query('SAVEPOINT baseline_fixture'); await seed();
    try {
        const result = await scalar(saveSql, saveArgs());
        report.beforeMigration = { messagingPageCreation: result.passwordCreated === true };
    } catch (error) {
        if (error.code !== '42501') throw error;
        report.beforeMigration = { messagingPageCreation: false, errorCode: error.code };
    }
    await db.query('ROLLBACK TO SAVEPOINT baseline_fixture');
    await db.query('RELEASE SAVEPOINT baseline_fixture');

    const migration = await readFile('database/migration_parent_connected_page_assignment.sql', 'utf8');
    await db.query(migration);
    const installedDefinition = await definition();
    await db.query(migration);
    check(await definition(), installedDefinition, 'Reapplying the migration is idempotent');
    for (const role of ['anon', 'authenticated', 'service_role']) check(
        await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value", [role, signature]),
        role === 'service_role', 'Only server roles can verify assignment authority');

    await db.query('SAVEPOINT fixtures'); await seed(); await db.query('SET LOCAL ROLE service_role');
    check(await scalar('SELECT public.tokko_is_parent_user($1,$2) value', [parent, subject]), true, 'Original parent identity remains valid');
    const firstArgs = saveArgs(), first = await scalar(saveSql, firstArgs);
    check(first.passwordCreated, true, 'Create a password account on a messaging-connected Page');
    check(await scalar('SELECT expires_at IS NULL AND NOT delete_after_expiry value FROM public.users WHERE id=$1', [first.userId]),
        true, 'An account created without expiry is permanent and has no deletion schedule');
    check(await scalar(saveSql, firstArgs), first, 'Retry returns the same account');
    const secondEmail = `assignment-check-${randomUUID()}@example.test`;
    const second = await scalar(saveSql, saveArgs({ memberEmail: secondEmail, pages: [pageA, pageB], days: 7, remove: true }));
    check(second.passwordCreated, true, 'Create a temporary multi-Page account');
    check(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE page_id=$1 AND user_id=ANY($2)',
        [pageA, [first.userId, second.userId]]), 2, 'Two subaccounts can share a Page');
    check(await scalar(`SELECT expires_at>now()+interval '6 days' AND delete_after_expiry value FROM public.users WHERE id=$1`,
        [second.userId]), true, 'Temporary account lifetime and deletion schedule are saved');
    check((await scalar(saveSql, saveArgs({ method: 'existing', pages: [pageB] }))).userId,
        first.userId, 'Existing-account assignment preserves identity');
    check(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE user_id=$1', [first.userId]), 2, 'Existing account retains both assignments');
    const login = (await db.query('SELECT * FROM public.tokko_email_login_record($1)', [email])).rows[0];
    check(Boolean(login?.is_active && login.email_login_enabled && login.email_verified_at && login.password_hash === passwordHash),
        true, 'The account can use its chosen email and password');
    check(await scalar(`SELECT profile_required AND profile_completed_at IS NULL value FROM public.users WHERE id=$1`, [first.userId]),
        true, 'New subaccounts still complete their first-login profile');

    await denied(saveSql, saveArgs()); // An active account's password cannot be overwritten.
    await denied(saveSql, saveArgs({ actor: first.userId, memberEmail: secondEmail, method: 'existing' }));
    await denied(saveSql, saveArgs({ pages: [pageA, foreign], memberEmail: `denied-${randomUUID()}@example.test` }));
    await denied('SELECT public.tokko_assert_manager($1,$2)', [parent, []], 'P0001');
    await db.query("UPDATE public.tokko_page_managers SET verified_at=now()-interval '2 minutes' WHERE user_id=$1", [parent]);
    await denied('SELECT public.tokko_assert_manager($1,$2)', [parent, [pageA]]);
    await db.query('UPDATE public.tokko_page_managers SET verified_at=now() WHERE user_id=$1', [parent]);
    await db.query('DELETE FROM public.tokko_auth_identities WHERE user_id=$1', [parent]);
    await denied('SELECT public.tokko_assert_manager($1,$2)', [parent, [pageA]]);
    await db.query("INSERT INTO public.tokko_auth_identities(provider,subject,user_id) VALUES('facebook',$1,$2)", [subject, parent]);
    check(await scalar('SELECT public.tokko_revoke_member($1,$2,$3) value', [parent, pageA, first.userId]), true, 'Revoke one delegated Page');
    check(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE user_id=$1', [first.userId]), 1, 'Other assignments survive revocation');
    check(await scalar('SELECT count(*)::int value FROM public.user_pages WHERE user_id=$1', [second.userId]), 2, 'Other subaccounts retain their access');
    await db.query('ROLLBACK TO SAVEPOINT fixtures'); await db.query('RELEASE SAVEPOINT fixtures');
    report.fixturesRolledBack = true;
    check(await inventory(), before, 'All fixture accounts, Pages, grants, requests, and mail are removed');
    check(await scalar('SELECT public.tokko_accounts_ready() value'), true, 'Account isolation stays enabled');
    report.inventory = before;
    await db.query(apply ? 'COMMIT' : 'ROLLBACK'); report.committed = apply; report.passed = true;
} catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    report.passed = false; report.error = { code: error.code || error.name, message: error.message }; process.exitCode = 1;
} finally {
    await db.end(); await mkdir('outputs', { recursive: true });
    await writeFile(`outputs/team-page-assignment-${report.mode}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
