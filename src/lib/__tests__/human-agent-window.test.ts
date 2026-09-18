import { describe, expect, it } from 'vitest';
import {
    getManualReplyMessagingType,
    HUMAN_AGENT_REPLY_WINDOW_MS,
    STANDARD_REPLY_WINDOW_MS
} from '../human-agent-window';

const now = new Date('2026-09-19T12:00:00.000Z');

function ago(milliseconds: number) {
    return new Date(now.getTime() - milliseconds).toISOString();
}

describe('getManualReplyMessagingType', () => {
    it('uses the standard reply for a customer message under 24 hours old', () => {
        expect(getManualReplyMessagingType(ago(STANDARD_REPLY_WINDOW_MS - 1), now)).toBe('RESPONSE');
    });

    it('uses Human Agent only after the standard window', () => {
        expect(getManualReplyMessagingType(ago(STANDARD_REPLY_WINDOW_MS), now)).toBe('HUMAN_AGENT');
    });

    it('blocks sends close to or outside the 7-day boundary', () => {
        expect(getManualReplyMessagingType(ago(HUMAN_AGENT_REPLY_WINDOW_MS - 30_000), now)).toBeNull();
        expect(getManualReplyMessagingType(ago(HUMAN_AGENT_REPLY_WINDOW_MS), now)).toBeNull();
    });

    it('blocks missing, invalid, and future customer-message times', () => {
        expect(getManualReplyMessagingType(null, now)).toBeNull();
        expect(getManualReplyMessagingType('invalid', now)).toBeNull();
        expect(getManualReplyMessagingType(new Date(now.getTime() + 1000).toISOString(), now)).toBeNull();
    });
});
