// Install shared quotas and continuous handoff without sending customer messages.
// --preflight rolls back migrations and fixtures; --apply backs up definitions.
// --refresh-identities verifies saved Page tokens through Meta's read-only debugger.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
const apply=process.argv.includes('--apply'), refresh=process.argv.includes('--refresh-identities');
assert.equal(Number(apply)+Number(process.argv.includes('--preflight')),1,'Choose --preflight or --apply');
const db=new Client({connectionString:process.env.DATABASE_POOLER_URL_5432||process.env.DATABASE_URL,
    ssl:{rejectUnauthorized:false},connectionTimeoutMillis:10000,query_timeout:15000});
const report={checkedAt:new Date().toISOString(),mode:apply?'apply':'preflight',checks:0,committed:false,
    fixturesRolledBack:false,customerMessagesSent:0};
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);report.checks++;};
const signatures=[
    'public.acquire_page_campaign_delivery(uuid,uuid)',
    'public.report_page_campaign_delivery_feedback(uuid,uuid,integer,integer,boolean,integer,text)',
    'public.release_page_campaign_delivery(uuid,uuid,boolean)'];
const pagesState=async()=>(await db.query(`SELECT id,campaign_delivery_concurrency,campaign_delivery_interval_ms,
    campaign_delivery_cooldown_until,campaign_delivery_owner,campaign_delivery_lease_until,
    campaign_delivery_feedback_at,campaign_delivery_rate_strikes FROM public.pages ORDER BY id`)).rows;
const campaignsState=async()=>(await db.query(`SELECT id,status,background_delivery_enabled,sent_count,failed_count,
    next_attempt_at FROM public.campaigns ORDER BY id`)).rows;
