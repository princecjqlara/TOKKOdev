import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    processDueFollowUpAutomationSteps: vi.fn(),
    processOneMessagingAutoTagPage: vi.fn()
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

import { GET } from './route';

describe('GET /api/cron/follow-up-automations', () => {
    afterEach(() => { vi.restoreAllMocks(); });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSupabaseAdmin.mockReturnValue({ database: true });
        mocks.processDueFollowUpAutomationSteps.mockResolvedValue({ processed: 0 });
        mocks.processOneMessagingAutoTagPage.mockResolvedValue({ pages: 1, conversations: 0, tagged: 0 });
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

        expect(fetchMock).toHaveBeenCalledWith(
            new URL('https://tokkobeta.vercel.app/api/cron/campaign-scheduled'),
            expect.objectContaining({ method: 'GET', cache: 'no-store' })
        );
        expect(body.campaignWorker).toEqual(expect.objectContaining({
            ok: true,
            processed: 1
        }));
        expect(mocks.processDueFollowUpAutomationSteps).toHaveBeenCalledTimes(1);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(3);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledWith({ maxProcessingTimeMs: 18000, conversationLimit: 10 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(body.messagingAutoTag).toEqual({ pages: 3, conversations: 0, tagged: 0, errors: [] });
    });

    it('starts polling in the existing scheduler while follow-ups are still running', async () => {
        let finishFollowUps!: (result: { processed: number }) => void;
        mocks.processDueFollowUpAutomationSteps.mockReturnValue(new Promise(resolve => { finishFollowUps = resolve; }));
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ success: true }));
        const responseTask = GET(new Request('https://tokkobeta.vercel.app/api/cron/follow-up-automations') as NextRequest);
        expect(mocks.processOneMessagingAutoTagPage).toHaveBeenCalledTimes(3);
        expect(fetchMock).not.toHaveBeenCalled();
        finishFollowUps({ processed: 1 });
        const response = await responseTask;
        expect(response.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('finishes tag polling even when the follow-up worker fails', async () => {
        mocks.processDueFollowUpAutomationSteps.mockRejectedValueOnce(new Error('Follow-up database unavailable'));
        const fetchMock = vi.spyOn(globalThis, 'fetch');
        mocks.processOneMessagingAutoTagPage.mockResolvedValue({ pages: 1, conversations: 2, tagged: 1 });
        const response = await GET(new Request('https://tokkobeta.vercel.app/api/cron/follow-up-automations') as NextRequest);
        expect(response.status).toBe(500);
        expect((await response.json()).messagingAutoTag).toEqual({ pages: 3, conversations: 6, tagged: 3, errors: [] });
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

    it('processes follow-ups before invoking the potentially slow campaign worker', async () => {
        const callOrder: string[] = [];
        mocks.processDueFollowUpAutomationSteps.mockImplementation(async () => {
            callOrder.push('follow-ups');
            return { processed: 1 };
        });
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            callOrder.push('campaigns');
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        await GET(new Request(
            'https://tokkobeta.vercel.app/api/cron/follow-up-automations'
        ) as NextRequest);

        expect(callOrder).toEqual(['follow-ups', 'campaigns']);
    });

    it('still processes follow-ups when campaign continuation temporarily fails', async () => {
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('temporary timeout'));

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
