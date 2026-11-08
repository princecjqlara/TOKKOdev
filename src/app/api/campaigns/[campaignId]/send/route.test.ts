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

    it('returns a service failure without claiming the signed-in user logged out', async () => {
        mocks.getServerSession.mockResolvedValueOnce({ user: {}, authenticationError: 'service_unavailable' });
        const response = await POST(new Request('http://localhost/api/campaigns/campaign_1/send', { method: 'POST' }) as NextRequest,
            { params: Promise.resolve({ campaignId: 'campaign_1' }) });
        expect(response.status).toBe(503);
        expect(mocks.sendCampaignById).not.toHaveBeenCalled();
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
            maxProcessingTimeMs: 45_000,
            sendRetryAttempts: 2
        }));
        expect(mocks.sendCampaignById.mock.calls[0][0]).not.toHaveProperty('maxRecipientsPerRun');
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

    it('preserves a delivery backoff instead of immediately retrying the paused campaign', async () => {
        mocks.sendCampaignById.mockResolvedValue({
            status: 503, body: { retryable: true, paused: true }
        });
        const response = await POST(new Request('http://localhost/api/campaigns/campaign_1/send', {
            method: 'POST', body: '{}'
        }) as NextRequest, { params: Promise.resolve({ campaignId: 'campaign_1' }) });

        expect(response.status).toBe(503);
        expect(mocks.sendCampaignById).toHaveBeenCalledTimes(1);
    });

    it('keeps automatic continuation from restarting a manually stopped draft', async () => {
        await POST(new Request('http://localhost/api/campaigns/campaign_1/send', {
            method: 'POST', body: JSON.stringify({ backgroundOnly: true, expectedUpdatedAt: '2026-11-08T00:00:00Z' })
        }) as NextRequest, { params: Promise.resolve({ campaignId: 'campaign_1' }) });
        expect(mocks.sendCampaignById).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'user_1', backgroundOnly: true, expectedUpdatedAt: '2026-11-08T00:00:00Z'
        }));
    });
});
