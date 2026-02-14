import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse } from '@/types';
import { CampaignRecipientError, normalizeCampaignRecipientErrors } from '@/lib/campaign-errors';

// GET /api/campaigns/[campaignId]/recipients - Get campaign recipients with pagination
export async function GET(
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
        const searchParams = request.nextUrl.searchParams;
        const page = parseInt(searchParams.get('page') || '1');
        const pageSize = parseInt(searchParams.get('pageSize') || '25');
        const status = searchParams.get('status') || 'failed';

        const supabase = getSupabaseAdmin();

        const { data: campaign } = await supabase
            .from('campaigns')
            .select('page_id')
            .eq('id', campaignId)
            .single();

        if (!campaign) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Campaign not found' },
                { status: 404 }
            );
        }

        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', campaign.page_id)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this campaign' },
                { status: 403 }
            );
        }

        let query = supabase
            .from('campaign_recipients')
            .select('id, contact_id, status, error_message, contacts(name, psid)', { count: 'exact' })
            .eq('campaign_id', campaignId)
            .order('created_at', { ascending: false });

        if (status) {
            query = query.eq('status', status);
        }

        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: recipients, error, count } = await query;

        if (error) throw error;

        const items = normalizeCampaignRecipientErrors(recipients || []);

        return NextResponse.json({
            items,
            page,
            pageSize,
            total: count || 0
        } as PaginatedResponse<CampaignRecipientError>);
    } catch (error) {
        console.error('Error fetching campaign recipients:', error);
        return NextResponse.json(
            { error: 'Failed to fetch campaign recipients', message: (error as Error).message },
            { status: 500 }
        );
    }
}
