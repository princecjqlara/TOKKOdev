import { generatePersonalizedMessage } from './ai';
import { getConversationIdForPsid, getConversationMessages, sendMessage, getPageTemplates, createUtilityTemplate, UTILITY_TEMPLATES } from './facebook';
import { UTILITY_TEMPLATES as TEMPLATE_DEFS } from './facebook-templates';
import { replaceTemplateVariables } from './placeholders';
import { getSupabaseAdmin } from './supabase';

type SupabaseLike = ReturnType<typeof getSupabaseAdmin>;

type SendCampaignByIdOptions = {
    campaignId: string;
    supabase?: SupabaseLike;
    userId?: string;
    allowScheduled?: boolean;
};

type SendCampaignByIdResult = {
    status: number;
    body: Record<string, unknown>;
    success?: boolean;
    sent?: number;
    failed?: number;
};

export async function sendCampaignById({
    campaignId,
    supabase = getSupabaseAdmin(),
    userId,
    allowScheduled = false
}: SendCampaignByIdOptions): Promise<SendCampaignByIdResult> {
    try {
        const { data: campaign } = await supabase
            .from('campaigns')
            .select('*, pages(fb_page_id, access_token, id)')
            .eq('id', campaignId)
            .single();

        if (!campaign) {
            return {
                status: 404,
                body: { error: 'Not Found', message: 'Campaign not found' }
            };
        }

        if (userId) {
            const { data: userPage } = await supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', userId)
                .eq('page_id', campaign.page_id)
                .single();

            if (!userPage) {
                return {
                    status: 403,
                    body: { error: 'Forbidden', message: 'You do not have access to this campaign' }
                };
            }
        }

        const allowedStatuses = new Set(allowScheduled ? ['draft', 'scheduled', 'sending'] : ['draft', 'sending']);
        if (!allowedStatuses.has(campaign.status)) {
            return {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: 'Campaign has already been completed or cancelled'
                }
            };
        }

        await supabase
            .from('campaigns')
            .update({ status: 'sending', updated_at: new Date().toISOString() })
            .eq('id', campaignId);

        let allRecipients: { id: string; contact_id: string; contacts: { psid: string; name?: string } | { psid: string; name?: string }[] | null }[] = [];
        const BATCH_SIZE = 1000;
        let offset = 0;
        let hasMore = true;

        console.log(`📤 Fetching all recipients for campaign ${campaignId}...`);

        while (hasMore) {
            const { data: recipientBatch, error: recipientError } = await supabase
                .from('campaign_recipients')
                .select('id, contact_id, contacts(psid, name)')
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

                if (recipientBatch.length < BATCH_SIZE) {
                    hasMore = false;
                }
            } else {
                hasMore = false;
            }
        }

        const recipients = allRecipients;

        if (!recipients?.length) {
            await supabase
                .from('campaigns')
                .update({ status: 'completed', failed_count: 0, updated_at: new Date().toISOString() })
                .eq('id', campaignId);

            return {
                status: 200,
                body: {
                    success: true,
                    sent: 0,
                    failed: 0,
                    message: 'No recipients to send to'
                },
                success: true,
                sent: 0,
                failed: 0
            };
        }

        const page = campaign.pages as { fb_page_id: string; access_token: string };
        let sent = 0;
        let failed = 0;

        const SEND_BATCH_SIZE = 15;
        const DELAY_BETWEEN_BATCHES = 80;
        const MAX_PROCESSING_TIME = 270000;
        const startTime = Date.now();

        console.log(`📤 Starting campaign send: ${recipients.length} recipients in batches of ${SEND_BATCH_SIZE}`);

        for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingCount = recipients.length - i;
                console.warn(`⏱️ Campaign timeout: processed ${i}/${recipients.length}, ${remainingCount} remaining`);

                await supabase
                    .from('campaigns')
                    .update({
                        status: 'sending',
                        sent_count: sent,
                        failed_count: failed,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaignId);

                return {
                    status: 200,
                    body: {
                        success: true,
                        partial: true,
                        sent,
                        failed,
                        processed: i,
                        total: recipients.length,
                        remaining: remainingCount,
                        message: `Processed ${i} of ${recipients.length} recipients before timeout. ${remainingCount} remaining.`
                    },
                    success: true,
                    sent,
                    failed
                };
            }

            const { data: currentCampaign } = await supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single();

            if (currentCampaign?.status === 'cancelled') {
                return {
                    status: 200,
                    body: {
                        success: true,
                        sent,
                        failed,
                        cancelled: true,
                        message: 'Campaign was cancelled'
                    },
                    success: true,
                    sent,
                    failed
                };
            }

            const batch = recipients.slice(i, i + SEND_BATCH_SIZE);
            const useAiMessages = campaign.use_ai_message || campaign.is_loop;

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
                    let messageToSend = campaign.message_text;

                    const placeholderContact = {
                        id: recipient.contact_id,
                        psid: contact.psid,
                        page_id: campaign.page_id,
                        name: contact.name || null,
                        last_interaction_at: null
                    };

                    if (useAiMessages && campaign.ai_prompt) {
                        try {
                            const conversationId = await getConversationIdForPsid(
                                page.fb_page_id,
                                contact.psid,
                                page.access_token
                            );

                            let messages: { id: string; message: string; from: { id: string; name?: string }; created_time: string }[] = [];
                            if (conversationId) {
                                messages = await getConversationMessages(
                                    conversationId,
                                    page.access_token
                                );
                            }

                            messageToSend = await generatePersonalizedMessage(
                                campaign.ai_prompt,
                                contact.name || 'Friend',
                                messages
                            );

                            console.log(`🤖 AI generated message for ${contact.name || contact.psid}`);
                        } catch (aiError) {
                            console.warn(`⚠️ AI generation failed for ${contact.psid}, using fallback:`, (aiError as Error).message);
                            messageToSend = replaceTemplateVariables(campaign.ai_prompt, placeholderContact);
                        }
                    } else if (messageToSend) {
                        messageToSend = replaceTemplateVariables(messageToSend, placeholderContact);
                    }

                    if (!messageToSend) {
                        throw new Error('No message content available');
                    }

                    const useTemplate = !!(campaign.template_name);
                    const messagingType = useTemplate ? 'UTILITY' : 'HUMAN_AGENT';

                    // Build body parameters for UTILITY template messages
                    // Look up paramCount from template definitions to send correct number of params
                    let bodyParameters: string[] | undefined;
                    if (useTemplate) {
                        const templateDef = TEMPLATE_DEFS.find(t => t.name === campaign.template_name);
                        const paramCount = templateDef?.paramCount ?? 1;
                        if (paramCount === 2) {
                            bodyParameters = [messageToSend, 'Thank you for your attention.'];
                        } else {
                            bodyParameters = [messageToSend];
                        }
                    }

                    await sendMessage(
                        page.fb_page_id,
                        page.access_token,
                        contact.psid,
                        messageToSend,
                        messagingType,
                        useTemplate ? campaign.template_name : undefined,
                        useTemplate ? (campaign.template_language || 'en_US') : undefined,
                        bodyParameters
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

            const batchResults = await Promise.allSettled(batchPromises);

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

            await supabase
                .from('campaigns')
                .update({
                    sent_count: sent,
                    failed_count: failed,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

            if (i + SEND_BATCH_SIZE < recipients.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }

            if ((i + SEND_BATCH_SIZE) % 50 === 0 || i + SEND_BATCH_SIZE >= recipients.length) {
                const progress = Math.min(i + SEND_BATCH_SIZE, recipients.length);
                const percentage = Math.round((progress / recipients.length) * 100);
                console.log(`📊 Campaign progress: ${progress}/${recipients.length} (${percentage}%) | Sent: ${sent}, Failed: ${failed}`);
            }
        }

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
                    failed_count: failed,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);
        }

        console.log(`✅ Campaign complete: ${sent} sent, ${failed} failed out of ${recipients.length} recipients`);

        return {
            status: 200,
            body: {
                success: true,
                sent,
                failed
            },
            success: true,
            sent,
            failed
        };
    } catch (error) {
        console.error('Error sending campaign:', error);

        // Reset campaign status back to draft so it can be retried
        try {
            await supabase
                .from('campaigns')
                .update({
                    status: 'draft',
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);
            console.log(`🔄 Campaign ${campaignId} status reset to 'draft' after error`);
        } catch (resetError) {
            console.error(`❌ Failed to reset campaign ${campaignId} status:`, resetError);
        }

        return {
            status: 500,
            body: { error: 'Failed to send campaign', message: (error as Error).message }
        };
    }
}
