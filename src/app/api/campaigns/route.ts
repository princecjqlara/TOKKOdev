import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { PaginatedResponse, Campaign } from '@/types';

// GET /api/campaigns - Get campaigns with pagination
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const searchParams = request.nextUrl.searchParams;
        const page = parseInt(searchParams.get('page') || '1');
        const pageSize = parseInt(searchParams.get('pageSize') || '25');
        const pageId = searchParams.get('pageId') || '';

        const supabase = getSupabaseAdmin();

        // Get user's accessible pages
        const { data: userPages } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id);

        const accessiblePageIds = userPages?.map(up => up.page_id) || [];

        if (accessiblePageIds.length === 0) {
            return NextResponse.json({
                items: [],
                page,
                pageSize,
                total: 0
            } as PaginatedResponse<Campaign>);
        }

        let query = supabase
            .from('campaigns')
            .select('*, pages(name)', { count: 'exact' })
            .in('page_id', accessiblePageIds)
            .order('created_at', { ascending: false });

        if (pageId && accessiblePageIds.includes(pageId)) {
            query = query.eq('page_id', pageId);
        }

        // Apply pagination
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        query = query.range(from, to);

        const { data: campaigns, error, count } = await query;

        if (error) throw error;

        return NextResponse.json({
            items: campaigns || [],
            page,
            pageSize,
            total: count || 0
        } as PaginatedResponse<Campaign>);
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        return NextResponse.json(
            { error: 'Failed to fetch campaigns', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// POST /api/campaigns - Create a campaign
export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { pageId, name, messageText, contactIds } = body;

        if (!pageId || !name || !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId, name, and messageText are required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Create campaign
        const { data: campaign, error: campaignError } = await supabase
            .from('campaigns')
            .insert({
                page_id: pageId,
                name,
                message_text: messageText,
                status: 'draft',
                total_recipients: contactIds?.length || 0,
                sent_count: 0,
                created_by: session.user.id
            })
            .select()
            .single();

        if (campaignError) throw campaignError;

        // Add recipients if provided
        if (contactIds?.length) {
            const recipients = contactIds.map((contactId: string) => ({
                campaign_id: campaign.id,
                contact_id: contactId,
                status: 'pending'
            }));

            await supabase
                .from('campaign_recipients')
                .insert(recipients);
        }

        return NextResponse.json({ campaign });
    } catch (error) {
        console.error('Error creating campaign:', error);
        return NextResponse.json(
            { error: 'Failed to create campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// PUT /api/campaigns - Update a campaign
export async function PUT(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { id, name, messageText, status } = body;

        if (!id) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Campaign ID is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get campaign and verify access
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('page_id')
            .eq('id', id)
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

        const updates: { name?: string; message_text?: string; status?: string; updated_at: string } = {
            updated_at: new Date().toISOString()
        };
        if (name) updates.name = name;
        if (messageText) updates.message_text = messageText;
        if (status) updates.status = status;

        const { data: updatedCampaign, error } = await supabase
            .from('campaigns')
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        return NextResponse.json({ campaign: updatedCampaign });
    } catch (error) {
        console.error('Error updating campaign:', error);
        return NextResponse.json(
            { error: 'Failed to update campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// DELETE /api/campaigns - Delete a campaign
export async function DELETE(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const searchParams = request.nextUrl.searchParams;
        const id = searchParams.get('id');

        if (!id) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Campaign ID is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get campaign and verify access
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('page_id')
            .eq('id', id)
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

        // Delete recipients first
        await supabase
            .from('campaign_recipients')
            .delete()
            .eq('campaign_id', id);

        // Delete campaign
        const { error } = await supabase
            .from('campaigns')
            .delete()
            .eq('id', id);

        if (error) throw error;

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Error deleting campaign:', error);
        return NextResponse.json(
            { error: 'Failed to delete campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}
