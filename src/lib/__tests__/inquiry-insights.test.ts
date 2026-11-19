import { describe, it, expect, vi } from 'vitest';
import { inquiryEventFromWebhook, captureWebhookInquiry, captureSavedInquiryMessages } from '../inquiry-insights';
const inbound = (changes: any = {}) => ({ sender: { id: 'person' }, recipient: { id: 'page' }, timestamp: 1770000000000, message: { mid: 'mid-inbound', text: 'hello' }, ...changes });
describe('forward inquiry source capture', () => {
    it('records actual customer messages and attachments without storing their contents', () => {
        const event = inquiryEventFromWebhook('page', inbound({ message: { mid: 'photo', attachments: [{ payload: { url: 'private-photo' } }] } }));
        expect(event).toMatchObject({ psid: 'person', event: { message_id: 'photo', kind: 'inbound', source: 'messenger', time_basis: 'provider' } });
        expect(JSON.stringify(event)).not.toContain('private-photo');
    });
    it.each(['delivery', 'read', 'postback', 'referral'])('does not turn %s events into inquiries', kind => {
        expect(inquiryEventFromWebhook('page', inbound({ message: undefined, [kind]: { watermark: 1770000000000 } }))).toBeNull();
    });
    it('does not invent a source timestamp for incomplete events', () => {
        expect(inquiryEventFromWebhook('page', inbound({ timestamp: undefined }))?.event.occurred_at).toBeNull();
        expect(inquiryEventFromWebhook('page', inbound({ timestamp: 'invalid' }))?.event.occurred_at).toBeNull();
    });
    it('rejects cross-Page and deleted/echoed inbound messages', () => {
        expect(inquiryEventFromWebhook('page', inbound({ recipient: { id: 'other' } }))).toBeNull();
        expect(inquiryEventFromWebhook('page', inbound({ message: { mid: 'x', is_echo: true } }))).toBeNull();
        expect(inquiryEventFromWebhook('page', inbound({ message: { mid: 'x', is_deleted: true } }))).toBeNull();
    });
    it('keeps Page replies separate from administrative stage evidence', () => {
        const outbound = inbound({ sender: { id: 'page' }, recipient: { id: 'person' }, message: { mid: 'stage', text: 'Lead stage set to Qualified.' } });
        expect(inquiryEventFromWebhook('page', outbound)).toMatchObject({ psid: 'person', event: { kind: 'stage', stage: 'qualified' } });
        expect(inquiryEventFromWebhook('page', { ...outbound, message: { mid: 'reply', text: 'Thanks for your inquiry' } })?.event.kind).toBe('outbound');
    });
    it('uses the resolved contact and Page in its service-only call', async () => {
        const db = { rpc: vi.fn().mockResolvedValue({ data: { accepted: 1 }, error: null }) };
        await captureWebhookInquiry(db, 'page-row', 'page', inbound(), 'contact-row', true);
        expect(db.rpc).toHaveBeenCalledWith('record_tokko_inquiry_events', expect.objectContaining({ p_page: 'page-row', p_contact: 'contact-row', p_new_contact: true }));
    });
    it('propagates a collection failure so the signed webhook can retry', async () => {
        const failure = { code: '503' };
        await expect(captureWebhookInquiry({ rpc: vi.fn().mockResolvedValue({ error: failure }) }, 'page-row', 'page', inbound(), 'contact-row')).rejects.toEqual(failure);
    });
    it('does not create contacts for outbound echoes', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
        const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle };
        const db = { from: vi.fn(() => query), rpc: vi.fn() };
        await captureWebhookInquiry(db, 'page-row', 'page', inbound({ sender: { id: 'page' }, recipient: { id: 'untracked' } }));
        expect(db.rpc).not.toHaveBeenCalled();expect(db.from).toHaveBeenCalledWith('contacts');
    });
    it('reuses history IDs/times in event order without reading Meta or storing message content', async () => {
        const query: any = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'contact-row' }, error: null }) };
        const db = { from: vi.fn(() => query), rpc: vi.fn().mockResolvedValue({ data: { accepted: 2 }, error: null }) };
        await captureSavedInquiryMessages(db, { id: 'page-row', fb_page_id: 'page' }, 'person', [
            { id: 'reply', from: { id: 'page' }, created_time: '2026-02-01T00:05:00Z', message: 'private reply' },
            { id: 'in', from: { id: 'person' }, created_time: '2026-02-01T00:00:00Z', message: 'private question' },
            { id: 'other', from: { id: 'someone-else' }, created_time: '2026-02-01T00:00:00Z' }
        ]);
        expect(db.rpc).toHaveBeenCalledTimes(1);
        const args = db.rpc.mock.calls[0][1];
        expect(args.p_events.map((e: any) => e.message_id)).toEqual(['in', 'reply']);expect(args.p_events[0]).toMatchObject({ kind: 'inbound', collector: 'saved_history' });
        expect(JSON.stringify(args)).not.toContain('private');
    });
    it('ignores incomplete history metadata before any database request', async () => {
        const db = { from: vi.fn(), rpc: vi.fn() };
        await captureSavedInquiryMessages(db, { id: 'page-row', fb_page_id: 'page' }, 'person', [{ message: 'not a source event', from: { id: 'person' } }]);
        expect(db.from).not.toHaveBeenCalled();expect(db.rpc).not.toHaveBeenCalled();
    });
});
