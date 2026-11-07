import { NextRequest, NextResponse } from 'next/server';
import { processCampaignQueue } from '@/lib/campaign-worker';

export const dynamic = 'force-dynamic';

// GET /api/cron/campaign-scheduled - Continue saved immediate and scheduled sends.
export async function GET(_request: NextRequest) {
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
