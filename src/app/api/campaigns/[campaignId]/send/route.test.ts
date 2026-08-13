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

    it('retries one database-busy response using the durable recipient queue', async () => {
        mocks.sendCampaignById
            .mockResolvedValueOnce({
                status: 503,
                body: { retryable: true, message: 'Database temporarily busy' }
            })
            .mockResolvedValueOnce({
                status: 200,
                body: { success: true, sent: 1, failed: 0 }
            });

        const request = new Request('http://localhost/api/campaigns/campaign_1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        }) as NextRequest;

        const response = await POST(request, {
            params: Promise.resolve({ campaignId: 'campaign_1' })
        });

        expect(response.status).toBe(200);
        expect(mocks.sendCampaignById).toHaveBeenCalledTimes(2);
    });

    it('passes video template headers through the send endpoint', async () => {
        const request = new Request('http://localhost/api/campaigns/campaign_1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                templateMediaHeader: {
                    type: 'video',
                    url: 'https://example.com/header.mp4'
                }
            })
        }) as NextRequest;

        await POST(request, {
            params: Promise.resolve({ campaignId: 'campaign_1' })
        });

        expect(mocks.sendCampaignById).toHaveBeenCalledWith(expect.objectContaining({
            templateMediaHeader: {
                type: 'video',
                url: 'https://example.com/header.mp4'
            }
        }));
    });
});
