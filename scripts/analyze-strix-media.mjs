import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  classifyConversation as classifyConversationV2,
  conversationTriggerBuckets,
  legacyPaymentSignal,
  normalizeText,
  responseEpisodes
} from './strix-analysis-core.mjs';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'analysis-output');
const PAGE_ID = 'aaf6cad1-ee3f-4cab-b2b6-44b6e7b067c6';
const CACHE_PATH = path.join(OUT_DIR, 'strix-media-conversations-cache.json');
const REPORT_JSON_PATH = path.join(OUT_DIR, 'strix-media-analysis.json');
const REPORT_MD_PATH = path.join(OUT_DIR, 'strix-media-analysis.md');
const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_MESSAGES_PER_CONVERSATION = Number(process.env.STRIX_MAX_MESSAGES || 500);
const MESSAGE_FETCH_CONCURRENCY = Number(process.env.STRIX_CONCURRENCY || 12);

function loadEnv() {
  const envPath = path.join(ROOT, '.env.local');
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (!match) continue;
    process.env[match[1].trim()] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 4) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url);
    const body = await response.json().catch(() => ({}));
    if (response.ok) return body;

    const message = body?.error?.message || `HTTP ${response.status}`;
    const isTransient = response.status === 429 || response.status >= 500;
    if (!isTransient || attempt === retries) {
      throw new Error(message);
    }
    await sleep(750 * Math.pow(2, attempt));
  }
  throw new Error('Facebook fetch failed');
}

async function fetchAllConversations(page) {
  let url = `${GRAPH_BASE}/${page.fb_page_id}/conversations?fields=id,participants,updated_time&limit=100&access_token=${page.access_token}`;
  const conversations = [];
  const seen = new Set();
  let pageNumber = 0;

  while (url) {
    if (seen.has(url)) break;
    seen.add(url);
    pageNumber++;
    const body = await fetchJson(url);
    conversations.push(...(body.data || []));
    url = body.paging?.next || null;
    if (pageNumber % 10 === 0) {
      console.log(`Fetched ${conversations.length} conversations...`);
    }
  }

  return conversations;
}

async function fetchMessages(conversationId, accessToken) {
  let url = `${GRAPH_BASE}/${conversationId}/messages?fields=id,message,from,created_time&limit=100&access_token=${accessToken}`;
  const messages = [];
  const seen = new Set();

  while (url && messages.length < MAX_MESSAGES_PER_CONVERSATION) {
    if (seen.has(url)) break;
    seen.add(url);
    const body = await fetchJson(url);
    messages.push(...(body.data || []));
    url = body.paging?.next || null;
    if ((body.data || []).length < 100) break;
  }

  return messages;
}

function normalize(text) {
  return normalizeText(text);
}

