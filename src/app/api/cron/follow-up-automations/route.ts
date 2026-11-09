import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processDueFollowUpAutomationSteps } from '@/lib/workflow-automations';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';
import { processContactImport } from '@/lib/contact-import';
import { processCampaignQueue } from '@/lib/campaign-worker';

export const dynamic = 'force-dynamic';

// GET /api/cron/follow-up-automations - Called by cron-jobs.org every minute.
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    // Start the primary job first, then run polling alongside it in this same
    // scheduler invocation. Slow or failing follow-ups must not
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

    // Start continuation independently of follow-ups. Use the shared worker in
    // this invocation so a second HTTP request and its timeout
    // cannot interrupt the handoff after the browser stops sending.
    const campaignTask = (async (): Promise<Record<string, unknown>> => {
        try {
            const result = await processCampaignQueue();
            return { ok: true, ...result };
        } catch (campaignError) {
            console.warn('Campaign continuation from follow-up cron failed:', campaignError);
            return {
                ok: false,
                retryable: true,
                message: campaignError instanceof Error ? campaignError.message : String(campaignError)
            };
        }
    })();

    try {
        const result = await followUpTask;
        const [campaignWorker, messagingAutoTag, contactImport] = await Promise.all([campaignTask, messagingAutoTagTask, contactImportTask]);

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
        const [campaignWorker, messagingAutoTag, contactImport] = await Promise.all([campaignTask, messagingAutoTagTask, contactImportTask]);
        return NextResponse.json(
            {
                error: 'Follow-up automation cron failed',
                message: (error as Error).message,
                campaignWorker,
                messagingAutoTag,
                contactImport,
                duration: Date.now() - startTime
            },
            { status: 500 }
        );
    }
}
