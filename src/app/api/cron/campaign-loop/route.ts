import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendMessage } from '@/lib/facebook';
import { generatePersonalizedMessage } from '@/lib/ai';

// Vercel Hobby has 10s limit - process small batches
const MAX_MESSAGES_PER_RUN = 5;
const MAX_CAMPAIGNS_PER_RUN = 3;

// GET /api/cron/campaign-loop - Called by cron-job.org every minute
export async function GET(request: NextRequest) {
    const startTime = Date.now();

    // Validate cron secret to prevent unauthorized calls
    const cronSecret = request.headers.get('x-cron-secret') || request.nextUrl.searchParams.get('secret');
    const expectedSecret = process.env.CRON_SECRET;

    if (!expectedSecret) {
        console.warn('⚠️ CRON_SECRET not configured - endpoint is unprotected!');
    } else if (cronSecret !== expectedSecret) {
        console.warn('❌ Invalid cron secret provided');
        return NextResponse.json(
            { error: 'Unauthorized', message: 'Invalid cron secret' },
            { status: 401 }
        );
    }

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

            // Get recipients due for contact (scheduled_at or next_scheduled_at <= NOW)
            const now = new Date().toISOString();
            const { data: dueRecipients, error: recipientError } = await supabase
                .from('campaign_recipients')
                .select(`
                    id,
                    contact_id,
                    message_sent_count,
                    contacts(id, psid, name, best_contact_hour)
                `)
                .eq('campaign_id', campaign.id)
                .or(`scheduled_at.lte.${now},next_scheduled_at.lte.${now}`)
                .is('status', 'pending')
                .limit(MAX_MESSAGES_PER_RUN);

            if (recipientError) {
                results.errors.push(`Campaign ${campaign.id}: ${recipientError.message}`);
                continue;
            }

            if (!dueRecipients?.length) {
                console.log(`ℹ️ Campaign ${campaign.id}: No due recipients`);
                continue;
            }

            console.log(`📨 Campaign ${campaign.id}: Processing ${dueRecipients.length} recipients`);

            // Process each recipient
            for (const recipient of dueRecipients) {
                const contactData = recipient.contacts;
                const contact = Array.isArray(contactData) ? contactData[0] : contactData;

                if (!contact?.psid) {
                    results.messagesFailed++;
                    continue;
                }

                try {
                    // Generate AI message using contact's name
                    const contactName = contact.name || 'there';
                    const messageText = await generatePersonalizedMessage(
                        campaign.ai_prompt || 'Just checking in with you!',
                        contactName
                    );

                    // Send the message
                    await sendMessage(
                        page.fb_page_id,
                        page.access_token,
                        contact.psid,
                        messageText
                    );

                    // Calculate next scheduled time (same hour tomorrow)
                    const bestHour = contact.best_contact_hour ?? 12;
                    const nextScheduled = new Date();
                    nextScheduled.setDate(nextScheduled.getDate() + 1);
                    nextScheduled.setUTCHours(bestHour, 0, 0, 0);

                    // Update recipient: increment count, set next schedule
                    await supabase
                        .from('campaign_recipients')
                        .update({
                            status: 'pending', // Keep pending for loop
                            message_sent_count: (recipient.message_sent_count || 0) + 1,
                            last_contacted_at: new Date().toISOString(),
                            next_scheduled_at: nextScheduled.toISOString(),
                            scheduled_at: null // Clear initial schedule
                        })
                        .eq('id', recipient.id);

                    results.messagesSent++;
                    console.log(`✅ Sent to ${contact.name || contact.psid}`);
                } catch (sendError) {
                    results.messagesFailed++;
                    console.error(`❌ Failed to send to ${contact.psid}:`, sendError);

                    // Mark as failed after too many attempts
                    if ((recipient.message_sent_count || 0) >= 3) {
                        await supabase
                            .from('campaign_recipients')
                            .update({
                                status: 'failed',
                                error_message: (sendError as Error).message
                            })
                            .eq('id', recipient.id);
                    }
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
