import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('analysis-output/azshinari-2026-09-15');
const outputDir = path.resolve('outputs/azshinari-chatbot-knowledge-2026-09-23');
fs.mkdirSync(outputDir, { recursive: true });

const PAGE_ID = '656646850875530';
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
const TURN_GAP_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const records = JSON.parse(fs.readFileSync(path.join(root, 'live-records.json'), 'utf8'));
const workbook = JSON.parse(fs.readFileSync(path.join(root, 'workbook-data.json'), 'utf8'));
const confirmedClients = new Set(workbook.clients.map((row) => String(row.at(-1))));

function repair(value = '') {
  return String(value)
    .replaceAll('â‚±', '₱')
    .replaceAll('â€“', '–')
    .replaceAll('â€”', '—')
    .replaceAll('â€œ', '“')
    .replaceAll('â€', '”')
    .replaceAll('â€™', '’')
    .replaceAll('Â', '');
}

function clean(value = '') {
  return repair(value).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

function canonical(value = '') {
  return clean(value)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b(?:63|0)9\d{9}\b/g, '<phone>')
    .replace(/\s+/g, ' ')
    .trim();
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function summarizeLatency(values) {
  return {
    count: values.length,
    medianMinutes: round(percentile(values, 0.5) / 60000, 1),
    p25Minutes: round(percentile(values, 0.25) / 60000, 1),
    p75Minutes: round(percentile(values, 0.75) / 60000, 1),
    p90Minutes: round(percentile(values, 0.9) / 60000, 1),
  };
}

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function rate(numerator, denominator) {
  return denominator ? round(numerator / denominator, 4) : null;
}

function wilson(successes, total, z = 1.96) {
  if (!total) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const center = (p + z ** 2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total)) / denominator;
  return { low: round(center - margin, 4), high: round(center + margin, 4) };
}

function localDateParts(timestamp) {
  const date = new Date(timestamp + TZ_OFFSET_MS);
  return {
    isoDate: date.toISOString().slice(0, 10),
    hour: date.getUTCHours(),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()],
  };
}

function makeTurns(messages) {
  const turns = [];
  for (const original of messages) {
    const text = clean(original.text || '');
    const time = Date.parse(original.date);
    if (!Number.isFinite(time)) continue;
    const sender = original.sender;
    const previous = turns.at(-1);
    if (previous && previous.sender === sender && time - previous.end <= TURN_GAP_MS) {
      previous.end = time;
      if (text) previous.texts.push(text);
      previous.messageCount += 1;
    } else {
      turns.push({ sender, start: time, end: time, texts: text ? [text] : [], messageCount: 1 });
    }
  }
  return turns;
}

const intentPatterns = {
  pricing: /\b(?:price|pricing|magkano|how much|hm\b|rate|presyo|cost|budget)\b/i,
  samples_portfolio: /\b(?:sample|samples|portfolio|previous work|example|examples|made before|works? niyo)\b/i,
  interest_availability: /\b(?:interested|available|avail|gusto|kuha|order|start|proceed|go na|push natin)\b/i,
  package_inclusions: /\b(?:package|inclusion|included|freebie|freebies|kasama|ano.*makukuha)\b/i,
  process_how_it_works: /\b(?:process|procedure|paano|how does|how to|anong gagawin|next step)\b/i,
  turnaround_timing: /\b(?:how long|ilang araw|kelan|kailan|when|turnaround|days?|oras|gaano katagal|deadline)\b/i,
  payment: /\b(?:payment|pay|paid|bayad|gcash|bank|deposit|down\s*payment|balance|receipt)\b/i,
  revisions_changes: /\b(?:revision|revise|changes?|edit|palitan|correction|correct|adjust)\b/i,
  promotion_results: /\b(?:promote|promotion|boost|ads?|advertis|views?|sales|customers?|inquir|result|viral|reach)\b/i,
  voice_language: /\b(?:voice|voiceover|language|tagalog|english|bisaya|accent|boses|male|female)\b/i,
  duration_format: /\b(?:seconds?|minutes?|duration|length|format|horizontal|vertical|portrait|landscape|reels?|tiktok)\b/i,
  requirements_materials: /\b(?:requirements?|need.*send|what.*send|materials?|photos?|videos?|logo|details|information)\b/i,
  ai_or_human: /\b(?:\bai\b|artificial intelligence|real person|human|animated|animation)\b/i,
  posting_channels: /\b(?:post|posting|facebook|fb page|tiktok|instagram|youtube|shopee|lazada|social media)\b/i,
  discounts: /\b(?:discount|promo|less|cheaper|tawad|last price|lowest|afford)\b/i,
  cancellation_refund: /\b(?:cancel|refund|money back|ibalik.*bayad|ayoko na|stop.*order)\b/i,
  status_delay: /\b(?:update|status|follow up|follow-up|waiting|wait|delay|matagal|wala pa|when.*finish|nasaan)\b/i,
  complaint_dissatisfaction: /\b(?:complain|disappoint|dissatisf|not happy|pangit|mali|problem|issue|scam|bad|hindi.*gusto|di.*gusto)\b/i,
};

