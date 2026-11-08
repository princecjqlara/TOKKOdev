import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { accountErrorResponse } from '@/lib/account-security';
import { sendCampaignById } from '@/lib/campaign-send';
import type { TemplateMediaType } from '@/lib/facebook-templates';

// Increase timeout for sending campaigns (up to 5 minutes)
export const maxDuration = 300;

// Keep every browser-driven invocation comfortably below the deployment
// timeout. The client continues while `partial` is true, and recipient status
// makes every subsequent invocation resume from pending recipients only.
const MAX_RECIPIENTS_PER_INVOCATION = 500;
const MAX_PROCESSING_TIME_MS = 45_000;
const DATABASE_BUSY_RETRY_DELAY_MS = 750;

function normalizeTemplateMediaHeader(value: unknown): { type: TemplateMediaType; url: string } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    return (record.type === 'image' || record.type === 'video') &&
        typeof record.url === 'string' &&
        record.url.trim()
        ? { type: record.type, url: record.url.trim() }
        : undefined;
}

// POST /api/campaigns/[campaignId]/send - Send a campaign
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ campaignId: string }> }
) {
    let session;
    try { session = await getSessionFromRequest(request); }
    catch (error) { return accountErrorResponse(error); }

    if (!session?.user?.id) {
        return NextResponse.json(
            { error: 'Unauthorized', message: 'Please sign in' },
            { status: 401 }
        );
    }

    const { campaignId } = await params;
    const body = await request.json().catch(() => ({}));
    const templateMediaHeader = normalizeTemplateMediaHeader(body.templateMediaHeader);
    const templateMediaHeaders = Array.isArray(body.templateMediaHeaders)
        ? body.templateMediaHeaders.map(normalizeTemplateMediaHeader)
        : undefined;
    const delayBetweenBatchesMs = typeof body.delayBetweenBatchesMs === 'number'
        ? Math.max(0, Math.min(body.delayBetweenBatchesMs, 250))
        : undefined;
    const sendOptions = {
        campaignId,
        userId: session.user.id,
        backgroundOnly: body.backgroundOnly === true,
        expectedUpdatedAt: typeof body.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : undefined,
        sendBatchSize: typeof body.sendBatchSize === 'number' ? body.sendBatchSize : undefined,
        maxRecipientsPerRun: MAX_RECIPIENTS_PER_INVOCATION,
        delayBetweenBatchesMs,
        maxProcessingTimeMs: MAX_PROCESSING_TIME_MS,
        sendRetryAttempts: 2,
        templateMediaHeader,
        templateMediaHeaders
    };

    let result = await sendCampaignById(sendOptions);
    if (result.status === 503 && result.body.retryable === true && result.body.paused !== true) {
        await new Promise(resolve => setTimeout(resolve, DATABASE_BUSY_RETRY_DELAY_MS));
        result = await sendCampaignById(sendOptions);
    }

    return NextResponse.json(result.body, { status: result.status });
}
