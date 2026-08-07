import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendMessage } from '@/lib/facebook';
import { generatePersonalizedMessage } from '@/lib/ai';
import { getNextPhilippinesScheduledAtIso } from '@/lib/philippines-time';
import { claimCampaignRecipients, finishLoopCampaignRecipient } from '@/lib/campaign-recipient-queue';

export const dynamic = 'force-dynamic';

// Keep external cron runs short by processing small batches.
const MAX_MESSAGES_PER_RUN = 5;
const MAX_CAMPAIGNS_PER_RUN = 3;

// GET /api/cron/campaign-loop - Called by cron-jobs.org every minute
export async function GET(_request: NextRequest) {
    const startTime = Date.now();

    const supabase = getSupabaseAdmin();
    const results = {
        campaignsProcessed: 0,
        messagesSent: 0,
        messagesFailed: 0,
        errors: [] as string[]
    };

    try {
        console.log('🔄 Campaign loop cron starting...');

        // Get active loop campaigns
        const { data: campaigns, error: campaignError } = await supabase
            .from('campaigns')
            .select(`
                id, 
                page_id, 
                ai_prompt,
                pages(fb_page_id, access_token)
            `)
            .eq('is_loop', true)
            .eq('loop_status', 'active')
            .limit(MAX_CAMPAIGNS_PER_RUN);

        if (campaignError) {
            console.error('❌ Error fetching campaigns:', campaignError);
            throw campaignError;
        }

        if (!campaigns?.length) {
            console.log('ℹ️ No active loop campaigns found');
            return NextResponse.json({
                success: true,
                message: 'No active loop campaigns',
                ...results,
                duration: Date.now() - startTime
            });
        }

        console.log(`📋 Found ${campaigns.length} active loop campaigns`);

        // Process each campaign
        for (const campaign of campaigns) {
            // Check time limit (leave 2s buffer)
            if (Date.now() - startTime > 8000) {
                console.warn('⏱️ Approaching time limit, stopping early');
                break;
            }

            results.campaignsProcessed++;
            // Supabase returns pages as array, get first item
            const pagesData = campaign.pages;
            const page = Array.isArray(pagesData) ? pagesData[0] : pagesData;

            if (!page?.access_token) {
                results.errors.push(`Campaign ${campaign.id}: No page access token`);
                continue;
            }

            const now = new Date().toISOString();
            let dueRecipients;
            try {
                dueRecipients = await claimCampaignRecipients({
                    supabase,
                    campaignId: campaign.id,
                    batchSize: MAX_MESSAGES_PER_RUN,
                    dueAt: now
                });
            } catch (recipientError) {
                results.errors.push(`Campaign ${campaign.id}: ${(recipientError as Error).message}`);
                continue;
            }

            if (!dueRecipients?.length) {
                console.log(`ℹ️ Campaign ${campaign.id}: No due recipients`);
                continue;
            }

            console.log(`📨 Campaign ${campaign.id}: Processing ${dueRecipients.length} recipients`);

            // Process each recipient
            for (const recipient of dueRecipients) {
                if (!recipient.contact_psid) {
                    await finishLoopCampaignRecipient({
                        supabase,
                        campaignId: campaign.id,
                        contactId: recipient.contact_id,
                        claimToken: recipient.claim_token,
                        success: false,
                        errorMessage: 'Contact missing PSID'
                    });
                    results.messagesFailed++;
                    continue;
                }

                try {
                    // Fetch conversation history for AI context
                    const { getConversationIdForPsid, getConversationMessages } = await import('@/lib/facebook');
                    let conversationHistory: Awaited<ReturnType<typeof getConversationMessages>> = [];

                    try {
                        const conversationId = await getConversationIdForPsid(
                            page.fb_page_id,
                            recipient.contact_psid,
                            page.access_token
                        );

                        if (conversationId) {
                            conversationHistory = await getConversationMessages(
                                conversationId,
                                page.access_token,
                                100 // Get all messages for full context
                            );
                            console.log(`📝 Fetched ${conversationHistory.length} messages for context`);
                        }
                    } catch (convError) {
                        console.warn('⚠️ Could not fetch conversation history:', convError);
                    }

                    // Generate AI message using conversation context
                    const contactName = recipient.contact_name || 'there';
                    const messageText = await generatePersonalizedMessage(
                        campaign.ai_prompt || 'Just checking in with you!',
                        contactName,
                        conversationHistory,
                        page.fb_page_id
                    );

                    // Send the message
                    await sendMessage(
                        page.fb_page_id,
                        page.access_token,
                        recipient.contact_psid,
                        messageText,
                        'HUMAN_AGENT'
                    );

                    // Calculate next scheduled time at the next PH best-time hour.
                    const bestHour = recipient.contact_best_hour ?? 12;
                    const nextScheduledAt = getNextPhilippinesScheduledAtIso(bestHour);

                    await finishLoopCampaignRecipient({
                        supabase,
                        campaignId: campaign.id,
                        contactId: recipient.contact_id,
                        claimToken: recipient.claim_token,
                        success: true,
                        nextScheduledAt
                    });

                    results.messagesSent++;
                    console.log(`Sent to ${recipient.contact_name || recipient.contact_psid}`);
                } catch (sendError) {
                    results.messagesFailed++;
                    console.error(`Failed to send to ${recipient.contact_psid}:`, sendError);
                    await finishLoopCampaignRecipient({
                        supabase,
                        campaignId: campaign.id,
                        contactId: recipient.contact_id,
                        claimToken: recipient.claim_token,
                        success: false,
                        errorMessage: (sendError as Error).message
                    });
                }
            }

            // Update campaign last_run_at
            await supabase
                .from('campaigns')
                .update({ last_run_at: new Date().toISOString() })
                .eq('id', campaign.id);
        }

        const duration = Date.now() - startTime;
        console.log(`✅ Campaign loop completed in ${duration}ms:`, results);

        return NextResponse.json({
            success: true,
            ...results,
            duration
        });
    } catch (error) {
        console.error('❌ Campaign loop error:', error);
        return NextResponse.json(
            {
                error: 'Campaign loop failed',
                message: (error as Error).message,
                ...results,
                duration: Date.now() - startTime
            },
            { status: 500 }
        );
    }
}
