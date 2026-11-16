// Real migration and SQL in a disposable local database. No network sends or
// production writes. Uses the same optional PGlite install as campaign-scale.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const require = createRequire(resolve('outputs/campaign-scale-tools/package.json'));
const { PGlite } = require('@electric-sql/pglite');
const db = await PGlite.create();
const report = { checks: 0, customerMessagesSent: 0, productionWrites: 0 };
const check = (actual, expected) => { assert.deepEqual(actual, expected); report.checks++; };
const migration = await readFile('database/migration_campaign_delivery_diagnostics.sql', 'utf8');
const campaign = randomUUID(), token = randomUUID();
const contacts = Array.from({ length: 8 }, () => randomUUID());
const scalar = async (sql, args = []) => (await db.query(sql, args)).rows[0].value;
const state = async () => (await db.query('SELECT * FROM campaigns WHERE id=$1', [campaign])).rows[0];
const finish = results => scalar('SELECT finish_campaign_recipient_batch($1,$2,$3::jsonb) value', [campaign, token, JSON.stringify(results)]);
async function rejects(results) {
    await assert.rejects(() => finish(results)); report.checks++;
}
try {
    await db.exec(`CREATE ROLE service_role; CREATE ROLE anon; CREATE ROLE authenticated;
        CREATE SCHEMA app_private;
        CREATE TABLE app_private.schema_migrations(version TEXT PRIMARY KEY, description TEXT);
        CREATE TABLE campaigns(id UUID PRIMARY KEY, is_loop BOOLEAN DEFAULT FALSE, recurrence TEXT DEFAULT 'none',
            sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, last_error TEXT, updated_at TIMESTAMPTZ);
        CREATE TABLE campaign_recipients(campaign_id UUID, contact_id UUID, status TEXT, claim_token UUID,
            claimed_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, error_message TEXT, PRIMARY KEY(campaign_id,contact_id));
        CREATE TABLE campaign_delivery_failures(campaign_id UUID, contact_id UUID, error_message TEXT,
            failed_at TIMESTAMPTZ, attempt_count SMALLINT, PRIMARY KEY(campaign_id,contact_id));`);
    const prepare = await readFile('database/migration_compact_campaign_delivery_prepare.sql', 'utf8');
    const mirrorStart = prepare.indexOf('CREATE OR REPLACE FUNCTION app_private.mirror_campaign_delivery_failure()');
    const mirrorEnd = prepare.indexOf('-- Extend the existing bounded retention job', mirrorStart);
    await db.exec(prepare.slice(mirrorStart, mirrorEnd));
    // Backfill only retained history; missing historical evidence stays unknown.
    await db.query('INSERT INTO campaigns(id,failed_count) VALUES($1,3)', [campaign]);
    await db.query('INSERT INTO campaign_delivery_failures VALUES($1,$2,$3,now(),1)', [campaign, contacts[7], "(#551) This person isn't available right now."]);
    await db.exec(migration);
    check((await state()).failure_counts, { recipient_unavailable: 1 });
    await db.exec(migration); // A second deployment must preserve totals.
    check((await state()).failure_counts, { recipient_unavailable: 1 });
    await db.query('UPDATE campaigns SET failed_count=0 WHERE id=$1', [campaign]);
    check((await state()).failure_counts, {});
    await db.query('DELETE FROM campaign_delivery_failures WHERE campaign_id=$1', [campaign]);
    for (const id of contacts) await db.query("INSERT INTO campaign_recipients VALUES($1,$2,'processing',$3,now(),NULL,NULL)", [campaign, id, token]);
    const recipientDiagnostic = { kind: 'recipient_unavailable', category: 'recipient_unavailable', source: 'meta', code: 551, subcode: 1545041 };
    check(await finish([
        { contact_id: contacts[0], success: true, error_message: null },
        { contact_id: contacts[1], success: false, error_message: 'Vague provider message', diagnostic: recipientDiagnostic },
        { contact_id: contacts[2], success: false, error_message: 'Legacy unknown message' }
    ]), 3);
    check((await state()).sent_count, 1);
    check((await state()).failed_count, 2);
    check((await state()).failure_counts, { recipient_unavailable: 1, unknown: 1 });
    check(await scalar('SELECT diagnostic value FROM campaign_delivery_failures WHERE contact_id=$1', [contacts[1]]), recipientDiagnostic);

    // A stale/duplicate claim cannot partially consume recipients or statistics.
    await rejects([{ contact_id: contacts[0], success: true }, { contact_id: contacts[3], success: true }]);
    check((await state()).sent_count, 1);
    check(await scalar('SELECT count(*)::int value FROM campaign_recipients WHERE contact_id=$1', [contacts[3]]), 1);
    await rejects([{ contact_id: contacts[3], success: true }, { contact_id: contacts[3], success: false }]);
    check((await state()).failed_count, 2);
    await rejects([{ contact_id: contacts[3], error_message: 'Missing success' }]);

    // A later checkpoint merges counts without replaying an earlier receipt.
    check(await finish([{ contact_id: contacts[3], success: false, error_message: 'DB failure',
        diagnostic: { kind: 'backend_failure', category: 'other', source: 'backend' } }]), 1);
    check((await state()).failure_counts, { recipient_unavailable: 1, unknown: 1, backend_failure: 1 });
    await db.query('DELETE FROM campaign_delivery_failures WHERE campaign_id=$1', [campaign]);
    check((await state()).failure_counts, { recipient_unavailable: 1, unknown: 1, backend_failure: 1 });

    // Recurring sends keep their queue and mirror evidence; rearming resets
    // this cycle's counters without deleting historical aggregate metadata.
    await db.query("UPDATE campaigns SET recurrence='daily' WHERE id=$1", [campaign]);
    check(await finish([{ contact_id: contacts[4], success: false, error_message: 'Meta permission failure',
        diagnostic: { kind: 'page_configuration', category: 'permission_missing', source: 'meta', code: 200 } }]), 1);
    check(await scalar('SELECT status value FROM campaign_recipients WHERE contact_id=$1', [contacts[4]]), 'failed');
    check(await scalar("SELECT diagnostic->>'code' value FROM campaign_delivery_failures WHERE contact_id=$1", [contacts[4]]), '200');
    await db.query('UPDATE campaigns SET sent_count=0,failed_count=0 WHERE id=$1', [campaign]);
    check((await state()).failure_counts, {});

    await db.query("UPDATE campaigns SET last_error='DB unavailable',last_error_diagnostic=$2 WHERE id=$1", [campaign, { kind: 'backend_failure' }]);
    check((await state()).last_error_diagnostic, { kind: 'backend_failure' });
    await db.query("UPDATE campaigns SET last_error='A second DB error',last_error_diagnostic=$2 WHERE id=$1", [campaign,
        { kind: 'backend_failure', message: 'A second DB error' }]);
    check((await state()).last_error_diagnostic, { kind: 'backend_failure', message: 'A second DB error' });
    await db.query("UPDATE campaigns SET last_error='A different error' WHERE id=$1", [campaign]);
    check((await state()).last_error_diagnostic, null);
    await db.query('UPDATE campaigns SET last_error=NULL WHERE id=$1', [campaign]);
    check((await state()).last_error_diagnostic, null);
    for (const role of ['anon', 'authenticated']) check(await scalar("SELECT has_function_privilege($1,'public.finish_campaign_recipient_batch(uuid,uuid,jsonb)','EXECUTE') value", [role]), false);
    check(await scalar("SELECT app_private.classify_delivery_failure('(#10) Permission denied') value"), 'page_configuration');
    console.log(JSON.stringify(report, null, 2));
} finally { await db.close(); }
