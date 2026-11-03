const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeText(value) {
  return String(value || '')
    .replace(/â‚±/g, '₱')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s.,!?@/#:+₱-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const signalPatterns = {
  paymentQuestion: [
    /\b(?:how|where|when|paano|saan|kelan|kailan|magkano|hm|ano)\b.{0,45}\b(?:pay|payment|paid|bayad|gcash|maya|deposit|down ?payment|dp)\b/i,
    /\b(?:pay|payment|paid|bayad|gcash|maya|deposit|down ?payment|dp)\b.{0,35}\b(?:ba|po ba|first|muna|how|where|when|paano|saan|magkano|hm|ano)\b/i,
    /\b(?:one[ -]?time|full|partial) payment\b.{0,15}\b(?:ba|po ba|lang ba|only)\b/i
  ],
  paymentIntent: [
    /\b(?:magbabayad|babayad|pay ako|i(?:'ll| will) pay|send ko|isesend ko|transfer ko)\b/i,
    /\b(?:gcash|maya|bank|payment)\b.{0,25}\b(?:number|details|account|qr|send|transfer)\b/i,
    /\b(?:mamaya|bukas|later|tomorrow|pag uwi|kapag)\b.{0,35}\b(?:pay|payment|bayad|gcash|send|transfer)\b/i
  ],
  purchaseCommitment: [
    /\b(?:go ahead|let(?:'s| us) proceed|proceed na|tuloy na|start na|gawan (?:mo|nyo|ninyo)|pagawa na|magpagawa|kukunin ko|i(?:'ll| will) take it|i want to avail|mag ?avail ako|avail ako|book na|reserve na)\b/i,
    /\b(?:sige|cge|yes|opo|oo|okay|ok)\b.{0,30}\b(?:proceed|tuloy|start|gawa|package|pack|seconds?|secs?|minute|minuto|video)\b/i,
    /\b(?:starter|basic|standard|premium|promo) (?:pack|package)\b.{0,15}\b(?:po|please|ako|kunin|avail)?\b/i
  ],
  qualified: [
    /\b(?:how much|hm|price|rate|rates|package|packages|details|samples?|portfolio|process|requirements?|interested|video ad|promo video|content|business|page|brand|product|service)\b/i,
    /\b(?:magkano|presyo|detalye|sample|paano|ano kasama|kailangan|interesado|gusto|business ko|page ko|brand ko|product ko|service ko)\b/i
  ],
  explicitOptOut: [
    /\b(?:not interested|no thanks|no thank you|stop|unsubscribe|remove me|wrong (?:person|number)|spam|don't message|do not message|hindi interested|di interested|d interested|ayaw|pass|wag na|huwag na)\b/i
  ],
  timingDeferral: [
    /\b(?:next time|sa susunod|not now|hindi muna|di muna|maybe next|balikan ko|pag[ -]?iisipan|later na lang|mamaya na lang|bukas na lang|not ready|di pa ready|hindi pa ready)\b/i
  ],
  budgetObjection: [
    /\b(?:no budget|wala(?:ng| pa)?(?: akong| kaming| po)? budget|kulang budget|can't afford|cannot afford|di kaya|hindi kaya|mahal|expensive|pricey|wala(?:ng| pa)?(?: akong| kaming| po)? (?:pera|pambayad|pang payment|funds?))\b/i
  ],
  trustObjection: [
    /\b(?:scam|legit|proof|sure ba|sigurado|baka maloko|trust|testimonial|reviews?)\b/i
  ],
  notDecisionMaker: [
    /\b(?:not (?:the )?owner|hindi (?:ako )?(?:ang )?owner|di (?:ako )?(?:ang )?owner|employee lang|empleyado lang|ask (?:my|the) boss|talk to (?:my|the) boss|discuss with (?:my|the) boss|consult (?:my|the) owner)\b/i
  ],
  priceQuestion: [/\b(?:how much|hm|price|rate|rates|magkano|presyo|quote)\b/i],
  sampleQuestion: [/\b(?:sample|samples|portfolio|previous work|outputs?|examples?|results?|testimonial|reviews?)\b/i],
  packageQuestion: [/\b(?:package|packages|inclusion|included|ano kasama|kasama|details|detalye|freebies)\b/i],
  processQuestion: [/\b(?:how does it work|what is the process|paano (?:po )?(?:ito|yan|magpagawa)|ano (?:po )?(?:ang )?(?:process|kailangan|need|requirements?))\b/i],
  turnaroundQuestion: [/\b(?:how long|when (?:will|can)|turnaround|deadline|kailan|kelan|gaano katagal|ilang araw|makukuha)\b/i],
  creativeNeed: [/\b(?:video ad|commercial video|promo video|reels?|content|edit|editing|shoot|script|voice ?over|fb ads|advertisement)\b/i],
  ownerBusinessSignal: [/\b(?:my|our|aming|naming|ko|namin)\b.{0,25}\b(?:business|page|brand|product|service|shop|store|restaurant|salon|clinic|gym|resort|cafe|real estate)\b/i, /\b(?:business|page|brand|product|service|shop|store|restaurant|salon|clinic|gym|resort|cafe|real estate) (?:ko|namin|po namin)\b/i],
  requirementsProvided: [
    /\b(?:business name|page\s*\/\s*social media link|goal (?:ng|of the) video|location)\s*:/i,
    /\b(?:contact number|phone number)\s*:/i
  ],
  durationSelected: [
    /\b(?:16|24|30|32|40|45|60)\s*(?:s|sec|secs|second|seconds)\b/i,
    /\b(?:1|2|one|two)\s*(?:min|mins|minute|minutes|minuto)\b/i
  ],
  mediaReady: [/\b(?:send|sent|upload|provide|prepare|share)\b.{0,30}\b(?:photo|photos|picture|pictures|pics|video|logo|materials?)\b/i],
  phoneCallIntent: [/\b(?:can (?:i|we) call|call (?:me|us|you)|tawag|tumawag|phone call)\b/i]
};

const paymentConfirmationPatterns = [
  /\b(?:nakapag ?bayad|nagbayad|bayad na|paid na|already paid|i have paid|i paid|payment (?:is )?(?:done|complete|completed)|payment sent)\b/i,
  /\b(?:sent|transferred|na ?send)\b.{0,25}\b(?:payment|bayad|down ?payment|deposit|dp)\b/i,
  /\b(?:payment|bayad|down ?payment|deposit|dp)\b.{0,25}\b(?:sent|transferred|complete|completed|done|na)\b/i,
  /\b(?:proof of payment|payment receipt|resibo ng bayad)\b.{0,30}\b(?:here|eto|ito|sent|attached|check)\b/i,
  /\b(?:here|eto|ito|sent|attached|check)\b.{0,30}\b(?:proof of payment|payment receipt|resibo ng bayad)\b/i
];

const paymentNegationOrFuture = /\b(?:not paid|unpaid|hindi pa|di pa|wala pa|haven't|have not|cannot|can't|cant|mamaya|bukas|tomorrow|later|next time|magbabayad|babayad|pay ako|send ko|isesend ko|transfer ko)\b/i;

export function hasAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

export function isExplicitPaymentConfirmation(rawText) {
  const text = normalizeText(rawText);
  if (!text || hasAny(text, signalPatterns.paymentQuestion) || paymentNegationOrFuture.test(text)) return false;
  return hasAny(text, paymentConfirmationPatterns);
}

function messageSignal(messages, patterns) {
  return messages.some((message) => hasAny(normalizeText(message.message), patterns));
}

function lastSignalIndex(messages, patterns, predicate) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const text = normalizeText(messages[index].message);
    if (predicate ? predicate(text) : hasAny(text, patterns)) return index;
  }
  return -1;
}

function getTurns(messages) {
  const turns = [];
  for (const message of messages) {
    if (!normalizeText(message.message)) continue;
    const last = turns[turns.length - 1];
    if (last?.senderType === message.senderType) {
      last.messages.push(message);
      last.text += ` ${message.message}`;
      last.endedAt = message.created_time || last.endedAt;
    } else {
      turns.push({
        senderType: message.senderType,
        messages: [message],
        text: message.message || '',
        startedAt: message.created_time || null,
        endedAt: message.created_time || null
      });
    }
  }
  return turns;
}

const businessCategories = [
  ['real_estate', /\b(?:real estate|realty|property|properties|condo|house and lot|broker)\b/i],
  ['food_and_beverage', /\b(?:food|restaurant|cafe|coffee|milktea|burger|chicken|catering|bakery|cooking oil)\b/i],
  ['automotive', /\b(?:car|auto|automotive|detailing|painting|motor|tire|vehicle|mudguard)\b/i],
  ['home_services', /\b(?:aircon|air conditioning|electrical|repair|cleaning|plumbing|construction|curtain|septic|furniture)\b/i],
  ['beauty_and_wellness', /\b(?:salon|spa|massage|beauty|skin|clinic|grooming|wellness)\b/i],
  ['retail_and_ecommerce', /\b(?:online shop|online business|retail|wholesale|reseller|clothing|gadget|accessories|baby shop)\b/i],
  ['professional_services', /\b(?:agency|consulting|insurance|security|accounting|legal|travel agency)\b/i],
  ['health', /\b(?:medical|dental|optical|hospital|health|supplement|barley)\b/i],
  ['education', /\b(?:school|tutorial|training|course|academy|books)\b/i]
];

function detectLanguage(text) {
  const tagalog = (text.match(/\b(?:po|opo|ako|ko|namin|ninyo|kayo|paano|magkano|gusto|hindi|wala|salamat|sige|pwede|ba)\b/g) || []).length;
  const english = (text.match(/\b(?:the|and|is|are|my|our|how|what|when|please|business|price|video|can|will)\b/g) || []).length;
  if (tagalog >= 2 && english >= 2) return 'taglish';
  if (tagalog >= 2) return 'tagalog';
  if (english >= 2) return 'english';
  return 'unknown';
}

function clamp(number, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, number));
}

