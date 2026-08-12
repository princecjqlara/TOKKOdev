import { FacebookPage, FacebookConversation } from '@/types';
import { FACEBOOK_REAUTH_MESSAGE } from './facebook-permissions';
import { isFacebookReauthMessage } from './facebook-errors';
import type { TemplateMediaType } from './facebook-templates';
import { getUtilityTemplateParameterValidationError } from './send-errors';

// Re-export templates from dedicated file
export { UTILITY_TEMPLATES } from './facebook-templates';

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';

type FacebookGraphErrorBody = {
    error?: {
        message?: string;
        type?: string;
        code?: number;
        error_subcode?: number;
        error_user_msg?: string;
        error_data?: {
            details?: string;
        };
    };
};

export class FacebookGraphApiError extends Error {
    status: number;
    code?: number;
    subcode?: number;
    type?: string;
    requiresReauth: boolean;
    raw: unknown;

    constructor(
        message: string,
        options: {
            status: number;
            code?: number;
            subcode?: number;
            type?: string;
            requiresReauth?: boolean;
            raw?: unknown;
        }
    ) {
        super(message);
        this.name = 'FacebookGraphApiError';
        this.status = options.status;
        this.code = options.code;
        this.subcode = options.subcode;
        this.type = options.type;
        this.requiresReauth = Boolean(options.requiresReauth);
        this.raw = options.raw;
    }
}

function isFacebookPageAuthorizationFailure(body: FacebookGraphErrorBody, endpoint: string) {
    const message = body.error?.message?.toLowerCase() || '';
    const code = body.error?.code;

    return (
        code === 190 ||
        isFacebookReauthMessage(message) ||
        (
            endpoint.includes('/me/accounts') &&
            message.includes('unsupported get request') &&
            message.includes('object with id') &&
            message.includes('me')
        )
    );
}

export function isFacebookReauthRequired(error: unknown) {
    if (error instanceof FacebookGraphApiError) {
        return error.requiresReauth;
    }

    const message = error instanceof Error ? error.message.toLowerCase() : String(error || '').toLowerCase();
    return isFacebookReauthMessage(message);
}

async function readFacebookError(response: Response, endpoint: string) {
    const body = await response
        .json()
        .catch(() => ({} as FacebookGraphErrorBody));
    const error = body.error;
    const message =
        error?.error_user_msg ||
        error?.message ||
        `HTTP ${response.status}: ${response.statusText || 'Facebook Graph request failed'}`;
    const requiresReauth = isFacebookPageAuthorizationFailure(body, endpoint);

    return new FacebookGraphApiError(
        requiresReauth ? FACEBOOK_REAUTH_MESSAGE : message,
        {
            status: response.status,
            code: error?.code,
            subcode: error?.error_subcode,
            type: error?.type,
            requiresReauth,
            raw: body
        }
    );
}

// Get user's Facebook pages (including business pages)
// /me/accounts returns all pages the user manages, including business pages
export async function getFacebookPages(userAccessToken: string): Promise<FacebookPage[]> {
    try {
        const pagesUrl = new URL(`${FACEBOOK_GRAPH_URL}/me/accounts`);
        pagesUrl.searchParams.set('fields', 'id,name,access_token,category,picture,tasks');
        pagesUrl.searchParams.set('limit', '100');
        pagesUrl.searchParams.set('access_token', userAccessToken);

        // Fetch all pages - this includes regular pages and business pages the user manages
        const response = await fetch(pagesUrl);

        if (!response.ok) {
            throw await readFacebookError(response, '/me/accounts');
        }

        const data = await response.json();
        const pages = data.data || [];

        // Handle pagination if there are more than 100 pages
        let nextUrl = data.paging?.next;
        while (nextUrl) {
            try {
                const nextResponse = await fetch(nextUrl);
                if (nextResponse.ok) {
                    const nextData = await nextResponse.json();
                    if (nextData.data) {
                        pages.push(...nextData.data);
                    }
                    nextUrl = nextData.paging?.next;
                } else {
                    break;
                }
            } catch (paginationError) {
                console.warn('Error fetching paginated pages:', paginationError);
                break;
            }
        }

        console.log(`Fetched ${pages.length} Facebook pages (including business pages if available)`);
        return pages;
    } catch (error) {
        console.error('Error fetching Facebook pages:', error);
        throw error;
    }
}

