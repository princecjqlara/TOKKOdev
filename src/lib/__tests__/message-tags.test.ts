import { describe, expect, it } from 'vitest';
import { normalizeMessageTag, isMessageTag } from '../message-tags';

describe('message tags', () => {
  it('accepts valid tags', () => {
    expect(isMessageTag('ACCOUNT_UPDATE')).toBe(true);
    expect(isMessageTag('CONFIRMED_EVENT_UPDATE')).toBe(true);
  });

  it('rejects nullish values', () => {
    expect(isMessageTag(null)).toBe(false);
    expect(isMessageTag(undefined)).toBe(false);
  });

  it('passes through valid tags', () => {
    expect(normalizeMessageTag('ACCOUNT_UPDATE')).toBe('ACCOUNT_UPDATE');
    expect(normalizeMessageTag('CONFIRMED_EVENT_UPDATE')).toBe('CONFIRMED_EVENT_UPDATE');
  });

  it('defaults invalid or missing tags', () => {
    expect(normalizeMessageTag(null)).toBe('ACCOUNT_UPDATE');
    expect(normalizeMessageTag(undefined)).toBe('ACCOUNT_UPDATE');
    expect(normalizeMessageTag('NOPE')).toBe('ACCOUNT_UPDATE');
  });
});
