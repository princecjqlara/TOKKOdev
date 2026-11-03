import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';

const PAGE_ROW_ID = 'd1f6da1f-9ffc-4a09-ab95-1293559064c0';
const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const OUT_PATH = 'webmo-all-image-body-media-format-probe.json';

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
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true }
  }).outputText;
  const mod = { exports: {} };
  const requireStub = (id) => (id === './facebook' ? {} : require(id));
  new Function('require', 'module', 'exports', output)(requireStub, mod, mod.exports);
  return mod.exports.UTILITY_TEMPLATES;
}

function cloneWithoutHeader(template) {
  return template.components
    .filter((component) => component.type !== 'HEADER')
    .map((component) => JSON.parse(JSON.stringify(component)));
}

function buildAttempts(template, suffix) {
  const baseComponents = cloneWithoutHeader(template);
  return [
    {
      baseTemplate: template.name,
      variant: 'body_format_image',
      payload: {
        name: `${template.name}_bix${suffix}_v1`,
        language: 'en_US',
        category: 'UTILITY',
        components: baseComponents.map((component) =>
          component.type === 'BODY' ? { ...component, format: 'IMAGE' } : component
        )
      }
    },
    {
      baseTemplate: template.name,
      variant: 'media_component_image',
      payload: {
        name: `${template.name}_mix${suffix}_v1`,
        language: 'en_US',
        category: 'UTILITY',
        components: [
          { type: 'MEDIA', format: 'IMAGE', text: 'Message Update' },
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

async function submitBatch(page, attempts) {
  const batch = attempts.map((attempt) => ({
    method: 'POST',
    relative_url: `${page.fb_page_id}/message_templates`,
    body: encodeTemplate(attempt.payload)
  }));

  const response = await fetch(`${GRAPH_BASE}/`, {
    method: 'POST',
    body: new URLSearchParams({
      access_token: page.access_token,
      batch: JSON.stringify(batch),
      include_headers: 'false'
    }),
    signal: AbortSignal.timeout(30000)
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(responseBody)) {
    const message = responseBody?.error?.message || `Batch request failed HTTP ${response.status}`;
    return attempts.map((attempt) => ({
      baseTemplate: attempt.baseTemplate,
      variant: attempt.variant,
      name: attempt.payload.name,
      ok: false,
      status: response.status,
      fbStatus: null,
      error: { message, code: responseBody?.error?.code || null, subcode: responseBody?.error?.error_subcode || null }
    }));
  }

  return responseBody.map((entry, index) => {
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
      error: error
        ? {
            message: error.message,
            code: error.code,
            subcode: error.error_subcode || null,
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
      acc.byVariant[result.variant] ||= { total: 0, ok: 0, failed: 0, errors: {} };
      const bucket = acc.byVariant[result.variant];
      bucket.total += 1;
      if (result.ok) {
        acc.ok += 1;
        bucket.ok += 1;
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
  if (!supabaseUrl || !serviceKey) throw new Error('Missing Supabase env');

  const supabase = createClient(supabaseUrl, serviceKey);
  const { data: page, error } = await supabase
    .from('pages')
    .select('id,name,fb_page_id,access_token')
    .eq('id', PAGE_ROW_ID)
    .single();
  if (error || !page?.access_token) throw new Error(error?.message || 'Page not found');

  const suffix = String(Date.now()).slice(-6);
  const templates = loadUtilityTemplates();
  const attempts = templates.flatMap((template) => buildAttempts(template, suffix));
  const results = [];

  for (let index = 0; index < attempts.length; index += 10) {
    const batchResults = await submitBatch(page, attempts.slice(index, index + 10));
    results.push(...batchResults);
    fs.writeFileSync(
      OUT_PATH,
      JSON.stringify({
        page: { id: page.id, name: page.name, fb_page_id: page.fb_page_id },
        localBaseTemplates: templates.length,
        attempted: attempts.length,
        submitted: results.length,
        suffix,
        graphVersion: 'v21.0',
        summary: summarize(results),
        sampleResults: results.slice(0, 12),
        results
      }, null, 2)
    );
  }

  const output = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
  output.complete = true;
  fs.writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ wrote: OUT_PATH, summary: output.summary }, null, 2));
}

main().catch((error) => {
  fs.writeFileSync(OUT_PATH, JSON.stringify({ complete: false, error: error.message || String(error) }, null, 2));
  console.error(error.message || error);
  process.exit(1);
});