// Get conversations for a page (handles pagination)
// If sinceTimestamp is provided, only fetches conversations updated after that time
export async function getPageConversations(
    pageId: string,
    pageAccessToken: string,
    limit: number = 100,
    fetchAll: boolean = true, // Set to true to fetch ALL conversations
    sinceTimestamp?: string // ISO timestamp - only fetch conversations updated after this
): Promise<FacebookConversation[]> {
    const allConversations: FacebookConversation[] = [];

    // Build initial URL with optional since parameter
    let baseUrl = `${FACEBOOK_GRAPH_URL}/${pageId}/conversations?fields=id,participants,updated_time&limit=${limit}&access_token=${pageAccessToken}`;

    // Add since parameter if provided (Facebook uses Unix timestamp)
    if (sinceTimestamp) {
        const sinceDate = new Date(sinceTimestamp);
        const unixTimestamp = Math.floor(sinceDate.getTime() / 1000);
        baseUrl += `&since=${unixTimestamp}`;
    }

    let nextUrl: string | null = baseUrl;
    const seenPageUrls = new Set<string>();

    let pageCount = 0;
    while (nextUrl) {
        if (seenPageUrls.has(nextUrl)) {
            console.warn('Facebook conversation pagination returned a repeated page URL; stopping to avoid a loop');
            break;
        }
        seenPageUrls.add(nextUrl);

        pageCount++;
        const res: Response = await fetch(nextUrl);

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error?.message || 'Failed to fetch conversations');
        }

        const responseData: { data?: FacebookConversation[]; paging?: { next?: string } } = await res.json();
        const conversations = responseData.data || [];

        console.log(`📄 Facebook API page ${pageCount}: fetched ${conversations.length} conversations (total so far: ${allConversations.length + conversations.length})`);

        // If using since parameter, filter out conversations older than sinceTimestamp
        if (sinceTimestamp && conversations.length > 0) {
            const sinceDate = new Date(sinceTimestamp);
            const filtered = conversations.filter(conv => {
                if (!conv.updated_time) return false;
                const convDate = new Date(conv.updated_time);
                return convDate >= sinceDate;
            });
            allConversations.push(...filtered);

            console.log(`📄 After filtering by sinceTimestamp: ${filtered.length} valid conversations (${conversations.length - filtered.length} filtered out)`);

            // If we got filtered results, we might have hit old conversations - stop pagination
            if (filtered.length < conversations.length) {
                console.log(`📄 Stopping pagination: hit conversations older than sinceTimestamp`);
                break;
            }
        } else {
            allConversations.push(...conversations);
        }

        // Check if we should continue pagination
        if (fetchAll && responseData.paging?.next) {
            nextUrl = responseData.paging.next;
            console.log(`📄 Continuing pagination: ${allConversations.length} conversations fetched so far`);
        } else {
            nextUrl = null;
            console.log(`📄 Pagination complete: no more pages available`);
        }

        // Repeated page URLs are checked above; otherwise continue until Facebook
        // returns no next page.
    }

    console.log(`✅ Total conversations fetched: ${allConversations.length} across ${pageCount} pages`);

    return allConversations;
}

export type PageConversationBatch = {
    conversations: FacebookConversation[];
    nextCursor: string | null;
};

export async function getPageConversationsBatch(
    pageId: string,
    pageAccessToken: string,
    options: {
        limit?: number;
        after?: string | null;
        sinceTimestamp?: string;
    } = {}
): Promise<PageConversationBatch> {
    const limit = options.limit || 100;
    let url = `${FACEBOOK_GRAPH_URL}/${pageId}/conversations?fields=id,participants,updated_time&limit=${limit}&access_token=${pageAccessToken}`;

    if (options.after) {
        url += `&after=${encodeURIComponent(options.after)}`;
    }

    if (options.sinceTimestamp) {
        const sinceDate = new Date(options.sinceTimestamp);
        const unixTimestamp = Math.floor(sinceDate.getTime() / 1000);
        url += `&since=${unixTimestamp}`;
    }

    const response: Response = await fetch(url);

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch conversations');
    }

    const responseData: {
        data?: FacebookConversation[];
        paging?: {
            next?: string;
            cursors?: {
                after?: string;
            };
        };
    } = await response.json();

    const rawConversations = responseData.data || [];
    let conversations = rawConversations;
    let nextCursor =
        typeof responseData.paging?.cursors?.after === 'string' && responseData.paging.next
            ? responseData.paging.cursors.after
            : null;

    if (options.sinceTimestamp && rawConversations.length > 0) {
        const sinceDate = new Date(options.sinceTimestamp);
        conversations = rawConversations.filter(conv => {
            if (!conv.updated_time) return false;
            const convDate = new Date(conv.updated_time);
            return convDate >= sinceDate;
        });

        if (conversations.length < rawConversations.length) {
            nextCursor = null;
        }
    }

    return {
        conversations,
        nextCursor
    };
}

