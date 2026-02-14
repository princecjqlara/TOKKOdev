import { describe, expect, it } from 'vitest';
import { buildTaggedMessagePayload } from '../facebook';

describe('buildTaggedMessagePayload', () => {
  it('uses the provided tag', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello', 'CONFIRMED_EVENT_UPDATE');
    expect(payload.tag).toBe('CONFIRMED_EVENT_UPDATE');
  });

  it('defaults to ACCOUNT_UPDATE', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello');
    expect(payload.tag).toBe('ACCOUNT_UPDATE');
  });

  it('defaults to ACCOUNT_UPDATE for invalid tags', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello', 'NOT_A_TAG');
    expect(payload.tag).toBe('ACCOUNT_UPDATE');
  });

  it('builds the expected payload shape', () => {
    const payload = buildTaggedMessagePayload('psid', 'hello', 'CONFIRMED_EVENT_UPDATE');
    expect(payload.messaging_type).toBe('MESSAGE_TAG');
    expect(payload.recipient).toEqual({ id: 'psid' });
    expect(payload.message).toEqual({ text: 'hello' });
  });
});