const patterns = {
  payment: [
    /\b(paid|payment|pay|deposit|down ?payment|dp|gcash|maya|bank transfer|receipt|resibo|proof|screenshot|sent|nasend|na send|bayad|nagbayad|binayaran|paid na|nakapagbayad)\b/i,
    /\b(50|₱50|p50|php ?50|1499|1,499|₱1,499|php ?1499)\b.*\b(sent|paid|bayad|dp|gcash|reserve|start)\b/i,
    /\b(send|sent|transfer|gcash)\b.*\b(50|₱50|p50|php ?50|payment|dp|deposit)\b/i
  ],
  strongBuyIntent: [
    /\b(go|g|proceed|tuloy|start|avail|availed|order|reserve|book|confirm|yes|sige|okay|ok|interested|game)\b/i,
    /\b(gawan|pagawa|magpagawa|pa gawa|mag start|start na|tuloy na|avail po|kuha ako|kuha po)\b/i
  ],
  qualified: [
    /\b(how much|hm|price|rate|rates|package|packages|details|samples?|portfolio|process|requirements?|need|interested|avail|video ad|ads?|promo video|content|business|page|brand|product|service|restaurant|salon|clinic|shop|store)\b/i,
    /\b(magkano|presyo|rate|rates|package|detalye|sample|paano|ano kasama|kailangan|interesado|interested|gusto|need ko|business ko|page ko|brand ko|product ko|service ko)\b/i
  ],
  rejection: [
    /\b(not interested|no thanks|no thank you|stop|unsubscribe|remove me|wrong number|spam|scam|already have|hindi interested|di interested|d interested|ayaw|pass|decline|reject|rejection|rejections|wag|huwag|don't message|do not message)\b/i,
    /\b(next time|sa susunod|wala pa|not now|hindi muna|di muna|maybe next|balikan ko|pag iisipan|pag-isipan|wala budget|no budget|mahal|expensive|too expensive|kulang budget|closed na|sarado na)\b/i,
    /\b(student|empleyado|employee lang|not owner|hindi owner|di owner|personal use|job applicant|looking for work|apply)\b/i
  ],
  objection: [
    /\b(mahal|expensive|budget|wala budget|no budget|legit|scam|sample|proof|portfolio|results?|roi|ads course|deadline|busy|next time|not now)\b/i,
    /\b(too much|can't afford|di kaya|hindi kaya|need think|pag iisipan|pag-isipan)\b/i
  ],
  priceQuestion: [/\b(how much|hm|price|rate|rates|magkano|presyo)\b/i],
  sampleQuestion: [/\b(sample|samples|portfolio|previous work|output|examples?|result|results)\b/i],
  packageQuestion: [/\b(package|packages|inclusion|included|ano kasama|kasama|details|detalye)\b/i],
  creativeNeed: [/\b(video ad|promo video|reels?|content|edit|editing|shoot|script|voice ?over|ads?|fb ads|advertisement)\b/i],
  ownerBusinessSignal: [/\b(business|page|brand|product|service|shop|store|restaurant|salon|clinic|gym|resort|cafe|food|real estate|car|auto|spa)\b/i],
  contactAskedLater: [/\b(next time|sa susunod|later|balikan|follow up|not now|hindi muna|di muna)\b/i]
};

function anyMatch(text, patternList) {
  return patternList.some((pattern) => pattern.test(text));
}

function classifyConversation(record, paidTagIds) {
  const messages = [...record.messages].sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
  const contactText = normalize(messages.filter((m) => m.senderType === 'contact').map((m) => m.message).join('\n'));
  const pageText = normalize(messages.filter((m) => m.senderType === 'page').map((m) => m.message).join('\n'));
  const allText = `${contactText}\n${pageText}`;
  const tagNames = record.tags.map((tag) => tag.name);
  const hasPaidTag = record.tags.some((tag) => paidTagIds.has(tag.id));
  const contactMessageCount = messages.filter((m) => m.senderType === 'contact' && normalize(m.message)).length;
  const pageMessageCount = messages.filter((m) => m.senderType === 'page' && normalize(m.message)).length;

  const flags = {
    hasPaidTag,
    paymentSignal: anyMatch(contactText, patterns.payment),
    strongBuyIntent: anyMatch(contactText, patterns.strongBuyIntent),
    qualifiedSignal: anyMatch(contactText, patterns.qualified),
    rejectionSignal: anyMatch(contactText, patterns.rejection),
    objectionSignal: anyMatch(contactText, patterns.objection),
    priceQuestion: anyMatch(contactText, patterns.priceQuestion),
    sampleQuestion: anyMatch(contactText, patterns.sampleQuestion),
    packageQuestion: anyMatch(contactText, patterns.packageQuestion),
    creativeNeed: anyMatch(contactText, patterns.creativeNeed),
    ownerBusinessSignal: anyMatch(contactText, patterns.ownerBusinessSignal),
    contactAskedLater: anyMatch(contactText, patterns.contactAskedLater),
    contactMessageCount,
    pageMessageCount
  };

  let outcome = 'undetermined';
  const reasons = [];

  if (flags.hasPaidTag) {
    outcome = 'converted';
    reasons.push('Paid / Availed Service tag');
  } else if (flags.paymentSignal && !flags.rejectionSignal) {
    outcome = 'converted';
    reasons.push('payment/deposit/proof signal');
  } else if (flags.rejectionSignal) {
    outcome = 'not_qualified';
    reasons.push('explicit rejection/no budget/not now/not owner signal');
  } else if (flags.strongBuyIntent && (flags.qualifiedSignal || flags.creativeNeed || flags.priceQuestion || flags.packageQuestion)) {
    outcome = 'qualified';
    reasons.push('buying intent plus relevant need/question');
  } else if (flags.qualifiedSignal || flags.creativeNeed || flags.ownerBusinessSignal || flags.priceQuestion || flags.sampleQuestion || flags.packageQuestion) {
    outcome = 'qualified';
    reasons.push('relevant need/question/business signal');
  } else if (contactMessageCount === 0 || (contactMessageCount <= 1 && pageMessageCount <= 1)) {
    outcome = 'undetermined';
    reasons.push('too little usable contact text');
  } else {
    outcome = 'undetermined';
    reasons.push('no clear buying, rejection, or fit signal');
  }

  return { outcome, reasons, flags, tagNames };
}

function firstPageTouch(messages) {
  return [...messages]
    .filter((m) => m.senderType === 'page' && normalize(m.message))
    .sort((a, b) => new Date(a.created_time) - new Date(b.created_time))[0]?.message || '';
}

function triggerBuckets(messages) {
  const pageText = normalize(messages.filter((m) => m.senderType === 'page').map((m) => m.message).join('\n'));
  const buckets = [];
  if (/\b(2 videos|buy 1 get 1|bonus video|free 30-sec|free advanced|ads course)\b/i.test(pageText)) buckets.push('bogo_bonus_course');
  if (/\b(1499|1,499|₱1,499|p1499|php 1499)\b/i.test(pageText)) buckets.push('1499_offer');
  if (/\b(50 dp|₱50|p50|php 50|50 pesos|50 only|dp to start)\b/i.test(pageText)) buckets.push('low_dp');
  if (/\b(promo|naka promo)\b/i.test(pageText)) buckets.push('promo_followup');
  if (/\b(tuloy|proceed|pagawa|gawan|interested)\b/i.test(pageText)) buckets.push('direct_close');
  if (/\b(customer|dumami|grow your brand|results|sales|benta)\b/i.test(pageText)) buckets.push('growth_benefit');
  if (/\b(sample|portfolio|previous|result)\b/i.test(pageText)) buckets.push('proof_sample');
  if (/\b(hi|hello|kamusta|checking|follow up)\b/i.test(pageText)) buckets.push('soft_followup');
  return buckets.length ? buckets : ['other'];
}

function pct(n, d) {
  return d ? Number(((n / d) * 100).toFixed(2)) : 0;
}

function countBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));
}