// Get user profile from PSID
export async function getUserProfile(
    psid: string,
    pageAccessToken: string
): Promise<{ id: string; name?: string; first_name?: string; last_name?: string; profile_pic?: string }> {
    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/${psid}?fields=id,name,first_name,last_name,profile_pic&access_token=${pageAccessToken}`
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch user profile');
    }

    return await response.json();
}

// Subscribe a page to this app's webhook events
export async function subscribePageToAppWebhook(
    pageId: string,
    pageAccessToken: string,
    subscribedFields: string[] = ['messages', 'messaging_postbacks']
): Promise<void> {
    const formData = new URLSearchParams();
    formData.set('access_token', pageAccessToken);

    if (subscribedFields.length > 0) {
        formData.set('subscribed_fields', subscribedFields.join(','));
    }

    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/${pageId}/subscribed_apps`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: formData.toString()
        }
    );

    const result = await response
        .json()
        .catch(() => ({} as { error?: { message?: string }; success?: boolean }));

    if (!response.ok) {
        const errorMessage =
            result.error?.message ||
            `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(errorMessage);
    }

    if (!result.success) {
        throw new Error('Facebook did not confirm webhook subscription for this page');
    }
}

// Send message to a contact
// messagingType: 
//   'RESPONSE' - within 24h window (plain text)
//   'HUMAN_AGENT' - within 7-day window (plain text with tag)
//   'UTILITY' - outside 7-day window (requires template)
const DEFAULT_UTILITY_TEMPLATE = 'account_general_notification';
const DEFAULT_UTILITY_LANGUAGE = 'en_US';
const FACEBOOK_SEND_TIMEOUT_MS = 20_000;

export async function takeThreadControl(
    pageAccessToken: string,
    recipientPsid: string,
    metadata: string = 'Tokko campaign delivery'
): Promise<void> {
    const endpoint = '/me/take_thread_control';
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FACEBOOK_SEND_TIMEOUT_MS);
    let response: Response;

    try {
        response = await fetch(
            `${FACEBOOK_GRAPH_URL}${endpoint}?access_token=${pageAccessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    recipient: { id: recipientPsid },
                    metadata
                }),
                signal: controller.signal
            }
        );
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Facebook thread-control request timed out after ${FACEBOOK_SEND_TIMEOUT_MS / 1000} seconds`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        throw await readFacebookError(response, endpoint);
    }

    const result = await response.json();
    if (result?.success !== true) {
        throw new Error('Facebook did not confirm thread control');
    }
}

export async function sendMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    messageText: string,
    messagingType: 'RESPONSE' | 'HUMAN_AGENT' | 'UTILITY' = 'HUMAN_AGENT',
    templateName?: string,
    templateLanguage: string = DEFAULT_UTILITY_LANGUAGE,
    templateBodyParameters?: string[],
    templateButtons?: Array<{ type: 'URL'; text: string; url: string } | { type: 'POSTBACK'; text: string; payload: string }>,
    templateMediaHeader?: { type: TemplateMediaType; url: string }
): Promise<{ message_id: string }> {
    // Build the request payload based on messaging type
    let bodyPayload: Record<string, unknown>;

    const responseButtons = messagingType === 'RESPONSE' && Array.isArray(templateButtons)
        ? templateButtons
            .map((button) => {
                const title = typeof button.text === 'string' ? button.text.trim() : '';
                if (!title) return null;

                if (button.type === 'URL') {
                    const url = typeof button.url === 'string' ? button.url.trim() : '';
                    if (!url) return null;

                    return {
                        type: 'web_url' as const,
                        title,
                        url
                    };
                }

                const payload = typeof button.payload === 'string' && button.payload.trim().length > 0
                    ? button.payload.trim()
                    : title;

                return {
                    type: 'postback' as const,
                    title,
                    payload
                };
            })
            .filter((button): button is { type: 'web_url'; title: string; url: string } | { type: 'postback'; title: string; payload: string } => button !== null)
            .slice(0, 3)
        : [];

    if (messagingType === 'UTILITY') {
        const invalidParameter = (templateBodyParameters || [messageText])
            .map(getUtilityTemplateParameterValidationError)
            .find((validationError): validationError is string => Boolean(validationError));
        if (invalidParameter) {
            throw new Error(invalidParameter);
        }

        // Utility message with template - no time window restrictions
        const template = templateName || DEFAULT_UTILITY_TEMPLATE;
        const templatePayload: Record<string, unknown> = {
            name: template,
            language: { code: templateLanguage }
        };
        const components: Array<Record<string, unknown>> = [];

        if (templateMediaHeader) {
        components.push({
            type: 'header',
            parameters: [
                {
                    type: templateMediaHeader.type,
                    url: templateMediaHeader.url
                }
            ]
        });
        }

        if (Array.isArray(templateBodyParameters) && templateBodyParameters.length > 0) {
            // Use explicitly provided body parameters (string array)
            components.push({
                type: 'body',
                parameters: templateBodyParameters.map((text) => ({
                    type: 'text',
                    text
                }))
            });
        } else if (!Array.isArray(templateBodyParameters)) {
            // Fallback: use messageText as single parameter (only when no explicit params provided)
            components.push({
                type: 'body',
                parameters: [
                    { type: 'text', text: messageText }
                ]
            });
        }
        // When templateBodyParameters is an empty array, omit components entirely
        // (template has no variable parameters)
        if (components.length > 0) {
            templatePayload.components = components;
        }

        bodyPayload = {
            recipient: { id: recipientPsid },
            messaging_type: 'UTILITY',
            message: {
                template: templatePayload
            }
        };
    } else if (messagingType === 'HUMAN_AGENT') {
        // HUMAN_AGENT tag - allows messaging within 7-day window
        bodyPayload = {
            recipient: { id: recipientPsid },
            messaging_type: 'MESSAGE_TAG',
            tag: 'HUMAN_AGENT',
            message: { text: messageText }
        };
    } else {
        // RESPONSE - standard messaging within 24-hour window
        if (responseButtons.length > 0) {
            bodyPayload = {
                recipient: { id: recipientPsid },
                messaging_type: 'RESPONSE',
                message: {
                    attachment: {
                        type: 'template',
                        payload: {
                            template_type: 'button',
                            text: messageText,
                            buttons: responseButtons
                        }
                    }
                }
            };
        } else {
            bodyPayload = {
                recipient: { id: recipientPsid },
                messaging_type: 'RESPONSE',
                message: { text: messageText }
            };
        }
    }

    // Facebook Messenger API endpoint - use /me/messages with page access token.
    // A stalled upstream request must not consume the entire campaign function
    // lifetime and prevent its completed recipient statuses from being saved.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FACEBOOK_SEND_TIMEOUT_MS);
    let response: Response;

    try {
        response = await fetch(
            `${FACEBOOK_GRAPH_URL}/me/messages?access_token=${pageAccessToken}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(bodyPayload),
                signal: controller.signal
            }
        );
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`Facebook send timed out after ${FACEBOOK_SEND_TIMEOUT_MS / 1000} seconds`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        const facebookError = await readFacebookError(response, '/me/messages');
        console.error('🔴 Facebook send message error:', {
            pageId,
            recipientPsid,
            status: response.status,
            error: facebookError.message,
            code: facebookError.code,
            subcode: facebookError.subcode
        });
        throw facebookError;
    }

    const result = await response.json();
    console.log('✅ Message sent successfully:', {
        pageId,
        recipientPsid,
        messageId: result.message_id
    });
    return result;
}

