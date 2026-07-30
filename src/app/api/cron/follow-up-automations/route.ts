import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { processDueFollowUpAutomationSteps } from '@/lib/workflow-automations';

export const dynamic = 'force-dynamic';

// GET /api/cron/follow-up-automations - Called by cron-jobs.org every minute.
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    try {
        const result = await processDueFollowUpAutomationSteps({
            supabase: getSupabaseAdmin(),
            limit: 10
        });

        return NextResponse.json({
            success: true,
            ...result,
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
