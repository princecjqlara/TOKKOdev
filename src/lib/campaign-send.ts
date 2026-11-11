import { generatePersonalizedMessage } from './ai';
import { parseCampaignMessageParts } from './campaign-message-sequence';
import { getConversationIdForPsid, getConversationMessages, sendMessage, getPageTemplates, takeThreadControl } from './facebook';
import { getBaseTemplateName, ALL_UTILITY_TEMPLATES as TEMPLATE_DEFS } from './facebook-templates';
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
import type { ClaimedCampaignRecipient, CampaignRecipientResult } from './campaign-recipient-queue';
import { mapConcurrentSettled } from './concurrent-work';
import type { TemplateMediaType } from './facebook-templates';
import { recordOutboundMessageEvents, type OutboundMessageEventInput } from './outbound-message-events';
import { acquirePageDelivery, releasePageDelivery, reportPageDeliveryFeedback, requestCampaignDeliveryContinuation,
    waitForPageDeliveryBatch, MAX_PAGE_DELIVERY_CONCURRENCY } from './page-delivery';
import { AdaptiveDeliveryController } from './adaptive-delivery';
import { getMetaThrottleScope, getMetaThrottleKey, type MetaDeliveryFeedback } from './meta-delivery-feedback';
import { databaseRequest, DATABASE_REQUEST_TIMEOUT_MS } from './database-request';

type SupabaseLike = ReturnType<typeof getSupabaseAdmin>;

