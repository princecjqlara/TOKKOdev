// Exercises the actual SQL migrations/functions in a fresh, isolated schema.
// Every DDL and fixture write is in one transaction and rolled back, including
// on failure. Existing production tables, grants, and user rows are untouched.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const schema = `tokko_test_${randomUUID().replaceAll('-', '')}`;
const connectionString = process.env.TOKKO_TEST_DATABASE_URL || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw Error('Set TOKKO_TEST_DATABASE_URL or DATABASE_POOLER_URL_5432.');
const db = new Client({ connectionString, ssl: process.env.TOKKO_TEST_NO_SSL === '1' ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 10000 });
let checks = 0;
function migration(path) {
    return fs.readFileSync(path, 'utf8')
        .replace(/INSERT INTO app_private\.schema_migrations[^;]+;/g, '')
        .replace(/NOTIFY pgrst[^;]+;/g, '')
        .replaceAll('public.', `${schema}.`).replaceAll("nspname='public'", `nspname='${schema}'`)
        .replaceAll("schemaname='public'", `schemaname='${schema}'`).replaceAll('search_path=public', `search_path=${schema}`);
}
async function denied(query, args = [], code = '42501') {
    await db.query('SAVEPOINT expected_denial');
    let failure;
    try { await db.query(query, args); } catch (error) { failure = error; }
    await db.query('ROLLBACK TO SAVEPOINT expected_denial');
    assert.equal(failure?.code, code, 'Operation must be rejected'); checks++;
}
async function scalar(query, args = []) { return (await db.query(query, args)).rows[0].value; }
async function provision(actor, pageIds, email, requestId = randomUUID(), hash = randomUUID()) {
    const args = [actor, pageIds, email, 'Invited Member', requestId, email + pageIds.join(','), hash, 'encrypted-test-token'];
    return { result: await scalar(`SELECT ${schema}.tokko_provision_member($1,$2,$3,$4,$5,$6,$7,$8) value`, args), args, hash };
}

