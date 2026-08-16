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

        // Pause without deleting recipient rows. This intentionally uses only
        // existing campaign columns so the deployed route remains safe while
        // the compatibility migration is rolling out.
        const stoppedAt = new Date().toISOString();
        const { data: pausedCampaign, error: pauseError } = await supabase
            .from('campaigns')
            .update({
                status: 'draft',
                background_delivery_enabled: false,
                next_attempt_at: null,
                completed_at: null,
                last_error: 'Stopped manually. Unsent recipients remain queued.',
                updated_at: stoppedAt
            })
            .eq('id', campaignId)
            .eq('status', 'sending')
            .select('id')
            .maybeSingle();

        if (pauseError) throw pauseError;
        if (!pausedCampaign) {
            return NextResponse.json(
                { error: 'Conflict', message: 'Campaign stopped or changed before this request completed' },
                { status: 409 }
            );
        }

        const { count: remainingRecipients, error: countError } = await supabase
            .from('campaign_recipients')
            .select('contact_id', { count: 'exact', head: true })
            .eq('campaign_id', campaignId)
            .in('status', ['pending', 'processing']);

        if (countError) throw countError;

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
