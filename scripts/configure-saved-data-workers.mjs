// Check with rolled-back, isolated SQL fixtures; never invoke either worker.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
const args=process.argv.slice(2),apply=args[0]==='--apply';
assert.ok(args.length===1&&['--apply','--preflight'].includes(args[0]),'Choose --preflight or --apply');
const connectionString=process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL;
assert.ok(connectionString,'Load the existing database environment first');
const db=new Client({connectionString,
 ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:30000});
const report={checkedAt:new Date().toISOString(),mode:apply?'apply':'preflight',checks:0,committed:false,
 fixturesRolledBack:false,customerMessagesSent:0,httpRequestsSent:0};
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);report.checks++;};
const jobs=async()=>(await db.query("SELECT * FROM cron.job WHERE jobname='tokko-saved-data-workers'")).rows;
const definition=async()=>(await db.query("SELECT pg_get_functiondef('public.claim_contact_import(uuid,uuid)'::regprocedure) AS value")).rows[0].value;
try{
 await db.connect();
 if(apply){
  await mkdir('.vercel/backups',{recursive:true});report.backup=`.vercel/backups/saved-data-workers-${Date.now()}.json`;
  await writeFile(report.backup,JSON.stringify({jobs:await jobs(),claimDefinition:await definition()},null,2));
 }
 await db.query("BEGIN; SET LOCAL statement_timeout='25s'; SET LOCAL lock_timeout='5s'");
 const sql=(await readFile('database/migration_saved_data_worker_schedule.sql','utf8')).replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
 await db.query(sql);await db.query(sql);
 const installed=await jobs();check(installed.length,1,'The named job is idempotent');
 check(installed[0].active,true,'The job is enabled');check(installed[0].schedule,'* * * * *','Recovery checks once per minute');
 assert.ok(!/follow-up-automations|campaign-scheduled|Authorization|CRON_SECRET/.test(installed[0].command));report.checks++;
 await db.query(`EXPLAIN ${installed[0].command}`);report.checks++;
 await db.query(`SAVEPOINT fixtures;
 CREATE TEMP TABLE pages(id UUID PRIMARY KEY,fb_page_id TEXT DEFAULT 'fixture',access_token TEXT DEFAULT 'not-a-token',
  messaging_auto_tag_enabled BOOLEAN DEFAULT TRUE,campaign_delivery_cooldown_until TIMESTAMPTZ);
 CREATE TEMP TABLE page_contact_imports(LIKE public.page_contact_imports INCLUDING DEFAULTS);
 CREATE TEMP TABLE conversation_export_jobs(status TEXT,expires_at TIMESTAMPTZ DEFAULT NOW()+INTERVAL '1 day',
  updated_at TIMESTAMPTZ DEFAULT NOW()-INTERVAL '1 hour',next_attempt_at TIMESTAMPTZ,claimed_at TIMESTAMPTZ);
 CREATE TEMP TABLE page_sync_leases(page_id UUID,expires_at TIMESTAMPTZ);
 CREATE TEMP TABLE quota_memberships(page_id UUID,scope TEXT,quota_key TEXT);
 CREATE TEMP TABLE campaign_shared_quota_cooldowns(scope TEXT,quota_key TEXT,retry_at TIMESTAMPTZ);
 CREATE FUNCTION pg_temp.campaign_page_quota_keys(p_page_id UUID) RETURNS TABLE(scope TEXT,quota_key TEXT)
 LANGUAGE SQL STABLE AS 'SELECT scope,quota_key FROM pg_temp.quota_memberships WHERE page_id=p_page_id';
 CREATE FUNCTION pg_temp.acquire_page_sync_lease(UUID,TEXT,INTEGER) RETURNS BOOLEAN LANGUAGE SQL AS 'SELECT TRUE';
 CREATE FUNCTION pg_temp.request_worker(url TEXT,timeout_milliseconds INTEGER) RETURNS TEXT LANGUAGE SQL VOLATILE AS 'SELECT url';`);
 const rewrite=value=>value.replaceAll('public.','pg_temp.').replaceAll('app_private.','pg_temp.');
 const command=rewrite(installed[0].command).replaceAll('net.http_get','pg_temp.request_worker');
 assert.ok(!/public\.|app_private\.|net\.http_get/.test(command));report.checks++;
 const dispatches=async()=>(await db.query(command)).rows.map(row=>row.request_id).sort();
 const sync='https://tokkobeta.vercel.app/api/cron/sync',exports='https://tokkobeta.vercel.app/api/cron/exports';
 check(await dispatches(),[],'An empty saved queue remains idle');
 const page=randomUUID();await db.query('INSERT INTO pg_temp.pages(id) VALUES($1)',[page]);
 await db.query("INSERT INTO pg_temp.page_contact_imports(page_id) VALUES($1)",[page]);
 check(await dispatches(),[sync],'A saved unattempted import recovers');
 await db.query('UPDATE pg_temp.page_contact_imports SET attempted_at=NOW()');
 check(await dispatches(),[],'Healthy import polling leaves fallback idle');
 await db.query("UPDATE pg_temp.page_contact_imports SET attempted_at=NOW()-INTERVAL '6 minutes',retry_after=NOW()+INTERVAL '1 minute'");
 check(await dispatches(),[],'Import retry windows are respected');
 await db.query("UPDATE pg_temp.page_contact_imports SET retry_after=NULL,lease_until=NOW()+INTERVAL '1 minute'");
 check(await dispatches(),[],'Active import leases prevent dispatch');
 await db.query('UPDATE pg_temp.page_contact_imports SET lease_until=NULL');
 await db.query("INSERT INTO pg_temp.page_sync_leases VALUES($1,NOW()+INTERVAL '1 minute')",[page]);
 check(await dispatches(),[],'Other Page sync leases prevent dispatch');
 await db.query('DELETE FROM pg_temp.page_sync_leases');
 await db.query("UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NOW()+INTERVAL '1 minute'");
 check(await dispatches(),[],'Page cooldowns are respected');
 await db.query('UPDATE pg_temp.pages SET campaign_delivery_cooldown_until=NULL');
 await db.query("INSERT INTO pg_temp.quota_memberships VALUES($1,'user','owner')",[page]);
 await db.query("INSERT INTO pg_temp.campaign_shared_quota_cooldowns VALUES('user','owner',NOW()+INTERVAL '1 minute')");
 check(await dispatches(),[],'Related Facebook owner cooldowns are respected');
 const fixtureClaim=rewrite(await definition());
 assert.ok(!/public\.|app_private\./.test(fixtureClaim));report.checks++;
 await db.query(fixtureClaim);
 const claim=async()=>(await db.query('SELECT page_id FROM pg_temp.claim_contact_import($1,$2)',[randomUUID(),page])).rows;
 check(await claim(),[],'The actual import claim also respects shared cooldowns');
 await db.query('DELETE FROM pg_temp.campaign_shared_quota_cooldowns');
 check((await claim()).map(row=>row.page_id),[page],'A due import claims its original Page');
 check(await claim(),[],'An active import cannot be claimed twice');
 await db.query("UPDATE pg_temp.page_contact_imports SET lease_until=NULL,status='blocked'");
 check(await dispatches(),[],'Blocked imports stay blocked');check(await claim(),[],'Blocked imports cannot be claimed');
 await db.query("UPDATE pg_temp.page_contact_imports SET status='completed',completed_at=NOW()-INTERVAL '2 days'");
 check(await dispatches(),[],'The fallback does not start periodic full scans on its own');
 await db.query("INSERT INTO pg_temp.conversation_export_jobs(status) VALUES('queued')");
 check(await dispatches(),[exports],'A saved queued export recovers');
 await db.query('UPDATE pg_temp.conversation_export_jobs SET updated_at=NOW()');
 check(await dispatches(),[],'A healthy export worker leaves fallback idle');
 await db.query("UPDATE pg_temp.conversation_export_jobs SET updated_at=NOW()-INTERVAL '1 hour',next_attempt_at=NOW()+INTERVAL '1 minute'");
 check(await dispatches(),[],'Export retry windows are respected');
 await db.query("UPDATE pg_temp.conversation_export_jobs SET next_attempt_at=NULL,status='running',claimed_at=NOW()");
 check(await dispatches(),[],'A fresh export claim cannot overlap');
 await db.query("UPDATE pg_temp.conversation_export_jobs SET claimed_at=NOW()-INTERVAL '7 minutes'");
 check(await dispatches(),[exports],'An expired export claim recovers');
 await db.query("UPDATE pg_temp.conversation_export_jobs SET expires_at=NOW()-INTERVAL '1 minute'");
 check(await dispatches(),[],'Expired exports are not restarted');
 for(const status of ['completed','failed']){
  await db.query("UPDATE pg_temp.conversation_export_jobs SET status=$1,expires_at=NOW()+INTERVAL '1 day'",[status]);
  check(await dispatches(),[],`${status} exports are not restarted`);
 }
 await db.query("UPDATE pg_temp.page_contact_imports SET status='queued',lease_until=NULL,attempted_at=NOW()-INTERVAL '6 minutes'; UPDATE pg_temp.conversation_export_jobs SET status='queued'");
 for(let i=0;i<4;i++)await db.query("INSERT INTO pg_temp.conversation_export_jobs(status) VALUES('queued')");
 check(await dispatches(),[exports,sync].sort(),'A backlog queues at most one request per worker per tick');
 for(const role of ['anon','authenticated'])check((await db.query("SELECT has_function_privilege($1,'public.claim_contact_import(uuid,uuid)','EXECUTE') AS value",[role])).rows[0].value,false,'End users cannot claim imports directly');
 check((await db.query("SELECT has_function_privilege('service_role','public.claim_contact_import(uuid,uuid)','EXECUTE') AS value")).rows[0].value,true,'The server retains import access');
 await db.query('ROLLBACK TO SAVEPOINT fixtures');report.fixturesRolledBack=true;
 await db.query(apply?'COMMIT':'ROLLBACK');report.committed=apply;report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error={code:error.code,message:error.message};process.exitCode=1;}
finally{await db.end();await mkdir('outputs',{recursive:true});await writeFile(`outputs/saved-data-workers-${apply?'apply':'preflight'}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