type SendCampaignByIdOptions = {
    campaignId: string;
    supabase?: SupabaseLike;
    userId?: string;
    allowScheduled?: boolean;
    backgroundOnly?: boolean;
    expectedUpdatedAt?: string;
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
const TRANSIENT_RETRY_DELAY_MS = 60_000;
const RATE_LIMIT_RETRY_DELAY_MS = 60_000;
const OUTBOUND_AUDIT_BATCH_SIZE = 250;

type DeliveryInterruption = { error: string; retryable: boolean; yielded?: boolean };
type RecipientDeliveryResult = {
    success: boolean; contactId: string; error?: string; pauseCampaign: boolean;
    retryable?: boolean; yielded?: boolean;
};
class CampaignDeliveryInterruptedError extends Error {
    constructor(readonly interruption: DeliveryInterruption) { super(interruption.error); }
}

async function updateCampaignState(supabase: SupabaseLike, campaignId: string,
    changes: Record<string, unknown>, expectedStatus?: string | string[]) {
    const query = supabase.from('campaigns').update(changes).eq('id', campaignId);
    const filtered = Array.isArray(expectedStatus) ? query.in('status', expectedStatus)
        : expectedStatus ? query.eq('status', expectedStatus) : query;
    const { data, error } = await databaseRequest(filtered.select('id'));
    if (error) throw error;
    return Boolean(data?.length);
}

function isRetryableInfrastructureError(error: unknown): boolean {
    const record = error && typeof error === 'object'
        ? error as { code?: string | number; status?: number; message?: string }
        : {};
    const code = String(record.code || '').toUpperCase();
    const category = categorizeSendError(error);
    // Pause for errors requiring a repair. Unexpected infrastructure failures
    // otherwise remain queued, including expired claims and empty gateway errors.
    if (['authentication_required', 'utility_permission_missing', 'utility_template_missing', 'invalid_utility_parameter'].includes(category)) return false;
    if (['PGRST202', 'PGRST204'].includes(code) || /^(22|23|42)/.test(code)) return false;
    if (isRetryableSendError(error)) return true;
    return !(typeof record.status === 'number' && record.status >= 400 && record.status < 500
        && ![408, 409, 429].includes(record.status));
}

async function updateCampaignIfUnchanged(supabase: SupabaseLike, campaignId: string,
    changes: Record<string, unknown>, expected: { status: string; updatedAt?: string }) {
    const query = supabase.from('campaigns').update(changes).eq('id', campaignId).eq('status', expected.status);
    if (expected.updatedAt) query.eq('updated_at', expected.updatedAt);
    const { data, error } = await databaseRequest(query.select('id,updated_at'));
    if (error) throw error;
    return data?.[0] || null;
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
    backgroundOnly = false,
    expectedUpdatedAt,
    dueAt,
    includeUnscheduledRecipients = false,
    sendBatchSize = MAX_PAGE_DELIVERY_CONCURRENCY,
    maxRecipientsPerRun,
    delayBetweenBatchesMs = 0,
    maxProcessingTimeMs = 240000,
    sendRetryAttempts = 2,
    sendRetryDelayMs = 500,
    templateMediaHeader,
    templateMediaHeaders
}: SendCampaignByIdOptions): Promise<SendCampaignByIdResult> {
    const startTime = Date.now();
    let pageLease: { pageId: string; owner: string; batchSize: number } | null = null;
    let pageRateLimited = false;
    let campaignAuthorized = false;
    let recoveryStatus: string | undefined;
    let isLoopCampaign = false;
    let continuationSaved = false;
    let stoppedResult: SendCampaignByIdResult | undefined;
    let adaptive: AdaptiveDeliveryController | undefined;
    let continuePageId: string | undefined;
    let lastFeedbackAt = 0;
    const resolveStateConflict = async (): Promise<SendCampaignByIdResult> => {
        // Delivery receipts and other workers also update updated_at. A failed
        // conditional write is not proof that the user pressed Stop.
        const { data: current, error } = await databaseRequest(supabase.from('campaigns')
            .select('status,background_delivery_enabled,sent_count,failed_count,total_recipients,next_attempt_at')
            .eq('id', campaignId).single());
        if (error) throw error;
        if (!current) throw new Error('Campaign state is temporarily unavailable.');
        const sent = Number(current.sent_count || 0);
        const failed = Number(current.failed_count || 0);
        const remaining = Math.max(0, Number(current.total_recipients || 0) - sent - failed);
        if (current.status === 'completed') return { status: 200,
            body: { success: true, sent, failed, remaining: 0 }, success: true, sent, failed };
        if ((current.status === 'sending' && (current.background_delivery_enabled || dueAt)) ||
            (current.status === 'scheduled' && allowScheduled)) {
            return { status: 200, body: {
                success: true, partial: true, paused: false, queued: true, retryable: true,
                processed: 0, sent, failed, remaining, nextAttemptAt: current.next_attempt_at || null,
                message: 'Another worker updated campaign progress. Delivery remains queued and will retry automatically.'
            }, success: true, sent, failed };
        }
        return { status: 200, body: {
            ...stoppedResult?.body, success: true, paused: true, retryable: false, queued: false,
            cancelled: current.status === 'cancelled', sent, failed, remaining
        }, success: true, sent, failed };
    };
    const persistFeedback = async () => {
        if (!pageLease || !adaptive) return;
        const budget = await reportPageDeliveryFeedback(supabase, pageLease.pageId, pageLease.owner, adaptive);
        lastFeedbackAt = Date.now();
        // Shared recovery budgets may come from a throttle on another Page.
        // Adopt them even when its cooldown has already elapsed.
        adaptive.concurrency = Math.min(adaptive.concurrency, budget.concurrency);
        adaptive.intervalMs = Math.max(adaptive.intervalMs, budget.intervalMs);
        adaptive.deferGrowth(budget.growthAfter);
        if (budget.retryAt && Date.parse(budget.retryAt) > Date.now()) {
            adaptive.pause(Date.parse(budget.retryAt) - Date.now());
            pageRateLimited = true;
        }
    };
    const pendingOutboundEvents: OutboundMessageEventInput[] = [];
    const flushOutboundEvents = async (includePartial = false) => {
        while (pendingOutboundEvents.length >= OUTBOUND_AUDIT_BATCH_SIZE || includePartial && pendingOutboundEvents.length) {
            await recordOutboundMessageEvents(supabase, pendingOutboundEvents.splice(0, OUTBOUND_AUDIT_BATCH_SIZE));
        }
    };
    try {
        const { data: campaign, error: campaignError } = await databaseRequest(supabase
            .from('campaigns')
            .select('*, pages(fb_page_id, access_token, id)')
            .eq('id', campaignId)
            .single());
        if (campaignError && campaignError.code !== 'PGRST116') throw campaignError;

        if (!campaign) {
            return {
                status: 404,
                body: { error: 'Not Found', message: 'Campaign not found' }
            };
        }

        if (userId) {
            const { data: userPage, error: membershipError } = await databaseRequest(supabase
                .from('user_pages')
                .select('page_id')
                .eq('user_id', userId)
                .eq('page_id', campaign.page_id)
                .single());
            if (membershipError && membershipError.code !== 'PGRST116') throw membershipError;

            if (!userPage) {
                return {
                    status: 403,
                    body: { error: 'Forbidden', message: 'You do not have access to this campaign' }
                };
            }
        }

        campaignAuthorized = true;
        const expectedState = { status: campaign.status, updatedAt: campaign.updated_at };
        isLoopCampaign = Boolean(campaign.is_loop);
        const allowedStatuses = new Set(allowScheduled ? ['draft', 'scheduled', 'sending'] : ['draft', 'sending']);
        if ((backgroundOnly || expectedUpdatedAt) && campaign.status === 'completed') return {
            status: 200, body: { success: true, sent: Number(campaign.sent_count || 0),
                failed: Number(campaign.failed_count || 0), remaining: 0 }
        };
        if (!allowedStatuses.has(campaign.status) && !((backgroundOnly || expectedUpdatedAt) && campaign.status === 'cancelled')) {
            return {
                status: 400,
                body: {
                    error: 'Bad Request',
                    message: 'Campaign has already been completed or cancelled'
                }
            };
        }

        stoppedResult = { status: 200, body: {
            success: true, paused: true, retryable: false, queued: false,
            sent: Number(campaign.sent_count || 0), failed: Number(campaign.failed_count || 0),
            remaining: Math.max(0, Number(campaign.total_recipients || 0) - Number(campaign.sent_count || 0) - Number(campaign.failed_count || 0)),
            message: 'Campaign stopped or changed. Unsent recipients remain saved; use Continue Unsent to resume.'
        } };
        if (campaign.status === 'cancelled') return stoppedResult;
        if (backgroundOnly && (campaign.status === 'draft' || (!dueAt && !campaign.background_delivery_enabled))) return stoppedResult;
        // Retrying a lost first response may start the original draft, but
        // cannot restart a draft that someone has since stopped or edited.
        if (campaign.status === 'draft' && expectedUpdatedAt &&
            Date.parse(campaign.updated_at) !== Date.parse(expectedUpdatedAt)) return stoppedResult;
        recoveryStatus = campaign.status;
        continuationSaved = campaign.status === 'scheduled' || campaign.status === 'sending' && campaign.background_delivery_enabled;

        if (campaign.next_attempt_at && new Date(campaign.next_attempt_at).getTime() > Date.now()) {
            const sent = Number(campaign.sent_count || 0);
            const failed = Number(campaign.failed_count || 0);
            return {
                status: 503,
                body: {
                    success: false,
                    paused: true,
                    retryable: true,
                    sent,
                    failed,
                    remaining: Math.max(0, Number(campaign.total_recipients || 0) - sent - failed),
                    nextAttemptAt: campaign.next_attempt_at,
                    message: 'Campaign is queued for retry after the delivery backoff.'
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
            const materialized = await updateCampaignIfUnchanged(supabase, campaignId, {
                audience_materialized_at: materializedAt,
                updated_at: materializedAt
            }, expectedState);
            if (!materialized) return await resolveStateConflict();
            expectedState.updatedAt = materialized.updated_at;
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

        const delivery = await acquirePageDelivery(supabase, campaign.page_id);
        if (!delivery.acquired) {
            // A first send can encounter a busy Page while still a draft.
            // Persist the handoff before asking the browser to stop; otherwise
            // no background worker can discover and resume this campaign.
            const activated = await updateCampaignIfUnchanged(supabase, campaignId, {
                status: dueAt ? 'scheduled' : 'sending',
                background_delivery_enabled: !dueAt && !campaign.is_loop,
                ...(delivery.reason === 'busy' ? {} : { next_attempt_at: delivery.retryAt }),
                updated_at: new Date().toISOString()
            }, expectedState);
            if (!activated) return await resolveStateConflict();
            continuationSaved = true;
            recoveryStatus = dueAt ? 'scheduled' : 'sending';
            return { status: 200, body: {
                success: true, partial: true, queued: true, retryable: true,
                processed: 0,
                nextAttemptAt: delivery.retryAt,
                sent: Number(campaign.sent_count || 0), failed: Number(campaign.failed_count || 0),
                remaining: Math.max(0, Number(campaign.total_recipients || 0) - Number(campaign.sent_count || 0) - Number(campaign.failed_count || 0)),
                message: 'Another campaign is delivering for this Page, or Meta recovery is in progress. Your recipients remain queued.'
            } };
        }
        pageLease = { pageId: campaign.page_id, owner: delivery.owner, batchSize: delivery.batchSize };

        // Save the durable handoff before slow Facebook/template checks. Even a
        // terminated invocation remains discoverable after its leases expire.
        const activated = await updateCampaignIfUnchanged(supabase, campaignId, {
            status: 'sending',
            background_delivery_enabled: !dueAt && !campaign.is_loop,
            next_attempt_at: null, last_error: null, updated_at: new Date().toISOString()
        }, expectedState);
        if (!activated) return await resolveStateConflict();
        continuationSaved = true;
        recoveryStatus = 'sending';

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
            await updateCampaignState(supabase, campaignId, { status: pausedStatus, background_delivery_enabled: false,
                next_attempt_at: null, last_error: validationError, updated_at: new Date().toISOString() }, 'sending');

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
                await updateCampaignState(supabase, campaignId, { status: pausedStatus, background_delivery_enabled: false,
                    next_attempt_at: null, last_error: `Template '${missingTemplate.name}' is not approved on this Page.`, updated_at: new Date().toISOString() }, 'sending');

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
                await updateCampaignState(supabase, campaignId, { status: pausedStatus, background_delivery_enabled: false,
                    next_attempt_at: null, last_error: `Template '${missingMediaValue.name}' requires a media header.`, updated_at: new Date().toISOString() }, 'sending');

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

        let sentThisRun = 0;
        let failedThisRun = 0;
        let processedThisRun = 0;
        const MAX_SEND_BATCH_SIZE = Number.isFinite(sendBatchSize)
            ? Math.max(1, Math.min(Math.floor(sendBatchSize), MAX_PAGE_DELIVERY_CONCURRENCY))
            : MAX_PAGE_DELIVERY_CONCURRENCY;
        const learned = await reportPageDeliveryFeedback(supabase, pageLease.pageId, pageLease.owner);
        lastFeedbackAt = Date.now();
        adaptive = new AdaptiveDeliveryController(MAX_SEND_BATCH_SIZE, learned.concurrency, learned.intervalMs, learned.growthAfter);
        if (learned.retryAt && Date.parse(learned.retryAt) > Date.now()) adaptive.pause(Date.parse(learned.retryAt) - Date.now());
        let sendBatchSizeThisRun = adaptive.concurrency;
        const DELAY_BETWEEN_BATCHES = Math.max(0, delayBetweenBatchesMs || 0);
        const MAX_PROCESSING_TIME = Math.max(10000, Math.min(maxProcessingTimeMs || 240000, 270000));
        const SEND_RETRY_ATTEMPTS = Math.max(0, Math.min(sendRetryAttempts || 0, 3));
        const SEND_RETRY_DELAY = Math.max(0, Math.min(sendRetryDelayMs || 0, 5000));
        const MAX_RECIPIENTS =
            typeof maxRecipientsPerRun === 'number' && Number.isFinite(maxRecipientsPerRun)
                ? Math.max(1, Math.floor(maxRecipientsPerRun))
                : Number.MAX_SAFE_INTEGER;
        const useAiMessages = campaign.use_ai_message || campaign.is_loop;
        // Estimate one recipient's cost, not the duration of an entire paced
        // prefetch. Unstarted recipients can yield at the soft deadline.
        let estimatedRecipientDurationMs = 0;

        console.log(`Starting campaign ${campaignId} with atomic batches up to ${MAX_SEND_BATCH_SIZE}`);

        while (processedThisRun < MAX_RECIPIENTS &&
            Date.now() - startTime + estimatedRecipientDurationMs + DATABASE_REQUEST_TIMEOUT_MS < MAX_PROCESSING_TIME) {
            const batchStartedAt = Date.now();
            const { data: currentCampaign, error: currentCampaignError } = await databaseRequest(supabase
                .from('campaigns')
                .select('status')
                .eq('id', campaignId)
                .single());

            if (currentCampaignError) throw currentCampaignError;

            if (currentCampaign?.status !== 'sending') {
                const progress = await getCampaignDeliveryProgress(supabase, campaignId);
                return {
                    status: 200,
                    body: {
                        success: true,
                        partial: progress.remaining > 0,
                        sent: progress.sent,
                        failed: progress.failed,
                        remaining: progress.remaining,
                        paused: currentCampaign?.status === 'draft',
                        cancelled: currentCampaign?.status === 'cancelled',
                        message: currentCampaign?.status === 'draft'
                            ? 'Campaign stopped. Unsent recipients remain queued and can be continued later.'
                            : 'Campaign was cancelled'
                    },
                    success: true,
                    sent: progress.sent,
                    failed: progress.failed
                };
            }

            // Prefetch work while learning speed too. The adaptive gate still
            // controls actual message starts; fetching need not idle the workers.
            const claimSize = MAX_SEND_BATCH_SIZE === 1 ? 1 : Math.min(500, sendBatchSizeThisRun * 5);
            const batch = await claimCampaignRecipients({
                supabase,
                campaignId,
                batchSize: Math.min(claimSize, MAX_RECIPIENTS - processedThisRun),
                dueAt,
                includeUnscheduledRecipients
            });

            if (batch.length === 0) break;

            const outboundEvents: OutboundMessageEventInput[] = [];
            let batchPause: DeliveryInterruption | null = null;
            const getBatchPause = (): DeliveryInterruption | null => batchPause;
            let saveError: unknown;
            let saveFailed = false;
            const checkpointed = new Set<string>();
            const checkpointResults: CampaignRecipientResult[] = [];
            let lastCheckpointAt = Date.now();
            let saveChain = Promise.resolve();
            const deliverRecipient = async (recipient: ClaimedCampaignRecipient): Promise<RecipientDeliveryResult> => {
                if (!batchPause && Date.now() - startTime + DATABASE_REQUEST_TIMEOUT_MS >= MAX_PROCESSING_TIME) {
                    batchPause = { error: 'Delivery slice ended. Unsent recipients remain queued.', retryable: true, yielded: true };
                }
                if (batchPause) return { success: false, contactId: recipient.contact_id,
                    pauseCampaign: true, ...batchPause };
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
                                messages,
                                page.fb_page_id
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
                    let recipientStarted = false;
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
                            const attemptStartedAt = Date.now();
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

                                const sendResult = await adaptive!.run(async () => {
                                    recipientStarted = true;
                                    const result = await sendMessage(...sendArgs);
                                    adaptive!.observeSuccess(result.deliveryFeedback);
                                    return result;
                                }, () => {
                                    // Finish an already-started multipart recipient across
                                    // the soft deadline, while deferring new recipients.
                                    if (batchPause && !(recipientStarted && batchPause.yielded)) {
                                        throw new CampaignDeliveryInterruptedError(batchPause);
                                    }
                                    if (!recipientStarted && Date.now() - startTime + DATABASE_REQUEST_TIMEOUT_MS >= MAX_PROCESSING_TIME) {
                                        throw new CampaignDeliveryInterruptedError({
                                            error: 'Delivery slice ended. Unsent recipients remain queued.', retryable: true, yielded: true
                                        });
                                    }
                                    return true;
                                });
                                outboundEvents.push({
                                    pageId: campaign.page_id,
                                    contactId: recipient.contact_id,
                                    messageId: sendResult.message_id,
                                    sourceType: 'campaign',
                                    sourceId: campaign.id,
                                    sourceName: campaign.name,
                                    actorUserId: campaign.created_by || null,
                                    messageKind: messagingType,
                                    sentAt: new Date().toISOString()
                                });
                                break;
                            } catch (sendError) {
                                if (sendError instanceof CampaignDeliveryInterruptedError) throw sendError;
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

                                // Immediate retries worsen a Page-wide rate limit. Stop
                                // this slice and let the shared recovery window expire.
                                if (categorizeSendError(sendError) === 'rate_limited') {
                                    pageRateLimited = true;
                                    throw sendError;
                                }
                                const shouldRetry = retryAttempt < SEND_RETRY_ATTEMPTS && isRetryableSendError(sendError);

                                if (!shouldRetry) {
                                    throw sendError;
                                }

                                retryAttempt += 1;
                                const retryDelay = SEND_RETRY_DELAY * retryAttempt;
                                // Leave time to persist the batch. Repeated slow
                                // timeouts continue in later durable invocations.
                                if (Date.now() - startTime + retryDelay + (Date.now() - attemptStartedAt)
                                    + DATABASE_REQUEST_TIMEOUT_MS >= MAX_PROCESSING_TIME) throw sendError;
                                console.warn(`Retrying send to ${recipient.contact_psid} after transient error (${retryAttempt}/${SEND_RETRY_ATTEMPTS}): ${errorMessage}`);
                                if (retryDelay > 0) {
                                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                                }
                                const { data: current, error: stateError } = await databaseRequest(supabase
                                    .from('campaigns').select('status').eq('id', campaignId).single());
                                if (stateError) { batchPause = {
                                    error: stateError.message || 'Campaign status could not be verified.',
                                    retryable: isRetryableInfrastructureError(stateError)
                                }; return {
                                    success: false, contactId: recipient.contact_id,
                                    error: stateError.message || 'Campaign status could not be verified.',
                                    pauseCampaign: true, retryable: isRetryableInfrastructureError(stateError)
                                }; }
                                if (current?.status !== 'sending') { batchPause = {
                                    error: 'Campaign stopped. Unsent recipients remain saved.', retryable: false
                                }; return {
                                    success: false, contactId: recipient.contact_id,
                                    error: 'Campaign stopped. Unsent recipients remain saved.',
                                    pauseCampaign: true, retryable: false
                                }; }
                                if (Date.now() - startTime + DATABASE_REQUEST_TIMEOUT_MS >= MAX_PROCESSING_TIME) throw sendError;
                            }
                        }
                    }

                } catch (error) {
                    if (error instanceof CampaignDeliveryInterruptedError) {
                        const currentPause = getBatchPause();
                        batchPause = currentPause && !currentPause.yielded ? currentPause : error.interruption;
                        return { success: false, contactId: recipient.contact_id, pauseCampaign: true, ...batchPause };
                    }
                    deliveryError = (error as Error).message;
                    pauseCampaign = shouldPauseCampaignForSendError(error);
                    if (pauseCampaign) batchPause = { error: deliveryError || 'Delivery temporarily unavailable.', retryable: isRetryableSendError(error) };
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
            };

            const batchResults = await mapConcurrentSettled(batch, MAX_SEND_BATCH_SIZE, deliverRecipient, async result => {
                if (result.status !== 'fulfilled' || result.value.pauseCampaign || saveFailed) return;
                checkpointResults.push({ contact_id: result.value.contactId, success: result.value.success,
                    error_message: result.value.success ? null : result.value.error || 'Unknown delivery error' });
                // Slow Pages also need durable progress and a timely Stop
                // check; waiting for 50 receipts can take several minutes.
                if (checkpointResults.length < 50 && Date.now() - lastCheckpointAt < 5000) return;
                const receipts = checkpointResults.splice(0, 50);
                lastCheckpointAt = Date.now();
                saveChain = saveChain.then(async () => {
                    if (saveFailed) return;
                    try {
                        await finishCampaignRecipientBatch({ supabase, campaignId, claimToken: batch[0].claim_token, results: receipts });
                        for (const receipt of receipts) checkpointed.add(receipt.contact_id);
                        // Check Stop while refilling a large claim instead of
                        // waiting for every slow recipient in the claim.
                        const { data: current, error } = await databaseRequest(supabase.from('campaigns')
                            .select('status').eq('id', campaignId).single());
                        if (error) { batchPause = { error: error.message, retryable: isRetryableInfrastructureError(error) }; }
                        else if (current?.status !== 'sending') batchPause = { error: 'Campaign stopped. Unsent recipients remain saved.', retryable: false };
                        // Small time-based checkpoints already save receipts
                        // and check Stop. Avoid a third database round trip on
                        // each one while the Page is sending slowly.
                        if (receipts.length === 50 || adaptive!.limited || Date.now() - lastFeedbackAt >= 30_000) {
                            await persistFeedback();
                        }
                    } catch (error) {
                        saveError = error; saveFailed = true;
                        batchPause = { error: 'Saving delivery progress is temporarily unavailable.', retryable: true };
                    }
                });
                await saveChain;
            });
            await saveChain;
            // A checkpoint also writes feedback and checks Stop. If either
            // fails, drain and persist accepted in-flight sends before exiting.
            const completionResults = batchResults.flatMap((result, index) => {
                if (result.status === 'fulfilled') {
                    if (result.value.pauseCampaign || checkpointed.has(result.value.contactId)) return [];
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
                            retryable: result.value.retryable,
                            yielded: result.value.yielded === true
                        }]
                        : [];
                }
                return shouldPauseCampaignForSendError(result.reason)
                    ? [{
                        contactId: batch[index].contact_id,
                        error: result.reason instanceof Error ? result.reason.message : 'Recoverable send failure',
                        retryable: isRetryableSendError(result.reason),
                        yielded: false
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

            // Persist delivery results before optional attribution. An unavailable
            // audit table must not leave accepted sends eligible for replay.
            pendingOutboundEvents.push(...outboundEvents);
            if (saveFailed) throw saveError;
            if (pendingOutboundEvents.length >= OUTBOUND_AUDIT_BATCH_SIZE) await flushOutboundEvents();

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
            processedThisRun += completionResults.length + checkpointed.size;
            estimatedRecipientDurationMs = Math.ceil((Date.now() - batchStartedAt) /
                Math.max(1, completionResults.length + checkpointed.size));

            if (pausedResults.length > 0) {
                // A normal invocation deadline is a handoff, not a service
                // failure. Released recipients can continue in the next slice
                // immediately, without an artificial one-minute error backoff.
                if (pausedResults.every(result => result.yielded)) break;
                const progress = await getCampaignDeliveryProgress(supabase, campaignId);
                const shouldRetryAutomatically = pausedResults.every(result => result.retryable);
                const pausedStatus = shouldRetryAutomatically
                    ? (allowScheduled ? 'scheduled' : 'sending')
                    : 'draft';
                let nextAttemptAt = shouldRetryAutomatically
                    ? new Date(pageRateLimited && adaptive?.retryAt ? adaptive.retryAt
                        : Date.now() + (pageRateLimited ? RATE_LIMIT_RETRY_DELAY_MS : TRANSIENT_RETRY_DELAY_MS)).toISOString()
                    : null;
                if (pageRateLimited && pageLease) {
                    await persistFeedback();
                    const recovery = await releasePageDelivery(supabase, pageLease.pageId, pageLease.owner, true);
                    pageLease = null;
                    if (recovery) nextAttemptAt = recovery;
                }
                const updated = await updateCampaignState(supabase, campaignId, {
                    status: pausedStatus,
                    background_delivery_enabled: shouldRetryAutomatically
                        ? !dueAt && !campaign.is_loop
                        : false,
                    next_attempt_at: nextAttemptAt,
                    last_error: pausedResults[0].error,
                    updated_at: new Date().toISOString()
                }, 'sending');
                if (!updated) return await resolveStateConflict();

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
                        nextAttemptAt,
                        message:
                            `Campaign paused before more recipients were consumed. ${reason} ` +
                            (shouldRetryAutomatically
                                ? 'The background worker will retry after the Page recovery window.'
                                : 'Fix the page/template issue, then press Send to resume.')
                    },
                    success: false,
                    sent: progress.sent,
                    failed: progress.failed
                };
            }

            sendBatchSizeThisRun = adaptive.concurrency;

            if (processedThisRun < MAX_RECIPIENTS && DELAY_BETWEEN_BATCHES > 0 &&
                Date.now() - startTime + DELAY_BETWEEN_BATCHES + estimatedRecipientDurationMs + DATABASE_REQUEST_TIMEOUT_MS < MAX_PROCESSING_TIME) {
                await waitForPageDeliveryBatch(DELAY_BETWEEN_BATCHES);
            }
        }

        const [finalState, progress] = await Promise.all([databaseRequest(supabase
            .from('campaigns')
            .select('status')
            .eq('id', campaignId)
            .single()), getCampaignDeliveryProgress(supabase, campaignId)]);
        const { data: finalStatus, error: finalStatusError } = finalState;
        if (finalStatusError) throw finalStatusError;

        if (finalStatus?.status === 'sending') {
            const updated = await updateCampaignState(supabase, campaignId, {
                status: progress.remaining > 0 ? (dueAt ? 'scheduled' : 'sending') : 'completed',
                completed_at: progress.remaining > 0 ? null : new Date().toISOString(),
                updated_at: new Date().toISOString()
            }, 'sending');
            if (!updated) return await resolveStateConflict();

            if (progress.remaining > 0) {
                if (processedThisRun > 0 && !campaign.is_loop) continuePageId = campaign.page_id;
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
        } else if (finalStatus?.status === 'draft') {
            return {
                status: 200,
                body: {
                    success: true,
                    partial: progress.remaining > 0,
                    paused: true,
                    sent: progress.sent,
                    failed: progress.failed,
                    remaining: progress.remaining,
                    message: 'Campaign stopped. Unsent recipients remain queued and can be continued later.'
                },
                success: true,
                sent: progress.sent,
                failed: progress.failed
            };
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
        if (categorizeSendError(error) === 'rate_limited') {
            pageRateLimited = true;
            const meta = error as MetaDeliveryFeedback & { code?: number };
            if (pageLease && !adaptive) adaptive = new AdaptiveDeliveryController(MAX_PAGE_DELIVERY_CONCURRENCY, pageLease.batchSize, 100);
            adaptive?.pause(meta.retryAfterMs || RATE_LIMIT_RETRY_DELAY_MS,
                getMetaThrottleScope(meta), Boolean(meta.retryAfterMs), getMetaThrottleKey(meta));
        }
        console.error('Error sending campaign:', error);
        const databaseError = error && typeof error === 'object' ? error as { code?: string; message?: string } : {};
        const shouldRetryAutomatically = isRetryableInfrastructureError(error);
        const retryAt = shouldRetryAutomatically
            ? new Date(pageRateLimited && adaptive?.retryAt ? adaptive.retryAt
                : Date.now() + (pageRateLimited ? RATE_LIMIT_RETRY_DELAY_MS : TRANSIENT_RETRY_DELAY_MS)).toISOString()
            : null;
        let queued = shouldRetryAutomatically && continuationSaved;

        // Claims expire automatically. Re-arm the campaign so a later request
        // can safely resume without resetting or duplicating completed rows.
        if (campaignAuthorized && recoveryStatus) {
            try {
                const updated = await updateCampaignState(supabase, campaignId, {
                    status: shouldRetryAutomatically
                        ? (allowScheduled ? 'scheduled' : 'sending')
                        : 'draft',
                    background_delivery_enabled: shouldRetryAutomatically
                        ? !dueAt && !isLoopCampaign
                        : false,
                    next_attempt_at: retryAt,
                    last_error: databaseError.message || String(error),
                    updated_at: new Date().toISOString()
                }, recoveryStatus);
                if (!updated && stoppedResult) return await resolveStateConflict();
                queued = shouldRetryAutomatically;
                console.log(`Campaign ${campaignId} re-armed after sender error`);
            } catch (resetError) {
                console.error(`❌ Failed to reset campaign ${campaignId} status:`, resetError);
            }
        }

        return {
            status: shouldRetryAutomatically ? 503 : 500,
            body: {
                error: shouldRetryAutomatically ? 'Delivery temporarily unavailable' : 'Failed to send campaign',
                message: queued
                    ? 'Delivery is temporarily unavailable. The campaign remains queued and the background worker will retry automatically.'
                    : shouldRetryAutomatically ? 'Delivery is temporarily unavailable. Retry to start or resume the campaign.'
                    : databaseError.message || 'Campaign delivery needs attention.',
                retryable: shouldRetryAutomatically,
                queued,
                paused: queued,
                nextAttemptAt: queued ? retryAt : null
            }
        };
    } finally {
        try { await flushOutboundEvents(true); }
        catch (auditError) { console.error('Optional campaign attribution could not be flushed:', auditError); }
        if (pageLease) {
            if (adaptive?.limited) pageRateLimited = true;
            try { await persistFeedback(); }
            catch (feedbackError) { console.error('Page delivery feedback could not be saved:', feedbackError); }
            try { await releasePageDelivery(supabase, pageLease.pageId, pageLease.owner, pageRateLimited); }
            catch (releaseError) { console.error('Page delivery lease release failed; the lease will expire:', releaseError); }
        }
        if (continuePageId && !pageRateLimited) {
            try { await requestCampaignDeliveryContinuation(supabase, continuePageId); }
            catch { console.warn('Campaign handoff could not be queued; the regular scheduler will retry.'); }
        }
    }
}
