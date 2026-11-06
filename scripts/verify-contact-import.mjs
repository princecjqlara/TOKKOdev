// Rollback-only checks of the actual import schema and its atomic checkpoint RPCs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
const connectionString = process.env.TOKKO_TEST_DATABASE_URL || process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL;
if (!connectionString) throw Error('A test database or configured database connection is required.');
const db = new Client({ connectionString, ssl: process.env.TOKKO_TEST_NO_SSL === '1' ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000, query_timeout: 15000 });
const schema = `tokko_import_test_${randomUUID().replaceAll('-', '')}`;
const report = { checks: 0, passed: false, rolledBack: false, customerMessagesSent: 0 };
const check = (actual, expected) => { assert.deepEqual(actual, expected); report.checks++; };
async function scalar(sql, args = []) { return (await db.query(sql,args)).rows[0].value; }
async function denied(sql,args = []) {
    await db.query('SAVEPOINT expected_failure');
    let code; try { await db.query(sql,args); } catch (error) { code=error.code; }
    await db.query('ROLLBACK TO SAVEPOINT expected_failure');
    assert.ok(code,'Operation must be rejected'); report.checks++;
}
try {
    await db.connect(); await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='12s'; SET LOCAL lock_timeout='3s'");
    await db.query("SET LOCAL timezone='UTC'");
    await db.query(`CREATE SCHEMA ${schema}; SET LOCAL search_path=${schema}`);
    for (const table of ['pages','contacts','page_sync_leases']) await db.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    for (const signature of ['acquire_page_sync_lease(uuid,text,integer)','release_page_sync_lease(uuid,text)']) {
        const source=(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[`public.${signature}`])).rows[0].definition;
        await db.query(source.replaceAll('public.',`${schema}.`).replaceAll("search_path TO 'public'",`search_path TO '${schema}'`));
    }
    const migration=fs.readFileSync('database/migration_durable_contact_import.sql','utf8')
        .replace(/^BEGIN;|^COMMIT;/gm,'').replace(/INSERT INTO app_private\.schema_migrations[^;]+;/g,'').replace(/NOTIFY pgrst[^;]+;/g,'')
        .replaceAll('public.',`${schema}.`).replaceAll('search_path=public',`search_path=${schema}`);
    await db.query(migration);
    const page=randomUUID(),pageB=randomUUID(),run=randomUUID(),owner=randomUUID();
    await db.query("INSERT INTO pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Import test','fixture'),($3,$4,'Other test','fixture')",[page,`fixture-${page}`,pageB,`fixture-${pageB}`]);
    async function request(id=page,runId=run) { return (await db.query(`SELECT * FROM ${schema}.request_contact_import($1,$2,FALSE)`,[id,runId])).rows[0]; }
    async function claim(id=page,worker=owner) { return (await db.query(`SELECT * FROM ${schema}.claim_contact_import($1,$2)`,[worker,id])).rows[0]; }
    async function finish(rows,nextCursor,nextFolder,worker=owner) { return (await db.query(`SELECT * FROM ${schema}.finish_contact_import_slice($1,$2,$3::jsonb,$4,$5)`,[page,worker,JSON.stringify(rows),nextCursor,nextFolder])).rows[0]; }
    const contact={psid:'contact',name:'Saved Customer',last_interaction_at:'2026-11-05T00:00:00Z',last_inbound_at:'2026-11-05T00:00:00Z',best_contact_hour:8};
    check((await request()).folder,'inbox');
    check((await request(page,randomUUID())).run_id,run);
    check((await claim()).run_id,run);
    check(await claim(page,randomUUID()),undefined);
    check(await scalar('SELECT count(*)::int value FROM page_sync_leases WHERE page_id=$1',[page]),1);
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,'[]','next','inbox')`,[page,randomUUID()]);
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,NULL,'next','inbox')`,[page,owner]);
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,'[]',NULL,NULL)`,[page,owner]);
    check((await finish([contact],'after_1','inbox')).cursor,'after_1');
    check(await scalar('SELECT count(*)::int value FROM contacts WHERE page_id=$1',[page]),1);
    check(await scalar('SELECT last_synced_at value FROM pages WHERE id=$1',[page]),null);
    check(await scalar('SELECT count(*)::int value FROM page_sync_leases WHERE page_id=$1',[page]),0);
    check((await request()).cursor,'after_1');
    await claim();
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,$3::jsonb,'after_1','inbox')`,[page,owner,JSON.stringify([contact])]);
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,$3::jsonb,'after_2','inbox')`,[page,owner,JSON.stringify([{...contact,psid:'unsaved'}, {...contact,psid:'invalid',name:'UNKNOWN'}])]);
    check(await scalar("SELECT count(*)::int value FROM contacts WHERE psid='unsaved'"),0);
    check(await scalar('SELECT cursor value FROM page_contact_imports WHERE page_id=$1',[page]),'after_1');
    await db.query("UPDATE contacts SET best_contact_confidence='high',interaction_count=99,best_contact_hour=14 WHERE page_id=$1",[page]);
    const first=await finish([{...contact,name:null,last_interaction_at:'2020-01-01T00:00:00Z',last_inbound_at:null}],'after_2','inbox');
    check(first.processed_count,2);
    check((await db.query('SELECT name,best_contact_confidence,interaction_count,best_contact_hour,last_interaction_at::text FROM contacts WHERE page_id=$1',[page])).rows[0],
        {name:'Saved Customer',best_contact_confidence:'high',interaction_count:99,best_contact_hour:14,last_interaction_at:'2026-11-05 00:00:00+00'});
    await claim(); check((await finish([],null,'other')).folder,'other');
    check(await scalar('SELECT last_synced_at value FROM pages WHERE id=$1',[page]),null);
    await claim(); check((await finish([{...contact,psid:'request'}],null,'page_done')).folder,'page_done');
    await claim(); check((await finish([{...contact,psid:'done'}],null,'spam')).folder,'spam');
    await claim(); check((await finish([{...contact,psid:'spam'}],null,null)).status,'completed');
    check(await scalar('SELECT count(*)::int value FROM contacts WHERE page_id=$1',[page]),4);
    check(await scalar('SELECT count(*)::int value FROM contacts WHERE page_id=$1',[pageB]),0);
    assert.ok(await scalar('SELECT last_synced_at value FROM pages WHERE id=$1',[page])); report.checks++;
    check((await request()).status,'completed');
    check((await request(page,randomUUID())).status,'queued');
    await claim();
    await db.query("UPDATE page_contact_imports SET lease_until=now()-interval '1 second' WHERE page_id=$1",[page]);
    await db.query("UPDATE page_sync_leases SET expires_at=now()-interval '1 second' WHERE page_id=$1",[page]);
    const recoveredOwner=randomUUID();
    check((await claim(page,recoveredOwner)).page_id,page);
    await denied(`SELECT ${schema}.finish_contact_import_slice($1,$2,'[]','next','inbox')`,[page,owner]);
    await finish([],null,'other',recoveredOwner);
    for(const folder of ['page_done','spam',null]){await claim();await finish([],null,folder);}
    const largeRun=randomUUID();await request(page,largeRun);
    for(let batch=0;batch<3;batch++){
        await claim();
        const rows=Array.from({length:batch===2?200:500},(_,index)=>({...contact,psid:`large-${batch*500+index}`}));
        const saved=await finish(rows,batch===2?null:`large-${batch+1}`,batch===2?'other':'inbox');
        check(saved.processed_count,batch===2?1200:(batch+1)*500);
    }
    for(const folder of ['page_done','spam',null]){await claim();await finish([],null,folder);}
    check((await request(page,largeRun)).status,'completed');
    check(await scalar("SELECT count(*)::int value FROM contacts WHERE page_id=$1 AND psid LIKE 'large-%'",[page]),1200);
    await db.query("UPDATE page_contact_imports SET status='blocked',folder='other',cursor='old-token-cursor',last_error='Expired' WHERE page_id=$1",[page]);
    await db.query("UPDATE pages SET access_token='refreshed-fixture-token' WHERE id=$1",[page]);
    check((await db.query('SELECT status,folder,cursor,processed_count,last_error FROM page_contact_imports WHERE page_id=$1',[page])).rows[0],
        {status:'queued',folder:'inbox',cursor:null,processed_count:0,last_error:null});
    for (const role of ['anon','authenticated']) {
        check(await scalar("SELECT has_table_privilege($1,$2,'SELECT') value",[role,`${schema}.page_contact_imports`]),false);
        for (const signature of ['request_contact_import(uuid,uuid,boolean)','claim_contact_import(uuid,uuid)','finish_contact_import_slice(uuid,uuid,jsonb,text,text)']) {
            check(await scalar("SELECT has_function_privilege($1,$2,'EXECUTE') value",[role,`${schema}.${signature}`]),false);
        }
    }
    report.passed=true;
} catch(error) { report.error={code:error.code,message:error.message,position:error.position,where:error.where}; process.exitCode=1; }
finally { await db.query('ROLLBACK').then(()=>{report.rolledBack=true;}).catch(()=>{}); await db.end(); console.log(JSON.stringify(report)); }