export async function sendMessengerMediaAttachment(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    media: { type: TemplateMediaType; url: string },
    messagingType: 'RESPONSE' | 'HUMAN_AGENT' = 'RESPONSE'
): Promise<{ message_id: string; attachment_id?: string }> {
    const bodyPayload: Record<string, unknown> = {
        recipient: { id: recipientPsid },
        message: {
            attachment: {
                type: media.type,
                payload: {
                    url: media.url,
                    is_reusable: true
                }
            }
        }
    };

    if (messagingType === 'HUMAN_AGENT') {
        bodyPayload.messaging_type = 'MESSAGE_TAG';
        bodyPayload.tag = 'HUMAN_AGENT';
    } else {
        bodyPayload.messaging_type = 'RESPONSE';
    }

    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/me/messages?access_token=${pageAccessToken}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(bodyPayload)
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        console.error('🔴 Facebook send media attachment error:', {
            pageId,
            recipientPsid,
            status: response.status,
            error: errorMessage,
            fullError: errorData
        });
        throw new Error(errorMessage);
    }

    return await response.json();
}

// Message type for conversation history
export interface ConversationMessage {
    id: string;
    message: string;
    from: {
        id: string;
        name?: string;
    };
    created_time: string;
}

// Get conversation messages for AI context - fetches ALL messages using pagination
export async function getConversationMessages(
    conversationId: string,
    pageAccessToken: string,
    maxMessages: number = 500 // Safety limit to prevent infinite loops
): Promise<ConversationMessage[]> {
    const allMessages: ConversationMessage[] = [];
    let nextUrl: string | null = `${FACEBOOK_GRAPH_URL}/${conversationId}/messages?fields=id,message,from,created_time&limit=100&access_token=${pageAccessToken}`;

    try {
        while (nextUrl && allMessages.length < maxMessages) {
            const fetchResponse = await fetch(nextUrl);

            if (!fetchResponse.ok) {
                const errorData = await fetchResponse.json().catch(() => ({}));
                console.warn('⚠️ Failed to fetch conversation messages:', errorData);
                break;
            }

            const responseData: { data?: ConversationMessage[]; paging?: { next?: string } } = await fetchResponse.json();
            const messages = responseData.data || [];
            allMessages.push(...messages);

            // Check for next page
            nextUrl = responseData.paging?.next || null;

            // If we got fewer messages than the limit, we've reached the end
            if (messages.length < 100) {
                break;
            }
        }

        console.log(`📨 Fetched ${allMessages.length} total messages for conversation ${conversationId}`);
        return allMessages;
    } catch (error) {
        console.warn('⚠️ Error fetching conversation messages:', error);
        return allMessages; // Return what we have so far
    }
}

