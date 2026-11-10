// Execute production SQL in a disposable local database. No customer records,
// production writes, Facebook requests, or real-time cooldown waits.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const report = { checks: 0, customerMessagesSent: 0, productionWrites: 0 };
const page = randomUUID(), other = randomUUID(), owner = randomUUID(), nextOwner = randomUUID();
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); report.checks++; }
async function feedback(concurrency = null, interval = null, limited = false, retryMs = 0, scope = 'page', worker = owner) {
    return (await db.query('SELECT report_page_campaign_delivery_feedback($1,$2,$3,$4,$5,$6,$7) value',
        [page,worker,concurrency,interval,limited,retryMs,scope])).rows[0].value;
}
async function acquire(worker = owner) { return (await db.query('SELECT * FROM acquire_page_campaign_delivery($1,$2)',[page,worker])).rows[0]; }
async function release(limited = false, worker = owner) { return (await db.query('SELECT release_page_campaign_delivery($1,$2,$3) value',[page,worker,limited])).rows[0].value; }
try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY,description TEXT);
        CREATE TABLE pages(id UUID PRIMARY KEY,campaign_delivery_owner UUID,campaign_delivery_lease_until TIMESTAMPTZ,
            campaign_delivery_cooldown_until TIMESTAMPTZ,campaign_delivery_rate_strikes INTEGER DEFAULT 0,
            campaign_delivery_last_rate_limit_at TIMESTAMPTZ);
        CREATE TABLE campaigns(id UUID PRIMARY KEY,page_id UUID,status TEXT,next_attempt_at TIMESTAMPTZ);
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon,authenticated;`);
    await db.exec(await readFile('database/migration_campaign_delivery_adaptive.sql','utf8'));
    const migration = await readFile('database/migration_campaign_delivery_recovery_pace.sql','utf8');
    await db.exec(migration); await db.exec(migration);
    await db.query('INSERT INTO pages(id) VALUES($1),($2)',[page,other]);
    for (const status of ['sending','scheduled','draft','cancelled','completed']) {
        await db.query('INSERT INTO campaigns VALUES($1,$2,$3,NULL)',[randomUUID(),page,status]);
    }
    check((await acquire()).acquired,true,'The Page can be acquired');
    const healthy = await feedback(50,10);
    check(healthy.concurrency,50,'Healthy Pages retain their available capacity');
    check(healthy.interval_ms,10,'Healthy Pages retain their learned message spacing');
    check(healthy.growth_after,null,'No recovery hold is invented for healthy Pages');
    const rejected = await feedback(100,0,false,0,'page',nextOwner);
    check(rejected.owned,false,'A stale or unauthorized lease owner cannot change pacing');
    check((await feedback()).concurrency,50,'A stale update leaves the current budget unchanged');

    const throttled = await feedback(25,20,true,120000);
    check(throttled.concurrency,5,'A newly throttled Page begins conservative recovery');
    check(throttled.interval_ms,1000,'A newly throttled Page receives at least one second spacing');
    check(Date.parse(throttled.growth_after)-Date.parse(throttled.retry_at),600000,'Growth remains deferred for ten minutes after the cooldown');
    check((await db.query('SELECT campaign_delivery_cooldown_until cooldown FROM pages WHERE id=$1',[other])).rows[0].cooldown,null,'Page throttles remain local');
    const repeated = await feedback(25,20,true);
    check(repeated.retry_at,throttled.retry_at,'Repeated reports do not slide the same cooldown forward');
    check(new Date(await release(true)).getTime(),Date.parse(throttled.retry_at),'Final lease release does not extend a saved cooldown');
    check((await acquire()).acquired,false,'Active provider recovery windows remain enforced');
    for (const campaign of (await db.query('SELECT status,next_attempt_at FROM campaigns')).rows) {
        check(Boolean(campaign.next_attempt_at),['sending','scheduled'].includes(campaign.status),'Paused and terminal campaigns remain untouched');
    }

    await db.query(`UPDATE pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '1 second',
        campaign_delivery_last_rate_limit_at=NOW(),campaign_delivery_rate_strikes=4,
        campaign_delivery_concurrency=50,campaign_delivery_interval_ms=100 WHERE id=$1`,[page]);
    check((await acquire()).acquired,true,'Recovery permits delivery after the saved cooldown');
    const recovering = await feedback();
    check(recovering.concurrency,1,'Repeated throttles retain a single worker');
    check(recovering.interval_ms,5000,'Repeated throttles retain five-second spacing');
    const optimistic = await feedback(100,0);
    check(optimistic.concurrency,1,'Clean responses cannot immediately restore a burst');
    check(optimistic.interval_ms,5000,'Clean responses cannot immediately erase learned spacing');
    check(optimistic.growth_after,recovering.growth_after,'Reporting success does not slide the growth hold');
    await release();
    check((await acquire(nextOwner)).acquired,true,'A subsequent worker can resume delivery');
    const restart = await feedback(null,null,false,0,'page',nextOwner);
    check(restart.concurrency,1,'A worker restart retains the same recovery budget');
    check(restart.growth_after,recovering.growth_after,'A worker restart retains the absolute recovery deadline');
    await db.query(`UPDATE pages SET campaign_delivery_cooldown_until=NOW()-INTERVAL '20 minutes',
        campaign_delivery_last_rate_limit_at=NOW()-INTERVAL '20 minutes' WHERE id=$1`,[page]);
    const restored = await feedback(20,50,false,0,'page',nextOwner);
    check(restored.concurrency,20,'Capacity can increase after sustained recovery');
    check(restored.interval_ms,50,'Spacing can reduce after sustained recovery');

    await db.query(`UPDATE pages SET campaign_delivery_cooldown_until=NOW()+INTERVAL '40 minutes',
        campaign_delivery_concurrency=20,campaign_delivery_interval_ms=50 WHERE id=$1`,[other]);
    const priorOtherCooldown = (await db.query('SELECT campaign_delivery_cooldown_until value FROM pages WHERE id=$1',[other])).rows[0].value;
    const appLimit = await feedback(5,500,true,180000,'app',nextOwner);
    const shared = (await db.query('SELECT campaign_delivery_concurrency,campaign_delivery_interval_ms,campaign_delivery_cooldown_until FROM pages WHERE id=$1',[other])).rows[0];
    check(shared.campaign_delivery_concurrency,5,'App throttles reduce other Pages too');
    check(shared.campaign_delivery_interval_ms,1000,'App throttles retain conservative shared spacing');
    check(shared.campaign_delivery_cooldown_until,priorOtherCooldown,'Existing longer recovery windows are never shortened');
    check(new Date(await release(true,nextOwner)).getTime(),Date.parse(appLimit.retry_at),'App feedback and release agree on the saved recovery window');
    for (const role of ['anon','authenticated','service_role']) {
        const allowed = (await db.query("SELECT has_function_privilege($1,'report_page_campaign_delivery_feedback(uuid,uuid,integer,integer,boolean,integer,text)','EXECUTE') value",[role])).rows[0].value;
        check(allowed,role==='service_role','Only server roles can report Page feedback');
    }
    report.passed = true;
} catch (error) { report.passed=false; report.error={code:error.code||error.name,message:error.message};process.exitCode=1; }
finally { await db.close();console.log(JSON.stringify(report)); }
