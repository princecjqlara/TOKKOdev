import { describe, expect, it } from 'vitest';
import {
  classifyConversation,
  conversationTriggerBuckets,
  isExplicitPaymentConfirmation,
  triggerBucketsForText
} from './strix-analysis-core.mjs';

function record(contactMessages, pageMessages = ['How can we help?']) {
  const messages = [];
  const max = Math.max(contactMessages.length, pageMessages.length);
  for (let index = 0; index < max; index++) {
    if (pageMessages[index]) messages.push({ senderType: 'page', message: pageMessages[index], created_time: `2026-01-01T00:${String(index * 2).padStart(2, '0')}:00Z` });
    if (contactMessages[index]) messages.push({ senderType: 'contact', message: contactMessages[index], created_time: `2026-01-01T00:${String(index * 2 + 1).padStart(2, '0')}:00Z` });
  }
  return { messages, tags: [] };
}

describe('payment confirmation accuracy', () => {
  it.each([
    'Magkano bayad?',
    'Payment first po ba?',
    'One time payment lang ba yan?',
    'Wala pa po akong pang payment',
    'Bukas na lang po ako magbabayad',
    'Paano ang payment via GCash?',
    'Send GCash po',
    'Please send the price and payment details'
  ])('does not treat a question, objection, or future intent as paid: %s', (text) => {
    expect(isExplicitPaymentConfirmation(text)).toBe(false);
    expect(classifyConversation(record([text])).outcome).not.toBe('converted');
  });

  it.each([
    'Nakapagbayad na po ako',
    'Paid na po, paki-check',
    'Sent na po ang down payment',
    'I already paid via GCash',
    'Here is the proof of payment, please check'
  ])('recognizes explicit completed payment: %s', (text) => {
    expect(isExplicitPaymentConfirmation(text)).toBe(true);
    const result = classifyConversation(record([text]));
    expect(result.outcome).toBe('converted');
    expect(result.confidence).toBe('likely');
  });
});

describe('latest intent wins', () => {
  it('keeps a timing objection as nurture instead of rejecting the lead', () => {
    const result = classifyConversation(record(['Magkano po?', 'Medyo mahal, next time na lang po'], ['Our package is ₱1,499', 'Okay po']));
    expect(result.outcome).toBe('nurture_later');
  });

  it('recognizes positive intent after an earlier objection', () => {
    const result = classifyConversation(record(['Wala pa akong budget', 'Sige po, proceed na tayo sa 40 seconds'], ['Okay', 'Great']));
    expect(result.outcome).toBe('high_intent');
    expect(result.flags.positiveAfterObjection).toBe(true);
  });

  it('uses an exact paid tag as verified ground truth', () => {
    const result = classifyConversation({
      ...record(['How much?']),
      tags: [{ id: 'paid', name: 'Paid / Availed Service' }]
    }, new Set(['paid']));
    expect(result.outcome).toBe('converted');
    expect(result.confidence).toBe('verified');
  });
});

describe('offer buckets', () => {
  it('keeps other for an individual unrecognized outbound message', () => {
    expect(triggerBucketsForText('Thank you po')).toEqual(['other']);
  });

  it('uses other at conversation level only when no recognized offer exists', () => {
    expect(conversationTriggerBuckets([
      { senderType: 'page', message: 'Thank you po' },
      { senderType: 'contact', message: 'Okay po' },
      { senderType: 'page', message: 'Promo still available, interested po?' }
    ])).toEqual(expect.arrayContaining(['promo_followup', 'direct_close']));
    expect(conversationTriggerBuckets([
      { senderType: 'page', message: 'Thank you po' },
      { senderType: 'contact', message: 'Okay po' }
    ])).toEqual(['other']);
  });
});