function bucketStats(records, bucketKey) {
  const rows = [];
  const allBuckets = new Set(records.flatMap((r) => r[bucketKey]));
  for (const bucket of allBuckets) {
    const subset = records.filter((r) => r[bucketKey].includes(bucket));
    const converted = subset.filter((r) => r.classification.outcome === 'converted').length;
    const verifiedConverted = subset.filter((r) => r.classification.outcome === 'converted' && r.classification.confidence === 'verified').length;
    const likelyConverted = subset.filter((r) => r.classification.outcome === 'converted' && r.classification.confidence === 'likely').length;
    const highIntent = subset.filter((r) => r.classification.outcome === 'high_intent').length;
    const qualified = subset.filter((r) => r.classification.outcome === 'qualified').length;
    const nurtureLater = subset.filter((r) => r.classification.outcome === 'nurture_later').length;
    const notQualified = subset.filter((r) => r.classification.outcome === 'not_qualified').length;
    const undetermined = subset.filter((r) => r.classification.outcome === 'undetermined').length;
    rows.push({
      bucket,
      conversations: subset.length,
      converted,
      verifiedConverted,
      likelyConverted,
      highIntent,
      qualified,
      nurtureLater,
      notQualified,
      undetermined,
      convertedPct: pct(converted, subset.length),
      verifiedConvertedPct: pct(verifiedConverted, subset.length),
      likelyConvertedPct: pct(likelyConverted, subset.length),
      highIntentPct: pct(highIntent, subset.length),
      qualifiedOrConvertedPct: pct(converted + highIntent + qualified, subset.length),
      notQualifiedPct: pct(notQualified, subset.length)
    });
  }
  return rows.sort((a, b) => b.conversations - a.conversations);
}

