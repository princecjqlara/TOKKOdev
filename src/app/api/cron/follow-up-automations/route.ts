import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processDueFollowUpAutomationSteps } from '@/lib/workflow-automations';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';

export const dynamic = 'force-dynamic';

// GET /api/cron/follow-up-automations - Called by cron-jobs.org every minute.
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    try {
        // Follow-ups are this route's primary job. Run them before the nested
        // campaign worker, which can consume almost the entire external cron
        // request timeout when campaign delivery is slow.
        const result = await processDueFollowUpAutomationSteps({
            supabase: getSupabaseAdmin(),
            limit: 10
        });

        // Reuse the already-configured minute job on cron-jobs.org to advance
        // durable immediate campaigns. Atomic recipient claims make this safe
        // even when a separate campaign-scheduled job also exists.
        const campaignTask = async (): Promise<Record<string, unknown>> => {
            try {
                const campaignUrl = new URL('/api/cron/campaign-scheduled', _request.url);
                const campaignResponse = await fetch(campaignUrl, {
                    method: 'GET',
                    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
                    cache: 'no-store',
                    signal: AbortSignal.timeout(25_000)
                });
                const campaignBody = await campaignResponse.json().catch(() => ({}));
                return {
                    ok: campaignResponse.ok,
                    status: campaignResponse.status,
                    ...campaignBody
                };
            } catch (campaignError) {
                console.warn('Campaign continuation from follow-up cron failed:', campaignError);
                return {
                    ok: false,
                    retryable: true,
                    message: campaignError instanceof Error ? campaignError.message : String(campaignError)
                };
            }
        };

        // The minute scheduler advances three independently claimed Pages per run.
        // Keep this isolated so an unavailable Meta token cannot delay follow-ups.
        const tagTask = async (): Promise<Record<string, unknown>> => {
            const results = await Promise.allSettled(Array.from({ length: 3 }, () => processOneMessagingAutoTagPage()));
            return {
                pages: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.pages : 0), 0),
                tagged: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.tagged : 0), 0),
                errors: results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
            };
        };
        // Both continuations start after follow-ups. An 18-second tag deadline
        // must not begin after the campaign's 25-second request timeout.
        const [campaignWorker, messagingAutoTag] = await Promise.all([campaignTask(), tagTask()]);

        return NextResponse.json({
            success: true,
            ...result,
            campaignWorker,
            messagingAutoTag,
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
