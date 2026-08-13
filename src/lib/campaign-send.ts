import { generatePersonalizedMessage } from './ai';
import { parseCampaignMessageParts } from './campaign-message-sequence';
import { getConversationIdForPsid, getConversationMessages, sendMessage, getPageTemplates, takeThreadControl } from './facebook';
import { getBaseTemplateName, UTILITY_TEMPLATES as TEMPLATE_DEFS } from './facebook-templates';
import { normalizeContactName } from './contact-names';
import { replaceTemplateVariables } from './placeholders';
import {
    categorizeSendError,
    getUtilityTemplateParameterValidationError,
    isRetryableSendError,
    shouldPauseCampaignForSendError
} from './send-errors';
import { getSupabaseAdmin } from './supabase';
import {
    claimCampaignRecipients,
    finishCampaignRecipientBatch,
    getCampaignDeliveryProgress,
    releaseCampaignRecipientBatch
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

const SENDABLE_TEMPLATE_STATUSES = new Set(['APPROVED', 'ACTIVE']);

function isRetryableInfrastructureError(error: unknown): boolean {
    if (isRetryableSendError(error)) return true;

    const record = error && typeof error === 'object'
        ? error as { code?: string | number; status?: number; message?: string }
        : {};
    const code = String(record.code || '').toUpperCase();
    const message = String(record.message || error || '').toLowerCase();

    return (
        ['40001', '40P01', '53300', '57014', '57P01', '57P02', '57P03'].includes(code) ||
        code.startsWith('08') ||
        record.status === 408 ||
        record.status === 429 ||
        (typeof record.status === 'number' && record.status >= 500) ||
        message.includes('statement timeout') ||
        message.includes('connection') ||
        message.includes('fetch failed') ||
        message.includes('network') ||
        message.includes('temporarily unavailable') ||
        message.includes('socket hang up') ||
        message.includes('econnreset')
    );
}

function normalizeStoredMediaHeader(value: unknown): { type: TemplateMediaType; url: string } | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (
        (record.type === 'image' || record.type === 'video') &&
        typeof record.url === 'string' &&
        record.url.trim()
    ) {
        return { type: record.type, url: record.url.trim() };
    }

    return undefined;
}

