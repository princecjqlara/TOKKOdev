import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ session: vi.fn(), delivery: vi.fn() }));
vi.mock('next-auth/react', () => ({ useSession: mocks.session }));
vi.mock('@/lib/campaign-delivery-client', () => ({ runCampaignDelivery: mocks.delivery }));
vi.mock('@/components/Modal', () => ({ default: () => null }));
vi.mock('@/components/Pagination', () => ({ default: () => null }));
import CampaignsPage from '../../app/dashboard/campaigns/page';

let screen: ReactTestRenderer | undefined;
let search: string;
let failListing: boolean;
let saved: any[];
const text = () => JSON.stringify(screen!.toJSON());
const render = async () => { await act(async () => { screen = create(React.createElement(CampaignsPage)); }); };
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    search = ''; failListing = false; saved = [];
    mocks.session.mockReturnValue({ data: { user: { id: 'user' } } });
    mocks.delivery.mockResolvedValue({ success: true, sent: 1, failed: 0, remaining: 0 });
    vi.stubGlobal('React', React);
    vi.stubGlobal('document', { hidden: false });
    vi.stubGlobal('window', {
        location: { get search() { return search; } }, history: { replaceState: vi.fn() },
        localStorage: { getItem: () => null }, setInterval, clearInterval
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/pages') return Response.json({ pages: [{ id: 'first', name: 'First Page' }, { id: 'other', name: 'Other Page' }] });
        if (url.startsWith('/api/campaigns?')) return failListing ? Response.json({ message: 'Service unavailable' }, { status: 503 })
            : Response.json({ items: saved, total: saved.length, page: 1, pageSize: 25 });
        throw new Error(`Unexpected request ${url}`);
    }));
});
afterEach(() => { act(() => screen?.unmount()); screen = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('finding and recovering a saved campaign', () => {
    it('opens all assigned Pages instead of hiding sends behind the first Page', async () => {
        await render();
        const listing = vi.mocked(fetch).mock.calls.find(([url]) => String(url).startsWith('/api/campaigns?'))!;
        expect(new URL(String(listing[0]), 'http://localhost').searchParams.get('pageId')).toBe('');
        expect(text()).toContain('All Pages');
    });

    it('opens the exact campaign on its own Page from a bulk recovery link', async () => {
        search = '?campaignId=saved&pageId=other';
        saved = [{ id: 'saved', page_id: 'other', name: 'Saved bulk send', status: 'draft', total_recipients: 2_000_005, sent_count: 0, failed_count: 0 }];
        await render();
        const listings = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/campaigns?'));
        expect(listings.every(([url]) => new URL(String(url), 'http://localhost').searchParams.get('campaignId') === 'saved')).toBe(true);
        expect(text()).toContain('Saved bulk send');
        expect(screen!.root.findAllByType('select')[0].props.value).toBe('other');
    });

    it('shows a retryable loading error without claiming there are no campaigns', async () => {
        failListing = true;
        await render();
        expect(text()).toContain('Campaigns could not be loaded');
        expect(text()).not.toContain('No matching campaigns');
        failListing = false;
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
        expect(text()).not.toContain('Campaigns could not be loaded');
    });

    it('explains a deleted or inaccessible recovery target without offering to continue it', async () => {
        search = '?campaignId=missing';
        await render();
        expect(text()).toContain('Campaign unavailable');
        expect(text()).not.toContain('Continue Unsent');
        expect(mocks.delivery).not.toHaveBeenCalled();
    });

    it('automatically continues an explicitly enabled saved queue when its link opens', async () => {
        search = '?campaignId=saved&pageId=other';
        saved = [{ id: 'saved', page_id: 'other', name: 'Saved bulk send', status: 'sending', background_delivery_enabled: true,
            total_recipients: 2_000_005, sent_count: 500, failed_count: 1 }];
        await render();
        expect(mocks.delivery).toHaveBeenCalledTimes(1);
        expect(mocks.delivery).toHaveBeenCalledWith('saved', expect.objectContaining({ initial: {
            queued: true, sent: 500, failed: 1, remaining: 1_999_504
        } }));
    });
});
