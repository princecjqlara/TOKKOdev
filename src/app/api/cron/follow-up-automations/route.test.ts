import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
    getSupabaseAdmin: vi.fn(),
    processDueFollowUpAutomationSteps: vi.fn()
}));

vi.mock('@/lib/supabase', () => ({
    getSupabaseAdmin: mocks.getSupabaseAdmin
}));

vi.mock('@/lib/workflow-automations', () => ({
    processDueFollowUpAutomationSteps: mocks.processDueFollowUpAutomationSteps
}));

import { GET } from './route';

describe('GET /api/cron/follow-up-automations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSupabaseAdmin.mockReturnValue({ database: true });
        mocks.processDueFollowUpAutomationSteps.mockResolvedValue({ processed: 0 });
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
