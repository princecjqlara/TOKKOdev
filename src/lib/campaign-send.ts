import { generatePersonalizedMessage } from './ai';
import { parseCampaignMessageParts } from './campaign-message-sequence';
import { getConversationIdForPsid, getConversationMessages, sendMessage, getPageTemplates, createUtilityTemplate, UTILITY_TEMPLATES } from './facebook';
import { getBaseTemplateName, UTILITY_TEMPLATES as TEMPLATE_DEFS } from './facebook-templates';
import { normalizeContactName } from './contact-names';
import { replaceTemplateVariables } from './placeholders';
import { isRetryableSendError } from './send-errors';
import { getSupabaseAdmin } from './supabase';
import {
    claimCampaignRecipients,
    finishCampaignRecipientBatch,
    getCampaignDeliveryProgress
} from './campaign-recipient-queue';
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
    templateMediaHeaders?: Array<{ type: TemplateMediaType; url: string } | null | undefined>;
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
    templateMediaHeader,
    templateMediaHeaders
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
        let sentThisRun = 0;
        let failedThisRun = 0;
        let processedThisRun = 0;
        const SEND_BATCH_SIZE = Math.max(1, Math.min(sendBatchSize || 10, 25));
        const DELAY_BETWEEN_BATCHES = Math.max(0, delayBetweenBatchesMs || 0);
        const MAX_PROCESSING_TIME = Math.max(30000, Math.min(maxProcessingTimeMs || 240000, 270000));
        const SEND_RETRY_ATTEMPTS = Math.max(0, Math.min(sendRetryAttempts || 0, 3));
        const SEND_RETRY_DELAY = Math.max(0, Math.min(sendRetryDelayMs || 0, 5000));
        const MAX_RECIPIENTS =
            typeof maxRecipientsPerRun === 'number' && Number.isFinite(maxRecipientsPerRun)
                ? Math.max(1, Math.floor(maxRecipientsPerRun))
                : Number.MAX_SAFE_INTEGER;
        const startTime = Date.now();
        const useAiMessages = campaign.use_ai_message || campaign.is_loop;

        console.log(`Starting campaign ${campaignId} with atomic batches of ${SEND_BATCH_SIZE}`);

        while (processedThisRun < MAX_RECIPIENTS && Date.now() - startTime <= MAX_PROCESSING_TIME) {
            const { data: currentCampaign } = await supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single();

            if (currentCampaign?.status === 'cancelled') {
                const progress = await getCampaignDeliveryProgress(supabase, campaignId);
                return {
                    status: 200,
                    body: {
                        success: true,
                        sent: progress.sent,
                        failed: progress.failed,
                        cancelled: true,
                        message: 'Campaign was cancelled'
                    },
                    success: true,
                    sent: progress.sent,
                    failed: progress.failed
                };
            }

            const batch = await claimCampaignRecipients({
                supabase,
                campaignId,
                batchSize: Math.min(SEND_BATCH_SIZE, MAX_RECIPIENTS - processedThisRun),
                dueAt,
                includeUnscheduledRecipients
            });

            if (batch.length === 0) break;

            const batchPromises = batch.map(async (recipient) => {
                if (!recipient.contact_psid) {
                    return { success: false, contactId: recipient.contact_id, error: 'Contact missing PSID' };
                }

                let deliveryError: string | undefined;
                try {
                    let messagesToSend = parseCampaignMessageParts(campaign.message_text);

                    const normalizedContactName = normalizeContactName(recipient.contact_name);
                    const placeholderContact = {
                        id: recipient.contact_id,
                        psid: recipient.contact_psid,
                        page_id: campaign.page_id,
                        name: normalizedContactName,
                        last_interaction_at: null
                    };

                    if (useAiMessages && campaign.ai_prompt) {
                        try {
                            const conversationId = await getConversationIdForPsid(
                                page.fb_page_id,
                                recipient.contact_psid,
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

                            console.log(`AI generated message for ${recipient.contact_name || recipient.contact_psid}`);
                        } catch (aiError) {
                            console.warn(`AI generation failed for ${recipient.contact_psid}, using fallback:`, (aiError as Error).message);
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

                    for (let messageIndex = 0; messageIndex < messagesToSend.length; messageIndex++) {
                        const messagePart = messagesToSend[messageIndex];
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
                                    recipient.contact_psid,
                                    messageToSend,
                                    messagingType,
                                    templateName,
                                    useTemplate ? templateLanguage : undefined,
                                    bodyParameters
                                ];

                                const messageMediaHeader = templateMediaHeaders?.[messageIndex] || templateMediaHeader;
                                if (useTemplate && messageMediaHeader) {
                                    sendArgs.push(undefined, messageMediaHeader);
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
                                console.warn(`Retrying send to ${recipient.contact_psid} after transient error (${attempt + 1}/${SEND_RETRY_ATTEMPTS}): ${errorMessage}`);
                                if (retryDelay > 0) {
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                }
                            }
                        }
                    }

                } catch (error) {
                    deliveryError = (error as Error).message;
                    console.warn(`Failed to send to ${recipient.contact_psid}: ${deliveryError}`);
                }

                return deliveryError
                    ? { success: false, contactId: recipient.contact_id, error: deliveryError }
                    : { success: true, contactId: recipient.contact_id };
            });

            const batchResults = await Promise.allSettled(batchPromises);
            const completionResults = batchResults.map((result, index) => {
                if (result.status === 'fulfilled') {
                    return {
                        contact_id: result.value.contactId,
                        success: result.value.success,
                        error_message: result.value.success ? null : result.value.error || 'Unknown delivery error'
                    };
                }

                return {
                    contact_id: batch[index].contact_id,
                    success: false,
                    error_message: result.reason instanceof Error ? result.reason.message : 'Unexpected delivery error'
                };
            });

            await finishCampaignRecipientBatch({
                supabase,
                campaignId,
                claimToken: batch[0].claim_token,
                results: completionResults
            });

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        sentThisRun++;
                    } else {
                        failedThisRun++;
                    }
                } else {
                    failedThisRun++;
                }
            }
            processedThisRun += batch.length;

            if (processedThisRun < MAX_RECIPIENTS) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }
        }

        const { data: finalStatus } = await supabase
            .from('campaigns')
            .select('status')
            .eq('id', campaignId)
            .single();

        const progress = await getCampaignDeliveryProgress(supabase, campaignId);

        if (finalStatus?.status !== 'cancelled') {
            await supabase
                .from('campaigns')
                .update({
                    status: progress.remaining > 0 ? (dueAt ? 'scheduled' : 'sending') : 'completed',
                    completed_at: progress.remaining > 0 ? null : new Date().toISOString(),
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId);

            if (progress.remaining > 0) {
                return {
                    status: 200,
                    body: {
                        success: true,
                        partial: true,
                        sent: progress.sent,
                        failed: progress.failed,
                        processed: processedThisRun,
                        total: campaign.total_recipients || progress.sent + progress.failed + progress.remaining,
                        remaining: progress.remaining,
                        message: processedThisRun > 0
                            ? `Processed ${processedThisRun} recipients in this slice. ${progress.remaining} queued recipients remain.`
                            : 'No recipients are due yet or another worker currently owns the due batch.'
                    },
                    success: true,
                    sent: progress.sent,
                    failed: progress.failed
                };
            }
        }

        console.log(`Campaign run finished: ${sentThisRun} sent, ${failedThisRun} failed`);

        return {
            status: 200,
            body: {
                success: true,
                sent: progress.sent,
                failed: progress.failed
            },
            success: true,
            sent: progress.sent,
            failed: progress.failed
        };
    } catch (error) {
        console.error('Error sending campaign:', error);

        // Claims expire automatically. Re-arm the campaign so a later request
        // can safely resume without resetting or duplicating completed rows.
        try {
            await supabase
                .from('campaigns')
                .update({
                    status: allowScheduled ? 'scheduled' : 'draft',
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId)
                .eq('status', 'sending');
            console.log(`Campaign ${campaignId} re-armed after sender error`);
        } catch (resetError) {
            console.error(`❌ Failed to reset campaign ${campaignId} status:`, resetError);
        }

        return {
            status: 500,
            body: { error: 'Failed to send campaign', message: (error as Error).message }
        };
    }
}