const pageKnowledgePattern = /(?:₱|\bphp\b|\bprice\b|\bpackage\b|\bpromo\b|\bdown\s*payment\b|\bremaining balance\b|\brevision\b|\bfreebie\b|\bseconds?\b|\bminutes?\b|\bturnaround\b|\bworking days?\b|\bdeliver\b|\bvoice.?over\b|\bcaption\b|\bposter\b|\blogo\b|\bwatermark\b|\brequirements?\b|\bprocess\b|\bgcash\b|\brefund\b)/i;

const featureTests = {
  contains_question: (t) => /\?/.test(t),
  starts_with_greeting: (t) => /^(?:hi|hello|good\s+(?:morning|afternoon|evening)|kumusta|magandang)/i.test(t),
  mentions_price: (t) => /(?:₱|\bphp\b|\bprice\b|\bmagkano\b|\bpromo\b|\b\d{3,5}\b)/i.test(t),
  mentions_freebies: (t) => /\b(?:free|freebie|freebies|bonus)\b/i.test(t),
  mentions_benefit: (t) => /\b(?:customers?|sales|inquir|awareness|promote|attention|engag|reach|views?|hakot)\b/i.test(t),
  urgency_or_scarcity: (t) => /\b(?:today|now|limited|last|slot|available kami ngayon|promo.*until|habol|agad)\b/i.test(t),
  gratitude_signoff: (t) => /\b(?:thank|thanks|salamat|have a great day)\b/i.test(t),
  asks_business_goal: (t) => /\b(?:goal|target|customers|inquiries|awareness|business.*need|ano.*business)\b/i.test(t) && /\?/.test(t),
  direct_cta: (t) => /\b(?:reply|message us|send|let us know|gawan|start|avail|interested|proceed|tara)\b/i.test(t),
  taglish: (t) => /\b(?:po|ninyo|niyo|natin|kami|kayo|gusto|pwede|para|yung|ang|mga|hanap|gawan|salamat)\b/i.test(t) && /\b(?:the|your|video|business|commercial|customers|available|interested|target|fresh|ready|quality)\b/i.test(t),
};

const totals = {
  conversations: records.length,
  messages: 0,
  pageMessages: 0,
  contactMessages: 0,
  unknownMessages: 0,
  blankOrMediaOnlyMessages: 0,
  confirmedClients: confirmedClients.size,
};

const conversationMetrics = {
  withContactMessage: 0,
  withPageMessage: 0,
  bothSides: 0,
  pageInitiated: 0,
  contactInitiated: 0,
  unknownInitiated: 0,
  pageInitiatedWithContactReply: 0,
  contactInitiatedWithPageReply: 0,
  confirmedAmongPageInitiated: 0,
  confirmedAmongContactInitiated: 0,
};

const firstPageReplyLatencies = [];
const firstContactReplyLatencies = [];
const pageOpportunities = [];
const templateMap = new Map();
const pageKnowledge = new Map();
const pageMessageFrequency = new Map();
const intentStats = Object.fromEntries(Object.keys(intentPatterns).map((key) => [key, { messages: 0, conversations: new Set(), responseTemplates: new Map() }]));
const dayStats = new Map();
const hourStats = new Map();
const followupStats = new Map();
let minTime = Infinity;
let maxTime = -Infinity;

function addMapCounter(map, key, success, conversion, sample, date) {
  if (!map.has(key)) map.set(key, { attempts: 0, replied24h: 0, replied7d: 0, conversions: new Set(), conversations: new Set(), sample, firstDate: date, lastDate: date });
  const item = map.get(key);
  item.attempts += 1;
  item.replied24h += success.reply24h ? 1 : 0;
  item.replied7d += success.reply7d ? 1 : 0;
  if (conversion) item.conversions.add(conversion);
  if (success.conversationId) item.conversations.add(success.conversationId);
  if (date < item.firstDate) item.firstDate = date;
  if (date > item.lastDate) item.lastDate = date;
}