try {
    await db.connect(); await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='15s'; SET LOCAL lock_timeout='3s'");
    await db.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema};
        CREATE TABLE users(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),email TEXT,name TEXT,image TEXT,facebook_id TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now());
        CREATE TABLE pages(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),fb_page_id TEXT,name TEXT,access_token TEXT);
        CREATE TABLE user_pages(user_id UUID REFERENCES users(id),page_id UUID REFERENCES pages(id),UNIQUE(user_id,page_id));
        CREATE TABLE contacts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id));
        CREATE TABLE tags(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id));
        CREATE TABLE contact_tags(contact_id UUID REFERENCES contacts(id),tag_id UUID REFERENCES tags(id));`);
    await db.query(migration('database/migration_page_member_accounts.sql'));
    assert.equal(await scalar(`SELECT ${schema}.tokko_accounts_ready() value`), false); checks++;
    const manager = randomUUID(), member = randomUUID(), pageA = randomUUID(), pageB = randomUUID(), foreign = randomUUID();
    await db.query(`INSERT INTO users(id,email,name,facebook_id,is_active) VALUES($1,'manager@example.test','Manager','fb-manager',TRUE),($2,'member@example.test','Member',NULL,TRUE);
    `, [manager, member]);
    await db.query('INSERT INTO pages(id,name) VALUES($1,\'Manawari\'),($2,\'Loki\'),($3,\'Foreign\')', [pageA,pageB,foreign]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$2,'facebook'),($1,$3,'facebook'),($4,$2,'delegated')", [manager,pageA,pageB,member]);
    await db.query("INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook','fb-manager',$1)", [manager]);
    await db.query("INSERT INTO tokko_page_managers(user_id,page_id,facebook_subject) VALUES($1,$2,'fb-manager'),($1,$3,'fb-manager')", [manager,pageA,pageB]);
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'disabled@example.test','Member',$3,'request','hash','encrypted')`, [manager,[pageA],randomUUID()], '55000');
    await db.query(migration('database/migration_page_member_isolation.sql'));
    assert.equal(await scalar(`SELECT ${schema}.tokko_accounts_ready() value`), true); checks++;
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'denied@example.test','Member',$3,'request','hash','encrypted')`, [member,[pageA],randomUUID()]);
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'mixed@example.test','Member',$3,'request','hash','encrypted')`, [manager,[pageA,foreign],randomUUID()]);
    assert.equal(await scalar("SELECT count(*)::int value FROM users WHERE email='mixed@example.test'"), 0); checks++;

    const setup = await provision(manager,[pageA,pageB],'new@example.test');
    assert.equal(setup.result.pending,true); assert.ok(setup.result.userId); checks++;
    const repeated = await scalar(`SELECT ${schema}.tokko_provision_member($1,$2,$3,$4,$5,$6,$7,$8) value`, setup.args);
    assert.deepEqual(repeated, setup.result); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[setup.result.userId]),2); checks++;
    assert.equal(await scalar('SELECT is_active value FROM users WHERE id=$1',[setup.result.userId]),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_revoke_member($1,$2,$3) value`,[manager,pageA,setup.result.userId]),true); checks++;
    const remaining = await db.query('SELECT page_id FROM user_pages WHERE user_id=$1',[setup.result.userId]);
    assert.deepEqual(remaining.rows.map(r=>r.page_id),[pageB]); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,$2) value`,[setup.hash,'scrypt-v1$test-password-hash']),true); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,$2) value`,[setup.hash,'scrypt-v1$overwrite']),false); checks++;
    const active = (await db.query('SELECT is_active,email_login_enabled,session_version FROM users WHERE id=$1',[setup.result.userId])).rows[0];
    assert.deepEqual(active,{is_active:true,email_login_enabled:true,session_version:1}); checks++;
    const assignedAgain = await provision(manager,[pageA],'new@example.test');
    assert.equal(assignedAgain.result.pending,false); assert.equal(assignedAgain.result.deliveryId,null); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[setup.result.userId]),'scrypt-v1$test-password-hash'); checks++;
    const expired = await provision(manager,[pageA],'expired@example.test');
    await db.query("UPDATE tokko_account_tokens SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[expired.hash]);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,$2) value`,[expired.hash,'scrypt-v1$password']),false); checks++;
    const revoked = await provision(manager,[pageA],'revoked@example.test');
    await db.query(`SELECT ${schema}.tokko_revoke_member($1,$2,$3)`,[manager,pageA,revoked.result.userId]);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,$2) value`,[revoked.hash,'scrypt-v1$password']),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_revoke_member($1,$2,$1) value`,[manager,pageA]),false); checks++;
    await db.query("UPDATE tokko_page_managers SET verified_at=now()-interval '5 minutes' WHERE user_id=$1",[manager]);
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'stale@example.test','Member',$3,'request','hash','encrypted')`,[manager,[pageA],randomUUID()]);
    await db.query('UPDATE tokko_page_managers SET verified_at=now() WHERE user_id=$1',[manager]);

    // An existing identity can receive a Page grant; it never receives new credentials.
    const existing = await provision(manager,[pageA],'manager@example.test');
    assert.equal(existing.result.userId,manager); assert.equal(existing.result.deliveryId,null); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_queue_password_reset('not-found@example.test','reset','encrypted') value`),null); checks++;
    await denied(`SELECT ${schema}.tokko_resolve_facebook_user('different-facebook','new@example.test','Intruder',NULL,NULL)`,[],'28000');
    const fresh = (await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('new-facebook','freshfb@example.test','Fresh',NULL,NULL)`)).rows[0];
    assert.ok(fresh.user_id); checks++;
    const identityAgain = (await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('new-facebook','changed@example.test','Fresh',NULL,NULL)`)).rows[0];
    assert.equal(identityAgain.user_id,fresh.user_id); checks++;

    const legacy = randomUUID();
    await db.query("INSERT INTO users(id,email,name,is_active) VALUES($1,'legacy@example.test','Legacy',TRUE)",[legacy]);
    await denied(`SELECT ${schema}.tokko_resolve_facebook_user('legacy-facebook','legacy@example.test','Legacy',NULL,NULL)`,[],'28000');
    await db.query(`SELECT ${schema}.tokko_queue_facebook_link('legacy@example.test','legacy-facebook','link-hash','encrypted')`);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password('link-hash','scrypt-v1$wrong-purpose') value`),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_confirm_facebook_link('link-hash','different-subject') value`),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_confirm_facebook_link('link-hash','legacy-facebook') value`),true); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_confirm_facebook_link('link-hash','legacy-facebook') value`),false); checks++;
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('legacy-facebook','legacy@example.test','Legacy',NULL,NULL)`)).rows[0].user_id,legacy); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[legacy]),null); checks++;

    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO anon,authenticated`);
    await db.query('SET LOCAL ROLE anon');
    await denied(`SELECT * FROM ${schema}.users`);
    await denied(`SELECT * FROM ${schema}.pages`);
    await denied(`SELECT ${schema}.tokko_email_login_record('new@example.test')`);
    await db.query('RESET ROLE');
    await db.query('SET LOCAL ROLE authenticated');
    await denied(`INSERT INTO ${schema}.user_pages(user_id,page_id) VALUES('${member}','${foreign}')`);
    await db.query('RESET ROLE');
    console.log(`PASS: ${checks} SQL checks for isolation, manager authority, activation, revocation, retries, and identity collisions.`);
} catch(error) {
    console.error('SQL account checks failed:', error.message, error.where || ''); process.exitCode=1;
} finally {
    await db.query('ROLLBACK').catch(()=>{}); await db.end();
    console.log('All SQL fixtures and migrations rolled back.');
}
