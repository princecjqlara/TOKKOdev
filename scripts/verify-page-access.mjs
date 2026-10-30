// Read-only checks of the application's real PostgREST queries across every
// Page and account. Run: node --env-file=.env.local scripts/verify-page-access.mjs
// Output contains counts and error codes, never emails or access tokens.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error('Configure the Supabase URL and service role key.');
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const failures = [];
let memberLookups = 0, assignmentLookups = 0, operationalReads = 0;
const optionalMissingTables = new Set();

async function rows(table, columns, order, filter = query => query) {
    const collected = [];
    let total;
    do {
        let query = filter(db.from(table).select(columns, { count: 'exact' }));
        for (const column of order) query = query.order(column);
        const result = await query.range(collected.length, collected.length + 499).abortSignal(AbortSignal.timeout(15000));
        if (result.error) throw new Error(`${table}: ${result.error.code || 'request_failed'}`);
        assert.notEqual(result.count, null, `${table}: exact count missing`);
        total = result.count;
        assert.ok(result.data.length || collected.length === total, `${table}: incomplete results`);
        collected.push(...result.data);
    } while (collected.length < total);
    assert.equal(collected.length, total, `${table}: count changed during verification`);
    return collected;
}

async function selector(path, matches) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
    const selections = [...source.matchAll(/\.select\((['"`])([\s\S]*?)\1/g)].map(match => match[2]);
    const found = selections.filter(matches);
    assert.equal(found.length, 1, `${path}: expected one membership selector`);
    return { path, columns: found[0] };
}

async function pool(jobs) {
    let index = 0;
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (index < jobs.length) {
            const job = jobs[index++];
            try { await job.run(); }
            catch (error) { failures.push({ check: job.label, error: error.message }); }
        }
    }));
}

const [pages, accounts, memberships, memberSelectors, assignmentSelectors] = await Promise.all([
    rows('pages', 'id', ['id']),
    rows('users', 'id', ['id']),
    rows('user_pages', 'user_id,page_id', ['user_id', 'page_id']),
    Promise.all([
        'src/app/api/team-access/route.ts',
        'src/app/api/pages/[pageId]/team/route.ts',
        'src/app/api/pages/[pageId]/history/route.ts'
    ].map(path => selector(path, columns => columns.includes('users:users!user_pages_user_id_fkey(')))),
    Promise.all([
        selector('src/lib/page-managers.ts', columns => columns.startsWith('grant_source,pages(')),
        selector('src/app/api/pages/route.ts', columns => /\bpages\s*\(/.test(columns))
    ])
]);
const pageIds = new Set(pages.map(page => page.id));
const accountIds = new Set(accounts.map(account => account.id));
const keys = memberships.map(row => `${row.user_id}:${row.page_id}`);
const orphanMemberships = memberships.filter(row => !pageIds.has(row.page_id) || !accountIds.has(row.user_id)).length;
const duplicateMemberships = keys.length - new Set(keys).size;
assert.equal(orphanMemberships, 0, 'Orphaned Page assignments found');
assert.equal(duplicateMemberships, 0, 'Duplicate Page assignments found');

console.log(JSON.stringify({ phase: 'inventory', pages: pages.length, accounts: accounts.length, memberships: memberships.length }));
const jobs = [];
for (const [pageIndex, page] of pages.entries()) {
    const expected = memberships.filter(row => row.page_id === page.id).map(row => row.user_id).sort();
    for (const { path, columns } of memberSelectors) jobs.push({
        label: `page-${pageIndex + 1}:${path}`,
        async run() {
            const actual = await rows('user_pages', columns, ['user_id'], query => query.eq('page_id', page.id));
            assert.deepEqual(actual.map(row => row.user_id).sort(), expected, 'Member list differs from assignments');
            for (const row of actual) {
                const user = Array.isArray(row.users) ? row.users[0] : row.users;
                assert.equal(user?.id, row.user_id, 'Joined the grantor instead of the assigned member');
            }
            memberLookups++;
        }
    });
    for (const resource of [
        { table: 'contacts', columns: 'id,page_id', column: 'page_id' },
        { table: 'tags', columns: 'id,owner_id', column: 'owner_id' },
        { table: 'campaigns', columns: 'id,page_id,pages(name)', column: 'page_id' },
        { table: 'page_activity_history', columns: 'id,page_id', column: 'page_id' },
        { table: 'tokko_page_managers', columns: 'user_id,page_id', column: 'page_id' }
    ]) jobs.push({
        label: `page-${pageIndex + 1}:${resource.table}`,
        async run() {
            let query = db.from(resource.table).select(resource.columns).eq(resource.column, page.id);
            if (resource.table === 'tags') query = query.eq('owner_type', 'page');
            const { data, error } = await query.limit(1).abortSignal(AbortSignal.timeout(15000));
            // The history endpoint explicitly tolerates its optional audit table.
            if (resource.table === 'page_activity_history' && ['42P01', 'PGRST205'].includes(error?.code)) {
                optionalMissingTables.add(resource.table);
                return;
            }
            if (error) throw new Error(`${resource.table}: ${error.code || 'request_failed'}`);
            assert.ok(data.every(row => row[resource.column] === page.id), 'Read returned data for a different Page');
            operationalReads++;
        }
    });
}
for (const [accountIndex, account] of accounts.entries()) {
    const expected = memberships.filter(row => row.user_id === account.id).map(row => row.page_id).sort();
    for (const { path, columns } of assignmentSelectors) jobs.push({
        label: `account-${accountIndex + 1}:${path}`,
        async run() {
            const actual = await rows('user_pages', columns, ['page_id'], query => query.eq('user_id', account.id));
            assert.deepEqual(actual.map(row => (Array.isArray(row.pages) ? row.pages[0] : row.pages)?.id).sort(), expected, 'Assigned Page list is incomplete or contains another account\'s Pages');
            assignmentLookups++;
        }
    });
}
await pool(jobs);
console.log(JSON.stringify({ pages: pages.length, accounts: accounts.length, memberships: memberships.length, memberLookups, assignmentLookups, operationalReads, optionalMissingTables: [...optionalMissingTables], orphanMemberships, duplicateMemberships, failures, passed: failures.length === 0 }));
if (failures.length) process.exitCode = 1;
