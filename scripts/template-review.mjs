import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import nextEnv from '@next/env';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { loadEnvConfig } = nextEnv;
const OUT = path.join(ROOT, 'outputs', 'template-review');
const GRAPH = 'https://graph.facebook.com/v21.0';
const require = createRequire(import.meta.url);
const modules = new Map();

function loadSource(relativePath) {
    const filename = path.resolve(ROOT, relativePath);
    if (modules.has(filename)) return modules.get(filename).exports;
    const mod = { exports: {} };
    modules.set(filename, mod);
    const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
    }).outputText;
    const localRequire = (id) => id.startsWith('.')
        ? id.endsWith('.json') ? JSON.parse(fs.readFileSync(path.resolve(path.dirname(filename), id), 'utf8'))
            : loadSource(path.relative(ROOT, path.resolve(path.dirname(filename), `${id}.ts`)))
        : require(id);
    new Function('require', 'module', 'exports', output)(localRequire, mod, mod.exports);
    return mod.exports;
}

export function isVerifiedCandidate(candidate, remote) {
    const language = typeof remote.language === 'string' ? remote.language : remote.language?.code;
    const body = remote.components?.find(component => component.type === 'BODY');
    return remote.name === candidate.name &&
        ['APPROVED', 'ACTIVE'].includes(String(remote.status).toUpperCase()) &&
        String(remote.category).toUpperCase() === 'UTILITY' && language === 'en_US' &&
        body?.text === candidate.components[0].text &&
        remote.components.every(component => component.type === 'BODY') &&
        remote.components.length === 1;
}

export function parseReviewBatch(candidates, entries) {
    if (!Array.isArray(entries) || entries.length !== candidates.length) {
        throw new Error('Facebook returned an incomplete template batch; check live statuses before resuming.');
    }
    return candidates.map((candidate, index) => {
        const entry = entries[index];
        let body;
        try { body = JSON.parse(entry?.body || '{}'); }
        catch { body = { error: { message: 'Invalid Facebook batch response' } }; }
        return entry?.code >= 200 && entry.code < 300 && !body.error
            ? { name: candidate.name, status: String(body.status || 'PENDING').toUpperCase(), id: body.id || null }
            : { name: candidate.name, status: body.error?.code === 100 ? 'INVALID' : 'ERROR',
                error: body.error?.message || `Facebook HTTP ${entry?.code || 'unknown'}`, code: body.error?.code,
                subcode: body.error?.error_subcode, details: body.error?.error_user_msg || body.error?.error_data?.details };
    });
}

export function isBlockingReviewError(entry) {
    return entry.status === 'ERROR' && ![-1, 960].includes(entry.code);
}

export function isReviewRateLimit(entry) {
    return entry.status === 'ERROR' && [4, 17, 32, 613, 80001].includes(Number(entry.code));
}

export async function reviewWithCooldown(candidates, send, wait, onWait = () => {}) {
    const completed = new Map();
    let pending = candidates;
    let attempt = 0;
    while (pending.length) {
        let entries;
        try { entries = await send(pending); }
        catch (error) {
            if (!isReviewRateLimit({ status: 'ERROR', code: error.code })) throw error;
            entries = pending.map(candidate => ({ name: candidate.name, status: 'ERROR', code: error.code, error: error.message }));
        }
        const limited = new Set(entries.filter(isReviewRateLimit).map(entry => entry.name));
        for (const entry of entries) if (!limited.has(entry.name)) completed.set(entry.name, entry);
        pending = pending.filter(candidate => limited.has(candidate.name));
        if (!pending.length) break;
        const delay = Math.min(600000, 60000 * (2 ** Math.min(attempt++, 4)));
        onWait({ retrying: pending.length, delayMs: delay });
        await wait(delay);
    }
    return candidates.map(candidate => completed.get(candidate.name));
}

async function waitForCooldown(delay) {
    for (let remaining = delay; remaining > 0; remaining -= 30000) {
        await new Promise(resolve => setTimeout(resolve, Math.min(30000, remaining)));
        if (remaining > 30000) console.log(JSON.stringify({ cooldownRemainingSeconds: Math.ceil((remaining - 30000) / 1000) }));
    }
}