// Get conversation ID for a contact (PSID)
export async function getConversationIdForPsid(
    pageId: string,
    psid: string,
    pageAccessToken: string
): Promise<string | null> {
    try {
        // Construct the conversation ID format used by Facebook
        // Format: t_<psid> for messenger conversations
        const response = await fetch(
            `${FACEBOOK_GRAPH_URL}/${pageId}/conversations?user_id=${psid}&fields=id&access_token=${pageAccessToken}`
        );

        if (!response.ok) {
            console.warn('⚠️ Failed to find conversation for PSID:', psid);
            return null;
        }

        const data = await response.json();
        if (data.data && data.data.length > 0) {
            return data.data[0].id;
        }
        return null;
    } catch (error) {
        console.warn('⚠️ Error finding conversation ID:', error);
        return null;
    }
}

// Generate verify token from app secret and app id
export function generateVerifyToken(appSecret: string, appId: string): string {
    const crypto = require('crypto');
    return crypto
        .createHash('sha256')
        .update(`${appSecret}:${appId}`)
        .digest('hex')
        .substring(0, 32); // Use first 32 chars for simplicity
}

// Verify webhook signature
export function verifyWebhookSignature(
    payload: string,
    signature: string,
    appSecret: string
): boolean {
    if (!payload || !signature || !appSecret) return false;

    const crypto = require('crypto');
    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(payload)
        .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return false;

    return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

// Utility message template types
export interface UtilityTemplate {
    name: string;
    language: string;
    category: string;
    components: TemplateComponent[];
}

export interface TemplateComponent {
    type: 'BODY' | 'HEADER' | 'BUTTONS';
    text?: string;
    format?: 'TEXT' | 'IMAGE' | 'VIDEO';
    example?: {
        body_text?: string[][];
        header_text?: string[];
        header_handle?: string[];
    };
    buttons?: TemplateButton[];
}

export interface TemplateButton {
    type: 'URL' | 'POSTBACK';
    text: string;
    url?: string;
    payload?: string;
    example?: {
        url_suffix_example?: string;
    };
}

// Create utility message template
export async function createUtilityTemplate(
    pageId: string,
    pageAccessToken: string,
    template: UtilityTemplate
): Promise<{ id: string; status: string; category: string }> {
    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/${pageId}/message_templates?access_token=${pageAccessToken}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(template)
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        const errorCode = errorData.error?.code;
        const errorSubcode = errorData.error?.error_subcode;
        const errorDetails =
            errorData.error?.error_data?.details ||
            errorData.error?.error_user_msg ||
            null;
        const diagnosticParts = [
            errorMessage,
            typeof errorCode !== 'undefined' ? `code=${errorCode}` : null,
            typeof errorSubcode !== 'undefined' ? `subcode=${errorSubcode}` : null,
            errorDetails ? `details=${errorDetails}` : null
        ].filter(Boolean);
        const diagnosticMessage = diagnosticParts.join(' | ');

        console.error('🔴 Facebook create template error:', {
            pageId,
            templateName: template.name,
            status: response.status,
            error: diagnosticMessage,
            fullError: errorData
        });
        throw new Error(diagnosticMessage);
    }

    const result = await response.json();
    console.log('✅ Template created successfully:', {
        pageId,
        templateName: template.name,
        templateId: result.id,
        status: result.status
    });
    return result;
}

