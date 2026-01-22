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
        const { pageId, name, messageText, contactIds, useBestTime, scheduledDate, isLoop, aiPrompt } = body;

        // For loop campaigns, messageText is optional (AI generates it), but aiPrompt is required
        if (!pageId || !name) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId and name are required' },
                { status: 400 }
            );
        }

        // Validate loop campaign requirements
        if (isLoop && !aiPrompt) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'aiPrompt is required for loop campaigns' },
                { status: 400 }
            );
        }

        // For non-loop campaigns, messageText is required
        if (!isLoop && !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'messageText is required for regular campaigns' },
                { status: 400 }
            );
        }

        // Validate scheduling params
        if (useBestTime && !scheduledDate && !isLoop) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'scheduledDate is required when useBestTime is enabled' },
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

        // Determine campaign status
        // Loop campaigns start as 'scheduled' with loop_status 'active'
        // Best time campaigns are 'scheduled', regular campaigns are 'draft'
        const campaignStatus = isLoop || useBestTime ? 'scheduled' : 'draft';

        // Create campaign
        const { data: campaign, error: campaignError } = await supabase
            .from('campaigns')
            .insert({
                page_id: pageId,
                name,
                message_text: isLoop ? null : messageText, // Loop campaigns use AI-generated messages
                status: campaignStatus,
                total_recipients: contactIds?.length || 0,
                sent_count: 0,
                created_by: session.user.id,
                use_best_time: useBestTime || isLoop || false, // Loop always uses best time
                scheduled_date: scheduledDate || null,
                // Loop campaign fields
                is_loop: isLoop || false,
                ai_prompt: isLoop ? aiPrompt : null,
                loop_status: isLoop ? 'active' : 'stopped'
            })
            .select()
            .single();

        if (campaignError) throw campaignError;

        // Add recipients if provided - batch inserts to avoid Supabase payload limits
        if (contactIds?.length) {
            const BATCH_SIZE = 500; // Supabase recommends batching large inserts
            console.log(`📤 Adding ${contactIds.length} recipients to campaign ${campaign.id}`);

            // If using best time, we need to fetch contacts' best_contact_hour
            let contactBestTimes: Map<string, number | null> = new Map();
            if (useBestTime) {
                // Fetch best_contact_hour for all contacts
                for (let i = 0; i < contactIds.length; i += 1000) {
                    const batchIds = contactIds.slice(i, i + 1000);
                    const { data: contacts } = await supabase
                        .from('contacts')
                        .select('id, best_contact_hour')
                        .in('id', batchIds);

                    if (contacts) {
                        for (const contact of contacts) {
                            contactBestTimes.set(contact.id, contact.best_contact_hour);
                        }
                    }
                }
                console.log(`📤 Fetched best times for ${contactBestTimes.size} contacts`);
            }

            for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
                const batchIds = contactIds.slice(i, i + BATCH_SIZE);
                const recipients = batchIds.map((contactId: string) => {
                    let scheduledAt: string | null = null;

                    // For loop campaigns or useBestTime, calculate scheduled_at
                    if (isLoop || (useBestTime && scheduledDate)) {
                        const bestHour = contactBestTimes.get(contactId);
                        const hour = bestHour !== null && bestHour !== undefined ? bestHour : 12; // Default to noon

                        if (isLoop) {
                            // For loops, schedule for today if hour hasn't passed, otherwise tomorrow
                            const now = new Date();
                            const sendDate = new Date();
                            if (now.getUTCHours() >= hour) {
                                // Hour already passed today, schedule for tomorrow
                                sendDate.setDate(sendDate.getDate() + 1);
                            }
                            sendDate.setUTCHours(hour, 0, 0, 0);
                            scheduledAt = sendDate.toISOString();
                        } else {
                            // Regular best time scheduling uses provided date
                            const sendDate = new Date(scheduledDate);
                            sendDate.setUTCHours(hour, 0, 0, 0);
                            scheduledAt = sendDate.toISOString();
                        }
                    }

                    return {
                        campaign_id: campaign.id,
                        contact_id: contactId,
                        status: 'pending',
                        scheduled_at: scheduledAt
                    };
                });

                const { error: insertError } = await supabase
                    .from('campaign_recipients')
                    .insert(recipients);

                if (insertError) {
                    console.error(`❌ Error inserting recipients batch ${Math.floor(i / BATCH_SIZE) + 1}:`, insertError);
                } else {
                    console.log(`✅ Inserted batch ${Math.floor(i / BATCH_SIZE) + 1} (${batchIds.length} recipients)`);
                }
            }

            console.log(`📤 Finished adding recipients to campaign`);
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
