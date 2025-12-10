import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendMessage } from '@/lib/facebook';

// POST /api/campaigns/[campaignId]/send - Send a campaign
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

        // Get campaign with page info
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('*, pages(fb_page_id, access_token)')
            .eq('id', campaignId)
            .single();

        if (!campaign) {
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
            .eq('page_id', campaign.page_id)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this campaign' },
                { status: 403 }
            );
        }

        if (campaign.status !== 'draft') {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Campaign has already been sent or is in progress' },
                { status: 400 }
            );
        }

        // Update campaign status to sending
        await supabase
            .from('campaigns')
            .update({ status: 'sending', updated_at: new Date().toISOString() })
            .eq('id', campaignId);

        // Get recipients with contact info
        const { data: recipients } = await supabase
            .from('campaign_recipients')
            .select('id, contact_id, contacts(psid)')
            .eq('campaign_id', campaignId)
            .eq('status', 'pending');

        if (!recipients?.length) {
            await supabase
                .from('campaigns')
                .update({ status: 'completed', updated_at: new Date().toISOString() })
                .eq('id', campaignId);

            return NextResponse.json({
                success: true,
                sent: 0,
                failed: 0,
                message: 'No recipients to send to'
            });
        }

        const page = campaign.pages as { fb_page_id: string; access_token: string };
        let sent = 0;
        let failed = 0;

        for (const recipient of recipients) {
            // Check if campaign was cancelled before each send
            const { data: currentCampaign } = await supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single();

            if (currentCampaign?.status === 'cancelled') {
                // Campaign was cancelled, stop sending
                return NextResponse.json({
                    success: true,
                    sent,
                    failed,
                    cancelled: true,
                    message: 'Campaign was cancelled'
                });
            }

            // Handle Supabase join which may return array or object
            const contactData = recipient.contacts;
            const contact = Array.isArray(contactData) ? contactData[0] : contactData;
            if (!contact?.psid) continue;

            try {
                await sendMessage(
                    page.fb_page_id,
                    page.access_token,
                    contact.psid,
                    campaign.message_text
                );

                await supabase
                    .from('campaign_recipients')
                    .update({
                        status: 'sent',
                        sent_at: new Date().toISOString()
                    })
                    .eq('id', recipient.id);

                sent++;
            } catch (error) {
                await supabase
                    .from('campaign_recipients')
                    .update({
                        status: 'failed',
                        error_message: (error as Error).message
                    })
                    .eq('id', recipient.id);

                failed++;
            }

            // Update sent_count periodically (every 10 messages to reduce DB calls)
            if ((sent + failed) % 10 === 0) {
                await supabase
                    .from('campaigns')
                    .update({
                        sent_count: sent,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaignId);
            }
        }

        // Mark campaign as completed (only if not cancelled)
        const { data: finalStatus } = await supabase
            .from('campaigns')
            .select('status')
            .eq('id', campaignId)
            .single();

        if (finalStatus?.status !== 'cancelled') {
            await supabase
                .from('campaigns')
                .update({
                    status: 'completed',
                    sent_count: sent,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);
        }

        return NextResponse.json({
            success: true,
            sent,
            failed
        });
    } catch (error) {
        console.error('Error sending campaign:', error);
        return NextResponse.json(
            { error: 'Failed to send campaign', message: (error as Error).message },
            { status: 500 }
        );
    }
}