async function submitReviewBatch(page, candidates, getPayload) {
    const batch = candidates.map(candidate => {
        const payload = getPayload(candidate);
        return {
            method: 'POST', relative_url: `${page.fb_page_id}/message_templates`,
            body: new URLSearchParams({ name: payload.name, category: payload.category, language: payload.language, components: JSON.stringify(payload.components) }).toString()
        };
    });
    const response = await fetch(`${GRAPH}/`, {
        method: 'POST', headers: { Authorization: `Bearer ${page.access_token}` },
        body: new URLSearchParams({ batch: JSON.stringify(batch), include_headers: 'false' }),
        signal: AbortSignal.timeout(45000)
    });
    const result = await response.json();
    if (!response.ok || result.error) {
        const error = new Error(result.error?.message || `Facebook HTTP ${response.status}`);
        error.code = result.error?.code ?? (response.status === 429 ? 613 : undefined);
        throw error;
    }
    return parseReviewBatch(candidates, result);
}

function save(filename, data) {
    fs.mkdirSync(OUT, { recursive: true });
    const destination = path.join(OUT, filename);
    const temporary = destination + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(temporary, destination);
}

async function graphRequest(page, nextUrl, payload) {
    const url = new URL(nextUrl || `${GRAPH}/${page.fb_page_id}/message_templates`);
    url.searchParams.delete('access_token');
    const response = await fetch(url, {
        method: payload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${page.access_token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(30000)
    });
    const result = await response.json();
    if (!response.ok || result.error) {
        const error = new Error(result.error?.message || `Facebook HTTP ${response.status}`);
        error.code = result.error?.code;
        throw error;
    }
    return result;
}

async function getTemplates(page) {
    const templates = new Map();
    const visited = new Set();
    let nextUrl = `${GRAPH}/${page.fb_page_id}/message_templates?fields=id,name,status,category,language,components&limit=100`;
    while (nextUrl) {
        if (visited.has(nextUrl)) throw new Error('Facebook repeated a template pagination cursor');
        visited.add(nextUrl);
        const result = await graphRequest(page, nextUrl);
        for (const template of result.data || []) {
            const language = typeof template.language === 'string' ? template.language : template.language?.code;
            templates.set(template.id || `${template.name}:${language}`, template);
        }
        nextUrl = result.paging?.next || null;
    }
    return [...templates.values()];
}

async function main() {
    const [command = 'catalog', ...args] = process.argv.slice(2);
    const option = name => {
        const index = args.indexOf(`--${name}`);
        return index === -1 ? undefined : args[index + 1];
    };
    if (!['catalog', 'audit', 'check', 'submit', 'review', 'promote'].includes(command)) {
        throw new Error('Use catalog, audit, check, submit, review, or promote. Page commands require --page <id or exact name>.');
    }
    const { TEMPLATE_CANDIDATES, getCandidatePayload } = loadSource('src/lib/facebook-template-candidates.ts');
    if (command === 'catalog') {
        save('catalog.json', TEMPLATE_CANDIDATES);
        const { UTILITY_TEMPLATES, ALL_UTILITY_TEMPLATES } = loadSource('src/lib/facebook-templates.ts');
        console.log(JSON.stringify({ candidates: TEMPLATE_CANDIDATES.length, activeTemplates: UTILITY_TEMPLATES.length,
            retiredTemplates: ALL_UTILITY_TEMPLATES.length - UTILITY_TEMPLATES.length,
            tones: ['casual', 'friendly', 'neutral', 'formal'], file: 'outputs/template-review/catalog.json' }));
        return;
    }
    if (command !== 'audit' && !option('page')) throw new Error('--page is required; choose a page explicitly.');
    loadEnvConfig(ROOT);
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: pages, error } = await db.from('pages').select('id,name,fb_page_id,access_token');
    if (error) throw new Error(error.message);
    const selected = option('page')
        ? pages.filter(page => [page.id, page.fb_page_id, page.name.trim()].includes(option('page')))
        : pages;
    if (!selected.length) throw new Error('Page not found.');
    if (command !== 'audit' && selected.length !== 1) throw new Error('Page name is ambiguous. Use its database or Facebook ID.');
    const audit = [];
    for (const page of selected) {
        const publicPage = { id: page.id, name: page.name, fbPageId: page.fb_page_id };
        let templates;
        try {
            templates = await getTemplates(page);
        } catch (error) {
            if (command !== 'audit') throw error;
            const entry = { ...publicPage, error: error.message };
            audit.push(entry);
            console.log(JSON.stringify(entry));
            continue;
        }
        const checkedAt = new Date().toISOString();
        const statuses = templates.reduce((counts, template) => {
            const status = String(template.status || 'UNKNOWN').toUpperCase();
            counts[status] = (counts[status] || 0) + 1;
            return counts;
        }, {});
        save(`${page.fb_page_id}-status.json`, { page: publicPage, checkedAt, statuses, templates });
        if (command === 'audit') save('audit.json', { checkedAt, pages: [...audit, { ...publicPage, checkedAt, total: templates.length, statuses }] });
        console.log(JSON.stringify({ ...publicPage, total: templates.length, statuses }));
        audit.push({ ...publicPage, checkedAt, total: templates.length, statuses });
        if (command === 'audit' || command === 'check') continue;
        if (command === 'review') {
            const limit = Number(option('limit') || TEMPLATE_CANDIDATES.length);
            if (!Number.isInteger(limit) || limit < 1 || limit > TEMPLATE_CANDIDATES.length) throw new Error('Invalid catalog review limit.');
            const batchSize = Number(option('batch-size') || 5);
            const concurrency = Number(option('concurrency') || 1);
            if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
                throw new Error('Use a batch size of 1 to 10 and concurrency of 1 to 4. Larger review batches can be aborted by Facebook.');
            }
            const names = new Set(templates.map(template => template.name));
            const bodies = new Set(templates.flatMap(template => template.components || []).filter(c => c.type === 'BODY').map(c => c.text));
            const groups = ['casual', 'friendly', 'neutral', 'formal'].map(tone => TEMPLATE_CANDIDATES.filter(c => c.tone === tone));
            const ordered = groups[0].flatMap((_, index) => groups.map(group => group[index]).filter(Boolean));
            const reviewedElsewhere = new Set();
            const ownProgressPath = path.join(OUT, `${page.fb_page_id}-review.json`);
            if (fs.existsSync(ownProgressPath)) {
                const ownProgress = JSON.parse(fs.readFileSync(ownProgressPath, 'utf8'));
                for (const entry of ownProgress.results || []) {
                    if (entry.status === 'INVALID' || (entry.status === 'ERROR' && entry.code === 100)) reviewedElsewhere.add(entry.name);
                }
            }
            if (args.includes('--unreviewed')) {
                for (const file of fs.readdirSync(OUT).filter(file => /^\d+-(status|review)\.json$/.test(file))) {
                    const snapshot = JSON.parse(fs.readFileSync(path.join(OUT, file), 'utf8'));
                    for (const entry of snapshot.templates || snapshot.results || []) {
                        if (['APPROVED', 'ACTIVE', 'REJECTED', 'INVALID'].includes(entry.status) || (entry.status === 'ERROR' && entry.code === 100)) reviewedElsewhere.add(entry.name);
                    }
                }
            }
            const remaining = ordered.filter(candidate => !names.has(candidate.name) && !reviewedElsewhere.has(candidate.name)).slice(0, limit);
            const reportName = `${page.fb_page_id}-review.json`;
            const reportPath = path.join(OUT, reportName);
            const currentNames = new Set(TEMPLATE_CANDIDATES.map(candidate => candidate.name));
            const previous = fs.existsSync(reportPath)
                ? (JSON.parse(fs.readFileSync(reportPath, 'utf8')).results || []).filter(result => currentNames.has(result.name))
                : [];
            const results = new Map(previous.map(result => [result.name, result]));
            let stopped = null;
            let nextOffset = 0;
            let processed = 0;
            let failedServerBatches = 0;
            async function worker() {
              while (!stopped && nextOffset < remaining.length) {
                const offset = nextOffset;
                nextOffset += batchSize;
                const batch = remaining.slice(offset, offset + batchSize);
                try {
                    const send = selection => submitReviewBatch(page, selection, getCandidatePayload);
                    const entries = args.includes('--wait')
                        ? await reviewWithCooldown(batch, send, waitForCooldown, details => {
                            console.log(JSON.stringify({ waitingForFacebookRateLimit: true, ...details }));
                            save(`${page.fb_page_id}-cooldown.json`, { page: publicPage, checkedAt: new Date().toISOString(), ...details });
                        })
                        : await send(batch);
                    for (const entry of entries) results.set(entry.name, { ...entry, checkedAt: new Date().toISOString() });
                    processed += batch.length;
                    const summary = entries.reduce((counts, entry) => ({ ...counts, [entry.status]: (counts[entry.status] || 0) + 1 }), {});
                    console.log(JSON.stringify({ processedThisRun: processed, plannedThisRun: remaining.length, batch: summary }));
                    failedServerBatches = entries.every(entry => entry.status === 'ERROR') ? failedServerBatches + 1 : 0;
                    stopped = stopped || entries.find(isBlockingReviewError)?.error ||
                        (failedServerBatches >= 3 ? 'Facebook failed three entire batches; review stopped for recovery.' : null);
                } catch (error) {
                    stopped = error.message;
                }
                save(reportName, { page: publicPage, checkedAt: new Date().toISOString(), plannedThisRun: remaining.length, processedThisRun: processed, batchSize, concurrency, stopped, results: [...results.values()] });
              }
            }
            await Promise.all(Array.from({ length: concurrency }, () => worker()));
            // Submission responses are observations only. Promotion always reads live statuses again.
            if (stopped) { console.error(stopped); process.exitCode = 1; }
            continue;
        }
        if (command === 'submit') {
            const tone = option('tone');
            if (tone && !['casual', 'friendly', 'neutral', 'formal'].includes(tone)) throw new Error('Unknown tone.');
            const limit = Number(option('limit') || 25);
            if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new Error('--limit must be between 1 and 25.');
            const names = new Set(templates.map(template => template.name));
            const bodies = new Set(templates.flatMap(template => template.components || []).filter(c => c.type === 'BODY').map(c => c.text));
            // Take a mix of all tones by default so initial review is representative.
            const groups = ['casual', 'friendly', 'neutral', 'formal'].map(t => TEMPLATE_CANDIDATES.filter(c => c.tone === t));
            const ordered = tone ? TEMPLATE_CANDIDATES.filter(c => c.tone === tone)
                : groups[0].flatMap((_, index) => groups.map(group => group[index]).filter(Boolean));
            const batch = ordered.filter(candidate => !names.has(candidate.name) && !bodies.has(candidate.components[0].text)).slice(0, limit);
            const results = [];
            for (const candidate of batch) {
                try {
                    const result = await graphRequest(page, null, getCandidatePayload(candidate));
                    results.push({ name: candidate.name, status: result.status || 'PENDING', id: result.id || null });
                } catch (error) {
                    results.push({ name: candidate.name, status: 'ERROR', error: error.message });
                    // Stop on the first failure; avoid repeating a rate or capacity failure.
                    break;
                }
                save(`${page.fb_page_id}-submissions.json`, { page: publicPage, checkedAt, results });
            }
            save(`${page.fb_page_id}-submissions.json`, { page: publicPage, checkedAt, results });
            console.log(JSON.stringify({ submitted: results.length, results }, null, 2));
        }
        if (command === 'promote') {
            const { UTILITY_TEMPLATES } = loadSource('src/lib/facebook-templates.ts');
            const knownBodies = new Set(UTILITY_TEMPLATES.map(template => template.components.find(c => c.type === 'BODY')?.text));
            const knownNames = new Set(UTILITY_TEMPLATES.map(template => template.name));
            const approved = args.includes('--existing')
                ? templates.filter(remote => {
                    const body = remote.components?.find(c => c.type === 'BODY');
                    if (!/^[a-z0-9_]{1,64}$/.test(remote.name) || !body?.text || body.text.length > 70 ||
                        knownNames.has(remote.name) || knownBodies.has(body.text) ||
                        JSON.stringify(body.text.match(/\{\{\d+\}\}/g)) !== JSON.stringify(['{{1}}']) ||
                        !isVerifiedCandidate({ name: remote.name, components: [body] }, remote)) return false;
                    knownBodies.add(body.text);
                    return true;
                }).map(remote => ({ name: remote.name, category: 'UTILITY', paramCount: 1, components: remote.components }))
                : TEMPLATE_CANDIDATES.filter(candidate => templates.some(remote => isVerifiedCandidate(candidate, remote)));
            const manifestPath = path.join(ROOT, 'src/lib/facebook-templates-approved.json');
            const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            const candidateNames = new Set(TEMPLATE_CANDIDATES.map(candidate => candidate.name));
            const evidencePath = path.join(ROOT, 'docs/template-review-results.json');
            const previousEvidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
            const priorRecords = args.includes('--merge')
                ? (previousEvidence?.verified || []).filter(record => candidateNames.has(record.name) &&
                    (record.sourcePageId || previousEvidence.page?.fbPageId) !== page.fb_page_id)
                    .map(record => ({ ...record, sourcePageId: record.sourcePageId || previousEvidence.page.fbPageId }))
                : [];
            const priorVerified = new Set(priorRecords.map(record => record.name));
            // Refresh generated entries from current decisions, including any withdrawn approval.
            const retained = args.includes('--existing') ? existing : existing.filter(template => !candidateNames.has(template.name) || priorVerified.has(template.name));
            const merged = new Map(retained.map(template => [template.name, template]));
            for (const candidate of approved) {
                const { tone: _tone, topic: _topic, ...definition } = candidate;
                merged.set(candidate.name, definition);
            }
            const { compareTemplates } = loadSource('src/lib/facebook-template-order.ts');
            const manifestTemporary = manifestPath + '.tmp';
            fs.writeFileSync(manifestTemporary, JSON.stringify([...merged.values()].sort(compareTemplates), null, 2) + '\n');
            fs.renameSync(manifestTemporary, manifestPath);
            const sourcePages = new Map((args.includes('--merge') ? previousEvidence?.sourcePages || [previousEvidence?.page].filter(Boolean) : [])
                .map(source => [source.fbPageId, source]));
            sourcePages.set(publicPage.fbPageId, publicPage);
            const reviewedByName = new Map();
            for (const source of sourcePages.values()) {
                const snapshotPath = path.join(OUT, `${source.fbPageId}-status.json`);
                const sourceTemplates = source.fbPageId === page.fb_page_id ? templates :
                    (fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')).templates || [] : []);
                for (const template of sourceTemplates) {
                    if (!candidateNames.has(template.name)) continue;
                    const prior = reviewedByName.get(template.name);
                    if (!prior || !['APPROVED', 'ACTIVE'].includes(prior.status)) reviewedByName.set(template.name, template);
                }
                const progressPath = path.join(OUT, `${source.fbPageId}-review.json`);
                const progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf8')) : null;
                for (const entry of progress?.results || []) {
                    if (!candidateNames.has(entry.name) || reviewedByName.has(entry.name)) continue;
                    if (entry.status === 'INVALID' || (entry.status === 'ERROR' && entry.code === 100)) {
                        reviewedByName.set(entry.name, { ...entry, status: 'INVALID' });
                    }
                }
            }
            const reviewed = [...reviewedByName.values()];
            const reviewStatuses = reviewed.reduce((counts, template) => ({ ...counts, [template.status]: (counts[template.status] || 0) + 1 }), {});
            const reviewPath = path.join(OUT, `${page.fb_page_id}-review.json`);
            const reviewProgress = fs.existsSync(reviewPath) ? JSON.parse(fs.readFileSync(reviewPath, 'utf8')) : null;
            const currentErrors = (reviewProgress?.results || []).filter(result => candidateNames.has(result.name) && result.status === 'ERROR' && !reviewed.some(template => template.name === result.name));
            const records = new Map(priorRecords.map(record => [record.name, record]));
            for (const candidate of approved) {
                const remote = templates.find(template => template.name === candidate.name);
                records.set(candidate.name, { name: candidate.name, id: remote.id, status: remote.status, category: remote.category, language: remote.language,
                    sourcePageId: page.fb_page_id, checkedAt,
                    bodySha256: createHash('sha256').update(candidate.components[0].text).digest('hex') });
            }
            const evidence = {
                page: publicPage, sourcePages: [...sourcePages.values()], checkedAt, catalogSize: TEMPLATE_CANDIDATES.length,
                reviewed: reviewed.length, notSubmitted: TEMPLATE_CANDIDATES.length - reviewed.length,
                submissionErrors: currentErrors.map(result => ({ name: result.name, error: result.error, code: result.code })),
                reviewStoppedReason: reviewProgress?.stopped || null,
                statuses: reviewStatuses, verifiedApprovals: records.size,
                verified: [...records.values()]
            };
            save(`${page.fb_page_id}-approvals.json`, evidence);
            if (!args.includes('--existing')) {
                fs.writeFileSync(path.join(ROOT, 'docs/template-review-results.json'), JSON.stringify(evidence, null, 2) + '\n');
            }
            console.log(JSON.stringify({ verifiedApprovals: approved.length, libraryTotal: merged.size }));
        }
    }
    if (command === 'audit') save('audit.json', { checkedAt: new Date().toISOString(), pages: audit });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