function episodeStats(episodes) {
  const rows = [];
  const buckets = new Set(episodes.flatMap((episode) => episode.buckets));
  for (const bucket of buckets) {
    const subset = episodes.filter((episode) => episode.buckets.includes(bucket));
    const replied = subset.filter((episode) => episode.replied).length;
    const positive = subset.filter((episode) => episode.positiveResponse).length;
    const negative = subset.filter((episode) => episode.negativeResponse).length;
    const highIntent = subset.filter((episode) => episode.responseOutcome === 'high_intent' || episode.responseOutcome === 'converted').length;
    rows.push({
      bucket,
      exposures: subset.length,
      replied,
      replyRate: pct(replied, subset.length),
      positive,
      positiveReplyRate: pct(positive, replied),
      highIntent,
      highIntentReplyRate: pct(highIntent, replied),
      negative,
      negativeReplyRate: pct(negative, replied)
    });
  }
  return rows.sort((a, b) => b.exposures - a.exposures);
}

function scoreBands(records) {
  const bands = [
    ['80-100', 80, 100],
    ['60-79', 60, 79],
    ['40-59', 40, 59],
    ['20-39', 20, 39],
    ['0-19', 0, 19]
  ];
  return bands.map(([band, minimum, maximum]) => {
    const subset = records.filter((record) => record.classification.leadScore >= minimum && record.classification.leadScore <= maximum);
    const verified = subset.filter((record) => record.classification.confidence === 'verified').length;
    return {
      band,
      conversations: subset.length,
      verifiedPaid: verified,
      verifiedPaidPct: pct(verified, subset.length),
      highIntent: subset.filter((record) => record.classification.outcome === 'high_intent').length,
      qualified: subset.filter((record) => record.classification.outcome === 'qualified').length
    };
  });
}

function textSamples(records, outcome, limit = 25) {
  return records
    .filter((r) => r.classification.outcome === outcome)
    .sort((a, b) => b.messages.length - a.messages.length)
    .slice(0, limit)
    .map((r) => ({
      contactName: r.contactName || '',
      messageCount: r.messages.length,
      reasons: r.classification.reasons,
      flags: r.classification.flags,
      firstPageMessage: firstPageTouch(r.messages).slice(0, 240),
      contactSnippets: r.messages
        .filter((m) => m.senderType === 'contact' && normalize(m.message))
        .slice(0, 8)
        .map((m) => m.message.slice(0, 180))
    }));
}

function campaignMessageStats(campaigns) {
  return campaigns.map((campaign) => ({
    name: campaign.name,
    status: campaign.status,
    createdAt: campaign.created_at,
    total: campaign.total_recipients || 0,
    sent: campaign.sent_count || 0,
    failed: campaign.failed_count || 0,
    deliveredAttemptPct: pct(campaign.sent_count || 0, campaign.total_recipients || 0),
    failedPct: pct(campaign.failed_count || 0, campaign.total_recipients || 0),
    message: campaign.message_text
  }));
}

