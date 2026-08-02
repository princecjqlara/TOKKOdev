import { generatePersonalizedMessage } from './ai';
import { parseCampaignMessageParts } from './campaign-message-sequence';
import { getConversationIdForPsid, getConversationMessages, sendMessage, getPageTemplates, createUtilityTemplate, UTILITY_TEMPLATES } from './facebook';
import { getBaseTemplateName, UTILITY_TEMPLATES as TEMPLATE_DEFS } from './facebook-templates';
import { normalizeContactName } from './contact-names';
import { replaceTemplateVariables } from './placeholders';
import { isRetryableSendError } from './send-errors';
import { getSupabaseAdmin } from './supabase';
import type { TemplateMediaType } from './facebook-templates';

type SupabaseLike = ReturnType<typeof getSupabaseAdmin>;

type SendCampaignByIdOptions = {
    campaignId: string;
    supabase?: SupabaseLike;
    userId?: string;
    allowScheduled?: boolean;
    dueAt?: string;
    includeUnscheduledRecipients?: boolean;
    sendBatchSize?: number;
    maxRecipientsPerRun?: number;
    delayBetweenBatchesMs?: number;
    maxProcessingTimeMs?: number;
    sendRetryAttempts?: number;
    sendRetryDelayMs?: number;
    templateMediaHeader?: { type: TemplateMediaType; url: string };
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
    allowScheduled = false,
    dueAt,
    includeUnscheduledRecipients = false,
    sendBatchSize = 20,
    maxRecipientsPerRun,
    delayBetweenBatchesMs = 50,
    maxProcessingTimeMs = 240000,
    sendRetryAttempts = 2,
    sendRetryDelayMs = 500,
    templateMediaHeader
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

        async function getRecipientStatusCounts() {
            const [sentResult, failedResult, pendingResult] = await Promise.all([
                supabase
                    .from('campaign_recipients')
                    .select('id', { count: 'exact', head: true })
                    .eq('campaign_id', campaignId)
                    .eq('status', 'sent'),
                supabase
                    .from('campaign_recipients')
                    .select('id', { count: 'exact', head: true })
                    .eq('campaign_id', campaignId)
                    .eq('status', 'failed'),
                supabase
                    .from('campaign_recipients')
                    .select('id', { count: 'exact', head: true })
                    .eq('campaign_id', campaignId)
                    .eq('status', 'pending')
            ]);

            const firstError = sentResult.error || failedResult.error || pendingResult.error;
            if (firstError) {
                throw firstError;
            }

            return {
                sent: sentResult.count || 0,
                failed: failedResult.count || 0,
                pending: pendingResult.count || 0
            };
        }

        const startingCounts = await getRecipientStatusCounts();
        let allRecipients: { id: string; contact_id: string; contacts: { psid: string; name?: string } | { psid: string; name?: string }[] | null }[] = [];
        const RECIPIENT_FETCH_PAGE_SIZE = 2000;
        const RECIPIENT_FETCH_LIMIT =
            typeof maxRecipientsPerRun === 'number' && Number.isFinite(maxRecipientsPerRun)
                ? Math.max(1, Math.floor(maxRecipientsPerRun))
                : null;
        let offset = 0;
        let hasMore = true;

        console.log(`📤 Fetching all recipients for campaign ${campaignId}...`);

        while (hasMore) {
            let recipientQuery = supabase
                .from('campaign_recipients')
                .select('id, contact_id, contacts(psid, name)')
                .eq('campaign_id', campaignId)
                .eq('status', 'pending');

            if (dueAt) {
                const dueFilters = [
                    includeUnscheduledRecipients ? 'scheduled_at.is.null' : null,
                    `scheduled_at.lte.${dueAt}`,
                    `next_scheduled_at.lte.${dueAt}`
                ].filter(Boolean);

                recipientQuery = recipientQuery.or(
                    dueFilters.join(',')
                );
            }

            const remainingFetchLimit = RECIPIENT_FETCH_LIMIT === null
                ? RECIPIENT_FETCH_PAGE_SIZE
                : RECIPIENT_FETCH_LIMIT - allRecipients.length;

            if (remainingFetchLimit <= 0) {
                break;
            }

            const pageSize = Math.min(RECIPIENT_FETCH_PAGE_SIZE, remainingFetchLimit);
            const { data: recipientBatch, error: recipientError } = await recipientQuery
                .range(offset, offset + pageSize - 1);

            if (recipientError) {
                console.error(`❌ Error fetching recipients batch at offset ${offset}:`, recipientError);
                break;
            }

            if (recipientBatch && recipientBatch.length > 0) {
                allRecipients = allRecipients.concat(recipientBatch);
                console.log(`📤 Fetched ${recipientBatch.length} recipients (total so far: ${allRecipients.length})`);
                offset += RECIPIENT_FETCH_PAGE_SIZE;

                hasMore =
                    recipientBatch.length === pageSize &&
                    (RECIPIENT_FETCH_LIMIT === null || allRecipients.length < RECIPIENT_FETCH_LIMIT);
            } else {
                hasMore = false;
            }
        }

        const recipients = allRecipients;

        if (!recipients?.length) {
            const currentCounts = await getRecipientStatusCounts();
            await supabase
                .from('campaigns')
                .update({
                    status: currentCounts.pending > 0 ? 'scheduled' : 'completed',
                    sent_count: currentCounts.sent,
                    failed_count: currentCounts.failed,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

            return {
                status: 200,
                body: {
                    success: true,
                    sent: 0,
                    failed: 0,
                    pending: currentCounts.pending,
                    message: currentCounts.pending > 0
                        ? 'No recipients are due yet'
                        : 'No recipients to send to'
                },
                success: true,
                sent: 0,
                failed: 0
            };
        }

        const pagesData = campaign.pages;
        const page = (Array.isArray(pagesData) ? pagesData[0] : pagesData) as { fb_page_id: string; access_token: string } | null;

        if (!page?.fb_page_id || !page?.access_token) {
            return {
                status: 400,
                body: { error: 'Bad Request', message: 'Campaign page not found or missing access token' },
                success: false,
                sent: 0,
                failed: 0
            };
        }
        let sent = 0;
        let failed = 0;

        const SEND_BATCH_SIZE = Math.max(1, Math.min(sendBatchSize || 10, 25));
        const DELAY_BETWEEN_BATCHES = Math.max(0, delayBetweenBatchesMs || 0);
        const MAX_PROCESSING_TIME = Math.max(30000, Math.min(maxProcessingTimeMs || 240000, 270000));
        const SEND_RETRY_ATTEMPTS = Math.max(0, Math.min(sendRetryAttempts || 0, 3));
        const SEND_RETRY_DELAY = Math.max(0, Math.min(sendRetryDelayMs || 0, 5000));
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
                        sent_count: startingCounts.sent + sent,
                        failed_count: startingCounts.failed + failed,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaignId);

                return {
                    status: 200,
                    body: {
                        success: true,
                        partial: true,
                        sent: startingCounts.sent + sent,
                        failed: startingCounts.failed + failed,
                        processed: i,
                        total: recipients.length,
                        remaining: remainingCount,
                        message: `Processed ${i} of ${recipients.length} recipients before timeout. ${remainingCount} remaining.`
                    },
                    success: true,
                    sent: startingCounts.sent + sent,
                    failed: startingCounts.failed + failed
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
                    let messagesToSend = parseCampaignMessageParts(campaign.message_text);

                    const normalizedContactName = normalizeContactName(contact.name);
                    const placeholderContact = {
                        id: recipient.contact_id,
                        psid: contact.psid,
                        page_id: campaign.page_id,
                        name: normalizedContactName,
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

                            const messageToSend = await generatePersonalizedMessage(
                                campaign.ai_prompt,
                                normalizedContactName || 'Friend',
                                messages
                            );
                            messagesToSend = [{ text: messageToSend }];

                            console.log(`🤖 AI generated message for ${contact.name || contact.psid}`);
                        } catch (aiError) {
                            console.warn(`⚠️ AI generation failed for ${contact.psid}, using fallback:`, (aiError as Error).message);
                            messagesToSend = [{ text: replaceTemplateVariables(campaign.ai_prompt, placeholderContact) }];
                        }
                    } else {
                        messagesToSend = messagesToSend.map((message) => ({
                            ...message,
                            text: replaceTemplateVariables(message.text, placeholderContact)
                        }));
                    }

                    if (messagesToSend.length === 0) {
                        throw new Error('No message content available');
                    }

                    for (const messagePart of messagesToSend) {
                        const messageToSend = messagePart.text;
                        const templateName = messagePart.templateName || campaign.template_name || undefined;
                        const templateLanguage = messagePart.templateLanguage || campaign.template_language || 'en_US';
                        const useTemplate = !!templateName;
                        const messagingType = useTemplate ? 'UTILITY' : 'HUMAN_AGENT';
                        const templateDef = useTemplate
                            ? TEMPLATE_DEFS.find(t => t.name === getBaseTemplateName(templateName as string))
                            : undefined;
                        const paramCount = templateDef?.paramCount ?? 1;
                        let bodyParameters: string[] | undefined;
                        if (useTemplate) {
                            if (paramCount === 2) {
                                bodyParameters = [messageToSend, 'Thank you for your attention.'];
                            } else {
                                bodyParameters = [messageToSend];
                            }
                        }

                        for (let attempt = 0; attempt <= SEND_RETRY_ATTEMPTS; attempt++) {
                            try {
                                const sendArgs: Parameters<typeof sendMessage> = [
                                    page.fb_page_id,
                                    page.access_token,
                                    contact.psid,
                                    messageToSend,
                                    messagingType,
                                    templateName,
                                    useTemplate ? templateLanguage : undefined,
                                    bodyParameters
                                ];

                                if (useTemplate && templateMediaHeader) {
                                    sendArgs.push(undefined, templateMediaHeader);
                                }

                                await sendMessage(...sendArgs);
                                break;
                            } catch (sendError) {
                                const errorMessage = (sendError as Error).message;
                                const shouldRetry = attempt < SEND_RETRY_ATTEMPTS && isRetryableSendError(errorMessage);

                                if (!shouldRetry) {
                                    throw sendError;
                                }

                                const retryDelay = SEND_RETRY_DELAY * (attempt + 1);
                                console.warn(`Retrying send to ${contact.psid} after transient error (${attempt + 1}/${SEND_RETRY_ATTEMPTS}): ${errorMessage}`);
                                if (retryDelay > 0) {
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                }
                            }
                        }
                    }

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
                    sent_count: startingCounts.sent + sent,
                    failed_count: startingCounts.failed + failed,
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
            const finalCounts = await getRecipientStatusCounts();
            await supabase
                .from('campaigns')
                .update({
                    status: finalCounts.pending > 0 ? (dueAt ? 'scheduled' : 'sending') : 'completed',
                    sent_count: finalCounts.sent,
                    failed_count: finalCounts.failed,
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

            if (finalCounts.pending > 0) {
                return {
                    status: 200,
                    body: {
                        success: true,
                        partial: true,
                        sent: finalCounts.sent,
                        failed: finalCounts.failed,
                        processed: sent + failed,
                        total: campaign.total_recipients || finalCounts.sent + finalCounts.failed + finalCounts.pending,
                        remaining: finalCounts.pending,
                        message: `Processed ${sent + failed} recipients in this slice. ${finalCounts.pending} pending recipients remain.`
                    },
                    success: true,
                    sent: finalCounts.sent,
                    failed: finalCounts.failed
                };
            }
        }

        console.log(`✅ Campaign complete: ${sent} sent, ${failed} failed out of ${recipients.length} recipients`);

        const completedSent = startingCounts.sent + sent;
        const completedFailed = startingCounts.failed + failed;

        return {
            status: 200,
            body: {
                success: true,
                sent: completedSent,
                failed: completedFailed
            },
            success: true,
            sent: completedSent,
            failed: completedFailed
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
