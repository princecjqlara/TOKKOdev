import { FacebookPage, FacebookConversation } from '@/types';

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v18.0';

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

// Split a long message into chunks for Facebook's 2000 character limit
function splitMessage(text: string, maxLength: number = 1900): string[] {
    if (text.length <= maxLength) {
        return [text];
    }

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= maxLength) {
            chunks.push(remaining);
            break;
        }

        // Find a good break point (sentence end, newline, or space)
        let breakPoint = maxLength;

        // Try to break at sentence end
        const sentenceEnd = remaining.lastIndexOf('. ', maxLength);
        if (sentenceEnd > maxLength / 2) {
            breakPoint = sentenceEnd + 1;
        } else {
            // Try to break at newline
            const newlineEnd = remaining.lastIndexOf('\n', maxLength);
            if (newlineEnd > maxLength / 2) {
                breakPoint = newlineEnd + 1;
            } else {
                // Break at last space
                const spaceEnd = remaining.lastIndexOf(' ', maxLength);
                if (spaceEnd > maxLength / 2) {
                    breakPoint = spaceEnd + 1;
                }
            }
        }

        chunks.push(remaining.substring(0, breakPoint).trim());
        remaining = remaining.substring(breakPoint).trim();
    }

    return chunks;
}

// Send message to a contact (with automatic message splitting for long messages)
export async function sendMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    messageText: string
): Promise<{ message_id: string }> {
    // Split message if too long for Facebook (2000 char limit)
    const chunks = splitMessage(messageText, 1900);

    let lastResult: { message_id: string } = { message_id: '' };

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        // Add small delay between chunks to maintain order
        if (i > 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        // Facebook Messenger API endpoint - use /me/messages with page access token
        const response = await fetch(
            `${FACEBOOK_GRAPH_URL}/me/messages?access_token=${pageAccessToken}`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    recipient: { id: recipientPsid },
                    message: { text: chunk },
                    messaging_type: 'MESSAGE_TAG',
                    tag: 'ACCOUNT_UPDATE'
                })
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
                fullError: errorData,
                chunk: i + 1,
                totalChunks: chunks.length
            });
            throw new Error(errorMessage);
        }

        lastResult = await response.json();

        if (chunks.length > 1) {
            console.log(`✅ Message chunk ${i + 1}/${chunks.length} sent:`, {
                pageId,
                recipientPsid,
                messageId: lastResult.message_id,
                chunkLength: chunk.length
            });
        }
    }

    if (chunks.length === 1) {
        console.log('✅ Message sent successfully:', {
            pageId,
            recipientPsid,
            messageId: lastResult.message_id
        });
    } else {
        console.log(`✅ All ${chunks.length} message chunks sent successfully`);
    }

    return lastResult;
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
