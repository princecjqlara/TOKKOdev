// Executes the real migration against an isolated in-memory PostgreSQL engine.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
let checks = 0;
function check(actual, expected) { assert.deepEqual(actual, expected); checks++; }
async function scalar(sql, args = []) { return (await db.query(sql, args)).rows[0].value; }
async function overview(args = ['', 'all', 'all', 'all', 1, 25, null]) {
    return scalar('SELECT tokko_admin_accounts($1,$2,$3,$4,$5,$6,$7) value', args);
}
const parent = randomUUID(), secondParent = randomUUID(), permanent = randomUUID(), temporary = randomUUID(), expired = randomUUID(), pending = randomUUID(), disabled = randomUUID(), linked = randomUUID();
const pageA = randomUUID(), pageB = randomUUID(), token = randomUUID();
const hash = `scrypt-v1$${'a'.repeat(48)}$${'b'.repeat(128)}`;

try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY,description TEXT);
        CREATE TABLE users(id UUID PRIMARY KEY,email TEXT,name TEXT,facebook_id TEXT,phone_number TEXT,
            created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),
            is_active BOOLEAN DEFAULT TRUE,account_kind TEXT DEFAULT 'email',created_by UUID REFERENCES users(id) ON DELETE SET NULL,
            expires_at TIMESTAMPTZ,delete_after_expiry BOOLEAN DEFAULT FALSE,password_hash TEXT,password_changed_at TIMESTAMPTZ,
            email_login_enabled BOOLEAN DEFAULT TRUE,email_verified_at TIMESTAMPTZ DEFAULT now(),session_version INTEGER DEFAULT 0);
        CREATE TABLE pages(id UUID PRIMARY KEY,name TEXT,fb_page_id TEXT,access_token TEXT);
        CREATE TABLE user_pages(user_id UUID REFERENCES users(id) ON DELETE CASCADE,page_id UUID REFERENCES pages(id),
            created_at TIMESTAMPTZ DEFAULT now(),grant_source TEXT,granted_by UUID REFERENCES users(id) ON DELETE SET NULL);
        CREATE TABLE tokko_auth_identities(user_id UUID REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE tokko_account_tokens(id UUID PRIMARY KEY,user_id UUID REFERENCES users(id) ON DELETE CASCADE,consumed_at TIMESTAMPTZ);
        CREATE TABLE tokko_account_mail(token_id UUID REFERENCES tokko_account_tokens(id) ON DELETE CASCADE,status TEXT,encrypted_token TEXT,lease_until TIMESTAMPTZ,claim_token UUID);
        CREATE TABLE tokko_access_audit(user_id UUID REFERENCES users(id) ON DELETE SET NULL,action TEXT);
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;`);
    const migration = await readFile('database/migration_system_admin.sql', 'utf8');
    await db.exec(migration);
    const initial = await overview();
    check(initial.accounts, []); check(initial.total, 0); check(initial.summary.accounts, 0);
    await db.query(`INSERT INTO users(id,email,name,account_kind,facebook_id) VALUES
        ($1,'owner@example.test','Owner','facebook','owner-subject'),($2,'other@example.test','Other owner','facebook','other-subject')`, [parent, secondParent]);
    for (const [id, name] of [[permanent, 'Permanent'], [temporary, 'Temporary'], [expired, 'Expired'], [pending, 'Pending'], [disabled, 'Disabled'], [linked, 'Linked']]) {
        await db.query(`INSERT INTO users(id,email,name,created_by,password_hash,phone_number) VALUES($1,$2,$3,$4,$5,'+639123456789')`, [id, `${name.toLowerCase()}@example.test`, name, parent, hash]);
    }
    await db.query("UPDATE users SET created_at=now(),expires_at=now()+interval '7 days',delete_after_expiry=TRUE WHERE id=$1", [temporary]);
    await db.query("UPDATE users SET expires_at=now()-interval '1 day' WHERE id=$1", [expired]);
    await db.query("UPDATE users SET is_active=FALSE,account_kind='invited',email_verified_at=NULL,email_login_enabled=FALSE WHERE id=$1", [pending]);
    await db.query('UPDATE users SET is_active=FALSE WHERE id=$1', [disabled]);
    await db.query('INSERT INTO tokko_auth_identities(user_id) VALUES($1)', [linked]);
    await db.query("INSERT INTO users(id,account_kind,is_active,email_login_enabled) VALUES($1,'system',FALSE,FALSE)", [randomUUID()]);
    await db.query("INSERT INTO pages VALUES($1,'Shared Page','fb-a','secret-page-token'),($2,'Other Page','fb-b','other-secret-token')", [pageA, pageB]);
    await db.query(`INSERT INTO user_pages(user_id,page_id,grant_source,granted_by) VALUES
        ($1,$2,'delegated',$3),($1,$4,'delegated',$3),($3,$2,'facebook',NULL),($5,$2,'facebook',NULL)`, [temporary, pageA, parent, pageB, secondParent]);

    const all = await overview();
    check(all.total, 8); check(all.summary, { accounts: 8, parents: 2, subaccounts: 6, permanent: 6, temporary: 2, expired: 1 });
    const temp = all.accounts.find(row => row.id === temporary);
    check(temp.daysRemaining, 7); check(temp.lifetimeDays, 7); check(temp.deleteAfterExpiry, true);
    check(temp.creator, { id: parent, name: 'Owner', email: 'owner@example.test' });
    check(temp.pages.length, 2); check(temp.pages[0].assignedBy.email, 'owner@example.test');
    check(temp.hasPassword, true); check(temp.canResetPassword, true);
    check(all.accounts.find(row => row.id === permanent).daysRemaining, null);
    check(all.accounts.find(row => row.id === expired).daysRemaining, 0);
    check(all.accounts.find(row => row.id === parent).subaccountCount, 6);
    check(all.accounts.find(row => row.id === pending).status, 'pending');
    check(all.accounts.find(row => row.id === disabled).status, 'disabled');
    check(all.accounts.find(row => row.id === linked).canResetPassword, false);
    check(/secret-page-token|scrypt-v1|password_hash|encrypted_token/.test(JSON.stringify(all)), false);
    check((await overview(['', 'all', 'all', 'all', 1, 25, parent])).total, 6);
    check((await overview(['', 'parent', 'all', 'all', 1, 25, null])).total, 2);
    check((await overview(['', 'all', 'temporary', 'expired', 1, 25, null])).total, 1);
    check((await overview(['Shared Page', 'all', 'all', 'all', 1, 25, null])).total, 3);
    check((await overview(['owner@example.test', 'subaccount', 'all', 'all', 1, 25, null])).total, 6);
    check((await overview(['%', 'all', 'all', 'all', 1, 25, null])).total, 0);
    const paginated = await overview(['', 'all', 'all', 'all', 1, 3, null]);
    const pageTwo = await overview(['', 'all', 'all', 'all', 2, 3, null]);
    check(paginated.accounts.length, 3); check(paginated.total, 8);
    check(pageTwo.accounts.some(row => paginated.accounts.some(first => first.id === row.id)), false);

    for (const role of ['anon', 'authenticated']) {
        for (const fn of ['tokko_admin_accounts(text,text,text,text,integer,integer,uuid)', 'tokko_admin_reset_subaccount_password(uuid,text,text)']) {
            check(await scalar('SELECT has_function_privilege($1,$2,\'EXECUTE\') value', [role, fn]), false);
        }
    }
    check(await scalar("SELECT has_function_privilege('service_role','tokko_admin_accounts(text,text,text,text,integer,integer,uuid)','EXECUTE') value"), true);
    await db.query('INSERT INTO tokko_account_tokens(id,user_id) VALUES($1,$2)', [token, temporary]);
    await db.query("INSERT INTO tokko_account_mail VALUES($1,'sending','encrypted-secret',now(),$2)", [token, randomUUID()]);
    const before = (await db.query('SELECT expires_at,is_active,delete_after_expiry FROM users WHERE id=$1', [temporary])).rows[0];
    check(await scalar('SELECT tokko_admin_reset_subaccount_password($1,$2,$3) value', [temporary, hash, 'admin@example.test']), true);
    check(await scalar('SELECT session_version value FROM users WHERE id=$1', [temporary]), 1);
    check(await scalar('SELECT password_changed_at IS NOT NULL value FROM users WHERE id=$1', [temporary]), true);
    check((await db.query('SELECT expires_at,is_active,delete_after_expiry FROM users WHERE id=$1', [temporary])).rows[0], before);
    check(await scalar('SELECT consumed_at IS NOT NULL value FROM tokko_account_tokens WHERE id=$1', [token]), true);
    check((await db.query('SELECT status,encrypted_token,lease_until,claim_token FROM tokko_account_mail')).rows[0], { status: 'cancelled', encrypted_token: '', lease_until: null, claim_token: null });
    check(await scalar('SELECT action value FROM tokko_access_audit WHERE user_id=$1', [temporary]), 'system_admin_password_reset:admin@example.test');
    for (const id of [parent, secondParent, pending, linked, randomUUID()]) {
        check(await scalar('SELECT tokko_admin_reset_subaccount_password($1,$2,$3) value', [id, hash, 'admin@example.test']), false);
    }
    check(await scalar('SELECT count(*)::integer value FROM tokko_access_audit'), 1);
    await assert.rejects(db.query('SELECT tokko_admin_reset_subaccount_password($1,$2,$3)', [temporary, 'plaintext-password', 'admin@example.test'])); checks++;
    check(await scalar('SELECT session_version value FROM users WHERE id=$1', [temporary]), 1);
    await assert.rejects(overview(['', 'admin', 'all', 'all', 1, 25, null])); checks++;
    await db.exec(migration);
    check((await overview()).total, 8);
    const loginMigration = await readFile('database/migration_system_admin_login.sql', 'utf8');
    await db.exec(loginMigration);
    check(await scalar('SELECT count(*)::integer value FROM tokko_system_admin_credentials()'), 0);
    for (const role of ['anon', 'authenticated']) {
        check(await scalar("SELECT has_function_privilege($1,'tokko_system_admin_credentials()','EXECUTE') value", [role]), false);
        check(await scalar("SELECT has_table_privilege($1,'app_private.system_admin_config','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') value", [role]), false);
    }
    check(await scalar("SELECT relrowsecurity value FROM pg_class WHERE oid='app_private.system_admin_config'::regclass"), true);
    await db.query('INSERT INTO app_private.system_admin_config(email,password_hash) VALUES($1,$2)', ['admin@example.test', hash]);
    check(await scalar('SELECT count(*)::integer value FROM tokko_system_admin_credentials()'), 0);
    await db.query('UPDATE app_private.system_admin_config SET enabled=TRUE');
    await db.exec('SET ROLE service_role');
    const credentials = (await db.query('SELECT * FROM tokko_system_admin_credentials()')).rows[0];
    check(credentials.email, 'admin@example.test'); check(credentials.password_hash, hash);
    await db.exec('RESET ROLE');
    await db.query('UPDATE app_private.system_admin_config SET enabled=FALSE');
    check(await scalar('SELECT count(*)::integer value FROM tokko_system_admin_credentials()'), 0);
    await db.query('UPDATE app_private.system_admin_config SET enabled=TRUE');
    const revision = await scalar('SELECT revision value FROM app_private.system_admin_config');
    check(revision !== credentials.revision, true);
    for (const role of ['anon', 'authenticated']) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(db.query('SELECT * FROM public.tokko_system_admin_credentials()')); checks++;
        await assert.rejects(db.query('SELECT * FROM app_private.system_admin_config')); checks++;
        await db.exec('RESET ROLE');
    }
    await db.exec(loginMigration);
    check(await scalar('SELECT revision value FROM app_private.system_admin_config'), revision);
    check((await overview()).total, 8);
    check(/admin@example.test|scrypt-v1/.test(JSON.stringify(await overview())), false);
    const managementMigration = await readFile('database/migration_system_admin_management.sql', 'utf8');
    await db.exec(managementMigration);
    const managed = async (overrides = {}) => {
        const params = { search: '', type: 'all', lifetime: 'all', status: 'all', page: 1, page_size: 25, parent: null,
            page_id: null, assignment: 'all', expires_within: null, deletion: 'all', password: 'all', sort: 'newest', ...overrides };
        return scalar('SELECT tokko_admin_accounts_v2($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) value', Object.values(params));
    };
    const managedAll = await managed();
    check(managedAll.total, 8); check(managedAll.filterOptions.pages.length, 2);
    check(managedAll.filterOptions.creators.map(row => row.id), [parent]);
    check(managedAll.accounts.find(row => row.id === parent).canDelete, false);
    check(managedAll.accounts.find(row => row.id === secondParent).canDelete, true);
    check(managedAll.accounts.find(row => row.id === pending).canEnable, false);
    check(managedAll.accounts.find(row => row.id === temporary).canScheduleDeletion, true);
    check(managedAll.accounts.find(row => row.id === linked).canScheduleDeletion, false);
    check((await managed({ page_id: pageA })).total, 3);
    check((await managed({ assignment: 'assigned' })).total, 3);
    check((await managed({ assignment: 'unassigned' })).total, 5);
    check((await managed({ expires_within: 7 })).accounts.map(row => row.id), [temporary]);
    check((await managed({ deletion: 'scheduled' })).accounts.map(row => row.id), [temporary]);
    check((await managed({ password: 'unset' })).total, 2);
    check((await managed({ password: 'set' })).total, 6);
    check((await managed({ parent, page_id: pageA, lifetime: 'temporary', deletion: 'scheduled', password: 'set', expires_within: 30 })).total, 1);
    check((await managed({ sort: 'name' })).accounts[0].name, 'Disabled');
    check((await managed({ sort: 'expiry' })).accounts[0].id, expired);
    const oldestDate = new Date(Date.now() - 100 * 86400_000).toISOString();
    await db.query('UPDATE users SET created_at=$1 WHERE id=$2', [oldestDate, parent]);
    check((await managed({ sort: 'oldest' })).accounts[0].id, parent);
    const sortedOne = await managed({ sort: 'name', page_size: 3 });
    const sortedTwo = await managed({ sort: 'name', page_size: 3, page: 2 });
    check(sortedTwo.accounts.some(row => sortedOne.accounts.some(first => row.id === first.id)), false);
    for (const bad of [{ assignment: 'invalid' }, { expires_within: 0 }, { deletion: null }, { password: 'clear' }, { sort: 'random' }]) {
        await assert.rejects(managed(bad)); checks++;
    }
    const signatures = ['tokko_admin_accounts_v2(text,text,text,text,integer,integer,uuid,uuid,text,integer,text,text,text)',
        'tokko_admin_set_account_active(uuid,boolean,text)', 'tokko_admin_set_account_lifetime(uuid,boolean,timestamptz,integer,boolean,text)', 'tokko_admin_delete_account(uuid,text,text)'];
    for (const role of ['anon', 'authenticated']) for (const signature of signatures) {
        check(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value", [role, signature]), false);
    }
    const active = (id, enabled) => scalar('SELECT tokko_admin_set_account_active($1,$2,$3) value', [id, enabled, 'admin@example.test']);
    const lifetime = (id, expirySet, deadline, days, autoDelete) => scalar('SELECT tokko_admin_set_account_lifetime($1,$2,$3,$4,$5,$6) value', [id, expirySet, deadline, days, autoDelete, 'admin@example.test']);
    const remove = (id, confirmation) => scalar('SELECT tokko_admin_delete_account($1,$2,$3) value', [id, confirmation, 'admin@example.test']);
    check(await active(temporary, false), true);
    check(await scalar('SELECT session_version value FROM users WHERE id=$1', [temporary]), 2);
    check(await scalar('SELECT is_active value FROM users WHERE id=$1', [temporary]), false);
    check(await active(temporary, true), true);
    check(await scalar('SELECT session_version value FROM users WHERE id=$1', [temporary]), 3);
    check(await active(temporary, true), true);
    check(await scalar('SELECT session_version value FROM users WHERE id=$1', [temporary]), 3);
    await assert.rejects(active(pending, true)); checks++;
    check(await lifetime(temporary, false, null, 14, true), true);
    check((await managed({ expires_within: 7 })).total, 0);
    check((await managed({ expires_within: 30 })).accounts[0].id, temporary);
    check(await lifetime(temporary, true, null, null, false), true);
    check(await scalar('SELECT expires_at IS NULL AND NOT delete_after_expiry value FROM users WHERE id=$1', [temporary]), true);
    await assert.rejects(lifetime(parent, false, null, 7, true)); checks++;
    await assert.rejects(lifetime(temporary, false, null, 0, false)); checks++;
    await active(temporary, false);
    check(await lifetime(temporary, false, null, 7, false), true);
    check(await scalar('SELECT is_active value FROM users WHERE id=$1', [temporary]), false);
    const systemId = await scalar("SELECT id value FROM users WHERE account_kind='system' LIMIT 1");
    check(await active(systemId, true), false);
    check(await lifetime(systemId, true, null, null, false), false);
    check(await remove(systemId, systemId), false);
    await assert.rejects(remove(parent, 'owner@example.test')); checks++;
    await assert.rejects(remove(temporary, 'wrong@example.test')); checks++;
    check(await scalar('SELECT count(*)::integer value FROM users WHERE id=$1', [temporary]), 1);
    await db.exec(`CREATE TABLE conversation_export_jobs(id UUID PRIMARY KEY,created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE contact_bot_permission_events(actor_id UUID NOT NULL REFERENCES users(id));
        CREATE TABLE campaigns(created_by UUID REFERENCES users(id));
        CREATE TABLE businesses(created_by UUID REFERENCES users(id));
        CREATE TABLE tags(id UUID PRIMARY KEY,owner_type TEXT,owner_id UUID);
        CREATE TABLE protected_records(user_id UUID REFERENCES users(id));`);
    const tempExport = randomUUID(), parentExport = randomUUID(), personalTag = randomUUID(), sharedTag = randomUUID();
    await db.query('INSERT INTO conversation_export_jobs VALUES($1,$2),($3,$4)', [tempExport, temporary, parentExport, secondParent]);
    await db.query('INSERT INTO contact_bot_permission_events VALUES($1)', [temporary]);
    await db.query('INSERT INTO campaigns VALUES($1)', [temporary]);
    await db.query('INSERT INTO businesses VALUES($1)', [temporary]);
    await db.query("INSERT INTO tags VALUES($1,'user',$2),($3,'page',$4)", [personalTag, temporary, sharedTag, pageA]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source,granted_by) VALUES($1,$2,'delegated',$3)", [permanent, pageA, temporary]);
    const marker = '00000000-0000-4000-8000-000000000001';
    check(await remove(temporary, ' TEMPORARY@example.test '), true);
    check(await scalar('SELECT count(*)::integer value FROM users WHERE id=$1', [temporary]), 0);
    check(await scalar('SELECT count(*)::integer value FROM tokko_account_tokens WHERE user_id=$1', [temporary]), 0);
    check(await scalar('SELECT count(*)::integer value FROM tokko_account_mail'), 0);
    check(await scalar('SELECT created_by value FROM conversation_export_jobs WHERE id=$1', [tempExport]), parent);
    check(await scalar('SELECT actor_id value FROM contact_bot_permission_events'), marker);
    check(await scalar('SELECT created_by value FROM campaigns'), null);
    check(await scalar('SELECT created_by value FROM businesses'), null);
    check(await scalar('SELECT count(*)::integer value FROM pages'), 2);
    check(await scalar('SELECT count(*)::integer value FROM user_pages WHERE user_id=$1', [permanent]), 1);
    check(await scalar('SELECT granted_by value FROM user_pages WHERE user_id=$1', [permanent]), null);
    check(await scalar('SELECT count(*)::integer value FROM tags WHERE id=$1', [personalTag]), 0);
    check(await scalar('SELECT count(*)::integer value FROM tags WHERE id=$1', [sharedTag]), 1);
    check(await scalar("SELECT count(*)::integer value FROM tokko_access_audit WHERE user_id IS NULL AND action=$1", [`system_admin_account_deleted:${temporary}:admin@example.test`]), 1);
    check(await remove(secondParent, 'other@example.test'), true);
    check(await scalar('SELECT created_by value FROM conversation_export_jobs WHERE id=$1', [parentExport]), marker);
    await db.query('INSERT INTO protected_records VALUES($1)', [permanent]);
    await db.query('INSERT INTO businesses VALUES($1)', [permanent]);
    await assert.rejects(remove(permanent, 'permanent@example.test')); checks++;
    check(await scalar('SELECT count(*)::integer value FROM users WHERE id=$1', [permanent]), 1);
    check(await scalar('SELECT count(*)::integer value FROM businesses WHERE created_by=$1', [permanent]), 1);
    check(await scalar("SELECT count(*)::integer value FROM tokko_access_audit WHERE action=$1", [`system_admin_account_deleted:${permanent}:admin@example.test`]), 0);
    check(await scalar('SELECT revision value FROM app_private.system_admin_config'), revision);
    await db.exec(managementMigration);
    check((await managed()).total, 6);
    console.log(JSON.stringify({ checks, productionWrites: 0, result: 'passed' }));
} finally { await db.close(); }