for (const record of records) {
  const messages = (record.messages || []).filter((m) => Number.isFinite(Date.parse(m.date))).sort((a, b) => a.date.localeCompare(b.date));
  totals.messages += messages.length;
  let hasContact = false;
  let hasPage = false;
  for (const message of messages) {
    const text = clean(message.text || '');
    const time = Date.parse(message.date);
    minTime = Math.min(minTime, time);
    maxTime = Math.max(maxTime, time);
    if (!text) totals.blankOrMediaOnlyMessages += 1;
    if (message.sender === 'page') {
      totals.pageMessages += 1;
      hasPage = true;
      if (text) {
        const key = canonical(text);
        const entry = pageMessageFrequency.get(key) || { count: 0, sample: text, firstDate: message.date, lastDate: message.date };
        entry.count += 1;
        if (message.date < entry.firstDate) entry.firstDate = message.date;
        if (message.date > entry.lastDate) entry.lastDate = message.date;
        pageMessageFrequency.set(key, entry);
        if (pageKnowledgePattern.test(text) && text.length <= 3000) {
          const knowledgeEntry = pageKnowledge.get(key) || { count: 0, sample: text, firstDate: message.date, lastDate: message.date };
          knowledgeEntry.count += 1;
          if (message.date < knowledgeEntry.firstDate) knowledgeEntry.firstDate = message.date;
          if (message.date > knowledgeEntry.lastDate) knowledgeEntry.lastDate = message.date;
          pageKnowledge.set(key, knowledgeEntry);
        }
      }
    } else if (message.sender === 'contact') {
      totals.contactMessages += 1;
      hasContact = true;
      for (const [intent, pattern] of Object.entries(intentPatterns)) {
        if (text && pattern.test(text)) {
          intentStats[intent].messages += 1;
          intentStats[intent].conversations.add(record.conversationId);
        }
      }
    } else {
      totals.unknownMessages += 1;
    }
  }
  if (hasContact) conversationMetrics.withContactMessage += 1;
  if (hasPage) conversationMetrics.withPageMessage += 1;
  if (hasContact && hasPage) conversationMetrics.bothSides += 1;

  const turns = makeTurns(messages);
  const firstSubstantive = turns.find((t) => t.sender === 'page' || t.sender === 'contact');
  if (!firstSubstantive) {
    conversationMetrics.unknownInitiated += 1;
    continue;
  }
  const initiatedByPage = firstSubstantive.sender === 'page';
  if (initiatedByPage) {
    conversationMetrics.pageInitiated += 1;
    if (confirmedClients.has(String(record.psid))) conversationMetrics.confirmedAmongPageInitiated += 1;
    const firstContact = turns.find((t) => t.sender === 'contact' && t.start >= firstSubstantive.end);
    if (firstContact) {
      conversationMetrics.pageInitiatedWithContactReply += 1;
      firstContactReplyLatencies.push(firstContact.start - firstSubstantive.end);
    }
  } else {
    conversationMetrics.contactInitiated += 1;
    if (confirmedClients.has(String(record.psid))) conversationMetrics.confirmedAmongContactInitiated += 1;
    const firstPage = turns.find((t) => t.sender === 'page' && t.start >= firstSubstantive.end);
    if (firstPage) {
      conversationMetrics.contactInitiatedWithPageReply += 1;
      firstPageReplyLatencies.push(firstPage.start - firstSubstantive.end);
    }
  }

  let preContactPageAttempt = 0;
  let contactSeen = false;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.sender === 'contact') {
      contactSeen = true;
      continue;
    }
    if (turn.sender !== 'page') continue;
    const text = turn.texts.join('\n').trim();
    if (!text) continue;
    const previousTurn = turns[index - 1];
    const nextTurn = turns[index + 1];
    const category = !contactSeen ? (preContactPageAttempt === 0 ? 'acquisition_opener' : 'unanswered_followup') : previousTurn?.sender === 'contact' ? 'reply_to_contact' : 'page_continuation';
    if (!contactSeen) preContactPageAttempt += 1;
    const replyLatency = nextTurn?.sender === 'contact' ? nextTurn.start - turn.end : null;
    const reply24h = replyLatency != null && replyLatency >= 0 && replyLatency <= DAY_MS;
    const reply7d = replyLatency != null && replyLatency >= 0 && replyLatency <= 7 * DAY_MS;
    const { isoDate, hour, weekday } = localDateParts(turn.end);
    const opportunity = {
      conversationId: record.conversationId,
      psid: record.psid,
      category,
      text,
      date: new Date(turn.end).toISOString(),
      localDate: isoDate,
      hour,
      weekday,
      reply24h,
      reply7d,
      replyLatency,
      converted: confirmedClients.has(String(record.psid)),
      attempt: !contactSeen ? preContactPageAttempt : null,
    };
    pageOpportunities.push(opportunity);

    if (category === 'acquisition_opener' || category === 'unanswered_followup') {
      const templateKey = canonical(text);
      addMapCounter(templateMap, templateKey, opportunity, opportunity.converted ? String(record.psid) : null, text, opportunity.date);
      addMapCounter(dayStats, weekday, opportunity, opportunity.converted ? String(record.psid) : null, weekday, opportunity.date);
      addMapCounter(hourStats, String(hour).padStart(2, '0'), opportunity, opportunity.converted ? String(record.psid) : null, `${hour}:00`, opportunity.date);
      addMapCounter(followupStats, String(opportunity.attempt), opportunity, opportunity.converted ? String(record.psid) : null, `Attempt ${opportunity.attempt}`, opportunity.date);
    }

    if (previousTurn?.sender === 'contact') {
      const inboundText = previousTurn.texts.join('\n');
      for (const [intent, pattern] of Object.entries(intentPatterns)) {
        if (!pattern.test(inboundText)) continue;
        const key = canonical(text);
        const map = intentStats[intent].responseTemplates;
        const item = map.get(key) || { count: 0, sample: text, latestDate: opportunity.date };
        item.count += 1;
        if (opportunity.date > item.latestDate) item.latestDate = opportunity.date;
        map.set(key, item);
      }
    }
  }
}

