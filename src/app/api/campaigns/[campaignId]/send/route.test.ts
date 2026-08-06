import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getServerSession: vi.fn(),
    sendCampaignById: vi.fn()
}));

vi.mock('next-auth', () => ({
    getServerSession: mocks.getServerSession
}));

vi.mock('@/lib/auth', () => ({
    authOptions: {}
}));

vi.mock('@/lib/campaign-send', () => ({
    sendCampaignById: mocks.sendCampaignById
}));

import { POST } from './route';

describe('POST /api/campaigns/[campaignId]/send', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getServerSession.mockResolvedValue({ user: { id: 'user_1' } });
        mocks.sendCampaignById.mockResolvedValue({
            status: 200,
            body: { success: true, partial: true, remaining: 10 }
        });
    });

    it('enforces a bounded resumable send slice regardless of client timing input', async () => {
        const request = new Request('http://localhost/api/campaigns/campaign_1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sendBatchSize: 20,
                delayBetweenBatchesMs: 50,
                maxProcessingTimeMs: 240_000
            })
        }) as NextRequest;

        const response = await POST(request, {
            params: Promise.resolve({ campaignId: 'campaign_1' })
        });

        expect(response.status).toBe(200);
        expect(mocks.sendCampaignById).toHaveBeenCalledWith(expect.objectContaining({
            campaignId: 'campaign_1',
            userId: 'user_1',
            sendBatchSize: 20,
            delayBetweenBatchesMs: 50,
            maxRecipientsPerRun: 500,
            maxProcessingTimeMs: 45_000,
            sendRetryAttempts: 1
        }));
    });
});
