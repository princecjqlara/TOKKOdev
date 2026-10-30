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
        .replaceAll("schemaname='public'", `schemaname='${schema}'`).replaceAll("table_schema='public'", `table_schema='${schema}'`).replaceAll('search_path=public', `search_path=${schema}`);
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
        CREATE TABLE user_pages(user_id UUID REFERENCES users(id) ON DELETE CASCADE,page_id UUID REFERENCES pages(id),UNIQUE(user_id,page_id));
        CREATE TABLE contacts(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id));
        CREATE TABLE tags(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id),owner_type TEXT DEFAULT 'page',owner_id UUID);
        CREATE TABLE contact_tags(contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,tag_id UUID REFERENCES tags(id) ON DELETE CASCADE);
        CREATE TABLE campaigns(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id),created_by UUID REFERENCES users(id) ON DELETE SET NULL);
        CREATE TABLE conversation_export_jobs(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),page_id UUID REFERENCES pages(id),created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE);
        CREATE TABLE contact_bot_permission_events(id UUID PRIMARY KEY DEFAULT gen_random_uuid(),actor_id UUID NOT NULL REFERENCES users(id));`);
    await db.query(migration('database/migration_page_member_accounts.sql'));
    await db.query(migration('database/migration_team_account_expiry.sql'));
    await db.query(migration('database/migration_facebook_signin_recovery.sql'));
    await db.query(migration('database/migration_account_password_options.sql'));
    assert.equal(await scalar(`SELECT ${schema}.tokko_accounts_ready() value`), false); checks++;
    const manager = randomUUID(), member = randomUUID(), pageA = randomUUID(), pageB = randomUUID(), foreign = randomUUID();
    await db.query(`INSERT INTO users(id,email,name,facebook_id,is_active) VALUES($1,'manager@example.test','Manager','fb-manager',TRUE),($2,'member@example.test','Member',NULL,TRUE);
    `, [manager, member]);
    await db.query('INSERT INTO pages(id,name) VALUES($1,\'Manawari\'),($2,\'Loki\'),($3,\'Foreign\')', [pageA,pageB,foreign]);
    await db.query("UPDATE pages SET fb_page_id=CASE id WHEN $1 THEN 'fb-page-a' ELSE 'fb-page-b' END WHERE id IN ($1,$2)",[pageA,pageB]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$2,'facebook'),($1,$3,'facebook'),($4,$2,'delegated')", [manager,pageA,pageB,member]);
    await db.query("INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook','fb-manager',$1)", [manager]);
    await db.query("INSERT INTO tokko_page_managers(user_id,page_id,facebook_subject) VALUES($1,$2,'fb-manager'),($1,$3,'fb-manager')", [manager,pageA,pageB]);
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'disabled@example.test','Member',$3,'request','hash','encrypted')`, [manager,[pageA],randomUUID()], '55000');
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'disabled-password@example.test','Member',$3,'request','hash','scrypt-v1$disabled',FALSE,NULL)`,[manager,[pageA],randomUUID()],'55000');
    await denied(`SELECT ${schema}.tokko_set_own_password($1,'fb-manager',0,NULL,'scrypt-v1$disabled')`,[manager],'55000');
    // Existing Facebook accounts must work before email provisioning is enabled.
    const recoveredOriginal = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'recovered-original@example.test','Original')",[recoveredOriginal]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$2,'legacy'),($1,$3,'facebook')",[recoveredOriginal,pageA,pageB]);
    const restored = (await db.query(`SELECT * FROM ${schema}.tokko_recover_legacy_facebook_login('fb-recovered',' RECOVERED-ORIGINAL@EXAMPLE.TEST ','Original',NULL,ARRAY['fb-page-a','fb-page-b'])`)).rows[0];
    assert.equal(restored.user_id,recoveredOriginal); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[recoveredOriginal]),2); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[recoveredOriginal]),null); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_accounts_ready() value`),false); checks++;
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('fb-recovered','recovered-original@example.test','Original',NULL,NULL)`)).rows[0].user_id,recoveredOriginal); checks++;
    const noEmailOriginal = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'fb_fb-noemail@facebook.local','No Email Original')",[noEmailOriginal]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('wrong-subject','fb_fb-noemail@facebook.local','Wrong',NULL,'{}')`),0); checks++;
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_recover_legacy_facebook_login('fb-noemail','fb_fb-noemail@facebook.local','Original',NULL,'{}')`)).rows[0].user_id,noEmailOriginal); checks++;
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

    const unsafeLegacy = randomUUID();
    await db.query("INSERT INTO users(id,email) VALUES($1,'partial-proof@example.test')",[unsafeLegacy]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$2,'legacy'),($1,$3,'legacy')",[unsafeLegacy,pageA,pageB]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('partial-subject','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a'])`),0); checks++;
    assert.equal(await scalar('SELECT facebook_id value FROM users WHERE id=$1',[unsafeLegacy]),null); checks++;
    await db.query("UPDATE user_pages SET grant_source='delegated' WHERE user_id=$1 AND page_id=$2",[unsafeLegacy,pageB]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('partial-subject','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;
    await db.query("UPDATE user_pages SET grant_source='legacy' WHERE user_id=$1",[unsafeLegacy]);
    await db.query("UPDATE users SET password_hash='scrypt-v1$existing' WHERE id=$1",[unsafeLegacy]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('partial-subject','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;
    await db.query("UPDATE users SET password_hash=NULL,is_active=FALSE WHERE id=$1",[unsafeLegacy]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('partial-subject','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;
    await db.query("UPDATE users SET is_active=TRUE,expires_at=now()-interval '1 second' WHERE id=$1",[unsafeLegacy]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('partial-subject','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;
    await db.query("UPDATE users SET expires_at=NULL WHERE id=$1",[unsafeLegacy]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('fb-manager','partial-proof@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_recover_legacy_facebook_login('other-subject','manager@example.test','Partial',NULL,ARRAY['fb-page-a','fb-page-b'])`),0); checks++;

    // Original Facebook assignments can administer their own Pages without a
    // new live Meta check. A delegated membership cannot forge that provenance.
    const original = randomUUID(), delegatedFacebook = randomUUID();
    await db.query("INSERT INTO users(id,email,facebook_id,is_active) VALUES($1,'original@example.test','fb-original',TRUE),($2,'delegated-fb@example.test','fb-delegated',TRUE)", [original,delegatedFacebook]);
    await db.query("INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook','fb-original',$1),('facebook','fb-delegated',$2)", [original,delegatedFacebook]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$3,'legacy'),($2,$3,'delegated')", [original,delegatedFacebook,pageA]);
    await db.query("INSERT INTO tokko_page_managers(user_id,page_id,facebook_subject,authority_source) VALUES($1,$3,'fb-original','original'),($2,$3,'fb-delegated','original')", [original,delegatedFacebook,pageA]);
    const originalInvite = await provision(original,[pageA],'original-invite@example.test');
    assert.equal(originalInvite.result.pending,true); checks++;
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'delegated-denied@example.test','Member',$3,'request','hash','encrypted')`, [delegatedFacebook,[pageA],randomUUID()]);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_member_expiry($1,$2,$3,now()+interval '7 days') value`, [manager,[pageA],originalInvite.result.userId]),false); checks++;

    // Expiry is atomic with account creation. Replays preserve later edits;
    // omitted expiry preserves the existing value, while explicit NULL removes it.
    const expiryHash = randomUUID();
    const initialExpiry = await scalar("SELECT now()+interval '7 days' value");
    const expiryArgs = [manager,[pageA],'timed@example.test','Timed Member',randomUUID(),'timed-request',expiryHash,'encrypted',true,initialExpiry];
    const expiring = await scalar(`SELECT ${schema}.tokko_provision_member_with_expiry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,expiryArgs);
    assert.ok(await scalar('SELECT expires_at value FROM users WHERE id=$1',[expiring.userId])); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,'scrypt-v1$timed') value`,[expiryHash]),true); checks++;
    await denied(`SELECT ${schema}.tokko_set_member_expiry($1,$2,$3,now()-interval '1 second')`,[manager,[pageA],expiring.userId],'22023');
    await db.query("UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",[expiring.userId]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_email_login_record('timed@example.test')`),0); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_member_expiry($1,$2,$3,now()+interval '30 days') value`,[manager,[pageA],expiring.userId]),true); checks++;
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_email_login_record('timed@example.test')`),1); checks++;
    const renewedExpiry = await scalar('SELECT expires_at value FROM users WHERE id=$1',[expiring.userId]);
    assert.deepEqual(await scalar(`SELECT ${schema}.tokko_provision_member_with_expiry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,expiryArgs),expiring); checks++;
    assert.deepEqual(await scalar('SELECT expires_at value FROM users WHERE id=$1',[expiring.userId]),renewedExpiry); checks++;
    await scalar(`SELECT ${schema}.tokko_provision_member_with_expiry($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,[manager,[pageA],'timed@example.test','Timed Member',randomUUID(),'preserve-expiry',randomUUID(),'encrypted',false,null]);
    assert.deepEqual(await scalar('SELECT expires_at value FROM users WHERE id=$1',[expiring.userId]),renewedExpiry); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_member_expiry($1,$2,$3,NULL) value`,[manager,[pageA],expiring.userId]),true); checks++;
    assert.equal(await scalar('SELECT expires_at value FROM users WHERE id=$1',[expiring.userId]),null); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_member_expiry($1,$2,$1,now()+interval '7 days') value`,[manager,[pageA]]),false); checks++;
    await denied(`SELECT ${schema}.tokko_provision_member_with_expiry($1,$2,'original-invite@example.test','Member',$3,'unauthorized-expiry','hash','encrypted',TRUE,now()+interval '7 days')`,[manager,[pageB],randomUUID()]);
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1 AND page_id=$2',[originalInvite.result.userId,pageB]),0); checks++;
    await db.query("UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",[original]);
    await denied(`SELECT ${schema}.tokko_provision_member($1,$2,'expired-actor@example.test','Member',$3,'request','hash','encrypted')`,[original,[pageA],randomUUID()]);

    // Password creation is atomic with assignments/expiry, consumes invitations,
    // and never overwrites an active account or someone else's pending account.
    const directHash = randomUUID();
    const directArgs = [manager,[pageA],'direct-password@example.test','Direct Member',randomUUID(),'direct-fingerprint',directHash,'scrypt-v1$initial-password',true,initialExpiry];
    const direct = await scalar(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,directArgs);
    assert.equal(direct.pending,false); assert.equal(direct.passwordCreated,true); assert.equal(direct.deliveryId,null); checks++;
    const directUser = (await db.query('SELECT is_active,email_login_enabled,email_verified_at,password_hash,expires_at,session_version FROM users WHERE id=$1',[direct.userId])).rows[0];
    assert.equal(directUser.is_active,true); assert.equal(directUser.email_login_enabled,true); assert.ok(directUser.email_verified_at); assert.ok(directUser.expires_at); assert.equal(directUser.session_version,1); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM tokko_account_tokens WHERE user_id=$1 AND consumed_at IS NULL',[direct.userId]),0); checks++;
    assert.equal(await scalar("SELECT count(*)::int value FROM tokko_account_mail m JOIN tokko_account_tokens t ON t.id=m.token_id WHERE t.user_id=$1 AND (m.status<>'cancelled' OR m.encrypted_token<>'')",[direct.userId]),0); checks++;
    assert.deepEqual(await scalar(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,directArgs),direct); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[direct.userId]),'scrypt-v1$initial-password'); checks++;
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[...directArgs.slice(0,5),'different-fingerprint',...directArgs.slice(6)],'22023');
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'direct-password@example.test','Cannot Replace',$3,'overwrite','hash','scrypt-v1$overwrite',FALSE,NULL)`,[manager,[pageB],randomUUID()]);
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1 AND page_id=$2',[direct.userId,pageB]),0); checks++;
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'original-invite@example.test','Cannot Claim',$3,'wrong-creator','hash','scrypt-v1$overwrite',FALSE,NULL)`,[manager,[pageA],randomUUID()]);
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'manager@example.test','Facebook Owner',$3,'wrong-identity','hash','scrypt-v1$overwrite',FALSE,NULL)`,[manager,[pageA],randomUUID()]);
    const pendingOwn = await provision(manager,[pageA],'pending-own-password@example.test');
    const completedOwn = await scalar(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'pending-own-password@example.test','Complete Invite',$3,'own-pending','own-hash','scrypt-v1$completed',FALSE,NULL) value`,[manager,[pageA],randomUUID()]);
    assert.equal(completedOwn.userId,pendingOwn.result.userId); assert.equal(completedOwn.pending,false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password($1,'scrypt-v1$old-invitation') value`,[pendingOwn.hash]),false); checks++;
    const expiredPending = await provision(manager,[pageA],'expired-pending-password@example.test');
    await db.query("UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",[expiredPending.result.userId]);
    await denied(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'expired-pending-password@example.test','Expired',$3,'expired-initial','new-hash','scrypt-v1$activate',FALSE,NULL)`,[manager,[pageA],randomUUID()],'22023');
    assert.equal(await scalar('SELECT is_active value FROM users WHERE id=$1',[expiredPending.result.userId]),false); checks++;
    const renewedPending = await scalar(`SELECT ${schema}.tokko_provision_member_with_password($1,$2,'expired-pending-password@example.test','Renewed',$3,'renewed-initial','renewed-hash','scrypt-v1$renewed',TRUE,now()+interval '7 days') value`,[manager,[pageA],randomUUID()]);
    assert.equal(renewedPending.userId,expiredPending.result.userId); assert.equal(renewedPending.pending,false); checks++;
    // Assign-existing is explicitly non-provisioning and needs no email delivery.
    const assignedExisting = await scalar(`SELECT ${schema}.tokko_assign_existing_member($1,$2,'direct-password@example.test','Keep Account',$3,'assign-only','unused-hash','',FALSE,NULL) value`,[manager,[pageB],randomUUID()]);
    assert.equal(assignedExisting.userId,direct.userId); assert.equal(assignedExisting.pending,false); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[direct.userId]),'scrypt-v1$initial-password'); checks++;
    await denied(`SELECT ${schema}.tokko_assign_existing_member($1,$2,'does-not-exist@example.test','No Create',$3,'assign-only','unused','',FALSE,NULL)`,[manager,[pageA],randomUUID()],'22023');
    assert.equal(await scalar("SELECT count(*)::int value FROM users WHERE email='does-not-exist@example.test'"),0); checks++;

    // Facebook users can enable password login on their own stable identity.
    await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('fb-manager','manager@example.test','Manager',NULL,NULL)`);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,'wrong-facebook',0,NULL,'scrypt-v1$self') value`,[manager]),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,'fb-manager',0,NULL,'scrypt-v1$self') value`,[manager]),true); checks++;
    const managerAfterPassword = (await db.query('SELECT facebook_id,account_kind,session_version,email_login_enabled FROM users WHERE id=$1',[manager])).rows[0];
    assert.deepEqual(managerAfterPassword,{facebook_id:'fb-manager',account_kind:'facebook',session_version:1,email_login_enabled:true}); checks++;
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('fb-manager','manager@example.test','Manager',NULL,NULL)`)).rows[0].user_id,manager); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,'fb-manager',0,NULL,'scrypt-v1$stale') value`,[manager]),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,NULL,1,'wrong-old-hash','scrypt-v1$changed') value`,[manager]),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,NULL,1,'scrypt-v1$self','scrypt-v1$changed') value`,[manager]),true); checks++;
    assert.equal(await scalar('SELECT session_version value FROM users WHERE id=$1',[manager]),2); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,'fb-noemail',0,NULL,'scrypt-v1$no-mail') value`,[noEmailOriginal]),false); checks++;
    assert.ok(await scalar(`SELECT ${schema}.tokko_queue_password_reset('direct-password@example.test','old-direct-reset','encrypted') value`)); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,NULL,1,'scrypt-v1$initial-password','scrypt-v1$member-changed') value`,[direct.userId]),true); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_account_password('old-direct-reset','scrypt-v1$old-reset') value`),false); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[direct.userId]),2); checks++;
    assert.deepEqual(await scalar('SELECT expires_at value FROM users WHERE id=$1',[direct.userId]),initialExpiry); checks++;
    await db.query("UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",[direct.userId]);
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_own_password($1,NULL,2,'scrypt-v1$member-changed','scrypt-v1$new') value`,[direct.userId]),false); checks++;

    // Corrected model: app-role Facebook users are parents independently of
    // Page MANAGE tasks; password identities are parent-owned subaccounts.
    await db.query(migration('database/migration_original_facebook_access.sql'));
    await db.query(migration('database/migration_parent_subaccounts.sql'));
    const oldOriginal = randomUUID();
    await db.query("INSERT INTO users(id,email,name) VALUES($1,'original-no-manage@example.test','Original app tester')",[oldOriginal]);
    await db.query("INSERT INTO user_pages(user_id,page_id,grant_source) VALUES($1,$2,'legacy'),($1,$3,'legacy')",[oldOriginal,pageA,pageB]);
    const originalLogin = (await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('app-tester-subject','original-no-manage@example.test','Tester',NULL,NULL)`)).rows[0];
    assert.equal(originalLogin.user_id,oldOriginal); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[oldOriginal]),2); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_is_parent_user($1,'app-tester-subject') value`,[oldOriginal]),true); checks++;
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('app-tester-subject','changed-profile@example.test','Tester',NULL,NULL)`)).rows[0].user_id,oldOriginal); checks++;
    const noPageOriginal = randomUUID();
    await db.query("INSERT INTO users(id,email) VALUES($1,'old-no-pages@example.test')",[noPageOriginal]);
    assert.equal((await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('old-no-pages','old-no-pages@example.test','Tester',NULL,NULL)`)).rows[0].user_id,noPageOriginal); checks++;
    await db.query("INSERT INTO tokko_page_managers(user_id,page_id,facebook_subject,authority_source) VALUES($1,$2,'app-tester-subject','original'),($1,$3,'app-tester-subject','original')",[oldOriginal,pageA,pageB]);
    const saveSql = `SELECT ${schema}.tokko_save_subaccount($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) value`;
    const temporaryArgs = [oldOriginal,[pageA,pageB],'temporary-team@example.test','Team Member',randomUUID(),'temporary-request','password','temporary-hash','','scrypt-v1$temporary',false,null,2,true];
    const temporary = await scalar(saveSql,temporaryArgs);
    assert.equal(temporary.pending,false); checks++;
    const firstDeadline = await scalar('SELECT expires_at value FROM users WHERE id=$1',[temporary.userId]);
    assert.deepEqual(firstDeadline,await scalar("SELECT now()+interval '2 days' value")); checks++;
    assert.equal(await scalar('SELECT delete_after_expiry value FROM users WHERE id=$1',[temporary.userId]),true); checks++;
    const permanent = await scalar(saveSql,[oldOriginal,[pageA,pageB],'permanent-team@example.test','Team Member',randomUUID(),'permanent-request','password','permanent-hash','','scrypt-v1$permanent',false,null,null,null]);
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=ANY($1)',[[temporary.userId,permanent.userId]]),4); checks++;
    assert.equal(await scalar('SELECT expires_at value FROM users WHERE id=$1',[permanent.userId]),null); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_subaccount_lifetime($1,$2,$3,FALSE,NULL,5,TRUE) value`,[oldOriginal,[pageA],temporary.userId]),true); checks++;
    await scalar(saveSql,temporaryArgs);
    assert.deepEqual(await scalar('SELECT expires_at value FROM users WHERE id=$1',[temporary.userId]),await scalar("SELECT now()+interval '5 days' value")); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_subaccount_lifetime($1,$2,$3,FALSE,NULL,7,TRUE) value`,[manager,[pageA],temporary.userId]),false); checks++;
    assert.equal(await scalar(`SELECT ${schema}.tokko_set_subaccount_lifetime($1,$2,$1,TRUE,NULL,NULL,FALSE) value`,[oldOriginal,[pageA]]),false); checks++;
    await denied(`SELECT ${schema}.tokko_assert_manager($1,$2)`,[temporary.userId,[pageA]]);
    await denied("INSERT INTO tokko_auth_identities(provider,subject,user_id) VALUES('facebook','child-cannot-be-parent',$1)",[temporary.userId]);
    const protectedChildHash = await scalar('SELECT password_hash value FROM users WHERE id=$1',[permanent.userId]);
    const separateParent = (await db.query(`SELECT * FROM ${schema}.tokko_resolve_facebook_user('developer-with-same-email','permanent-team@example.test','Developer',NULL,NULL)`)).rows[0];
    assert.notEqual(separateParent.user_id,permanent.userId); checks++;
    assert.equal(await scalar('SELECT password_hash value FROM users WHERE id=$1',[permanent.userId]),protectedChildHash); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[separateParent.user_id]),0); checks++;
    // Actual deletion must preserve shared work and the other overlapping account.
    const retainedTag=randomUUID(),privateTag=randomUUID(),contact=randomUUID(),campaign=randomUUID(),exportId=randomUUID(),eventId=randomUUID();
    await db.query('INSERT INTO contacts(id,page_id) VALUES($1,$2)',[contact,pageA]);
    await db.query("INSERT INTO tags(id,page_id,owner_type,owner_id) VALUES($1,$3,'page',$3),($2,$3,'user',$4)",[retainedTag,privateTag,pageA,temporary.userId]);
    await db.query('INSERT INTO contact_tags(contact_id,tag_id) VALUES($1,$2),($1,$3)',[contact,retainedTag,privateTag]);
    await db.query('INSERT INTO campaigns(id,page_id,created_by) VALUES($1,$2,$3)',[campaign,pageA,temporary.userId]);
    await db.query('INSERT INTO conversation_export_jobs(id,page_id,created_by) VALUES($1,$2,$3)',[exportId,pageA,temporary.userId]);
    await db.query('INSERT INTO contact_bot_permission_events(id,actor_id) VALUES($1,$2)',[eventId,temporary.userId]);
    await db.query("UPDATE users SET expires_at=now()-interval '1 second' WHERE id=$1",[temporary.userId]);
    assert.equal(await scalar(`SELECT count(*)::int value FROM ${schema}.tokko_email_login_record('temporary-team@example.test')`),0); checks++;
    const cleanup = await scalar(`SELECT ${schema}.tokko_delete_expired_subaccounts(100) value`);
    assert.deepEqual(cleanup,{deleted:1,failed:0}); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM users WHERE id=$1',[temporary.userId]),0); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[temporary.userId]),0); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM tokko_account_tokens WHERE user_id=$1',[temporary.userId]),0); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM users WHERE id=$1',[oldOriginal]),1); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM user_pages WHERE user_id=$1',[permanent.userId]),2); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM tags WHERE id=$1',[retainedTag]),1); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM tags WHERE id=$1',[privateTag]),0); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM contact_tags WHERE contact_id=$1',[contact]),1); checks++;
    assert.equal(await scalar('SELECT count(*)::int value FROM campaigns WHERE id=$1',[campaign]),1); checks++;
    assert.equal(await scalar('SELECT created_by value FROM conversation_export_jobs WHERE id=$1',[exportId]),oldOriginal); checks++;
    assert.equal(await scalar("SELECT u.account_kind value FROM contact_bot_permission_events e JOIN users u ON u.id=e.actor_id WHERE e.id=$1",[eventId]),'system'); checks++;
    assert.deepEqual(await scalar(`SELECT ${schema}.tokko_delete_expired_subaccounts(100) value`),{deleted:0,failed:0}); checks++;

    await db.query(`GRANT USAGE ON SCHEMA ${schema} TO anon,authenticated`);
    await db.query('SET LOCAL ROLE anon');
    await denied(`SELECT * FROM ${schema}.users`);
    await denied(`SELECT * FROM ${schema}.pages`);
    await denied(`SELECT ${schema}.tokko_email_login_record('new@example.test')`);
    await denied(`SELECT ${schema}.tokko_recover_legacy_facebook_login('forged','partial-proof@example.test','Forged',NULL,ARRAY['fb-page-a','fb-page-b'])`);
    await denied(`SELECT ${schema}.tokko_set_member_expiry('${manager}',ARRAY['${pageA}']::uuid[],'${expiring.userId}',NULL)`);
    await denied(`SELECT ${schema}.tokko_set_own_password('${manager}','fb-manager',2,NULL,'scrypt-v1$forged')`);
    await denied(`SELECT ${schema}.tokko_provision_member_with_password('${manager}',ARRAY['${pageA}']::uuid[],'forged-password@example.test','Forged','${randomUUID()}','forged','hash','scrypt-v1$forged',FALSE,NULL)`);
    await denied(`SELECT ${schema}.tokko_delete_expired_subaccounts(100)`);
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