const acquisition = pageOpportunities.filter((item) => item.category === 'acquisition_opener' || item.category === 'unanswered_followup');
const acquisitionBaseline = {
  attempts: acquisition.length,
  replied24h: acquisition.filter((item) => item.reply24h).length,
  replied7d: acquisition.filter((item) => item.reply7d).length,
};
acquisitionBaseline.replyRate24h = rate(acquisitionBaseline.replied24h, acquisitionBaseline.attempts);
acquisitionBaseline.replyRate7d = rate(acquisitionBaseline.replied7d, acquisitionBaseline.attempts);

const featureAnalysis = [];
for (const [feature, test] of Object.entries(featureTests)) {
  const matched = acquisition.filter((item) => test(item.text));
  const unmatched = acquisition.filter((item) => !test(item.text));
  const yes24 = matched.filter((item) => item.reply24h).length;
  const no24 = unmatched.filter((item) => item.reply24h).length;
  featureAnalysis.push({
    feature,
    attempts: matched.length,
    coverage: rate(matched.length, acquisition.length),
    replyRate24h: rate(yes24, matched.length),
    comparisonAttempts: unmatched.length,
    comparisonReplyRate24h: rate(no24, unmatched.length),
    relativeLift24h: matched.length && unmatched.length && no24 ? round((yes24 / matched.length) / (no24 / unmatched.length) - 1, 4) : null,
    wilson95: wilson(yes24, matched.length),
  });
}

const wordBuckets = [
  { label: '1-5', min: 1, max: 5 },
  { label: '6-10', min: 6, max: 10 },
  { label: '11-20', min: 11, max: 20 },
  { label: '21-40', min: 21, max: 40 },
  { label: '41-80', min: 41, max: 80 },
  { label: '81+', min: 81, max: Infinity },
].map((bucket) => {
  const items = acquisition.filter((item) => {
    const words = item.text.split(/\s+/).filter(Boolean).length;
    return words >= bucket.min && words <= bucket.max;
  });
  const success = items.filter((item) => item.reply24h).length;
  return { bucket: bucket.label, attempts: items.length, replied24h: success, replyRate24h: rate(success, items.length), wilson95: wilson(success, items.length) };
});

function serializeCounter(map, minAttempts = 1) {
  return [...map.entries()]
    .filter(([, item]) => item.attempts >= minAttempts)
    .map(([key, item]) => ({
      key,
      sample: item.sample,
      attempts: item.attempts,
      conversations: item.conversations.size,
      replied24h: item.replied24h,
      replyRate24h: rate(item.replied24h, item.attempts),
      replied7d: item.replied7d,
      replyRate7d: rate(item.replied7d, item.attempts),
      confirmedClients: item.conversions.size,
      confirmedClientRatePerConversation: rate(item.conversions.size, item.conversations.size),
      wilson95: wilson(item.replied24h, item.attempts),
      firstDate: item.firstDate,
      lastDate: item.lastDate,
    }));
}

