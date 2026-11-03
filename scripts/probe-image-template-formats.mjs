import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';

const PAGE_ROW_ID = 'd1f6da1f-9ffc-4a09-ab95-1293559064c0';
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const SAMPLE_URL = 'https://dummyimage.com/1200x800/ffffff/000000.png&text=Image+Format+Probe';
const OUT_PATH = 'webmo-all-image-template-format-probe-v2.json';
const PROGRESS_PATH = 'webmo-all-image-template-format-probe-v2.progress.json';

function writeProgress(value) {
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify({ at: new Date().toISOString(), ...value }, null, 2));
}

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadUtilityTemplates() {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'facebook-templates.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true
    }
  }).outputText;
  const mod = { exports: {} };
  const requireStub = (id) => (id === './facebook' ? {} : require(id));
  new Function('require', 'module', 'exports', output)(requireStub, mod, mod.exports);
  return mod.exports.UTILITY_TEMPLATES;
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(options?.timeoutMs ?? 60000)
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function createUploadHandle(appId, accessToken) {
  writeProgress({ step: 'fetch-sample' });
  const sampleResponse = await fetch(SAMPLE_URL, { signal: AbortSignal.timeout(30000) });
  if (!sampleResponse.ok) {
    throw new Error(`Failed to fetch image sample HTTP ${sampleResponse.status}`);
  }
  const sampleBuffer = Buffer.from(await sampleResponse.arrayBuffer());
  const fileType = sampleResponse.headers.get('content-type') || 'image/png';

  writeProgress({ step: 'create-upload-session', sampleBytes: sampleBuffer.length, fileType });
  const session = await fetchJson(
    `${GRAPH_BASE}/${appId}/uploads?` +
      new URLSearchParams({
        file_name: 'image-format-probe.png',
        file_length: String(sampleBuffer.length),
        file_type: fileType
      }).toString(),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      timeoutMs: 30000
    }
  );
  if (!session.response.ok || typeof session.body.id !== 'string') {
    throw new Error(session.body?.error?.message || `Failed to create upload session HTTP ${session.response.status}`);
  }

  writeProgress({ step: 'upload-sample', sampleBytes: sampleBuffer.length });
  const upload = await fetchJson(`${GRAPH_BASE}/${session.body.id}`, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${accessToken}`,
      file_offset: '0',
      'Content-Type': 'application/octet-stream'
    },
    body: sampleBuffer,
    timeoutMs: 30000
  });
  if (!upload.response.ok || typeof upload.body.h !== 'string') {
    throw new Error(upload.body?.error?.message || `Failed to upload image sample HTTP ${upload.response.status}`);
  }

  return upload.body.h;
}

function cloneWithoutHeader(template) {
  return template.components
    .filter((component) => component.type !== 'HEADER')
    .map((component) => JSON.parse(JSON.stringify(component)));
}

function buildAttempts(template, imageHandle, suffix) {
  const baseComponents = cloneWithoutHeader(template);
  return [
    {
      variant: 'header_image',
      payload: {
        name: `${template.name}_ih${suffix}_v1`,
        language: 'en_US',
        category: 'UTILITY',
        components: [
          { type: 'HEADER', format: 'IMAGE', text: 'Message Update', example: { header_handle: [imageHandle] } },
          ...baseComponents
        ]
      }
    },
    {
      variant: 'body_format_image',
      payload: {
        name: `${template.name}_bi${suffix}_v1`,
        language: 'en_US',
        category: 'UTILITY',
        components: baseComponents.map((component) =>
          component.type === 'BODY'
            ? { ...component, format: 'IMAGE', example: { ...(component.example || {}), header_handle: [imageHandle] } }
            : component
        )
      }
    },
    {
      variant: 'media_component_image',
      payload: {
        name: `${template.name}_mi${suffix}_v1`,
        language: 'en_US',
        category: 'UTILITY',
        components: [
          { type: 'MEDIA', format: 'IMAGE', text: 'Message Update', example: { header_handle: [imageHandle] } },
          ...baseComponents
        ]
      }
    }
  ];
}

function encodeTemplate(template) {
  return new URLSearchParams({
    name: template.name,
    language: template.language,
    category: template.category,
    components: JSON.stringify(template.components)
  }).toString();
}

function parseBatchBody(body) {
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    return { raw: body };
  }
}

async function submitBatch(fbPageId, accessToken, attempts) {
  const batch = attempts.map((attempt) => ({
    method: 'POST',
    relative_url: `${fbPageId}/message_templates`,
    body: encodeTemplate(attempt.payload)
  }));
  const batchResult = await fetchJson(`${GRAPH_BASE}/`, {
    method: 'POST',
    body: new URLSearchParams({
      access_token: accessToken,
      batch: JSON.stringify(batch),
      include_headers: 'false'
    }),
    timeoutMs: 60000
  });
  if (!batchResult.response.ok || !Array.isArray(batchResult.body)) {
    throw new Error(batchResult.body?.error?.message || `Batch request failed HTTP ${batchResult.response.status}`);
  }
  return batchResult.body.map((entry, index) => {
    const attempt = attempts[index];
    const entryBody = parseBatchBody(entry?.body);
    const error = entryBody.error;
    return {
      baseTemplate: attempt.baseTemplate,
      variant: attempt.variant,
      name: attempt.payload.name,
      ok: entry?.code >= 200 && entry?.code < 300,
      status: entry?.code || null,
      fbStatus: entryBody.status || null,
      category: entryBody.category || null,
      id: entryBody.id || null,
      error: error
        ? {
            message: error.message,
            code: error.code,
            subcode: error.error_subcode || null,
            userTitle: error.error_user_title || null,
            userMessage: error.error_user_msg || null,
            details: error.error_data?.details || null,
            fbtrace_id: error.fbtrace_id || null
          }
        : null
    };
  });
}

function summarize(results) {
  return results.reduce(
    (acc, result) => {
      acc.total += 1;
      acc.byVariant[result.variant] ||= { total: 0, ok: 0, failed: 0, statuses: {}, errors: {} };
      const bucket = acc.byVariant[result.variant];
      bucket.total += 1;

      if (result.ok) {
        acc.ok += 1;
        bucket.ok += 1;
        const status = result.fbStatus || 'UNKNOWN';
        bucket.statuses[status] = (bucket.statuses[status] || 0) + 1;
      } else {
        acc.failed += 1;
        bucket.failed += 1;
        const message =
          result.error?.details ||
          result.error?.userMessage ||
          result.error?.message ||
          `HTTP ${result.status || 'unknown'}`;
        acc.errors[message] = (acc.errors[message] || 0) + 1;
        bucket.errors[message] = (bucket.errors[message] || 0) + 1;
      }

      return acc;
    },
    { total: 0, ok: 0, failed: 0, errors: {}, byVariant: {} }
  );
}

async function main() {
  loadEnvFile(path.join(process.cwd(), '.env.local'));
  loadEnvFile(path.join(process.cwd(), '.env'));

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const appId = process.env.FACEBOOK_CLIENT_ID;
  if (!supabaseUrl || !serviceKey || !appId) {
    throw new Error('Missing Supabase or Facebook app env');
  }

  writeProgress({ step: 'load-page' });
  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: page, error } = await supabase
    .from('pages')
    .select('id,name,fb_page_id,access_token')
    .eq('id', PAGE_ROW_ID)
    .single();
  if (error || !page?.access_token) {
    throw new Error(error?.message || 'Page not found');
  }

  const imageHandle = await createUploadHandle(appId, page.access_token);
  const templates = loadUtilityTemplates();
  const suffix = String(Date.now()).slice(-6);
  const attempts = templates.flatMap((template) =>
    buildAttempts(template, imageHandle, suffix).map((attempt) => ({
      ...attempt,
      baseTemplate: template.name
    }))
  );

  const results = [];
  for (let index = 0; index < attempts.length; index += 25) {
    const batch = attempts.slice(index, index + 25);
    const batchResults = await submitBatch(page.fb_page_id, page.access_token, batch);
    results.push(...batchResults);
    writeProgress({
      step: 'submit',
      submitted: results.length,
      total: attempts.length,
      summary: summarize(results)
    });
  }

  const output = {
    page: { id: page.id, name: page.name, fb_page_id: page.fb_page_id },
    localBaseTemplates: templates.length,
    attempted: attempts.length,
    suffix,
    graphVersion: 'v21.0',
    sampleUrl: SAMPLE_URL,
    summary: summarize(results),
    sampleResults: results.slice(0, 12),
    results
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  writeProgress({ step: 'done', submitted: results.length, total: attempts.length, summary: output.summary });
  console.log(JSON.stringify({ wrote: OUT_PATH, summary: output.summary }, null, 2));
}

main().catch((error) => {
  writeProgress({ step: 'error', error: error.message || String(error) });
  console.error(error.message || error);
  process.exit(1);
});
