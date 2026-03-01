import { FacebookPage, FacebookConversation } from '@/types';

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';

// Get user's Facebook pages (including business pages)
// /me/accounts returns all pages the user manages, including business pages
export async function getFacebookPages(userAccessToken: string): Promise<FacebookPage[]> {
    try {
        // Fetch all pages - this includes regular pages and business pages the user manages
        const response = await fetch(
            `${FACEBOOK_GRAPH_URL}/me/accounts?fields=id,name,access_token,category,picture,tasks&limit=100&access_token=${userAccessToken}`
        );

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error?.message || 'Failed to fetch Facebook pages');
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

    let pageCount = 0;
    while (nextUrl) {
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

        // Safety limit to prevent infinite loops (max 10000 conversations)
        if (allConversations.length >= 10000) {
            console.warn(`⚠️ Hit conversation limit of 10000 (stopping pagination)`);
            break;
        }
    }

    console.log(`✅ Total conversations fetched: ${allConversations.length} across ${pageCount} pages`);

    return allConversations;
}

// Get user profile from PSID
export async function getUserProfile(
    psid: string,
    pageAccessToken: string
): Promise<{ id: string; name: string; profile_pic?: string }> {
    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/${psid}?fields=id,name,profile_pic&access_token=${pageAccessToken}`
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

export async function sendMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    messageText: string,
    messagingType: 'RESPONSE' | 'HUMAN_AGENT' | 'UTILITY' = 'HUMAN_AGENT',
    templateName?: string,
    templateLanguage: string = DEFAULT_UTILITY_LANGUAGE,
    templateBodyParameters?: string[],
    templateButtons?: Array<{ type: 'URL'; text: string; url: string } | { type: 'POSTBACK'; text: string; payload: string }>
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
        // Utility message with template - no time window restrictions
        const template = templateName || DEFAULT_UTILITY_TEMPLATE;
        const templatePayload: Record<string, unknown> = {
            name: template,
            language: { code: templateLanguage }
        };

        if (Array.isArray(templateBodyParameters)) {
            if (templateBodyParameters.length > 0) {
                const components: Record<string, unknown>[] = [
                    {
                        type: 'body',
                        parameters: templateBodyParameters.map((text) => ({
                            type: 'text',
                            text
                        }))
                    }
                ];

                // Note: buttons with static URLs are defined in the template itself
                // and don't need runtime parameters in the send call.

                templatePayload.components = components;
            }
        } else {
            const components: Record<string, unknown>[] = [
                {
                    type: 'body',
                    parameters: [
                        { type: 'text', text: messageText }
                    ]
                }
            ];


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

    // Facebook Messenger API endpoint - use /me/messages with page access token
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
        console.error('🔴 Facebook send message error:', {
            pageId,
            recipientPsid,
            status: response.status,
            error: errorMessage,
            fullError: errorData
        });
        throw new Error(errorMessage);
    }

    const result = await response.json();
    console.log('✅ Message sent successfully:', {
        pageId,
        recipientPsid,
        messageId: result.message_id
    });
    return result;
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
    const crypto = require('crypto');
    const expectedSignature = 'sha256=' + crypto
        .createHmac('sha256', appSecret)
        .update(payload)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
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
    format?: 'TEXT' | 'IMAGE';
    example?: {
        body_text?: string[][];
        header_text?: string[];
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
            throw new Error(errorData.error?.message || 'Failed to fetch templates');
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

// Pre-defined utility templates for account notifications
export const UTILITY_TEMPLATES: Omit<UtilityTemplate, 'language'>[] = [
    {
        name: 'account_security_alert',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['We detected a new login to your account. If this was not you, please secure your account immediately.']]
                }
            }
        ]
    },
    {
        name: 'account_update_notification',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Your account settings have been changed successfully.']]
                }
            }
        ]
    },
    {
        name: 'account_general_notification',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Your account information has been updated.']]
                }
            }
        ]
    },
    {
        name: 'account_verification_alert',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Please verify your email address to complete your account setup.']]
                }
            }
        ]
    },
    {
        name: 'account_billing_notice',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Your billing statement is ready. Please review the details in your account.']]
                }
            }
        ]
    },
    {
        name: 'account_payment_confirmation',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Your payment was received successfully. Thank you.']]
                }
            }
        ]
    },
    {
        name: 'account_subscription_reminder',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Your subscription renews soon. Please verify your payment method.']]
                }
            }
        ]
    },
    {
        name: 'account_service_announcement',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['We have an important service update related to your account.']]
                }
            }
        ]
    },
    {
        name: 'account_action_required_notice',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['Action is required to keep your account settings up to date.']]
                }
            }
        ]
    },
    {
        name: 'account_policy_update_notice',
        category: 'UTILITY',
        components: [
            {
                type: 'BODY',
                text: '{{1}}',
                example: {
                    body_text: [['We updated account terms and policies. Please review the latest information.']]
                }
            }
        ]
    }
];

// Send utility message using template
export async function sendUtilityMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    templateName: string,
    languageCode: string,
    bodyText: string
): Promise<{ message_id: string; recipient_id: string }> {
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
                    template: {
                        name: templateName,
                        language: { code: languageCode },
                        components: [
                            {
                                type: 'body',
                                parameters: [
                                    {
                                        type: 'text',
                                        text: bodyText
                                    }
                                ]
                            }
                        ]
                    }
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