const templates = serializeCounter(templateMap, 10);
const templateRankings = {
  mostUsed: [...templates].sort((a, b) => b.attempts - a.attempts).slice(0, 100),
  bestReplyRateMin50: [...templates].filter((x) => x.attempts >= 50).sort((a, b) => b.wilson95.low - a.wilson95.low || b.replyRate24h - a.replyRate24h).slice(0, 50),
  worstReplyRateMin50: [...templates].filter((x) => x.attempts >= 50).sort((a, b) => a.replyRate24h - b.replyRate24h || b.attempts - a.attempts).slice(0, 50),
};

const directReplyOpportunities = pageOpportunities.filter((item) => item.category === 'reply_to_contact');
const directReply24h = directReplyOpportunities.filter((item) => item.reply24h).length;

const intents = Object.fromEntries(Object.entries(intentStats).map(([intent, item]) => [intent, {
  messages: item.messages,
  conversations: item.conversations.size,
  topObservedPageResponses: [...item.responseTemplates.values()].sort((a, b) => b.count - a.count || b.latestDate.localeCompare(a.latestDate)).slice(0, 20),
}]));

const knowledgeCandidates = [...pageKnowledge.values()]
  .sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate))
  .slice(0, 500);

const commonPageMessages = [...pageMessageFrequency.values()]
  .sort((a, b) => b.count - a.count || b.lastDate.localeCompare(a.lastDate))
  .slice(0, 200);

