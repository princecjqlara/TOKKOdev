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

// POST /api/campaigns/[campaignId]/cancel - Cancel a sending campaign
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

        // Atomically stop the campaign and discard unsent queue rows. In-flight
        // claimed rows are allowed to finish; no cancelled target is recorded
        // as a delivery failure.
        const { data: discardedRecipients, error: cancelError } = await supabase.rpc(
            'cancel_campaign_delivery',
            { p_campaign_id: campaignId }
        );

        if (cancelError) throw cancelError;

        return NextResponse.json({
            success: true,
            message: 'Campaign cancelled successfully',
            discardedRecipients: Number(discardedRecipients || 0)
        });
    } catch (error) {
        console.error('Error cancelling campaign:', error);
        return NextResponse.json(
            { error: 'Failed to cancel campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}
