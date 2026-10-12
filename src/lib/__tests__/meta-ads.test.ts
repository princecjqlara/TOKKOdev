import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdsApiError, getAdsDateRanges, getCreativePageId, getMetaAdAccounts, getMetaAdsReport, normalizeInsight } from '../meta-ads';
import type { AdsAccount } from '../ads-guard';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const account: AdsAccount = { id: 'act_123', name: 'Test', currency: 'PHP', timezone_name: 'Asia/Manila', account_status: 1 };
const now = new Date('2026-10-13T00:00:00Z');
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('Meta ads metric normalization', () => {
    it('never sums overlapping purchase or lead action aliases', () => {
        const row = { ad_id: '1', date_start: '2026-10-06', date_stop: '2026-10-12',
            actions: [{ action_type: 'purchase', value: '5' }, { action_type: 'omni_purchase', value: '5' }, { action_type: 'offsite_conversion.fb_pixel_purchase', value: '5' }],
            action_values: [{ action_type: 'purchase', value: '500' }, { action_type: 'omni_purchase', value: '500' }] };
        expect(normalizeInsight(row, 'purchases')).toMatchObject({ results: 5, revenue: 500 });
        expect(normalizeInsight({ ...row, actions: [{ action_type: 'lead', value: '8' }, { action_type: 'omni_lead', value: '8' }] }, 'leads').results).toBe(8);
    });
    it('distinguishes missing purchase values from zero value and rejects malformed spend', () => {
        expect(normalizeInsight(undefined, 'purchases').revenue).toBeNull();
        expect(() => normalizeInsight({ ad_id: '1', spend: 'NaN', date_start: '', date_stop: '' }, 'messages')).toThrow(AdsApiError);
    });
    it('does not substitute new messaging connections for started conversations', () => {
        expect(normalizeInsight({ ad_id: '1', date_start: '', date_stop: '', actions: [{ action_type: 'onsite_conversion.total_messaging_connection', value: '100' }] }, 'messages').results).toBe(0);
    });
    it('uses completed account-local days across month boundaries', () => {
        expect(getAdsDateRanges('Asia/Manila', new Date('2026-10-31T18:00:00Z'))).toEqual({
            currentRange: { since: '2026-10-25', until: '2026-10-31' }, previousRange: { since: '2026-10-18', until: '2026-10-24' }
        });
        expect(getAdsDateRanges('America/Los_Angeles', now).currentRange.until).toBe('2026-10-11');
    });
    it('matches boosted posts and unpublished Page creatives', () => {
        expect(getCreativePageId({ object_story_spec: { page_id: '111' }, actor_id: '222' })).toBe('111');
        expect(getCreativePageId({ effective_object_story_id: '111_333' })).toBe('111');
        expect(getCreativePageId(undefined)).toBeNull();
    });
});

describe('Meta ads complete reporting', () => {
    it('follows cursors at the trusted endpoint and keeps tokens out of URLs', async () => {
        const mock = vi.fn().mockResolvedValueOnce(json({ data: [account], paging: { next: 'https://untrusted.invalid/', cursors: { after: 'page-2' } } }))
            .mockResolvedValueOnce(json({ data: [{ ...account, id: 'act_456' }] }));
        vi.stubGlobal('fetch', mock);
        expect(await getMetaAdAccounts('secret-token')).toHaveLength(2);
        const [url, options] = mock.mock.calls[1];
        expect(url.hostname).toBe('graph.facebook.com');
        expect(url.searchParams.get('after')).toBe('page-2');
        expect(String(url)).not.toContain('secret-token');
        expect(options.headers.Authorization).toBe('Bearer secret-token');
    });
    it('rejects a malformed response rather than treating it as zero spend', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({})));
        await expect(getMetaAdAccounts('token')).rejects.toMatchObject({ code: 'ADS_REPORT_INCOMPLETE' });
    });
    it('classifies permission, expired login, and rate-limit failures', async () => {
        const mock = vi.fn().mockResolvedValueOnce(json({ error: { code: 200 } }, 400))
            .mockResolvedValueOnce(json({ error: { code: 190 } }, 400))
            .mockResolvedValueOnce(json({ error: { code: 613 } }, 400));
        vi.stubGlobal('fetch', mock);
        await expect(getMetaAdAccounts('token')).rejects.toMatchObject({ status: 409, code: 'ADS_PERMISSION_REQUIRED' });
        await expect(getMetaAdAccounts('token')).rejects.toMatchObject({ status: 409, code: 'ADS_REAUTH_REQUIRED' });
        await expect(getMetaAdAccounts('token')).rejects.toMatchObject({ status: 429, code: 'ADS_RATE_LIMIT' });
    });
    it('uses full-period frequency and a recent campaign edit while preserving 7-day totals', async () => {
        const row = { ad_id: '11', spend: '700', impressions: '10000', reach: '2000', frequency: '5', date_start: '2026-10-06', date_stop: '2026-10-12' };
        const mock = vi.fn().mockResolvedValueOnce(json({ data: [{ id: '11', name: 'Ad', effective_status: 'ACTIVE', updated_time: '2026-09-01T00:00:00Z', campaign: { id: '22', name: 'Campaign', daily_budget: '5000', updated_time: '2026-10-12T00:00:00Z' }, creative: { actor_id: '111' } }] }))
            .mockResolvedValueOnce(json({ data: [row] })).mockResolvedValueOnce(json({ data: [] }))
            .mockResolvedValueOnce(json({ data: Array.from({ length: 7 }, (_, i) => ({ ...row, spend: '100', reach: '500', frequency: '1', date_start: `2026-10-${String(i + 6).padStart(2, '0')}` })) }));
        vi.stubGlobal('fetch', mock);
        const report = await getMetaAdsReport('token', account, 'messages', now);
        expect(report.ads[0]).toMatchObject({ updatedTime: '2026-10-12T00:00:00Z', budgetOwner: 'campaign', pageId: '111', current: { spend: 700, reach: 2000, frequency: 5, activeDays: 7 } });
        expect(report.ads[0].daily).toHaveLength(7);
        expect(mock.mock.calls[1][0].searchParams.get('use_unified_attribution_setting')).toBe('true');
    });
    it('withholds a report when daily spending does not reconcile with weekly spending', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ data: [] }))
            .mockResolvedValueOnce(json({ data: [{ ad_id: '11', spend: '500', date_start: '2026-10-06', date_stop: '2026-10-12' }] }))
            .mockResolvedValueOnce(json({ data: [] })).mockResolvedValueOnce(json({ data: [] })));
        await expect(getMetaAdsReport('token', account, 'messages', now)).rejects.toMatchObject({ code: 'ADS_REPORT_INCOMPLETE' });
    });
});
