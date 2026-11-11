// Real SQL in a disposable local database; net.http_get is a fixture-only stub.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const report = { checks: 0, customerMessagesSent: 0, productionWrites: 0 };
const ids = Array.from({ length: 4 }, () => randomUUID()), owners = ids.map(() => randomUUID());
const campaign = randomUUID(), contact = randomUUID();
const token = i => `synthetic-token-${i}`;
const hash = value => createHash('sha256').update(value).digest('hex');
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
const state = async i => (await db.query('SELECT * FROM pages WHERE id=$1', [ids[i]])).rows[0];
const acquire = async i => (await db.query('SELECT acquire_page_campaign_delivery_v2($1,$2) value', [ids[i],owners[i]])).rows[0].value;
const release = async (i, limited = false) => db.query('SELECT release_page_campaign_delivery($1,$2,$3)', [ids[i],owners[i],limited]);
const feedback = async (i, scope = 'page', limited = false, retryMs = 0, concurrency = 10, interval = 100) =>
    (await db.query('SELECT report_page_campaign_delivery_feedback($1,$2,$3,$4,$5,$6,$7) value',
        [ids[i],owners[i],concurrency,interval,limited,retryMs,typeof scope === 'object' ? JSON.stringify(scope) : scope])).rows[0].value;
const identity = async (i,user) => (await db.query('SELECT record_page_campaign_quota_identity($1,$2,$3) value',
    [ids[i],hash(token(i)),user])).rows[0].value;
