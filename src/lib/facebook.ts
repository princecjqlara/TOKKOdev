import { FacebookPage, FacebookConversation } from '@/types';

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v18.0';

// Get user's Facebook pages
export async function getFacebookPages(userAccessToken: string): Promise<FacebookPage[]> {
    const response = await fetch(
        `${FACEBOOK_GRAPH_URL}/me/accounts?fields=id,name,access_token,category,picture&access_token=${userAccessToken}`
    );

    if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error?.message || 'Failed to fetch Facebook pages');
    }

    const data = await response.json();
    return data.data || [];
}

// Get ALL conversations for a page (handles pagination)
export async function getPageConversations(
    pageId: string,
    pageAccessToken: string,
    limit: number = 100,
    fetchAll: boolean = true // Set to true to fetch ALL conversations
): Promise<FacebookConversation[]> {
    const allConversations: FacebookConversation[] = [];
    let nextUrl: string | null = `${FACEBOOK_GRAPH_URL}/${pageId}/conversations?fields=id,participants,updated_time&limit=${limit}&access_token=${pageAccessToken}`;

    while (nextUrl) {
        const res: Response = await fetch(nextUrl);

        if (!res.ok) {
            const error = await res.json();
            throw new Error(error.error?.message || 'Failed to fetch conversations');
        }

        const responseData: { data?: FacebookConversation[]; paging?: { next?: string } } = await res.json();
        allConversations.push(...(responseData.data || []));

        // Check if we should continue pagination
        if (fetchAll && responseData.paging?.next) {
            nextUrl = responseData.paging.next;
        } else {
            nextUrl = null;
        }

        // Safety limit to prevent infinite loops (max 10000 conversations)
        if (allConversations.length >= 10000) {
            console.warn('Hit conversation limit of 10000');
            break;
        }
    }

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

// Send message to a contact
export async function sendMessage(
    pageId: string,
    pageAccessToken: string,
    recipientPsid: string,
    messageText: string
): Promise<{ message_id: string }> {
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
                message: { text: messageText },
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
