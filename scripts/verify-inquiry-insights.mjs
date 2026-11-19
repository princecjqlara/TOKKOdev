// Real SQL in a disposable local PostgreSQL-compatible database. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
const require=createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const {PGlite}=require('@electric-sql/pglite');
const db=await PGlite.create();let checks=0;
const eq=(a,b)=>{assert.deepEqual(a,b);checks++;};
const actor='00000000-0000-4000-8000-000000000001',member='00000000-0000-4000-8000-000000000002',stranger='00000000-0000-4000-8000-000000000003';
const page='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const contact='20000000-0000-4000-8000-000000000001',existing='20000000-0000-4000-8000-000000000002',foreign='20000000-0000-4000-8000-000000000003';
const record=async(c,id,at,kind='inbound',extra={},isNew=false)=>{const rows=await db.query('SELECT record_tokko_inquiry_events($1,$2,$3::jsonb,$4) value',[page,c,JSON.stringify([{message_id:id,occurred_at:at,kind,source:'messenger',...extra}]),isNew]);return rows.rows[0].value;};
const report=async(kind='all',who=actor,from='2026-01-01',to='2026-04-30',h=24,at='2026-04-30T00:00:00Z')=>(await db.query('SELECT tokko_inquiry_insights($1,$2,$3::date,$4::date,$5,$6,$7::timestamptz) value',[who,page,from,to,kind,h,at])).rows[0].value;
try{
 await db.exec(`CREATE ROLE service_role;CREATE ROLE anon;CREATE ROLE authenticated;CREATE SCHEMA app_private;
 CREATE TABLE app_private.schema_migrations(version text PRIMARY KEY,description text);
 CREATE TABLE users(id uuid PRIMARY KEY,is_active boolean DEFAULT true);
 CREATE TABLE pages(id uuid PRIMARY KEY);
 CREATE TABLE user_pages(user_id uuid REFERENCES users,page_id uuid REFERENCES pages);
 CREATE TABLE contacts(id uuid PRIMARY KEY,page_id uuid REFERENCES pages,name text,psid text,first_interaction_at timestamptz,last_inbound_at timestamptz);
 CREATE TABLE outbound_message_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,page_id uuid,contact_id uuid,message_id text UNIQUE,source_type text,actor_user_id uuid,sent_at timestamptz DEFAULT now());
 CREATE FUNCTION tokko_assert_manager(p_actor uuid,p_page uuid) RETURNS void LANGUAGE plpgsql AS $$BEGIN IF p_actor<>'${actor}' OR NOT EXISTS(SELECT 1 FROM user_pages WHERE user_id=p_actor AND page_id=p_page) THEN RAISE EXCEPTION 'Manager required' USING ERRCODE='42501';END IF;END;$$;
 INSERT INTO users(id) VALUES('${actor}'),('${member}'),('${stranger}');INSERT INTO pages VALUES('${page}'),('${other}');
 INSERT INTO user_pages VALUES('${actor}','${page}'),('${member}','${page}');
 INSERT INTO contacts VALUES('${contact}','${page}','New contact','psid-new',NULL,NULL),('${existing}','${page}','Existing contact','psid-existing',NULL,NULL),('${foreign}','${other}','Other Page','foreign',NULL,NULL);`);
 const migration=fs.readFileSync('database/migration_inquiry_insights.sql','utf8');await db.exec(migration);
 await db.exec("UPDATE app_private.tokko_insight_config SET started_at='2026-01-01';UPDATE tokko_insight_settings SET started_at='2026-01-01'");
 let r=await report();eq(r.episodes.total,0);eq(r.funnel.converted_rate,null);eq(r.response.sla_rate,null);eq(r.contact_coverage.first_interaction_fraction,0);
 eq((await record(contact,'old','2025-12-31T00:00:00Z')).historical_ignored,1);eq((await report()).episodes.total,0);
 eq((await record(contact,'bad',null)).invalid,1);eq((await record(contact,'bad-future','2999-01-01')).invalid,1);eq((await record(contact,'', '2026-02-01')).invalid,1);
 await record(contact,'new-1','2026-02-01T00:00:00Z','inbound',{},true);
 await record(contact,'new-1','2026-02-01T00:00:00Z');eq((await report()).episodes.total,1);eq((await report()).items[0].inbound_messages,1);
 await record(contact,'new-2','2026-02-02T00:00:00Z');eq((await report()).episodes.total,1);
 await record(contact,'return-1','2026-03-05T00:00:00Z');r=await report();eq(r.episodes.new_contacts,1);eq(r.episodes.returning_contacts,1);eq(r.episodes.unique_contacts,1);
 await record(existing,'existing-1','2026-03-06T00:00:00Z');eq((await report()).episodes.returning_contacts,2);
 await assert.rejects(()=>record(foreign,'cross-page','2026-03-06'));checks++;
 await assert.rejects(()=>report('all',stranger));checks++;
 eq((await report('all',member)).episodes.total,3);
 await db.query('INSERT INTO outbound_message_events(page_id,contact_id,message_id,source_type,actor_user_id,sent_at) VALUES($1,$2,$3,$4,$5,$6)',[page,contact,'manual-1','manual',actor,'2026-02-01T00:30:00Z']);
 r=await report();eq(r.response.human_replied,1);eq(r.response.sla_met,1);eq(r.response.median_minutes,30);
 await record(contact,'manual-1','2026-02-01T00:29:00Z','outbound');r=await report();eq(r.response.human_replied,1);eq(r.response.median_minutes,29);
 await db.query('INSERT INTO outbound_message_events(page_id,contact_id,message_id,source_type,sent_at) VALUES($1,$2,$3,$4,$5)',[page,existing,'campaign-1','campaign','2026-03-06T00:00:01Z']);
 await record(existing,'campaign-1','2026-03-06T00:00:01Z','outbound');r=await report();eq(r.response.replied,1);eq(r.response.mature_unanswered,2);
 await record(contact,'qualified-1','2026-02-01T02:00:00Z','stage',{stage:'qualified'});
 await record(contact,'converted-late','2026-02-03T12:00:00Z','stage',{stage:'converted'});
 r=await report();eq(r.funnel.qualified,1);eq(r.funnel.converted,0);eq(r.funnel.qualified_rate,1/3);
 r=await report('all',actor,'2026-01-01','2026-04-30',168);eq(r.funnel.converted,1);
 r=await report('all',actor,'2026-02-01','2026-02-01',24,'2026-02-01T00:20:00Z');eq(r.episodes.mature,0);eq(r.funnel.qualified_rate,null);eq(r.response.sla_rate,null);eq(r.response.replied,0);
 eq((await report('new_contact')).episodes.total,1);eq((await report('returning_contact')).episodes.total,2);
 // Event-time sessionization repairs out-of-order arrivals without replaying old contacts.
 await record(contact,'late-middle','2026-02-15T00:00:00Z');eq((await report()).episodes.total,2); // existing contact + now-one merged contact episode
 eq((await report()).items.find(i=>i.contact_id===contact).inbound_messages,4);
 // A future policy applies to future messages; earlier threshold snapshots stay fixed.
 await db.query('SELECT tokko_set_inquiry_policy($1,$2,7,30)',[actor,page]);
 await record(contact,'short-return','2026-03-13T00:00:00Z');eq((await report()).episodes.total,3);
 // A short new return censors an earlier seven-day observation window.
 await db.query('SELECT tokko_set_inquiry_policy($1,$2,1,30)',[actor,page]);
 await record(contact,'one-day-return','2026-03-14T00:00:00Z');
 r=await report('all',actor,'2026-01-01','2026-04-30',168);eq(r.episodes.censored,1);eq(r.episodes.mature,3);eq(r.episodes.provisional,0);
 await assert.rejects(()=>db.query('SELECT tokko_set_inquiry_policy($1,$2,7,30)',[member,page]));checks++;
 await assert.rejects(()=>report('all',actor,'2026-04-02','2026-03-02'));checks++;
 await assert.rejects(()=>report('other'));checks++;
 await assert.rejects(()=>report('all',actor,'2026-01-01','2026-04-30',12));checks++;
 for(const role of ['anon','authenticated']){
  eq((await db.query("SELECT has_table_privilege($1,'public.tokko_inquiry_events','SELECT') allowed",[role])).rows[0].allowed,false);
  eq((await db.query("SELECT has_function_privilege($1,'public.record_tokko_inquiry_events(uuid,uuid,jsonb,boolean)','EXECUTE') allowed",[role])).rows[0].allowed,false);
  eq((await db.query("SELECT has_function_privilege($1,'public.tokko_inquiry_insights(uuid,uuid,date,date,text,integer,timestamp with time zone)','EXECUTE') allowed",[role])).rows[0].allowed,false);
 }
 await db.exec(migration);eq((await report()).episodes.total,4); // idempotent reinstall preserves captured data
 console.log(JSON.stringify({passed:true,checks,production_writes:0,customer_messages_sent:0}));
}finally{await db.close();}
