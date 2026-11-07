import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    processDueFollowUpAutomationSteps: vi.fn(),
    processOneMessagingAutoTagPage: vi.fn(),
    processContactImport: vi.fn(),
    processCampaignQueue: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/workflow-automations', () => ({
    processDueFollowUpAutomationSteps: mocks.processDueFollowUpAutomationSteps
}));

vi.mock('@/lib/messaging-auto-tag-worker', () => ({
    processOneMessagingAutoTagPage: mocks.processOneMessagingAutoTagPage
}));
vi.mock('@/lib/campaign-worker', () => ({ processCampaignQueue: mocks.processCampaignQueue }));

import { GET } from './route';
vi.mock('@/lib/contact-import', () => ({ processContactImport: mocks.processContactImport }));

describe('GET /api/cron/follow-up-automations', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSupabaseAdmin.mockReturnValue({ database: true });
        mocks.processDueFollowUpAutomationSteps.mockResolvedValue({ processed: 0 });
        mocks.processOneMessagingAutoTagPage.mockResolvedValue({ pages: 1, conversations: 0, tagged: 0 });
        mocks.processContactImport.mockResolvedValue({ success: true, synced: 100, partial: true });
        mocks.processCampaignQueue.mockResolvedValue({ success: true, processed: 1, results: [] });
    });

    it('uses the existing minute cron invocation to continue campaigns', async () => {
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
            success: true,
            processed: 1
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

        const response = await GET(new Request(
            'https://tokkobeta.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);
        const body = await response.json();

        expect(mocks.processCampaignQueue).toHaveBeenCalledOnce();
        expect(body.campaignWorker).toEqual(expect.objectContaining({
            ok: true,
            processed: 1
        }));
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
        expect(mocks.processContactImport).toHaveBeenCalledOnce();
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(3);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledWith({ maxProcessingTimeMs: 18000, conversationLimit: 10 });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(body.messagingAutoTag).toEqual({ pages: 3, conversations: 0, tagged: 0, errors: [] });
    });

    it('starts campaign continuation and polling while follow-ups are still running', async () => {
        let finishFollowUps!: (result: { processed: number }) => void;
        mocks.processDueFollowUpAutomationSteps.mockReturnValue(new Promise(resolve => { finishFollowUps = resolve; }));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
        const responseTask = GET(new Request('https://tokkobeta.vercel.app/api/cron/follow-up-automations') as NextRequest);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(3);
        expect(fetchMock).not.toHaveBeenCalled();
        const startedBeforeFollowUpsFinished = mocks.processCampaignQueue.mock.calls.length;
        finishFollowUps({ processed: 1 });
        const response = await responseTask;
        expect(startedBeforeFollowUpsFinished).toBe(1);
        expect(response.status).toBe(200);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('continues saved campaign recipients even when the follow-up worker fails', async () => {
        mocks.processDueFollowUpAutomationSteps.mockRejectedValueOnce(new Error('Follow-up database unavailable'));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
        mocks.processOneMessagingAutoTagPage.mockResolvedValue({ pages: 1, conversations: 2, tagged: 1 });
        const response = await GET(new Request('https://tokkobeta.vercel.app/api/cron/follow-up-automations') as NextRequest);
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body.messagingAutoTag).toEqual({ pages: 3, conversations: 6, tagged: 3, errors: [] });
        expect(body.campaignWorker).toMatchObject({ ok: true, processed: 1 });
        expect(mocks.processCampaignQueue).toHaveBeenCalledOnce();
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(3);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('isolates a failed Page scan without failing follow-ups or the other Page scans', async () => {
        mocks.processOneMessagingAutoTagPage.mockRejectedValueOnce(new Error('Facebook permissions expired'));
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
        const response = await GET(new Request('https://tokkobeta.vercel.app/api/cron/follow-up-automations') as NextRequest);
        const body = await response.json();
        expect(response.status).toBe(200);
        expect(body.messagingAutoTag).toEqual({ pages: 2, conversations: 0, tagged: 0, errors: ['Facebook permissions expired'] });
        expect(body.campaignWorker.ok).toBe(true);
    });

    it('starts follow-ups first and runs campaign continuation directly in the same invocation', async () => {
        const callOrder: string[] = [];
        mocks.processDueFollowUpAutomationSteps.mockImplementation(async () => {
            callOrder.push('follow-ups');
            return { processed: 1 };
        });
        mocks.processCampaignQueue.mockImplementation(async () => {
            callOrder.push('campaigns');
            return { success: true, processed: 1, results: [] };
        });

        await GET(new Request(
            'https://tokkobeta.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);

        expect(callOrder).toEqual(['follow-ups', 'campaigns']);
    });

    it('still processes follow-ups when campaign continuation temporarily fails', async () => {
        mocks.processCampaignQueue.mockRejectedValue(new Error('temporary timeout'));

        const response = await GET(new Request(
            'https://tokkobeta.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.campaignWorker).toEqual(expect.objectContaining({
            ok: false,
            retryable: true
        }));
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
    });
});
