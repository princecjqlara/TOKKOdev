import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendMessage } from '@/lib/facebook';

// Increase timeout for sending campaigns (up to 5 minutes)
export const maxDuration = 300;

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

        // Get ALL recipients with contact info - use pagination to handle large lists
        // Supabase default limit is 1000, so we need to paginate for larger campaigns
        let allRecipients: { id: string; contact_id: string; contacts: { psid: string } | { psid: string }[] | null }[] = [];
        const BATCH_SIZE = 1000;
        let offset = 0;
        let hasMore = true;

        console.log(`📤 Fetching all recipients for campaign ${campaignId}...`);

        while (hasMore) {
            const { data: recipientBatch, error: recipientError } = await supabase
                .from('campaign_recipients')
                .select('id, contact_id, contacts(psid)')
                .eq('campaign_id', campaignId)
                .eq('status', 'pending')
                .range(offset, offset + BATCH_SIZE - 1);

            if (recipientError) {
                console.error(`❌ Error fetching recipients batch at offset ${offset}:`, recipientError);
                break;
            }

            if (recipientBatch && recipientBatch.length > 0) {
                allRecipients = allRecipients.concat(recipientBatch);
                console.log(`📤 Fetched ${recipientBatch.length} recipients (total so far: ${allRecipients.length})`);
                offset += BATCH_SIZE;

                // If we got less than BATCH_SIZE, we've reached the end
                if (recipientBatch.length < BATCH_SIZE) {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        }

        console.log(`📤 Total recipients fetched: ${allRecipients.length}`);
        const recipients = allRecipients;

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

        // Process messages in parallel batches to avoid timeout and respect rate limits
        const SEND_BATCH_SIZE = 15; // Send 15 messages in parallel
        const DELAY_BETWEEN_BATCHES = 80; // 80ms delay between batches
        const MAX_PROCESSING_TIME = 270000; // 4.5 minutes (leave 30 seconds buffer before 5 min timeout)
        const startTime = Date.now();

        console.log(`📤 Starting campaign send: ${recipients.length} recipients in batches of ${SEND_BATCH_SIZE}`);

        for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingCount = recipients.length - i;
                console.warn(`⏱️ Campaign timeout: processed ${i}/${recipients.length}, ${remainingCount} remaining`);

                // Update campaign to partial status
                await supabase
                    .from('campaigns')
                    .update({
                        status: 'sending', // Keep as sending since there's more to do
                        sent_count: sent,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaignId);

                return NextResponse.json({
                    success: true,
                    partial: true,
                    sent,
                    failed,
                    processed: i,
                    total: recipients.length,
                    remaining: remainingCount,
                    message: `Processed ${i} of ${recipients.length} recipients before timeout. ${remainingCount} remaining.`
                });
            }

            // Check if campaign was cancelled (every batch instead of every message)
            const { data: currentCampaign } = await supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single();

            if (currentCampaign?.status === 'cancelled') {
                return NextResponse.json({
                    success: true,
                    sent,
                    failed,
                    cancelled: true,
                    message: 'Campaign was cancelled'
                });
            }

            const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

            // Process batch in parallel
            const batchPromises = batch.map(async (recipient) => {
                const contactData = recipient.contacts;
                const contact = Array.isArray(contactData) ? contactData[0] : contactData;

                if (!contact?.psid) {
                    await supabase
                        .from('campaign_recipients')
                        .update({
                            status: 'failed',
                            error_message: 'Contact missing PSID'
                        })
                        .eq('id', recipient.id);
                    return { success: false, recipientId: recipient.id, error: 'Contact missing PSID' };
                }

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

                    return { success: true, recipientId: recipient.id };
                } catch (error) {
                    const errorMessage = (error as Error).message;
                    console.warn(`Failed to send to ${contact.psid}: ${errorMessage}`);

                    await supabase
                        .from('campaign_recipients')
                        .update({
                            status: 'failed',
                            error_message: errorMessage
                        })
                        .eq('id', recipient.id);

                    return { success: false, recipientId: recipient.id, error: errorMessage };
                }
            });

            // Wait for all promises to settle
            const batchResults = await Promise.allSettled(batchPromises);

            // Count results
            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        sent++;
                    } else {
                        failed++;
                    }
                } else {
                    failed++;
                }
            }

            // Update sent_count after each batch
            await supabase
                .from('campaigns')
                .update({
                    sent_count: sent,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

            // Delay between batches (except for last batch)
            if (i + SEND_BATCH_SIZE < recipients.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }

            // Log progress every 50 contacts
            if ((i + SEND_BATCH_SIZE) % 50 === 0 || i + SEND_BATCH_SIZE >= recipients.length) {
                const progress = Math.min(i + SEND_BATCH_SIZE, recipients.length);
                const percentage = Math.round((progress / recipients.length) * 100);
                console.log(`📊 Campaign progress: ${progress}/${recipients.length} (${percentage}%) | Sent: ${sent}, Failed: ${failed}`);
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

        console.log(`✅ Campaign complete: ${sent} sent, ${failed} failed out of ${recipients.length} recipients`);

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
