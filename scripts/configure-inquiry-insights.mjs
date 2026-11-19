// Installs only additive insight storage/collectors. No sends or historical import.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
import {Client} from 'pg';
const apply=process.argv.includes('--apply');assert(apply||process.argv.includes('--preflight'),'Choose --preflight or --apply');
const root=path.resolve(import.meta.dirname,'..'),env=parseEnv(fs.readFileSync(path.join(root,'.env.local'),'utf8'));
assert.equal(new URL(env.SUPABASE_URL).hostname,'ucirfbweulbvjxmvtiox.supabase.co');
const raw=fs.readFileSync(path.join(root,'database/migration_inquiry_insights.sql'),'utf8');const sql=raw.replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,'');
const sha256=crypto.createHash('sha256').update(raw).digest('hex'),mode=apply?'apply':'preflight';
const dir=path.join(root,'.vercel/inquiry-insights');fs.mkdirSync(dir,{recursive:true});
const db=new Client({connectionString:env.DATABASE_POOLER_URL_5432||env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:20000});
const report={mode,project:'ucirfbweulbvjxmvtiox',migration:'20261120_001',sha256,started_at:new Date().toISOString(),committed:false,manual_dispatches:0,fixtures_rolled_back:false};
async function snapshot(){return (await db.query(`SELECT
 (SELECT count(*)::int FROM users) users,(SELECT count(*)::int FROM pages) pages,(SELECT count(*)::int FROM contacts) contacts,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(c)::text),'' ORDER BY id),'')) FROM campaigns c) campaign_fingerprint,
 (SELECT count(*)::int FROM campaign_recipients) recipient_rows,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(r)::text),'' ORDER BY campaign_id,contact_id),'')) FROM campaign_recipients r) recipient_fingerprint,
 (SELECT jsonb_agg(jsonb_build_object('id',id,'owner',campaign_delivery_owner,'lease',campaign_delivery_lease_until,'cooldown',campaign_delivery_cooldown_until) ORDER BY id) FROM pages) page_recovery`)).rows[0];}
function protect(data){const plaintext=JSON.stringify(data),key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 const p=spawnSync('powershell.exe',['-NoProfile','-Command',"Add-Type -AssemblyName System.Security; $data=[Convert]::FromBase64String([Console]::In.ReadToEnd()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($data,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))"],{input:key.toString('base64'),encoding:'utf8',windowsHide:true});assert.equal(p.status,0);assert(p.stdout.trim());
 const name=path.join(dir,'before-'+Date.now());fs.writeFileSync(name+'.enc',Buffer.concat([iv,cipher.getAuthTag(),body]));fs.writeFileSync(name+'.key.dpapi',p.stdout.trim());const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);decipher.setAuthTag(cipher.getAuthTag());assert.equal(Buffer.concat([decipher.update(body),decipher.final()]).toString(),plaintext);return {encrypted:true,integrity_verified:true,file:name+'.enc'};}
try{await db.connect();await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='15s';SET LOCAL lock_timeout='3s'");
 assert((await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('tokko-inquiry-insights-install',0)) acquired")).rows[0].acquired);
 if(apply){const pre=JSON.parse(fs.readFileSync(path.join(dir,'preflight.json'),'utf8'));assert(pre.passed);assert.equal(pre.sha256,sha256);}
 const before=await snapshot();
 const oldFunctions=(await db.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f' ORDER BY 1")).rows;
 const ledger=(await db.query("SELECT version,description FROM app_private.schema_migrations ORDER BY version")).rows;
 const triggers=(await db.query("SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE tgrelid='public.outbound_message_events'::regclass AND NOT tgisinternal ORDER BY tgname")).rows;
 if(apply)report.backup=protect({before,functions:oldFunctions,migrations:ledger,triggers});
 await db.query(sql);
 // These counters belong to this transaction only. Normal customer/worker
 // writes on other connections remain free to proceed during installation.
 const legacyWrites=(await db.query("SELECT relname,n_tup_ins,n_tup_upd,n_tup_del FROM pg_stat_xact_user_tables WHERE schemaname='public' AND relname IN ('users','pages','contacts','campaigns','campaign_recipients')")).rows;
 assert(legacyWrites.every(r=>Number(r.n_tup_ins)===0&&Number(r.n_tup_upd)===0&&Number(r.n_tup_del)===0),'Migration must not write existing customer data or campaign queues');
 const afterFunctions=(await db.query("SELECT p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition,p.proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','app_private') AND p.prokind='f' ORDER BY 1")).rows;
 for(const f of oldFunctions){const after=afterFunctions.find(v=>v.signature===f.signature);if(!['record_tokko_inquiry_events','tokko_inquiry_insights','tokko_set_inquiry_policy','tokko_capture_outbound_insight'].some(n=>f.signature.includes(n+'(')))assert.deepEqual(after,f,'Existing function changed: '+f.signature);}
 for(const role of ['anon','authenticated'])for(const signature of ['public.record_tokko_inquiry_events(uuid,uuid,jsonb,boolean)','public.tokko_inquiry_insights(uuid,uuid,date,date,text,integer,timestamp with time zone)','public.tokko_set_inquiry_policy(uuid,uuid,integer,integer)'])assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') allowed',[role,signature])).rows[0].allowed,false);
 // Exercise installed scope validation without writing a real event.
 await db.query('SAVEPOINT access_check');
 try{await db.query("SELECT public.tokko_inquiry_insights('00000000-0000-4000-8000-000000000000','00000000-0000-4000-8000-000000000000',current_date,current_date)");throw Error('Unassigned actor was allowed');}catch(e){assert.equal(e.code,'42501');}await db.query('ROLLBACK TO SAVEPOINT access_check');report.fixtures_rolled_back=true;
 report.existing_data_preserved={users_observed:before.users,pages_observed:before.pages,contacts_observed:before.contacts,recipient_rows_observed:before.recipient_rows,migration_business_writes:0,concurrent_worker_activity_allowed:true};
 report.existing_functions_preserved=true;report.restricted_rpcs=true;report.historical_contacts_imported=0;
 if(apply){await db.query('COMMIT');report.committed=true;}else await db.query('ROLLBACK');report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error={code:error.code||error.name,message:error.name==='AssertionError'?error.message.split('\n')[0]:error.message};process.exitCode=1;
}finally{await db.end();report.finished_at=new Date().toISOString();fs.writeFileSync(path.join(dir,mode+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
