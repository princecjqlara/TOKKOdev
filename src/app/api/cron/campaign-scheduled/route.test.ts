import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    resolveCampaignAudienceContactIds: vi.fn(),
    sendCampaignById: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/campaign-audience', () => ({
    resolveCampaignAudienceContactIds: mocks.resolveCampaignAudienceContactIds
}));

vi.mock('@/lib/campaign-send', () => ({
    sendCampaignById: mocks.sendCampaignById
}));

import { GET } from './route';

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/cron/campaign-scheduled', {
        method: 'GET'
    }) as NextRequest;
}

function createSupabaseMock() {
    const dueCampaigns = [
        {
            id: 'campaign_1',
            page_id: 'page_1',
            audience_mode: 'dynamic',
            audience_start_date: '2026-03-01',
            audience_include_tag_ids: ['tag_a'],
            audience_exclude_tag_ids: ['tag_x']
        }
    ];

    const campaignsLte = vi.fn().mockResolvedValue({
        data: dueCampaigns,
        error: null
    });
    const campaignsEqIsLoop = vi.fn().mockReturnValue({ lte: campaignsLte });
    const campaignsInStatus = vi.fn().mockReturnValue({ eq: campaignsEqIsLoop });
    const campaignsSelect = vi.fn().mockReturnValue({ in: campaignsInStatus });

    const campaignsUpdateEq = vi.fn().mockResolvedValue({ error: null });
    const campaignsUpdate = vi.fn().mockReturnValue({ eq: campaignsUpdateEq });

    const campaignRecipientsUpsert = vi.fn().mockResolvedValue({ error: null });

    const from = vi.fn((table: string) => {
        if (table === 'campaigns') {
            return {
                select: campaignsSelect,
                update: campaignsUpdate
            };
        }

        if (table === 'campaign_recipients') {
            return {
                upsert: campaignRecipientsUpsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

        return {
            from,
            campaignRecipientsUpsert,
            campaignsUpdate,
            campaignsInStatus
        };
}

describe('GET /api/cron/campaign-scheduled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('processes due campaigns successfully', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.resolveCampaignAudienceContactIds.mockResolvedValue(['contact_1']);
        mocks.sendCampaignById.mockResolvedValue({
            success: true,
            sent: 1,
            failed: 0
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
    });

    it('materializes dynamic recipients and dispatches due campaigns', async () => {
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.resolveCampaignAudienceContactIds.mockResolvedValue(['contact_1', 'contact_2']);
        mocks.sendCampaignById.mockResolvedValue({
            success: true,
            sent: 2,
            failed: 0
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        expect(supabase.campaignsInStatus).toHaveBeenCalledWith('status', ['scheduled', 'sending']);
        expect(mocks.resolveCampaignAudienceContactIds).toHaveBeenCalledWith({
            supabase,
            pageId: 'page_1',
            rules: {
                startDate: '2026-03-01',
                includeTagIds: ['tag_a'],
                excludeTagIds: ['tag_x']
            }
        });
        expect(supabase.campaignRecipientsUpsert).toHaveBeenCalledWith(
            [
                {
                    campaign_id: 'campaign_1',
                    contact_id: 'contact_1',
                    status: 'pending'
                },
                {
                    campaign_id: 'campaign_1',
                    contact_id: 'contact_2',
                    status: 'pending'
                }
            ],
            { onConflict: 'campaign_id,contact_id', ignoreDuplicates: false }
        );
        expect(mocks.sendCampaignById).toHaveBeenCalledWith({
            campaignId: 'campaign_1',
            supabase,
            allowScheduled: true
        });
        expect(supabase.campaignsUpdate).toHaveBeenCalled();
    });
});