// Get page's existing templates
export async function getPageTemplates(
    pageId: string,
    pageAccessToken: string
): Promise<any[]> {
    const allTemplates: any[] = [];
    let nextUrl: string | null =
        `${FACEBOOK_GRAPH_URL}/${pageId}/message_templates` +
        `?fields=id,name,language,status,category,components` +
        `&limit=100&access_token=${pageAccessToken}`;

    while (nextUrl) {
        const response: Response = await fetch(nextUrl);

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
            const errorMessage = errorData.error?.message || 'Failed to fetch templates';
            const errorCode = errorData.error?.code;
            const errorSubcode = errorData.error?.error_subcode;
            const errorDetails =
                errorData.error?.error_data?.details ||
                errorData.error?.error_user_msg ||
                null;
            const diagnosticParts = [
                errorMessage,
                typeof errorCode !== 'undefined' ? `code=${errorCode}` : null,
                typeof errorSubcode !== 'undefined' ? `subcode=${errorSubcode}` : null,
                errorDetails ? `details=${errorDetails}` : null
            ].filter(Boolean);
            throw new Error(diagnosticParts.join(' | '));
        }

        const data: { data?: any[]; paging?: { next?: string } } = await response.json();
        allTemplates.push(...(data.data || []));
        nextUrl = data.paging?.next || null;

        if (allTemplates.length >= 1000) {
            console.warn(`⚠️ Template fetch reached safety limit: ${allTemplates.length}`);
            break;
        }
    }

    return allTemplates;
}

// Send utility message using template (supports multiple body parameters for {{1}}/{{2}} format)
export async function sendUtilityMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    templateName: string,
    languageCode: string,
    bodyTexts: string | string[],
    mediaHeader?: { type: TemplateMediaType; url: string }
): Promise<{ message_id: string; recipient_id: string }> {
    const textsArray = Array.isArray(bodyTexts) ? bodyTexts : [bodyTexts];
    const invalidParameter = textsArray
        .map(getUtilityTemplateParameterValidationError)
        .find((validationError): validationError is string => Boolean(validationError));
    if (invalidParameter) {
        throw new Error(invalidParameter);
    }
    const parameters = textsArray.map((text) => ({ type: 'text' as const, text }));
    const components: Array<Record<string, unknown>> = [];

    if (mediaHeader) {
        components.push({
            type: 'header',
            parameters: [
                {
                    type: mediaHeader.type,
                    url: mediaHeader.url
                }
            ]
        });
    }

    if (parameters.length > 0) {
        components.push({
            type: 'body',
            parameters
        });
    }

    const templatePayload: Record<string, unknown> = {
        name: templateName,
        language: { code: languageCode }
    };

    if (components.length > 0) {
        templatePayload.components = components;
    }

    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/${pageId}/messages?access_token=${pageAccessToken}`,
        {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                recipient: { id: recipientPsid },
                messaging_type: 'UTILITY',
                message: {
                    template: templatePayload
                }
            })
        }
    );

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: { message: 'Unknown error' } }));
        const errorMessage = errorData.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        console.error('🔴 Facebook send utility message error:', {
            pageId,
            recipientPsid,
            templateName,
            status: response.status,
            error: errorMessage,
            fullError: errorData
        });
        throw new Error(errorMessage);
    }

    const result = await response.json();
    console.log('✅ Utility message sent successfully:', {
        pageId,
        recipientPsid,
        templateName,
        messageId: result.message_id
    });
    return result;
}