export function classifyConversation(record, paidTagIds = new Set()) {
  const messages = [...(record.messages || [])].sort((a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0));
  const contactMessages = messages.filter((message) => message.senderType === 'contact' && normalizeText(message.message));
  const pageMessages = messages.filter((message) => message.senderType === 'page' && normalizeText(message.message));
  const contactText = normalizeText(contactMessages.map((message) => message.message).join('\n'));
  const tagNames = (record.tags || []).map((tag) => tag.name);
  const hasPaidTag = (record.tags || []).some((tag) => paidTagIds.has(tag.id) || /^paid\s*\/\s*availed service$/i.test(tag.name || '') || /^availed service$/i.test(tag.name || '') || /^paid$/i.test(tag.name || ''));

  const flags = {
    hasPaidTag,
    explicitPaymentConfirmation: contactMessages.some((message) => isExplicitPaymentConfirmation(message.message)),
    paymentQuestion: messageSignal(contactMessages, signalPatterns.paymentQuestion),
    paymentIntent: messageSignal(contactMessages, signalPatterns.paymentIntent),
    purchaseCommitment: messageSignal(contactMessages, signalPatterns.purchaseCommitment),
    qualifiedSignal: messageSignal(contactMessages, signalPatterns.qualified),
    explicitOptOut: messageSignal(contactMessages, signalPatterns.explicitOptOut),
    timingDeferral: messageSignal(contactMessages, signalPatterns.timingDeferral),
    budgetObjection: messageSignal(contactMessages, signalPatterns.budgetObjection),
    trustObjection: messageSignal(contactMessages, signalPatterns.trustObjection),
    notDecisionMaker: messageSignal(contactMessages, signalPatterns.notDecisionMaker),
    priceQuestion: messageSignal(contactMessages, signalPatterns.priceQuestion),
    sampleQuestion: messageSignal(contactMessages, signalPatterns.sampleQuestion),
    packageQuestion: messageSignal(contactMessages, signalPatterns.packageQuestion),
    processQuestion: messageSignal(contactMessages, signalPatterns.processQuestion),
    turnaroundQuestion: messageSignal(contactMessages, signalPatterns.turnaroundQuestion),
    creativeNeed: messageSignal(contactMessages, signalPatterns.creativeNeed),
    ownerBusinessSignal: messageSignal(contactMessages, signalPatterns.ownerBusinessSignal),
    requirementsProvided: messageSignal(contactMessages, signalPatterns.requirementsProvided),
    durationSelected: messageSignal(contactMessages, signalPatterns.durationSelected),
    mediaReady: messageSignal(contactMessages, signalPatterns.mediaReady),
    phoneCallIntent: messageSignal(contactMessages, signalPatterns.phoneCallIntent)
  };

  const lastPositiveIndex = Math.max(
    lastSignalIndex(contactMessages, signalPatterns.purchaseCommitment),
    lastSignalIndex(contactMessages, [], isExplicitPaymentConfirmation),
    lastSignalIndex(contactMessages, signalPatterns.paymentIntent),
    lastSignalIndex(contactMessages, signalPatterns.requirementsProvided)
  );
  const lastNegativeIndex = Math.max(
    lastSignalIndex(contactMessages, signalPatterns.explicitOptOut),
    lastSignalIndex(contactMessages, signalPatterns.timingDeferral),
    lastSignalIndex(contactMessages, signalPatterns.budgetObjection),
    lastSignalIndex(contactMessages, signalPatterns.notDecisionMaker)
  );
  const currentNegative = lastNegativeIndex > lastPositiveIndex;
  const explicitOptOutIsCurrent = lastSignalIndex(contactMessages, signalPatterns.explicitOptOut) === lastNegativeIndex && currentNegative;
  const notDecisionMakerIsCurrent = lastSignalIndex(contactMessages, signalPatterns.notDecisionMaker) === lastNegativeIndex && currentNegative;
  const positiveAfterObjection = lastPositiveIndex > -1 && lastNegativeIndex > -1 && lastPositiveIndex > lastNegativeIndex;
  const turns = getTurns(messages);
  const twoWayTurns = turns.filter((turn) => turn.senderType === 'contact' || turn.senderType === 'page').length;
  const highEngagement = contactMessages.length >= 5 && pageMessages.length >= 5 && twoWayTurns >= 6;
  Object.assign(flags, { positiveAfterObjection, highEngagement });

  const scoreReasons = [];
  let leadScore = 0;
  const add = (points, reason) => {
    leadScore += points;
    scoreReasons.push({ points, reason });
  };
  if (flags.explicitPaymentConfirmation) add(55, 'explicit payment confirmation');
  if (flags.paymentIntent) add(22, 'payment intent');
  if (flags.purchaseCommitment) add(24, 'purchase commitment');
  if (flags.requirementsProvided) add(18, 'requirements provided');
  if (flags.durationSelected) add(12, 'duration selected');
  if (flags.packageQuestion) add(10, 'package interest');
  if (flags.priceQuestion) add(8, 'price interest');
  if (flags.sampleQuestion) add(7, 'proof/sample interest');
  if (flags.processQuestion) add(6, 'process interest');
  if (flags.turnaroundQuestion) add(5, 'turnaround interest');
  if (flags.creativeNeed) add(8, 'creative need');
  if (flags.ownerBusinessSignal) add(8, 'business ownership signal');
  if (flags.mediaReady) add(8, 'media/material readiness');
  if (flags.phoneCallIntent) add(5, 'call intent');
  if (highEngagement) add(6, 'high two-way engagement');
  if (positiveAfterObjection) add(10, 'positive intent after an objection');
  if (currentNegative && flags.timingDeferral) add(-12, 'current timing deferral');
  if (currentNegative && flags.budgetObjection) add(-18, 'current budget objection');
  if (currentNegative && flags.trustObjection) add(-10, 'current trust objection');
  if (explicitOptOutIsCurrent) add(-80, 'current opt-out');
  if (notDecisionMakerIsCurrent) add(-55, 'not the decision maker');
  leadScore = clamp(leadScore, 0, 100);

  let outcome = 'undetermined';
  let confidence = 'low';
  let conversionEvidence = null;
  const reasons = [];
  if (hasPaidTag) {
    outcome = 'converted';
    confidence = 'verified';
    conversionEvidence = 'Paid / Availed Service tag';
    reasons.push(conversionEvidence);
  } else if (flags.explicitPaymentConfirmation) {
    outcome = 'converted';
    confidence = 'likely';
    conversionEvidence = 'explicit first-person payment confirmation';
    reasons.push(conversionEvidence);
  } else if (explicitOptOutIsCurrent || notDecisionMakerIsCurrent) {
    outcome = 'not_qualified';
    confidence = 'high';
    reasons.push(explicitOptOutIsCurrent ? 'latest clear opt-out' : 'latest not-decision-maker signal');
  } else if (currentNegative && (flags.timingDeferral || flags.budgetObjection)) {
    outcome = 'nurture_later';
    confidence = 'medium';
    reasons.push(flags.budgetObjection ? 'current budget constraint' : 'current timing deferral');
  } else if (leadScore >= 40 && (flags.purchaseCommitment || flags.paymentIntent || flags.requirementsProvided)) {
    outcome = 'high_intent';
    confidence = 'medium';
    reasons.push('multiple buying-stage signals');
  } else if (leadScore >= 18 || flags.qualifiedSignal) {
    outcome = 'qualified';
    confidence = leadScore >= 25 ? 'medium' : 'low';
    reasons.push('relevant business need or buying question');
  } else if (contactMessages.length <= 1 && pageMessages.length <= 1) {
    reasons.push('too little usable contact text');
  } else {
    reasons.push('no clear current buying or rejection signal');
  }

  const firstAt = messages[0]?.created_time || null;
  const lastAt = messages[messages.length - 1]?.created_time || null;
  const activeSpanDays = firstAt && lastAt ? Math.max(0, Math.round((new Date(lastAt) - new Date(firstAt)) / DAY_MS)) : 0;
  const businessCategoriesFound = businessCategories.filter(([, pattern]) => pattern.test(contactText)).map(([name]) => name);
  const lastUsableMessage = [...messages].reverse().find((message) => normalizeText(message.message));

  return {
    outcome,
    confidence,
    conversionEvidence,
    reasons,
    flags,
    leadScore,
    scoreReasons,
    tagNames,
    traits: {
      language: detectLanguage(contactText),
      businessCategories: businessCategoriesFound.length ? businessCategoriesFound : ['unknown'],
      contactMessageCount: contactMessages.length,
      pageMessageCount: pageMessages.length,
      conversationTurns: twoWayTurns,
      activeSpanDays,
      lastSender: lastUsableMessage?.senderType || 'unknown',
      firstMessageAt: firstAt,
      lastMessageAt: lastAt
    }
  };
}

