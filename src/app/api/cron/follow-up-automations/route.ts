import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processDueFollowUpAutomationSteps } from '@/lib/workflow-automations';

export const dynamic = 'force-dynamic';

// GET /api/cron/follow-up-automations - Called by cron-jobs.org every minute.
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    try {
        // Reuse the already-configured minute job on cron-jobs.org to advance
        // durable immediate campaigns. Atomic recipient claims make this safe
        // even when a separate campaign-scheduled job also exists.
        let campaignWorker: Record<string, unknown> = { skipped: true };
        try {
            const campaignUrl = new URL('/api/cron/campaign-scheduled', _request.url);
            const campaignResponse = await fetch(campaignUrl, {
                method: 'GET',
                cache: 'no-store',
                signal: AbortSignal.timeout(25_000)
            });
            const campaignBody = await campaignResponse.json().catch(() => ({}));
            campaignWorker = {
                ok: campaignResponse.ok,
                status: campaignResponse.status,
                ...campaignBody
            };
        } catch (campaignError) {
            campaignWorker = {
                ok: false,
                retryable: true,
                message: campaignError instanceof Error ? campaignError.message : String(campaignError)
            };
            console.warn('Campaign continuation from follow-up cron failed:', campaignError);
        }

        const result = await processDueFollowUpAutomationSteps({
            supabase: getSupabaseAdmin(),
            limit: 10
        });

        return NextResponse.json({
            success: true,
            ...result,
            campaignWorker,
            duration: Date.now() - startTime
        });
    } catch (error) {
        console.error('Follow-up automation cron failed:', error);
        return NextResponse.json(
            {
                error: 'Follow-up automation cron failed',
                message: (error as Error).message,
                duration: Date.now() - startTime
            },
            { status: 500 }
        );
    }
}