function getTemplateLanguage(template: Record<string, unknown>): string | null {
    if (typeof template.language === 'string') return template.language.replace('-', '_');
    if (template.language && typeof template.language === 'object') {
        const language = template.language as Record<string, unknown>;
        const code = language.code || language.locale || language.name;
        return typeof code === 'string' ? code.replace('-', '_') : null;
    }
    return null;
}

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

        // Campaigns created before audience materialization was tracked can be
        // resumed only when their durable counters plus queued rows match the
        // intended audience. This prevents a timed-out, partially inserted
        // campaign from silently sending to only part of its selection.
        if (
            campaign.audience_mode === 'specific' &&
            !campaign.audience_materialized_at &&
            !campaign.is_loop &&
            (campaign.recurrence || 'none') === 'none'
        ) {
            const materializationProgress = await getCampaignDeliveryProgress(supabase, campaignId);
            const materializedRecipientCount =
                materializationProgress.sent +
                materializationProgress.failed +
                materializationProgress.remaining;
            const expectedRecipientCount = Number(campaign.total_recipients || 0);

            if (materializedRecipientCount !== expectedRecipientCount) {
                return {
                    status: 409,
                    body: {
                        error: 'Campaign audience incomplete',
                        message:
                            `Campaign setup stopped after queuing ${materializedRecipientCount} of ` +
                            `${expectedRecipientCount} recipients. Delete this campaign and create it again; ` +
                            'sending it would omit recipients.'
                    }
                };
            }

            const materializedAt = new Date().toISOString();
            const { error: materializationUpdateError } = await supabase
                .from('campaigns')
                .update({
                    audience_materialized_at: materializedAt,
                    updated_at: materializedAt
                })
                .eq('id', campaignId);

            if (materializationUpdateError) throw materializationUpdateError;
            campaign.audience_materialized_at = materializedAt;
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

        const effectiveTemplateMediaHeader =
            templateMediaHeader || normalizeStoredMediaHeader(campaign.template_media_header);
        const storedTemplateMediaHeaders = Array.isArray(campaign.template_media_headers)
            ? campaign.template_media_headers.map(normalizeStoredMediaHeader)
            : undefined;
        const effectiveTemplateMediaHeaders = templateMediaHeaders || storedTemplateMediaHeaders;

        // Validate every template before claiming even one recipient. This
        // prevents a typo/stale media variant from turning a page-wide setup
        // problem into tens of thousands of recipient failures.
        const campaignMessageParts = parseCampaignMessageParts(campaign.message_text);
        const configuredTemplates = campaignMessageParts
            .map((message, messageIndex) => ({
                name: message.templateName || campaign.template_name || null,
                language: (message.templateLanguage || campaign.template_language || 'en_US').replace('-', '_'),
                messageIndex
            }))
            .filter((template): template is { name: string; language: string; messageIndex: number } => Boolean(template.name));

        const invalidTemplateParameter = campaignMessageParts.find(message => (
            Boolean(message.templateName || campaign.template_name) &&
            Boolean(getUtilityTemplateParameterValidationError(message.text))
        ));
        if (invalidTemplateParameter) {
            const validationError = getUtilityTemplateParameterValidationError(invalidTemplateParameter.text);
            const pausedStatus = 'draft';
            await supabase
                .from('campaigns')
                .update({ status: pausedStatus, updated_at: new Date().toISOString() })
                .eq('id', campaignId);

            return {
                status: 409,
                body: {
                    success: false,
                    paused: true,
                    retryable: false,
                    sent: Number(campaign.sent_count || 0),
                    failed: Number(campaign.failed_count || 0),
                    message: `Campaign paused before recipients were claimed. ${validationError}`
                },
                success: false,
                sent: Number(campaign.sent_count || 0),
                failed: Number(campaign.failed_count || 0)
            };
        }

        // The creation endpoint also validates new tracked campaigns. Repeat
        // the check at the first actual delivery so older/resumed campaigns
        // are protected, without spending two Graph calls on every 500-row
        // continuation slice of a very large campaign.
        if (configuredTemplates.length > 0 && Number(campaign.sent_count || 0) === 0) {
            const pageTemplates = await getPageTemplates(page.fb_page_id, page.access_token);
            const missingTemplate = configuredTemplates.find(configured => !pageTemplates.some(template => {
                if (!template || typeof template !== 'object') return false;
                const candidate = template as Record<string, unknown>;
                const status = typeof candidate.status === 'string' ? candidate.status.toUpperCase() : '';
                const language = getTemplateLanguage(candidate);
                return (
                    candidate.name === configured.name &&
                    SENDABLE_TEMPLATE_STATUSES.has(status) &&
                    (!language || language === configured.language)
                );
            }));

            if (missingTemplate) {
                const pausedStatus = 'draft';
                await supabase
                    .from('campaigns')
                    .update({ status: pausedStatus, updated_at: new Date().toISOString() })
                    .eq('id', campaignId);

                return {
                    status: 409,
                    body: {
                        success: false,
                        paused: true,
                        retryable: false,
                        sent: Number(campaign.sent_count || 0),
                        failed: Number(campaign.failed_count || 0),
                        message:
                            `Campaign paused: template '${missingTemplate.name}' (${missingTemplate.language}) ` +
                            'is not approved and available on this Facebook page. Select an approved template, then resume.'
                    },
                    success: false,
                    sent: Number(campaign.sent_count || 0),
                    failed: Number(campaign.failed_count || 0)
                };
            }

            const missingMediaValue = configuredTemplates.find(configured => {
                const matchingTemplate = pageTemplates.find(template => {
                    if (!template || typeof template !== 'object') return false;
                    const candidate = template as Record<string, unknown>;
                    const language = getTemplateLanguage(candidate);
                    return candidate.name === configured.name && (!language || language === configured.language);
                }) as Record<string, unknown> | undefined;
                const components = Array.isArray(matchingTemplate?.components)
                    ? matchingTemplate.components as Array<Record<string, unknown>>
                    : [];
                const requiresMedia = components.some(component => (
                    String(component.type || '').toUpperCase() === 'HEADER' &&
                    ['IMAGE', 'VIDEO'].includes(String(component.format || '').toUpperCase())
                ));
                const suppliedMedia =
                    effectiveTemplateMediaHeaders?.[configured.messageIndex] || effectiveTemplateMediaHeader;
                return requiresMedia && !suppliedMedia;
            });

            if (missingMediaValue) {
                const pausedStatus = 'draft';
                await supabase
                    .from('campaigns')
                    .update({ status: pausedStatus, updated_at: new Date().toISOString() })
                    .eq('id', campaignId);

                return {
                    status: 409,
                    body: {
                        success: false,
                        paused: true,
                        retryable: false,
                        sent: Number(campaign.sent_count || 0),
                        failed: Number(campaign.failed_count || 0),
                        message:
                            `Campaign paused: template '${missingMediaValue.name}' requires a media header, ` +
                            'but the campaign has no durable media URL.'
                    },
                    success: false,
                    sent: Number(campaign.sent_count || 0),
                    failed: Number(campaign.failed_count || 0)
                };
            }
        }

        await supabase
            .from('campaigns')
            .update({
                status: 'sending',
                background_delivery_enabled: !dueAt && !campaign.is_loop,
                next_attempt_at: null,
                last_error: null,
                updated_at: new Date().toISOString()
            })
            .eq('id', campaignId);
        let sentThisRun = 0;
        let failedThisRun = 0;
        let processedThisRun = 0;
        const SEND_BATCH_SIZE = Math.max(1, Math.min(sendBatchSize || 10, 25));
        const DELAY_BETWEEN_BATCHES = Math.max(0, delayBetweenBatchesMs || 0);
        const MAX_PROCESSING_TIME = Math.max(10000, Math.min(maxProcessingTimeMs || 240000, 270000));
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
                    return {
                        success: false,
                        contactId: recipient.contact_id,
                        error: 'Contact missing PSID',
                        pauseCampaign: false
                    };
                }

                let deliveryError: string | undefined;
                let pauseCampaign = false;
                try {
                    let messagesToSend = campaignMessageParts;

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

                    let threadControlRecoveryAttempted = false;
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

                        let retryAttempt = 0;
                        while (true) {
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

                                const messageMediaHeader =
                                    effectiveTemplateMediaHeaders?.[messageIndex] || effectiveTemplateMediaHeader;
                                if (useTemplate && messageMediaHeader) {
                                    sendArgs.push(undefined, messageMediaHeader);
                                }

                                await sendMessage(...sendArgs);
                                break;
                            } catch (sendError) {
                                const errorMessage = (sendError as Error).message;
                                if (
                                    categorizeSendError(sendError) === 'thread_controlled_by_another_app' &&
                                    !threadControlRecoveryAttempted
                                ) {
                                    threadControlRecoveryAttempted = true;
                                    try {
                                        await takeThreadControl(
                                            page.access_token,
                                            recipient.contact_psid,
                                            `Tokko campaign ${campaignId}`
                                        );
                                        console.warn(`Took Messenger thread control for ${recipient.contact_psid}; retrying delivery once.`);
                                        continue;
                                    } catch (threadControlError) {
                                        const takeoverMessage = threadControlError instanceof Error
                                            ? threadControlError.message
                                            : String(threadControlError || 'Unknown thread-control error');
                                        const original = sendError as Error & { status?: number; code?: number; subcode?: number };
                                        throw Object.assign(
                                            new Error(
                                                `${errorMessage} Automatic thread-control recovery failed: ${takeoverMessage}. ` +
                                                'Configure this Meta app as the Page Primary Receiver, then resume the campaign.'
                                            ),
                                            {
                                                status: original.status,
                                                code: original.code,
                                                subcode: original.subcode
                                            }
                                        );
                                    }
                                }

                                const shouldRetry = retryAttempt < SEND_RETRY_ATTEMPTS && isRetryableSendError(sendError);

                                if (!shouldRetry) {
                                    throw sendError;
                                }

                                retryAttempt += 1;
                                const retryDelay = SEND_RETRY_DELAY * retryAttempt;
                                console.warn(`Retrying send to ${recipient.contact_psid} after transient error (${retryAttempt}/${SEND_RETRY_ATTEMPTS}): ${errorMessage}`);
                                if (retryDelay > 0) {
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                }
                            }
                        }
                    }

                } catch (error) {
                    deliveryError = (error as Error).message;
                    pauseCampaign = shouldPauseCampaignForSendError(error);
                    console.warn(`Failed to send to ${recipient.contact_psid}: ${deliveryError}`);
                    return {
                        success: false,
                        contactId: recipient.contact_id,
                        error: deliveryError,
                        pauseCampaign,
                        retryable: isRetryableSendError(error)
                    };
                }

                return deliveryError
                    ? { success: false, contactId: recipient.contact_id, error: deliveryError, pauseCampaign, retryable: false }
                    : { success: true, contactId: recipient.contact_id, pauseCampaign: false, retryable: false };
            });

            const batchResults = await Promise.allSettled(batchPromises);
            const completionResults = batchResults.flatMap((result, index) => {
                if (result.status === 'fulfilled') {
                    if (result.value.pauseCampaign) return [];
                    return [{
                        contact_id: result.value.contactId,
                        success: result.value.success,
                        error_message: result.value.success ? null : result.value.error || 'Unknown delivery error'
                    }];
                }

                if (shouldPauseCampaignForSendError(result.reason)) return [];
                return [{
                        contact_id: batch[index].contact_id,
                        success: false,
                        error_message: result.reason instanceof Error ? result.reason.message : 'Unexpected delivery error'
                }];
            });

            const pausedResults = batchResults.flatMap((result, index) => {
                if (result.status === 'fulfilled') {
                    return result.value.pauseCampaign
                        ? [{
                            contactId: result.value.contactId,
                            error: result.value.error || 'Recoverable send failure',
                            retryable: result.value.retryable
                        }]
                        : [];
                }
                return shouldPauseCampaignForSendError(result.reason)
                    ? [{
                        contactId: batch[index].contact_id,
                        error: result.reason instanceof Error ? result.reason.message : 'Recoverable send failure',
                        retryable: isRetryableSendError(result.reason)
                    }]
                    : [];
            });

            if (completionResults.length > 0) {
                await finishCampaignRecipientBatch({
                    supabase,
                    campaignId,
                    claimToken: batch[0].claim_token,
                    results: completionResults
                });
            }

            if (pausedResults.length > 0) {
                await releaseCampaignRecipientBatch({
                    supabase,
                    campaignId,
                    claimToken: batch[0].claim_token,
                    contactIds: pausedResults.map(result => result.contactId)
                });
            }

            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        sentThisRun++;
                    } else if (!result.value.pauseCampaign) {
                        failedThisRun++;
                    }
                } else if (!shouldPauseCampaignForSendError(result.reason)) {
                    failedThisRun++;
                }
            }
            processedThisRun += completionResults.length;

            if (pausedResults.length > 0) {
                const progress = await getCampaignDeliveryProgress(supabase, campaignId);
                const shouldRetryAutomatically = pausedResults.every(result => result.retryable);
                const pausedStatus = shouldRetryAutomatically
                    ? (allowScheduled ? 'scheduled' : 'sending')
                    : 'draft';
                const nextAttemptAt = shouldRetryAutomatically
                    ? new Date(Date.now() + 5 * 60 * 1000).toISOString()
                    : null;
                await supabase
                    .from('campaigns')
                    .update({
                        status: pausedStatus,
                        next_attempt_at: nextAttemptAt,
                        last_error: pausedResults[0].error,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaignId)
                    .eq('status', 'sending');

                const reason = pausedResults[0].error;
                return {
                    status: shouldRetryAutomatically ? 503 : 409,
                    body: {
                        success: false,
                        paused: true,
                        retryable: shouldRetryAutomatically,
                        sent: progress.sent,
                        failed: progress.failed,
                        remaining: progress.remaining,
                        message:
                            `Campaign paused before more recipients were consumed. ${reason} ` +
                            (shouldRetryAutomatically
                                ? 'The background worker will retry automatically after a five-minute backoff.'
                                : 'Fix the page/template issue, then press Send to resume.')
                    },
                    success: false,
                    sent: progress.sent,
                    failed: progress.failed
                };
            }

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
        const databaseError = error as { code?: string; message?: string };
        const isStatementTimeout =
            databaseError.code === '57014' ||
            databaseError.message?.toLowerCase().includes('statement timeout');
        const shouldRetryAutomatically = isRetryableInfrastructureError(error);

        // Claims expire automatically. Re-arm the campaign so a later request
        // can safely resume without resetting or duplicating completed rows.
        try {
            const retryAt = shouldRetryAutomatically
                ? new Date(Date.now() + (isStatementTimeout ? 2 : 5) * 60 * 1000).toISOString()
                : null;
            await supabase
                .from('campaigns')
                .update({
                    status: shouldRetryAutomatically
                        ? (allowScheduled ? 'scheduled' : 'sending')
                        : 'draft',
                    next_attempt_at: retryAt,
                    last_error: databaseError.message || String(error),
                    updated_at: new Date().toISOString()
                })
                .eq('id', campaignId)
                .eq('status', 'sending');
            console.log(`Campaign ${campaignId} re-armed after sender error`);
        } catch (resetError) {
            console.error(`❌ Failed to reset campaign ${campaignId} status:`, resetError);
        }

        return {
            status: shouldRetryAutomatically ? 503 : 500,
            body: {
                error: shouldRetryAutomatically ? 'Delivery temporarily unavailable' : 'Failed to send campaign',
                message: shouldRetryAutomatically
                    ? 'Delivery is temporarily unavailable. The campaign remains queued and the background worker will retry automatically.'
                    : (error as Error).message,
                retryable: shouldRetryAutomatically
            }
        };
    }
}