export function triggerBucketsForText(rawText) {
  const text = normalizeText(rawText);
  const buckets = [];
  if (/\b(?:2 videos|buy 1 get 1|bonus video|free 30-sec|free advanced|ads course)\b/i.test(text)) buckets.push('bogo_bonus_course');
  if (/\b(?:1499|1,499|₱1,499|p1499|php 1499)\b/i.test(text)) buckets.push('1499_offer');
  if (/\b(?:50 dp|₱50|p50|php 50|50 pesos|50 only|dp to start)\b/i.test(text)) buckets.push('low_dp');
  if (/\b(?:promo|naka promo)\b/i.test(text)) buckets.push('promo_followup');
  if (/\b(?:tuloy|proceed|pagawa|gawan|interested)\b/i.test(text)) buckets.push('direct_close');
  if (/\b(?:customer|dumami|grow your brand|sales|benta|roi)\b/i.test(text)) buckets.push('growth_benefit');
  if (/\b(?:sample|portfolio|previous work|result|testimonial)\b/i.test(text)) buckets.push('proof_sample');
  if (/\b(?:hi|hello|kamusta|checking|follow up)\b/i.test(text)) buckets.push('soft_followup');
  return buckets.length ? buckets : ['other'];
}

export function conversationTriggerBuckets(messages) {
  const buckets = new Set();
  for (const message of messages || []) {
    if (message.senderType !== 'page') continue;
    for (const bucket of triggerBucketsForText(message.message)) {
      if (bucket !== 'other') buckets.add(bucket);
    }
  }
  return buckets.size ? [...buckets] : ['other'];
}

