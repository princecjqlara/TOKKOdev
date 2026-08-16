import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

type CampaignWithPage = {
    id: string;
    page_id: string;
    status: string;
    pages?: { id: string } | { id: string }[];
};

// POST /api/campaigns/[campaignId]/cancel - Stop a campaign without losing its unsent queue
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ campaignId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { campaignId } = await params;
        const supabase = getSupabaseAdmin();

        // Get campaign
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('*, pages(id)')
            .eq('id', campaignId)
            .single();

        const typedCampaign = campaign as CampaignWithPage | null;

        if (!typedCampaign) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Campaign not found' },
                { status: 404 }
            );
        }

        // Verify user access
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', typedCampaign.page_id)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this campaign' },
                { status: 403 }
            );
        }

        // Only allow cancelling if campaign is currently sending
        if (typedCampaign.status !== 'sending') {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Campaign is not currently sending' },
                { status: 400 }
            );
        }

        // Atomically pause the campaign while preserving pending and in-flight
        // rows. In-flight workers observe the draft status before claiming a
        // new batch, so Continue Unsent can safely resume the same queue.
        const { data: remainingRecipients, error: pauseError } = await supabase.rpc(
            'pause_campaign_delivery',
            { p_campaign_id: campaignId }
        );

        if (pauseError) throw pauseError;

        return NextResponse.json({
            success: true,
            message: 'Campaign stopped. Unsent recipients were preserved.',
            remainingRecipients: Number(remainingRecipients || 0),
            resumable: true
        });
    } catch (error) {
        console.error('Error stopping campaign:', error);
        return NextResponse.json(
            { error: 'Failed to stop campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}
