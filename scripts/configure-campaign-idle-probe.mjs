// Install only stale-pacing recovery. Does not invoke a sender, clear cooldowns,
// resume campaigns, or change recipients. Preflight fixtures are rolled back.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

const apply = process.argv.includes('--apply');
assert.equal(Number(apply) + Number(process.argv.includes('--preflight')), 1, 'Choose --preflight or --apply');
const db = new Client({ connectionString: process.env.DATABASE_POOLER_URL_5432 || process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000, query_timeout: 15000 });
const signature = 'public.acquire_page_campaign_delivery(uuid,uuid)';
const report = { checkedAt: new Date().toISOString(), mode: apply ? 'apply' : 'preflight',
    checks: 0, committed: false, fixturesRolledBack: false, customerMessagesSent: 0 };
const check = (actual, expected, message) => { assert.deepEqual(actual, expected, message); report.checks++; };
const pageState = async () => (await db.query(`SELECT id,campaign_delivery_concurrency,campaign_delivery_interval_ms,
    campaign_delivery_cooldown_until,campaign_delivery_owner,campaign_delivery_lease_until,
    campaign_delivery_feedback_at,campaign_delivery_rate_strikes FROM public.pages ORDER BY id`)).rows;
const campaignState = async () => (await db.query(`SELECT id,status,background_delivery_enabled,
    sent_count,failed_count,next_attempt_at FROM public.campaigns ORDER BY id`)).rows;
try {
    await db.connect(); await db.query('BEGIN');
    await db.query("SET LOCAL statement_timeout='12s'; SET LOCAL lock_timeout='3s'");
    if (apply) check((await db.query("SELECT to_regprocedure('public.acquire_page_campaign_delivery_local(uuid,uuid)') IS NOT NULL installed")).rows[0].installed,
        false, 'Shared quota coordination is already installed; use configure-campaign-shared-quotas.mjs instead of replacing its wrapper');
    check((await db.query("SELECT pg_try_advisory_xact_lock(hashtextextended('tokko-campaign-idle-probe-install',0)) acquired")).rows[0].acquired,
        true, 'Only one installation can proceed');
    const beforeDefinition = (await db.query('SELECT pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0].definition;
    const beforePages = await pageState(), beforeCampaigns = await campaignState();
    if (apply) {
        await mkdir('.vercel/backups', { recursive: true });
        report.backup = `.vercel/backups/campaign-idle-probe-${Date.now()}.json`;
        await writeFile(report.backup, JSON.stringify({ definition: beforeDefinition, pages: beforePages, campaigns: beforeCampaigns }, null, 2), { flag: 'wx' });
    }
    const migration = (await readFile('database/migration_campaign_delivery_idle_probe.sql', 'utf8'))
        .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');
    await db.query(migration);
    check(await pageState(), beforePages, 'Installation preserves saved Page pacing, cooldowns, and leases');
    check(await campaignState(), beforeCampaigns, 'Installation preserves all campaign states, counters, and retry windows');
    for (const role of ['anon', 'authenticated', 'service_role']) {
        check((await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') allowed", [role, signature])).rows[0].allowed,
            role === 'service_role', 'Only server roles may acquire delivery');
    }
    const definition = (await db.query('SELECT pg_get_functiondef($1::regprocedure) definition', [signature])).rows[0].definition;
    check(definition.includes('v_probe'), true, 'Installed function contains stale-pacing recovery');

    await db.query('SAVEPOINT fixture');
    await db.query('CREATE TEMP TABLE pages (LIKE public.pages INCLUDING ALL) ON COMMIT DROP');
    await db.query(definition.replaceAll('public.', 'pg_temp.').replaceAll("search_path TO 'public'", "search_path TO 'pg_temp'"));
    const page = randomUUID(), owner = randomUUID(), other = randomUUID();
    await db.query(`INSERT INTO pg_temp.pages(id,fb_page_id,name,access_token,campaign_delivery_concurrency,
        campaign_delivery_interval_ms,campaign_delivery_feedback_at,campaign_delivery_last_rate_limit_at,
        campaign_delivery_cooldown_until) VALUES($1,$2,'Synthetic stale Page','fixture-only',1,5000,
        NOW()-INTERVAL '2 hours',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour')`, [page, `fixture-${page}`]);
    check((await db.query('SELECT * FROM pg_temp.acquire_page_campaign_delivery($1,$2)', [page, owner])).rows[0].batch_size,
        5, 'Deployed SQL resumes a stale slow fixture at default capacity');
    check((await db.query('SELECT campaign_delivery_interval_ms pace FROM pg_temp.pages WHERE id=$1', [page])).rows[0].pace,
        100, 'Deployed SQL restores conservative default spacing');
    check((await db.query('SELECT * FROM pg_temp.acquire_page_campaign_delivery($1,$2)', [page, other])).rows[0].acquired,
        false, 'Concurrent workers cannot bypass the Page lease');
    await db.query("UPDATE pg_temp.pages SET campaign_delivery_lease_until=NULL,campaign_delivery_cooldown_until=NOW()+INTERVAL '1 minute'");
    check((await db.query('SELECT * FROM pg_temp.acquire_page_campaign_delivery($1,$2)', [page, owner])).rows[0].acquired,
        false, 'Provider cooldowns remain enforced');
    await db.query('ROLLBACK TO SAVEPOINT fixture'); report.fixturesRolledBack = true;
    check(await pageState(), beforePages, 'Fixtures never alter customer Pages');
    check(await campaignState(), beforeCampaigns, 'Fixtures never resume or mutate customer campaigns');
    if (apply) { await db.query('COMMIT'); report.committed = true; }
    else await db.query('ROLLBACK');
    report.passed = true;
} catch (error) {
    await db.query('ROLLBACK').catch(() => {}); report.passed = false;
    report.error = { code: error.code || error.name, message: error.message }; process.exitCode = 1;
} finally {
    await db.end(); await mkdir('outputs', { recursive: true });
    await writeFile(`outputs/campaign-idle-probe-${report.mode}.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
}