export function responseEpisodes(record, paidTagIds = new Set()) {
  const messages = [...(record.messages || [])].sort((a, b) => new Date(a.created_time || 0) - new Date(b.created_time || 0));
  const turns = getTurns(messages);
  const episodes = [];
  for (let index = 0; index < turns.length; index++) {
    const outbound = turns[index];
    if (outbound.senderType !== 'page') continue;
    const response = turns[index + 1]?.senderType === 'contact' ? turns[index + 1] : null;
    const responseClassification = response
      ? classifyConversation({ messages: response.messages, tags: [] }, new Set())
      : null;
    const buckets = triggerBucketsForText(outbound.text);
    episodes.push({
      conversationId: record.conversationId,
      sentAt: outbound.endedAt,
      buckets,
      replied: Boolean(response),
      repliedAt: response?.startedAt || null,
      responseOutcome: responseClassification?.outcome || null,
      responseLeadScore: responseClassification?.leadScore || 0,
      positiveResponse: Boolean(responseClassification && ['converted', 'high_intent', 'qualified'].includes(responseClassification.outcome)),
      negativeResponse: Boolean(responseClassification && ['not_qualified', 'nurture_later'].includes(responseClassification.outcome))
    });
  }
  return episodes;
}

export function legacyPaymentSignal(rawText) {
  const text = normalizeText(rawText);
  return /\b(?:paid|payment|pay|deposit|down ?payment|dp|gcash|maya|bank transfer|receipt|resibo|proof|screenshot|sent|nasend|na send|bayad|nagbayad|binayaran|paid na|nakapagbayad)\b/i.test(text);
}

export { signalPatterns };