const dispatch = async () => (await db.query('SELECT request_campaign_delivery_continuation($1) value',[ids[0]])).rows[0].value;
async function reset() {
    await db.exec(`TRUNCATE app_private.campaign_shared_quota_cooldowns,app_private.campaign_page_business_quotas,
        app_private.campaign_worker_handoffs,net.fixture_requests;
        UPDATE pages SET campaign_delivery_owner=NULL,campaign_delivery_lease_until=NULL,
        campaign_delivery_cooldown_until=NULL,campaign_delivery_feedback_owner=NULL,
        campaign_delivery_feedback_at=NULL,campaign_delivery_feedback_limited=FALSE,
        campaign_delivery_last_rate_limit_at=NULL,campaign_delivery_rate_strikes=0,
        campaign_delivery_concurrency=5,campaign_delivery_interval_ms=100;
        UPDATE campaigns SET next_attempt_at=NULL;`);
}
try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA app_private; CREATE SCHEMA net;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY,description TEXT);
        CREATE TABLE pages(id UUID PRIMARY KEY,access_token TEXT NOT NULL,campaign_delivery_owner UUID,
            campaign_delivery_lease_until TIMESTAMPTZ,campaign_delivery_cooldown_until TIMESTAMPTZ,
            campaign_delivery_rate_strikes INTEGER DEFAULT 0,campaign_delivery_last_rate_limit_at TIMESTAMPTZ);
        CREATE TABLE campaigns(id UUID PRIMARY KEY,page_id UUID,status TEXT,next_attempt_at TIMESTAMPTZ,
            total_recipients INTEGER DEFAULT 10,sent_count INTEGER DEFAULT 0,failed_count INTEGER DEFAULT 0,
            is_loop BOOLEAN DEFAULT FALSE,scheduled_at TIMESTAMPTZ,background_delivery_enabled BOOLEAN DEFAULT TRUE);
        CREATE TABLE campaign_recipients(campaign_id UUID,status TEXT,claimed_at TIMESTAMPTZ,scheduled_at TIMESTAMPTZ);
        CREATE TABLE net.fixture_requests(id BIGSERIAL PRIMARY KEY,url TEXT,timeout_ms INTEGER);
        CREATE FUNCTION net.http_get(url TEXT,timeout_milliseconds INTEGER) RETURNS BIGINT LANGUAGE SQL AS $$
            INSERT INTO net.fixture_requests(url,timeout_ms) VALUES(url,timeout_milliseconds) RETURNING id $$;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;`);
    for (const name of ['adaptive','recovery_pace','idle_probe']) {
        await db.exec(await readFile(`database/migration_campaign_delivery_${name}.sql`,'utf8'));
    }
    const shared = await readFile('database/migration_campaign_shared_quotas.sql','utf8');
    const handoff = await readFile('database/migration_campaign_continuous_handoff.sql','utf8');
    await db.exec(shared); await db.exec(handoff); await db.exec(shared); await db.exec(handoff);
    for (let i=0;i<ids.length;i++) await db.query('INSERT INTO pages(id,access_token) VALUES($1,$2)',[ids[i],token(i)]);
    for (const [i,user] of [[0,'111'],[1,'111'],[2,'222']]) check(await identity(i,user),true,'Verified identities can be registered');
    check((await db.query('SELECT record_page_campaign_quota_identity($1,$2,$3) value',[ids[1],hash('stale-token'),'999'])).rows[0].value,
        false,'A stale token cannot replace verified ownership');
    await db.query("INSERT INTO campaigns(id,page_id,status) VALUES($1,$2,'sending')",[campaign,ids[0]]);
    await db.query("INSERT INTO campaign_recipients(campaign_id,status) VALUES($1,'pending')",[campaign]);
    const stopped = randomUUID();
    await db.query("INSERT INTO campaigns(id,page_id,status) VALUES($1,$2,'draft')",[stopped,ids[1]]);

    check((await acquire(0)).acquired,true,'Healthy first Page acquires a worker');
    check((await acquire(1)).acquired,true,'Healthy Pages of one user can deliver independently');
    await release(1);
    const userLimited = await feedback(0,'user',true,120_000);
    check((await state(1)).campaign_delivery_cooldown_until !== null,true,'A user limit reaches another verified Page of that user');
    check((await state(2)).campaign_delivery_cooldown_until,null,'A user limit does not reach a different user');
    check((await state(3)).campaign_delivery_cooldown_until,null,'Unknown identities are not guessed');
    check((await db.query('SELECT next_attempt_at FROM campaigns WHERE id=$1',[stopped])).rows[0].next_attempt_at,null,'Manual Stop is preserved');
    await release(0,true);
    check((await acquire(1)).reason,'cooldown','Related Page waits for the same user cooldown');
    check((await acquire(2)).acquired,true,'An unrelated user continues during the cooldown');
    await release(2);

    // Recovery is shared too, preventing simultaneous probes of the same quota.
    await db.exec("UPDATE app_private.campaign_shared_quota_cooldowns SET retry_at=NOW()-INTERVAL '1 second'; UPDATE pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '1 second'");
    check((await acquire(0)).acquired,true,'A Page resumes after the user cooldown');
    check((await acquire(1)).reason,'busy','A related Page waits for the existing recovery probe');
    check((await acquire(2)).acquired,true,'A different user is independent during recovery');
    await release(2); await release(0);
    check((await acquire(1)).acquired,true,'A subsequent related Page takes over the probe');
    const held = await feedback(1,'page',false,0,100,0);
    check(held.concurrency<=5,true,'Shared recovery cannot be erased by optimistic capacity');
    check(held.interval_ms>=1000,true,'Shared recovery keeps conservative spacing');
    await release(1);

    await reset();await acquire(0);await feedback(0,'user',true,120_000);await release(0,true);
    await db.exec("UPDATE app_private.campaign_shared_quota_cooldowns SET retry_at=NOW()-INTERVAL '1 second'");
    await db.query("UPDATE pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '1 second' WHERE id=$1",[ids[1]]);
    await acquire(1);
    const ownCooldown=await acquire(0);
    check(ownCooldown.reason,'cooldown','A Page-specific provider cooldown takes priority over a related busy probe');
    check(Date.parse(ownCooldown.retry_at)>Date.now()+60_000,true,'The response retains the actual provider deadline');
    await release(1);

    await reset();
    await db.query('UPDATE pages SET access_token=$2 WHERE id=$1',[ids[1],'rotated-token']);
    await acquire(0); await feedback(0,'user',true,60_000); await release(0,true);
    check((await state(1)).campaign_delivery_cooldown_until,null,'Rotated tokens invalidate old ownership');
    await db.query('UPDATE pages SET access_token=$2 WHERE id=$1',[ids[1],token(1)]);

    await reset();
    for (const [i,key] of [[0,'555:messenger'],[1,'555:messenger'],[2,'555:pages']]) {
        await acquire(i); await feedback(i,{scope:'page',businessKeys:[key]}); await release(i);
    }
    await acquire(0);
    await feedback(0,{scope:'business',key:'555:messenger',businessKeys:['555:messenger']},true,180_000);
    await release(0,true);
    check((await state(1)).campaign_delivery_cooldown_until!==null,true,'An observed business quota reaches the matching Page');
    check((await state(2)).campaign_delivery_cooldown_until,null,'A different use case of the same business stays independent');
    check((await state(3)).campaign_delivery_cooldown_until,null,'An unobserved business membership is never inferred');

    await reset();
    for (const i of [0,2]) { await acquire(i);await feedback(i,{scope:'page',businessKeys:['777:messenger']});await release(i); }
    await acquire(0);
    await feedback(0,{scope:'user',businessKeys:['777:messenger'],targets:[
        {scope:'user',retryAfterMs:120_000},{scope:'business',key:'777:messenger',retryAfterMs:180_000}
    ]},true,180_000); await release(0,true);
    const userRetry=(await state(1)).campaign_delivery_cooldown_until;
    const businessRetry=(await state(2)).campaign_delivery_cooldown_until;
    check(new Date(businessRetry).getTime()-new Date(userRetry).getTime(),60_000,
        'Different shared quotas retain their own provider recovery deadlines');

    await reset();
    for (const i of [0,1]) { await acquire(i);await feedback(i,{scope:'page',businessKeys:['888:messenger']});await release(i); }
    await db.query("UPDATE app_private.campaign_page_business_quotas SET observed_at=NOW()-INTERVAL '25 hours' WHERE page_id=$1",[ids[1]]);
    await acquire(0);await feedback(0,{scope:'business',key:'888:messenger',businessKeys:['888:messenger']},true,60_000);await release(0,true);
    check((await state(1)).campaign_delivery_cooldown_until,null,'Expired business observations do not broaden a cooldown');

    await reset(); await acquire(0);
    await feedback(0,{scope:'business',key:'999:messenger'},true,60_000); await release(0,true);
    check((await db.query('SELECT count(*)::int count FROM app_private.campaign_shared_quota_cooldowns')).rows[0].count,0,
        'An unobserved business scope falls back to the affected Page');
    await reset(); await acquire(0); await feedback(0,'app',true,60_000); await release(0,true);
    check((await state(3)).campaign_delivery_cooldown_until!==null,true,'An actual app limit reaches every Page');

    await reset();
    check(typeof await dispatch(),'number','Due pending work queues a successor');
    check(await dispatch(),null,'Duplicate successor requests are bounded');
    check((await db.query('SELECT count(*)::int count FROM net.fixture_requests')).rows[0].count,1,'Only one HTTP request was queued');
    await reset();
    await db.query("UPDATE campaigns SET status='draft',background_delivery_enabled=FALSE WHERE id=$1",[campaign]);
    check(await dispatch(),null,'Manual Stop never starts a successor');
    await db.query("UPDATE campaigns SET status='sending',background_delivery_enabled=TRUE,next_attempt_at=NOW()+INTERVAL '1 minute' WHERE id=$1",[campaign]);
    check(await dispatch(),null,'A future retry window prevents a successor');
    await db.query('UPDATE campaigns SET next_attempt_at=NULL WHERE id=$1',[campaign]);
    await db.query("UPDATE campaign_recipients SET status='processing',claimed_at=NOW() WHERE campaign_id=$1",[campaign]);
    check(await dispatch(),null,'Fresh claimed rows do not create an empty-claim handoff loop');
    await db.query("UPDATE campaign_recipients SET claimed_at=NOW()-INTERVAL '11 minutes' WHERE campaign_id=$1",[campaign]);
    check(typeof await dispatch(),'number','An expired claim can recover through a successor');
    await reset();
    await db.query("UPDATE campaign_recipients SET status='pending',scheduled_at=NOW()+INTERVAL '1 hour' WHERE campaign_id=$1",[campaign]);
    check(await dispatch(),null,'Future recipient schedules are preserved');
    await db.query('UPDATE campaign_recipients SET scheduled_at=NULL WHERE campaign_id=$1',[campaign]);
    await acquire(0); check(await dispatch(),null,'An active worker prevents another successor');
    await release(0); await acquire(0); await feedback(0,'user',true,60_000); await release(0,true);
    check(await dispatch(),null,'Shared Meta cooldowns prevent successor dispatch');

    for (const role of ['anon','authenticated','service_role']) {
        for (const signature of ['record_page_campaign_quota_identity(uuid,text,text)',
            'acquire_page_campaign_delivery_v2(uuid,uuid)','request_campaign_delivery_continuation(uuid)']) {
            check((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') value',[role,signature])).rows[0].value,
                role==='service_role','Administrative RPC permissions are preserved');
        }
        check((await db.query("SELECT has_function_privilege($1,'acquire_page_campaign_delivery_local(uuid,uuid)','EXECUTE') value",[role])).rows[0].value,
            false,'Clients cannot bypass grouping through the local helper');
    }
    report.passed=true;
} catch(error) { report.passed=false;report.error={code:error.code||error.name,message:error.message};process.exitCode=1; }
finally { await db.close();console.log(JSON.stringify(report)); }
