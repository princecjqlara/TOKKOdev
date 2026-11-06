import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processDueFollowUpAutomationSteps } from '@/lib/workflow-automations';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';
import { processContactImport } from '@/lib/contact-import';

export const dynamic = 'force-dynamic';

// GET /api/cron/follow-up-automations - Called by cron-jobs.org every minute.
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    // Start the primary job first, then run polling alongside it in this same
    // authenticated scheduler invocation. Slow or failing follow-ups must not
    // prevent the Page cursor from advancing. No extra cron or HTTP call.
    const followUpTask = (async () => processDueFollowUpAutomationSteps({
        supabase: getSupabaseAdmin(), limit: 10
    }))();
    const messagingAutoTagTask = (async () => {
        const results = await Promise.allSettled(Array.from({ length: 3 }, async () =>
            processOneMessagingAutoTagPage({ maxProcessingTimeMs: 18000, conversationLimit: 10 })));
        return {
            pages: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.pages : 0), 0),
            conversations: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.conversations : 0), 0),
            tagged: results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.tagged : 0), 0),
            errors: results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
        };
    })();

    const contactImportTask = processContactImport().catch(() => ({ success: false, retryable: true,
        message: 'Contact import is pending; its database checkpoint is retained.' }));

    try {
        // Follow-ups are this route's primary job. Run them before the nested
        // campaign worker, which can consume almost the entire external cron
        // request timeout when campaign delivery is slow.
        const result = await followUpTask;

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

        const [campaignWorker, messagingAutoTag, contactImport] = await Promise.all([campaignTask(), messagingAutoTagTask, contactImportTask]);

        return NextResponse.json({
            success: true,
            ...result,
            campaignWorker,
            messagingAutoTag,
            contactImport,
            duration: Date.now() - startTime
        });
    } catch (error) {
        console.error('Follow-up automation cron failed:', error);
        const [messagingAutoTag, contactImport] = await Promise.all([messagingAutoTagTask, contactImportTask]);
        return NextResponse.json(
            {
                error: 'Follow-up automation cron failed',
                message: (error as Error).message,
                messagingAutoTag,
                contactImport,
                duration: Date.now() - startTime
            },
            { status: 500 }
        );
    }
}
