import { describe, expect, it } from 'vitest';
import { normalizeMessageTag, isMessageTag } from '../message-tags';

describe('message tags', () => {
  it('accepts valid tags', () => {
    expect(isMessageTag('ACCOUNT_UPDATE')).toBe(true);
    expect(isMessageTag('CONFIRMED_EVENT_UPDATE')).toBe(true);
  });

  it('defaults invalid or missing tags', () => {
    expect(normalizeMessageTag(undefined)).toBe('ACCOUNT_UPDATE');
    expect(normalizeMessageTag('NOPE')).toBe('ACCOUNT_UPDATE');
  });
});