function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Strix Media Agency Conversation Analysis`);
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Page: ${report.page.name}`);
  lines.push(`Conversations studied: ${report.totals.conversations}`);
  lines.push(`Messages studied: ${report.totals.messages}`);
  lines.push('');
  lines.push(`## Outcome Split`);
  for (const row of report.outcomes) {
    lines.push(`- ${row.outcome}: ${row.count} (${row.percentage}%)`);
  }
  lines.push('');
  lines.push(`## Conversation-Level Offer Co-occurrence (descriptive, not causal)`);
  for (const row of report.triggerStats) {
    lines.push(`- ${row.bucket}: ${row.conversations} convos | verified paid ${row.verifiedConvertedPct}% | likely paid ${row.likelyConvertedPct}% | high intent ${row.highIntentPct}%`);
  }
  lines.push('');
  lines.push(`## Offer/Follow-up Response Episodes`);
  lines.push(`Each row evaluates the contact turn immediately after a page-message burst, avoiding whole-conversation attribution.`);
  for (const row of report.responseEpisodeStats) {
    lines.push(`- ${row.bucket}: ${row.exposures} exposures | replied ${row.replyRate}% | positive among replies ${row.positiveReplyRate}% | high intent among replies ${row.highIntentReplyRate}% | negative among replies ${row.negativeReplyRate}%`);
  }
  lines.push('');
  lines.push(`## Contact Signals`);
  for (const row of report.contactSignalStats) {
    lines.push(`- ${row.bucket}: ${row.conversations} convos | verified paid ${row.verifiedConvertedPct}% | likely paid ${row.likelyConvertedPct}% | high intent ${row.highIntentPct}% | not qualified ${row.notQualifiedPct}%`);
  }
  lines.push('');
  lines.push(`## Lead Score Bands`);
  for (const row of report.leadScoreBands) {
    lines.push(`- ${row.band}: ${row.conversations} convos | verified paid ${row.verifiedPaid} (${row.verifiedPaidPct}%) | open high-intent ${row.highIntent} | qualified ${row.qualified}`);
  }
  lines.push('');
  lines.push(`## Accuracy Audit`);
  lines.push(`- Old broad payment-word rule marked ${report.accuracyAudit.legacyTextConversions} untagged conversations as converted.`);
  lines.push(`- New explicit confirmation rule retains ${report.accuracyAudit.explicitLikelyConversions} as likely conversions and removes ${report.accuracyAudit.ambiguousPaymentMentionsRemoved} ambiguous questions, future plans, and objections from conversion counts.`);
  lines.push(`- ${report.accuracyAudit.verifiedPaidTags} conversions are verified by the exact Paid / Availed Service tag.`);
  lines.push(`- Accuracy cannot be claimed from heuristics alone; paid tags are positive ground truth, while untagged contacts are not guaranteed negatives.`);
  lines.push('');
  lines.push(`## Campaign Delivery`);
  for (const row of report.campaigns) {
    lines.push(`- ${row.createdAt} | ${row.status} | sent ${row.sent}/${row.total} (${row.deliveredAttemptPct}%), failed ${row.failedPct}% | ${String(row.message || '').replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  lines.push('');
  lines.push(`## Notes`);
  lines.push(`- Verified conversion requires the exact local Paid / Availed Service tag; likely conversion requires explicit completed-payment language.`);
  lines.push(`- Latest intent wins, so an old objection does not override a newer commitment.`);
  lines.push(`- Budget/timing objections are nurture-later leads, not automatically unqualified leads.`);
  lines.push(`- Undetermined means no clear fit, rejection, or conversion signal was found in usable text.`);
  lines.push('');
  return lines.join('\n');
}

async function main() {
  loadEnv();
  ensureOutDir();
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: page, error: pageError } = await supabase
    .from('pages')
    .select('id,fb_page_id,name,access_token,last_synced_at')
    .eq('id', PAGE_ID)
    .single();
  if (pageError) throw pageError;

  const [{ data: tags, error: tagError }, { data: contactTags, error: contactTagError }, { data: campaigns, error: campaignError }] = await Promise.all([
    supabase.from('tags').select('id,name,color,owner_type,page_id,owner_id').or(`page_id.eq.${PAGE_ID},owner_id.eq.${PAGE_ID}`),
    supabase.from('contact_tags').select('contact_id,tag_id,created_at,contacts!inner(id,psid,page_id)').eq('contacts.page_id', PAGE_ID),
    supabase.from('campaigns').select('id,name,status,scheduled_at,total_recipients,sent_count,failed_count,message_text,created_at').eq('page_id', PAGE_ID).order('created_at', { ascending: false })
  ]);
  if (tagError) throw tagError;
  if (contactTagError) throw contactTagError;
  if (campaignError) throw campaignError;

  const tagById = new Map((tags || []).map((tag) => [tag.id, tag]));
  const tagsByPsid = new Map();
  for (const row of contactTags || []) {
    const psid = row.contacts?.psid;
    const tag = tagById.get(row.tag_id);
    if (!psid || !tag) continue;
    if (!tagsByPsid.has(psid)) tagsByPsid.set(psid, []);
    tagsByPsid.get(psid).push({ ...tag, assignedAt: row.created_at || null });
  }
  const paidTagIds = new Set((tags || []).filter((tag) => /^(?:paid|availed service|paid\s*\/\s*availed service)$/i.test(String(tag.name || '').trim())).map((tag) => tag.id));

  let cached = null;
  if (fs.existsSync(CACHE_PATH) && process.env.STRIX_REFRESH !== '1') {
    cached = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  }

  let conversations = cached?.conversations || null;
  if (!conversations) {
    conversations = await fetchAllConversations(page);
    fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: new Date().toISOString(), page: { id: page.id, name: page.name, fbPageId: page.fb_page_id }, conversations }, null, 2));
  }

  const cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  if (!cache.records) cache.records = {};

  let processed = 0;
  let failed = 0;
  const missingConversations = conversations.filter((conversation) => !cache.records[conversation.id]?.messages);
  let nextIndex = 0;

  async function processConversation(conversation) {
    const contact = conversation.participants?.data?.find((p) => p.id !== page.fb_page_id) || null;
    const messages = await fetchMessages(conversation.id, page.access_token);
    cache.records[conversation.id] = {
      conversationId: conversation.id,
      updatedTime: conversation.updated_time,
      contactPsid: contact?.id || '',
      contactName: contact?.name || '',
      messages: messages.map((message) => ({
        id: message.id,
        message: message.message || '',
        fromId: message.from?.id || '',
        fromName: message.from?.name || '',
        senderType: message.from?.id === page.fb_page_id ? 'page' : message.from?.id === contact?.id ? 'contact' : 'unknown',
        created_time: message.created_time || ''
      }))
    };
  }

  async function worker() {
    while (nextIndex < missingConversations.length) {
      const conversation = missingConversations[nextIndex++];
      try {
        await processConversation(conversation);
      } catch (error) {
        failed++;
        cache.records[conversation.id] = {
          conversationId: conversation.id,
          updatedTime: conversation.updated_time,
          contactPsid: '',
          contactName: '',
          messages: [],
          fetchError: error instanceof Error ? error.message : String(error)
        };
      }

      processed++;
      if (processed % 50 === 0) {
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
        console.log(`Fetched messages for ${processed}/${missingConversations.length} new conversations this run; total cached ${Object.keys(cache.records).length}; failed ${failed}`);
      }
    }
  }

  if (missingConversations.length > 0) {
    console.log(`Fetching ${missingConversations.length} missing conversations with concurrency ${MESSAGE_FETCH_CONCURRENCY}...`);
    await Promise.all(
      Array.from({ length: Math.min(MESSAGE_FETCH_CONCURRENCY, missingConversations.length) }, () => worker())
    );
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  const records = Object.values(cache.records).map((record) => {
    const enriched = {
      ...record,
      tags: tagsByPsid.get(record.contactPsid) || []
    };
    const classification = classifyConversationV2(enriched, paidTagIds);
    const signalBuckets = [];
    for (const [flag, value] of Object.entries(classification.flags)) {
      if (value === true && flag !== 'hasPaidTag') signalBuckets.push(flag);
    }
    if (signalBuckets.length === 0) signalBuckets.push('no_clear_signal');
    return {
      ...enriched,
      classification,
      triggerBuckets: conversationTriggerBuckets(enriched.messages),
      signalBuckets
    };
  });

  const outcomeCounts = countBy(records, (record) => record.classification.outcome);
  const totalConversations = records.length;
  const episodes = records.flatMap((record) => responseEpisodes(record, paidTagIds));
  const legacyTextConversions = records.filter((record) => {
    if (record.classification.flags.hasPaidTag) return false;
    const contactText = record.messages.filter((message) => message.senderType === 'contact').map((message) => message.message).join('\n');
    return legacyPaymentSignal(contactText);
  }).length;
  const explicitLikelyConversions = records.filter((record) => record.classification.outcome === 'converted' && record.classification.confidence === 'likely').length;
  const report = {
    generatedAt: new Date().toISOString(),
    page: {
      id: page.id,
      fbPageId: page.fb_page_id,
      name: page.name,
      lastSyncedAt: page.last_synced_at
    },
    totals: {
      conversations: totalConversations,
      messages: records.reduce((sum, record) => sum + record.messages.length, 0),
      contactMessages: records.reduce((sum, record) => sum + record.messages.filter((m) => m.senderType === 'contact').length, 0),
      pageMessages: records.reduce((sum, record) => sum + record.messages.filter((m) => m.senderType === 'page').length, 0),
      locallyPaidTaggedContacts: records.filter((record) => record.classification.flags.hasPaidTag).length
    },
    outcomes: ['converted', 'high_intent', 'qualified', 'nurture_later', 'not_qualified', 'undetermined'].map((outcome) => ({
      outcome,
      count: outcomeCounts[outcome] || 0,
      percentage: pct(outcomeCounts[outcome] || 0, totalConversations)
    })),
    triggerStats: bucketStats(records, 'triggerBuckets'),
    responseEpisodeStats: episodeStats(episodes),
    contactSignalStats: bucketStats(records, 'signalBuckets'),
    leadScoreBands: scoreBands(records),
    accuracyAudit: {
      legacyTextConversions,
      explicitLikelyConversions,
      ambiguousPaymentMentionsRemoved: Math.max(0, legacyTextConversions - explicitLikelyConversions),
      verifiedPaidTags: records.filter((record) => record.classification.flags.hasPaidTag).length
    },
    campaignMessageCounts: countBy(campaigns || [], (campaign) => normalize(campaign.message_text).slice(0, 120)),
    campaigns: campaignMessageStats(campaigns || []),
    classifiedRecords: records.map((record) => {
      const sortedMessages = [...record.messages].sort((a, b) => new Date(a.created_time) - new Date(b.created_time));
      return {
        conversationId: record.conversationId,
        updatedTime: record.updatedTime,
        outcome: record.classification.outcome,
        confidence: record.classification.confidence,
        conversionEvidence: record.classification.conversionEvidence,
        reasons: record.classification.reasons,
        flags: record.classification.flags,
        leadScore: record.classification.leadScore,
        scoreReasons: record.classification.scoreReasons,
        traits: record.classification.traits,
        triggerBuckets: record.triggerBuckets,
        signalBuckets: record.signalBuckets,
        tagNames: record.classification.tagNames,
        messageCount: record.messages.length,
        contactMessageCount: record.messages.filter((m) => m.senderType === 'contact').length,
        pageMessageCount: record.messages.filter((m) => m.senderType === 'page').length,
        firstMessageAt: sortedMessages[0]?.created_time || null,
        lastMessageAt: sortedMessages[sortedMessages.length - 1]?.created_time || null
      };
    }),
    examples: {
      converted: textSamples(records, 'converted', 20),
      highIntent: textSamples(records, 'high_intent', 30),
      qualified: textSamples(records, 'qualified', 20),
      nurtureLater: textSamples(records, 'nurture_later', 20),
      notQualified: textSamples(records, 'not_qualified', 30),
      undetermined: textSamples(records, 'undetermined', 10)
    }
  };

  fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2));
  fs.writeFileSync(REPORT_MD_PATH, renderMarkdown(report));
  console.log(JSON.stringify({
    reportJson: REPORT_JSON_PATH,
    reportMarkdown: REPORT_MD_PATH,
    cache: CACHE_PATH,
    totals: report.totals,
    outcomes: report.outcomes,
    triggerStats: report.triggerStats.slice(0, 10),
    contactSignalStats: report.contactSignalStats.slice(0, 10)
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
