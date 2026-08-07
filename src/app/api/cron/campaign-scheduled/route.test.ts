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

type CampaignRow = {
    id: string;
    page_id: string;
    status: 'scheduled' | 'sending';
    audience_mode: 'specific' | 'dynamic';
    audience_start_date: string | null;
    audience_include_tag_ids: string[];
    audience_exclude_tag_ids: string[];
    audience_materialized_at: string | null;
    recurrence: 'none' | 'daily';
    recurrence_end_at: string | null;
    scheduled_at: string | null;
    updated_at: string;
};

function createRequest(): NextRequest {
    return new Request('http://localhost:3000/api/cron/campaign-scheduled', {
        method: 'GET'
    }) as NextRequest;
}

function createThenableQuery<T>(resultFactory: () => Promise<T>) {
    const query: any = {
        eq: vi.fn(() => query),
        lte: vi.fn(() => query),
        in: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        select: vi.fn(() => query),
        then: (resolve: (value: T) => unknown, reject: (error: unknown) => unknown) =>
            resultFactory().then(resolve, reject)
    };

    return query;
}

function createCampaign(overrides: Partial<CampaignRow> = {}): CampaignRow {
    return {
        id: 'campaign_1',
        page_id: 'page_1',
        status: 'scheduled',
        audience_mode: 'dynamic',
        audience_start_date: '2026-03-01',
        audience_include_tag_ids: ['tag_a'],
        audience_exclude_tag_ids: ['tag_x'],
        audience_materialized_at: null,
        recurrence: 'none',
        recurrence_end_at: null,
        scheduled_at: '2026-03-22T10:30:00.000Z',
        updated_at: '2026-03-22T10:00:00.000Z',
        ...overrides
    };
}

function createSupabaseMock(options: {
    campaignLevelCampaigns?: CampaignRow[];
    staleSendingCampaigns?: CampaignRow[];
    dueRecipientCampaigns?: CampaignRow[];
    claimSucceeds?: boolean;
} = {}) {
    const campaignLevelCampaigns = options.campaignLevelCampaigns ?? [createCampaign()];
    const staleSendingCampaigns = options.staleSendingCampaigns ?? [];
    const dueRecipientCampaigns = options.dueRecipientCampaigns ?? [];
    const claimSucceeds = options.claimSucceeds ?? true;

    let campaignSelectCount = 0;
    const campaignsSelect = vi.fn(() => {
        campaignSelectCount += 1;
        return createThenableQuery(async () => ({
            data: campaignSelectCount === 1 ? campaignLevelCampaigns : staleSendingCampaigns,
            error: null
        }));
    });

    const campaignsUpdateEq = vi.fn();
    const campaignsUpdateSelect = vi.fn();
    const campaignsUpdate = vi.fn((updates: Record<string, unknown>) => {
        const query: any = {
            eq: vi.fn(() => query),
            lte: vi.fn(() => query),
            select: vi.fn(() => {
                campaignsUpdateSelect();
                return Promise.resolve({
                    data: updates.status === 'sending' && claimSucceeds ? [{ id: 'claimed' }] : null,
                    error: null
                });
            }),
            then: (
                resolve: (value: { error: null }) => unknown,
                reject: (error: unknown) => unknown
            ) => Promise.resolve({ error: null }).then(resolve, reject)
        };
        campaignsUpdateEq.mockImplementation(query.eq);
        return query;
    });

    const campaignRecipientsUpsert = vi.fn().mockResolvedValue({ error: null });
    const campaignRecipientsSelect = vi.fn(() => createThenableQuery(async () => ({
        data: dueRecipientCampaigns.map((campaign) => ({
            campaign_id: campaign.id,
            campaigns: campaign
        })),
        error: null
    })));

    const from = vi.fn((table: string) => {
        if (table === 'campaigns') {
            return {
                select: campaignsSelect,
                update: campaignsUpdate
            };
        }

        if (table === 'campaign_recipients') {
            return {
                select: campaignRecipientsSelect,
                upsert: campaignRecipientsUpsert
            };
        }

        throw new Error(`Unexpected table: ${table}`);
    });

    return {
        from,
        campaignsSelect,
        campaignsUpdate,
        campaignsUpdateSelect,
        campaignRecipientsUpsert,
        campaignRecipientsSelect
    };
}

async function loadRoute() {
    vi.resetModules();
    return import('./route');
}

describe('GET /api/cron/campaign-scheduled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('materializes dynamic recipients and dispatches due campaign-level schedules', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.resolveCampaignAudienceContactIds.mockResolvedValue(['contact_1', 'contact_2']);
        mocks.sendCampaignById.mockResolvedValue({
            success: true,
            sent: 2,
            failed: 0,
            body: { success: true, sent: 2, failed: 0 }
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
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
            allowScheduled: true,
            dueAt: expect.any(String),
            sendBatchSize: 10,
            delayBetweenBatchesMs: 0,
            maxRecipientsPerRun: 25,
            maxProcessingTimeMs: 25000,
            includeUnscheduledRecipients: true
        });
    });

    it('dispatches recipient-level scheduled campaigns such as best-time sends', async () => {
        const { GET } = await loadRoute();
        const bestTimeCampaign = createCampaign({
            id: 'campaign_best_time',
            audience_mode: 'specific',
            scheduled_at: null
        });
        const supabase = createSupabaseMock({
            campaignLevelCampaigns: [],
            dueRecipientCampaigns: [bestTimeCampaign]
        });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.sendCampaignById.mockResolvedValue({
            success: true,
            sent: 1,
            failed: 0,
            body: { success: true, sent: 1, failed: 0 }
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        expect(mocks.resolveCampaignAudienceContactIds).not.toHaveBeenCalled();
        expect(mocks.sendCampaignById).toHaveBeenCalledWith({
            campaignId: 'campaign_best_time',
            supabase,
            allowScheduled: true,
            dueAt: expect.any(String),
            sendBatchSize: 10,
            delayBetweenBatchesMs: 0,
            maxRecipientsPerRun: 25,
            maxProcessingTimeMs: 25000,
            includeUnscheduledRecipients: false
        });
    });

    it('upserts large dynamic audiences in batches', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock();
        const contactIds = Array.from({ length: 1001 }, (_, index) => `contact_${index + 1}`);
        mocks.getSupabaseAdmin.mockReturnValue(supabase);
        mocks.resolveCampaignAudienceContactIds.mockResolvedValue(contactIds);
        mocks.sendCampaignById.mockResolvedValue({
            success: true,
            sent: 1001,
            failed: 0,
            body: { success: true, sent: 1001, failed: 0 }
        });

        const response = await GET(createRequest());

        expect(response.status).toBe(200);
        expect(supabase.campaignRecipientsUpsert).toHaveBeenCalledTimes(3);
        expect(supabase.campaignRecipientsUpsert.mock.calls[0][0]).toHaveLength(500);
        expect(supabase.campaignRecipientsUpsert.mock.calls[1][0]).toHaveLength(500);
        expect(supabase.campaignRecipientsUpsert.mock.calls[2][0]).toHaveLength(1);
    });

    it('skips campaigns that another cron invocation already claimed', async () => {
        const { GET } = await loadRoute();
        const supabase = createSupabaseMock({ claimSucceeds: false });
        mocks.getSupabaseAdmin.mockReturnValue(supabase);

        const response = await GET(createRequest());
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.results[0]).toEqual(expect.objectContaining({
            campaignId: 'campaign_1',
            skipped: true
        }));
        expect(mocks.sendCampaignById).not.toHaveBeenCalled();
    });
});
