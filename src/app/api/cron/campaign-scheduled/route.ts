import { NextRequest, NextResponse } from 'next/server';
import { processCampaignQueue } from '@/lib/campaign-worker';
import { waitUntil } from '@vercel/functions';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Read-only deployment verification; never dispatches a sender.
export function OPTIONS() {
    return new NextResponse(null, { status: 204,
        headers: { 'X-Tokko-Campaign-Worker-Version': '2026-11-11-shared-quotas' } });
}

// GET /api/cron/campaign-scheduled - Continue saved immediate and scheduled sends.
export async function GET(_request: NextRequest) {
    if (process.env.VERCEL === '1') {
        waitUntil(processCampaignQueue({ extendedRun: true }).catch(error => {
            console.error('Background campaign worker failed; saved queues will retry on the next scheduler tick:', error);
        }));
        return NextResponse.json({ success: true, background: true, message: 'Saved campaign queues are being processed.' });
    }
    try {
        return NextResponse.json(await processCampaignQueue());
    } catch (error) {
        return NextResponse.json(
            {
                error: 'Scheduled campaign cron failed',
                message: (error as Error).message
            },
            { status: 500 }
        );
    }
}