// A second pass distinguishes genuine campaigns/reactivations from direct service
// replies and Messenger system events. This avoids treating automated entry flows
// as high-performing promotional copy.
function stripSystemArtifacts(value = '') {
  return clean(value)
    .replace(/Customer replied to an ad\.?/gi, '')
    .replace(/You are responding to a user comment to a post on your Page\.\s*View comment\.\([^\n]+\)/gi, '')
    .replace(/You are responding to a user comment to a post on your Page\.?/gi, '')
    .replace(/View comment\.\(https?:\/\/[^\s]+\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const conversionDateByPsid = new Map(
  workbook.clients
    .filter((row) => row[9] && row.at(-1))
    .map((row) => [String(row.at(-1)), String(row[9])]),
);

const turnTextFrequency = new Map();
for (const record of records) {
  const turns = makeTurns((record.messages || []).filter((m) => Number.isFinite(Date.parse(m.date))).sort((a, b) => a.date.localeCompare(b.date)));
  for (const turn of turns) {
    if (turn.sender !== 'page') continue;
    const text = stripSystemArtifacts(turn.texts.join('\n'));
    if (!text) continue;
    const key = canonical(text);
    turnTextFrequency.set(key, (turnTextFrequency.get(key) || 0) + 1);
  }
}

function promotionTags(text) {
  const tags = [];
  const tests = {
    freebies: /\b(?:free|freebie|freebies|bonus)\b/i,
    price_drop_or_discount: /\b(?:price drop|discount|\d+%\s*off|off on|promo price|sale)\b/i,
    generic_promo: /\bpromo\b/i,
    scarcity_or_deadline: /\b(?:limited|slots?|last day|days? left|ends?|until|tonight|today only|habol)\b/i,
    bundle_or_bogo: /\b(?:bundle|buy\s*1|get\s*1|bogo|package deal)\b/i,
    repeat_client_offer: /\b(?:repeat client|customer repeater|returning client|suki)\b/i,
    asks_interest: /\b(?:interested|avail|tuloy|proceed|start|simulan|gawan)\b/i,
    asks_business: /\b(?:anong business|ano pong business|para saan|business.*gawan)\b/i,
    asks_goal: /\b(?:goal|customers|inquiries|awareness|target ninyo|target niyo)\b/i,
    asks_duration: /\b(?:gaano.*kahaba|16s|24s|32s|40s|1 minute|2 minutes)\b/i,
    shows_price: /(?:₱|\bphp\b|\bpesos?\b|\b\d{3,5}(?:\.\d{1,2})?\b)/i,
  };
  for (const [tag, test] of Object.entries(tests)) if (test.test(text)) tags.push(tag);
  return tags.length ? tags : ['plain_followup'];
}

function outcomeForCampaign(opportunity) {
  const conversionDate = conversionDateByPsid.get(String(opportunity.psid));
  const convertedAfter = conversionDate && conversionDate >= opportunity.localDate;
  const conversionTime = convertedAfter ? Date.parse(`${conversionDate}T00:00:00+08:00`) : null;
  return {
    convertedWithin30d: Boolean(convertedAfter && conversionTime - opportunity.time <= 30 * DAY_MS),
    convertedWithin90d: Boolean(convertedAfter && conversionTime - opportunity.time <= 90 * DAY_MS),
  };
}

const campaignOpportunities = [];
const likelyHumanFirstReplyLatencies = [];
for (const record of records) {
  const turns = makeTurns((record.messages || []).filter((m) => Number.isFinite(Date.parse(m.date))).sort((a, b) => a.date.localeCompare(b.date)));
  const nextPageAfter = new Array(turns.length);
  let nextPageTurn = null;
  for (let reverseIndex = turns.length - 1; reverseIndex >= 0; reverseIndex -= 1) {
    nextPageAfter[reverseIndex] = nextPageTurn;
    if (turns[reverseIndex].sender === 'page') nextPageTurn = turns[reverseIndex];
  }
  let contactSeen = false;
  let campaignAttempt = 0;
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn.sender === 'contact') {
      contactSeen = true;
      campaignAttempt = 0;
      const nextPage = nextPageAfter[index];
      if (nextPage) {
        const responseText = stripSystemArtifacts(nextPage.texts.join('\n'));
        const responseKey = canonical(responseText);
        if (responseText && (turnTextFrequency.get(responseKey) || 0) < 100) likelyHumanFirstReplyLatencies.push(nextPage.start - turn.end);
      }
      continue;
    }
    if (turn.sender !== 'page') continue;
    const text = stripSystemArtifacts(turn.texts.join('\n'));
    if (!text) continue;
    const previousTurn = turns[index - 1];
    const nextTurn = turns[index + 1];
    const gapFromPrevious = previousTurn ? turn.start - previousTurn.end : null;
    let category;
    if (!contactSeen) category = previousTurn?.sender === 'page' ? 'pre_contact_followup' : 'pre_contact_opener';
    else if (previousTurn?.sender === 'contact') category = gapFromPrevious <= DAY_MS ? 'direct_reply' : 'reactivation';
    else if (previousTurn?.sender === 'page') category = 'unanswered_followup';
    else category = 'other';
    const isCampaign = category === 'reactivation' || category === 'unanswered_followup' || category === 'pre_contact_followup';
    if (!isCampaign) continue;
    campaignAttempt += 1;
    const replyLatency = nextTurn?.sender === 'contact' ? nextTurn.start - turn.end : null;
    const { isoDate, hour, weekday } = localDateParts(turn.end);
    const opportunity = {
      conversationId: record.conversationId,
      psid: record.psid,
      category,
      text,
      key: canonical(text),
      date: new Date(turn.end).toISOString(),
      localDate: isoDate,
      time: turn.end,
      hour,
      weekday,
      attempt: campaignAttempt,
      replyLatency,
      reply24h: replyLatency != null && replyLatency >= 0 && replyLatency <= DAY_MS,
      reply7d: replyLatency != null && replyLatency >= 0 && replyLatency <= 7 * DAY_MS,
      promotionTags: promotionTags(text),
    };
    Object.assign(opportunity, outcomeForCampaign(opportunity));
    campaignOpportunities.push(opportunity);
  }
}

function aggregateCampaign(items, keyFn, sampleFn = (item) => item.text) {
  const map = new Map();
  for (const item of items) {
    const keys = [].concat(keyFn(item));
    for (const key of keys) {
      if (!map.has(key)) map.set(key, { key, sample: sampleFn(item), attempts: 0, replies24h: 0, replies7d: 0, converted30d: new Set(), converted90d: new Set(), conversations: new Set(), firstDate: item.date, lastDate: item.date });
      const row = map.get(key);
      row.attempts += 1;
      row.replies24h += item.reply24h ? 1 : 0;
      row.replies7d += item.reply7d ? 1 : 0;
      row.conversations.add(item.conversationId);
      if (item.convertedWithin30d) row.converted30d.add(String(item.psid));
      if (item.convertedWithin90d) row.converted90d.add(String(item.psid));
      if (item.date < row.firstDate) row.firstDate = item.date;
      if (item.date > row.lastDate) row.lastDate = item.date;
    }
  }
  return [...map.values()].map((row) => ({
    key: row.key,
    sample: row.sample,
    attempts: row.attempts,
    conversations: row.conversations.size,
    replies24h: row.replies24h,
    replyRate24h: rate(row.replies24h, row.attempts),
    replies7d: row.replies7d,
    replyRate7d: rate(row.replies7d, row.attempts),
    convertedClientsWithin30d: row.converted30d.size,
    convertedClientRateWithin30d: rate(row.converted30d.size, row.conversations.size),
    convertedClientsWithin90d: row.converted90d.size,
    convertedClientRateWithin90d: rate(row.converted90d.size, row.conversations.size),
    wilson95: wilson(row.replies24h, row.attempts),
    firstDate: row.firstDate,
    lastDate: row.lastDate,
  }));
}

const campaignTemplates = aggregateCampaign(campaignOpportunities, (item) => item.key);
const campaignFeatures = aggregateCampaign(campaignOpportunities, (item) => item.promotionTags, (item) => item.promotionTags.join(', '));
const campaignAttempts = aggregateCampaign(campaignOpportunities, (item) => String(item.attempt), (item) => `Attempt ${item.attempt}`);
const campaignWeekdays = aggregateCampaign(campaignOpportunities, (item) => item.weekday, (item) => item.weekday);
const campaignHours = aggregateCampaign(campaignOpportunities, (item) => String(item.hour).padStart(2, '0'), (item) => `${item.hour}:00`);
const campaignWordBuckets = wordBuckets.map((bucket) => {
  const [lowText, highText] = bucket.bucket.split('-');
  const min = Number(lowText.replace('+', ''));
  const max = bucket.bucket.endsWith('+') ? Infinity : Number(highText);
  const items = campaignOpportunities.filter((item) => {
    const words = item.text.split(/\s+/).filter(Boolean).length;
    return words >= min && words <= max;
  });
  const success = items.filter((item) => item.reply24h).length;
  return { bucket: bucket.bucket, attempts: items.length, replies24h: success, replyRate24h: rate(success, items.length), wilson95: wilson(success, items.length) };
});

const campaignBaseline = {
  attempts: campaignOpportunities.length,
  replies24h: campaignOpportunities.filter((item) => item.reply24h).length,
  replies7d: campaignOpportunities.filter((item) => item.reply7d).length,
  conversations: new Set(campaignOpportunities.map((item) => item.conversationId)).size,
};
campaignBaseline.replyRate24h = rate(campaignBaseline.replies24h, campaignBaseline.attempts);
campaignBaseline.replyRate7d = rate(campaignBaseline.replies7d, campaignBaseline.attempts);

const campaignPerformance = {
  definition: 'Page reactivations, unanswered follow-ups, and pre-contact follow-ups; direct service replies and Messenger system-only events are excluded.',
  baseline: campaignBaseline,
  likelyHumanFirstResponseLatency: summarizeLatency(likelyHumanFirstReplyLatencies.filter((value) => value >= 0)),
  exactTemplates: {
    mostUsed: [...campaignTemplates].sort((a, b) => b.attempts - a.attempts).slice(0, 100),
    bestMin100: [...campaignTemplates].filter((row) => row.attempts >= 100).sort((a, b) => b.wilson95.low - a.wilson95.low || b.replyRate24h - a.replyRate24h).slice(0, 50),
    worstMin100: [...campaignTemplates].filter((row) => row.attempts >= 100).sort((a, b) => a.replyRate24h - b.replyRate24h || b.attempts - a.attempts).slice(0, 50),
  },
  promotionElements: campaignFeatures.sort((a, b) => b.wilson95.low - a.wilson95.low),
  followupAttempt: campaignAttempts.sort((a, b) => Number(a.key) - Number(b.key)),
  wordBuckets: campaignWordBuckets,
  weekday: campaignWeekdays.sort((a, b) => b.wilson95.low - a.wilson95.low),
  hour: campaignHours.sort((a, b) => b.wilson95.low - a.wilson95.low),
};

const factualEvidencePatterns = {
  turnaround: /\b(?:turnaround|working days?|business days?|ilang araw|days? bago|days? po|oras|hours?|within \d+|matatapos|finish|finished|delivery time)\b/i,
  process: /\b(?:step-by-step|business details form|script.*check|approved.*script|video preview|watermark|final payment|without watermark)\b/i,
  revision: /\b(?:revision|revise|changes? based on script|out of script)\b/i,
  requirements: /\b(?:business name|social media link|preferred video length|preferred style|portrait or landscape|send photos|send.*logo|product images)\b/i,
  payment: /\b(?:down\s*payment|gcash|remaining balance|fully paid|final payment|receipt)\b/i,
  posting_and_ads: /\b(?:ready-to-post caption|facebook\/tiktok|boosting|poster ads?|post.*page|posting)\b/i,
  language_voice: /\b(?:voice.?over|tagalog|english|bisaya|male voice|female voice|boses)\b/i,
  refund_cancellation: /\b(?:refund|cancel|cancellation|non-refundable|money back)\b/i,
  claims_and_results: /\b(?:more sales|more customers|customers, inquiries|viral|guarantee|high-converting|increase.*sales|padamihin.*customers)\b/i,
  legitimacy: /\b(?:legit|transparent|scam|proof|testimonials?|client feedback)\b/i,
};

const factualEvidence = Object.fromEntries(Object.entries(factualEvidencePatterns).map(([category, pattern]) => [category,
  [...pageMessageFrequency.values()]
    .filter((item) => pattern.test(item.sample))
    .sort((a, b) => b.lastDate.localeCompare(a.lastDate) || b.count - a.count)
    .slice(0, 100),
]));

const report = {
  generatedAt: new Date().toISOString(),
  source: {
    page: 'Azshinari',
    archiveDate: '2026-09-15',
    timezone: 'Asia/Manila',
    files: ['live-records.json', 'workbook-data.json'],
    fetchErrors: JSON.parse(fs.readFileSync(path.join(root, 'fetch-errors.json'), 'utf8')).length,
    dateRange: { firstMessage: new Date(minTime).toISOString(), lastMessage: new Date(maxTime).toISOString() },
  },
  definitions: {
    turn: 'Consecutive messages from the same sender grouped when no more than 10 minutes apart.',
    acquisitionAttempt: 'A page turn sent before the contact has ever replied in that conversation.',
    reply24h: 'The next conversational turn is from the contact and begins within 24 hours of the page turn ending.',
    confirmedClient: 'A client included in the separately reviewed 2026-09-15 paid/service evidence workbook.',
  },
  totals,
  conversationMetrics: {
    ...conversationMetrics,
    pageInitiatedContactReplyRate: rate(conversationMetrics.pageInitiatedWithContactReply, conversationMetrics.pageInitiated),
    contactInitiatedPageReplyRate: rate(conversationMetrics.contactInitiatedWithPageReply, conversationMetrics.contactInitiated),
    pageInitiatedConfirmedClientRate: rate(conversationMetrics.confirmedAmongPageInitiated, conversationMetrics.pageInitiated),
    contactInitiatedConfirmedClientRate: rate(conversationMetrics.confirmedAmongContactInitiated, conversationMetrics.contactInitiated),
  },
  latency: {
    firstPageResponseToContactInitiated: summarizeLatency(firstPageReplyLatencies),
    firstContactResponseToPageInitiated: summarizeLatency(firstContactReplyLatencies),
  },
  acquisitionBaseline,
  directReply: {
    attempts: directReplyOpportunities.length,
    replied24h: directReply24h,
    replyRate24h: rate(directReply24h, directReplyOpportunities.length),
  },
  outboundPerformance: {
    features: featureAnalysis.sort((a, b) => (b.relativeLift24h ?? -Infinity) - (a.relativeLift24h ?? -Infinity)),
    wordBuckets,
    weekday: serializeCounter(dayStats).sort((a, b) => b.replyRate24h - a.replyRate24h),
    hour: serializeCounter(hourStats).sort((a, b) => b.replyRate24h - a.replyRate24h),
    attemptNumber: serializeCounter(followupStats).sort((a, b) => Number(a.key) - Number(b.key)),
    templates: templateRankings,
  },
  campaignPerformance,
  intents,
  factualEvidence,
  knowledgeCandidates,
  commonPageMessages,
  caveats: [
    'Observed associations are not randomized experiments; audience quality, campaign source, season, and message age may confound results.',
    'A reply is not the same as a sale. Confirmed-client status is used only where the prior manual evidence review supported it.',
    'Historical prices, promos, turnaround promises, payment details, and inclusions require owner verification before chatbot publication.',
    'Blank/media-only messages are counted but their attachment contents are not available in the text export.',
  ],
};

fs.writeFileSync(path.join(outputDir, 'analysis-data.json'), JSON.stringify(report, null, 2));

const summary = {
  output: path.join(outputDir, 'analysis-data.json'),
  conversations: totals.conversations,
  messages: totals.messages,
  pageMessages: totals.pageMessages,
  contactMessages: totals.contactMessages,
  confirmedClients: totals.confirmedClients,
  pageInitiatedReplyRate: report.conversationMetrics.pageInitiatedContactReplyRate,
  contactInitiatedPageReplyRate: report.conversationMetrics.contactInitiatedPageReplyRate,
  acquisitionAttempts: acquisitionBaseline.attempts,
  acquisitionReplyRate24h: acquisitionBaseline.replyRate24h,
  templatesAnalyzed: templates.length,
};
console.log(JSON.stringify(summary, null, 2));