const hash=value=>createHash('sha256').update(value).digest('hex');
async function verifyIdentities(){
    const appId=process.env.FACEBOOK_CLIENT_ID,secret=process.env.FACEBOOK_CLIENT_SECRET||process.env.FACEBOOK_APP_SECRET;
    assert.ok(appId&&secret,'Facebook application credentials are required for token verification');
    const pages=(await db.query('SELECT id,fb_page_id,name,access_token FROM public.pages ORDER BY id')).rows;
    const verified=[],issues=[];
    for(let offset=0;offset<pages.length;offset+=2){
        const results=await Promise.all(pages.slice(offset,offset+2).map(async page=>{
            try{
                const url=new URL('https://graph.facebook.com/v21.0/debug_token');url.searchParams.set('input_token',page.access_token);
                const response=await fetch(url,{headers:{Authorization:`Bearer ${appId}|${secret}`},signal:AbortSignal.timeout(10000)});
                const body=await response.json(),data=body.data;
                if(!response.ok||!data?.is_valid||String(data.app_id)!==appId||data.type!=='PAGE'||
                    String(data.profile_id)!==page.fb_page_id||!/^\d+$/.test(data.user_id||''))return{issue:{page:page.name,
                        reason:!data?.is_valid?'token_invalid':String(data.app_id)!==appId?'app_mismatch':
                            String(data.profile_id)!==page.fb_page_id?'page_mismatch':'missing_owner'}};
                return{pageId:page.id,fingerprint:hash(page.access_token),userId:data.user_id};
            }catch{return{issue:{page:page.name,reason:'verification_unavailable'}};}
        }));
        for(const result of results)if(result.issue)issues.push(result.issue);else verified.push(result);
    }
    return{verified,issues,total:pages.length};
}
async function fixtures(){
    const schema=`tokko_quota_test_${randomUUID().replaceAll('-','')}`;
    assert.match(schema,/^tokko_quota_test_[a-f0-9]{32}$/);
    await db.query('SAVEPOINT fixtures');
    await db.query(`CREATE SCHEMA ${schema}; REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC,anon,authenticated,service_role`);
    for(const table of ['pages','campaigns','campaign_recipients'])await db.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    for(const table of ['campaign_page_quota_identity','campaign_page_business_quotas','campaign_shared_quota_cooldowns',
        'campaign_worker_configuration','campaign_worker_handoffs'])await db.query(`CREATE TABLE ${schema}.${table} (LIKE app_private.${table} INCLUDING ALL)`);
    await db.query(`CREATE TABLE ${schema}.fixture_requests(id BIGSERIAL PRIMARY KEY,url TEXT);
        CREATE FUNCTION ${schema}.http_get(url TEXT,timeout_milliseconds INTEGER) RETURNS BIGINT LANGUAGE SQL AS $$
        INSERT INTO ${schema}.fixture_requests(url) VALUES(url) RETURNING id $$`);
    for(const signature of ['app_private.campaign_page_quota_keys(uuid)',
        'public.record_page_campaign_quota_identity(uuid,text,text)',
        'public.acquire_page_campaign_delivery_local(uuid,uuid)',
        'public.report_page_campaign_delivery_feedback_local(uuid,uuid,integer,integer,boolean,integer,text)',
        ...signatures,'public.acquire_page_campaign_delivery_v2(uuid,uuid)',
        'public.request_campaign_delivery_continuation(uuid)']){
        const source=(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition;
        await db.query(source.replaceAll('public.',`${schema}.`).replaceAll('app_private.',`${schema}.`)
            .replaceAll('net.http_get',`${schema}.http_get`).replaceAll("search_path TO 'public'",`search_path TO '${schema}'`));
    }
    const pages=[randomUUID(),randomUUID(),randomUUID()],owners=pages.map(()=>randomUUID());
    for(let i=0;i<3;i++){
        await db.query(`INSERT INTO ${schema}.pages(id,fb_page_id,name,access_token) VALUES($1,$2,'Quota fixture',$3)`,[pages[i],`fixture-${pages[i]}`,`fixture-token-${i}`]);
        check((await db.query(`SELECT ${schema}.record_page_campaign_quota_identity($1,$2,$3) value`,
            [pages[i],hash(`fixture-token-${i}`),i<2?'111':'222'])).rows[0].value,true,'Token ownership is recorded only for matching token fingerprints');
    }
    check((await db.query(`SELECT (${schema}.acquire_page_campaign_delivery_v2($1,$2)->>'acquired')::BOOLEAN acquired`,[pages[0],owners[0]])).rows[0].acquired,
        true,'Fixture Page can acquire delivery');
    await db.query(`SELECT ${schema}.report_page_campaign_delivery_feedback($1,$2,5,100,TRUE,120000,'user')`,[pages[0],owners[0]]);
    const cooldowns=(await db.query(`SELECT id,campaign_delivery_cooldown_until>NOW() cooling FROM ${schema}.pages ORDER BY id`)).rows;
    check(cooldowns.find(p=>p.id===pages[1]).cooling,true,'Related verified user receives the cooldown');
    check(Boolean(cooldowns.find(p=>p.id===pages[2]).cooling),false,'An unrelated user is not cooled down');
    check((await db.query(`SELECT ${schema}.acquire_page_campaign_delivery_v2($1,$2)->>'reason' reason`,[pages[1],owners[1]])).rows[0].reason,
        'cooldown','Worker responses distinguish provider cooldowns');
    await db.query(`TRUNCATE ${schema}.campaign_shared_quota_cooldowns;
        UPDATE ${schema}.pages SET campaign_delivery_owner=NULL,campaign_delivery_lease_until=NULL,campaign_delivery_cooldown_until=NULL`);
    const campaign=randomUUID();
    await db.query(`INSERT INTO ${schema}.campaigns(id,page_id,name,status,total_recipients,background_delivery_enabled)
        VALUES($1,$2,'Handoff fixture','sending',1,TRUE)`,[campaign,pages[0]]);
    await db.query(`INSERT INTO ${schema}.campaign_recipients(campaign_id,contact_id,status) VALUES($1,$2,'pending')`,[campaign,randomUUID()]);
    await db.query(`INSERT INTO ${schema}.campaign_worker_configuration(singleton,worker_url)
        VALUES(TRUE,'https://tokkobeta.vercel.app/api/cron/campaign-scheduled')`);
    check((await db.query(`SELECT ${schema}.request_campaign_delivery_continuation($1) request`,[pages[0]])).rows[0].request!==null,
        true,'A productive queue can dispatch a successor through a stub');
    check((await db.query(`SELECT ${schema}.request_campaign_delivery_continuation($1) request`,[pages[0]])).rows[0].request,
        null,'Repeated handoffs are deduplicated');
    check((await db.query(`SELECT count(*)::INTEGER count FROM ${schema}.fixture_requests`)).rows[0].count,1,'No real HTTP worker is called by fixtures');
    await db.query('ROLLBACK TO SAVEPOINT fixtures');report.fixturesRolledBack=true;
}
try{
    await db.connect();
    const identities=refresh?await verifyIdentities():null;
    await db.query('BEGIN');await db.query("SET LOCAL statement_timeout='12s';SET LOCAL lock_timeout='3s'");
    check((await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('tokko-campaign-shared-quota-install',0)) acquired")).rows[0].acquired,
        true,'Only one shared-quota installation can proceed');
    const beforePages=await pagesState(),beforeCampaigns=await campaignsState();
    if(apply){
        const definitions=[];
        for(const signature of signatures)definitions.push({signature,definition:(await db.query('SELECT pg_get_functiondef($1::regprocedure) definition',[signature])).rows[0].definition});
        await mkdir('.vercel/backups',{recursive:true});report.backup=`.vercel/backups/campaign-shared-quotas-${Date.now()}.json`;
        await writeFile(report.backup,JSON.stringify({definitions,pages:beforePages,campaigns:beforeCampaigns},null,2),{flag:'wx'});
    }
    for(const file of ['migration_campaign_shared_quotas.sql','migration_campaign_continuous_handoff.sql']){
        await db.query((await readFile(`database/${file}`,'utf8')).replace(/^BEGIN;\s*$/m,'').replace(/^COMMIT;\s*$/m,''));
    }
    check(await pagesState(),beforePages,'Installation does not reset Page pacing, leases, or cooldowns');
    check(await campaignsState(),beforeCampaigns,'Installation does not resume or reset campaigns');
    for(const role of ['anon','authenticated','service_role'])for(const signature of [
        'public.record_page_campaign_quota_identity(uuid,text,text)','public.acquire_page_campaign_delivery_v2(uuid,uuid)',
        'public.request_campaign_delivery_continuation(uuid)']){
        check((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed",[role,signature])).rows[0].allowed,
            role==='service_role','Only server roles can invoke administrative coordination');
    }
    await fixtures();
    check(await pagesState(),beforePages,'Isolated fixtures leave customer Page state unchanged');
    check(await campaignsState(),beforeCampaigns,'Isolated fixtures leave customer campaign state unchanged');
    if(identities){
        let recorded=0;
        for(const identity of identities.verified){
            if((await db.query('SELECT record_page_campaign_quota_identity($1,$2,$3) value',
                [identity.pageId,identity.fingerprint,identity.userId])).rows[0].value)recorded++;
        }
        report.identities={pages:identities.total,verified:identities.verified.length,recorded,
            facebookUsers:new Set(identities.verified.map(i=>i.userId)).size,issues:identities.issues};
    }
    if(apply){await db.query('COMMIT');report.committed=true;}else await db.query('ROLLBACK');
    report.passed=true;
}catch(error){await db.query('ROLLBACK').catch(()=>{});report.passed=false;report.error={code:error.code||error.name,message:error.message};process.exitCode=1;}
finally{await db.end();await mkdir('outputs',{recursive:true});await writeFile(`outputs/campaign-shared-quotas-${report.mode}.json`,JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
