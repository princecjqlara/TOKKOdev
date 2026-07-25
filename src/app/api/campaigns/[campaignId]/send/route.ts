import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { sendCampaignById } from '@/lib/campaign-send';

// Increase timeout for sending campaigns (up to 5 minutes)
export const maxDuration = 300;

// POST /api/campaigns/[campaignId]/send - Send a campaign
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ campaignId: string }> }
) {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
        return NextResponse.json(
            { error: 'Unauthorized', message: 'Please sign in' },
            { status: 401 }
        );
    }

    const { campaignId } = await params;
    const body = await request.json().catch(() => ({}));
    const result = await sendCampaignById({
        campaignId,
        userId: session.user.id,
        sendBatchSize: typeof body.sendBatchSize === 'number' ? body.sendBatchSize : undefined,
        delayBetweenBatchesMs: typeof body.delayBetweenBatchesMs === 'number' ? body.delayBetweenBatchesMs : undefined,
        maxProcessingTimeMs: typeof body.maxProcessingTimeMs === 'number' ? body.maxProcessingTimeMs : undefined
    });

    return NextResponse.json(result.body, { status: result.status });
}
