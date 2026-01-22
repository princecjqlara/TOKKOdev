// NVIDIA AI Message Generation Utility with Conversation Analysis
import { ConversationMessage } from './facebook';

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * Format conversation history for AI context
 */
function formatConversationHistory(
    messages: ConversationMessage[],
    pageId: string,
    contactName: string
): string {
    if (!messages || messages.length === 0) {
        return 'No previous conversation history available.';
    }

    // Messages come in reverse order (newest first), so reverse to get chronological
    const chronological = [...messages].reverse();

    const formatted = chronological.map(msg => {
        const sender = msg.from.id === pageId ? 'Business' : contactName;
        const text = msg.message || '[No text]';
        return `${sender}: ${text}`;
    }).join('\n');

    return formatted;
}

/**
 * Generate a personalized message for a contact using NVIDIA AI
 * Analyzes conversation history to create contextual, relevant messages
 * @param prompt User's custom prompt for message style/construction
 * @param contactName Contact's first name to personalize the message
 * @param conversationHistory Previous messages for context analysis
 * @param pageId Page ID to identify which messages are from the business
 * @returns Generated personalized message
 */
export async function generatePersonalizedMessage(
    prompt: string,
    contactName: string,
    conversationHistory: ConversationMessage[] = [],
    pageId: string = ''
): Promise<string> {
    const apiKey = process.env.NVIDIA_API_KEY;

    if (!apiKey) {
        console.error('❌ NVIDIA_API_KEY not configured');
        throw new Error('NVIDIA API key not configured');
    }

    // Extract first name from full name
    const firstName = contactName?.split(' ')[0] || 'there';

    // Format conversation for AI context
    const conversationContext = formatConversationHistory(conversationHistory, pageId, firstName);
    const hasHistory = conversationHistory.length > 0;

    const systemPrompt = `You are a helpful assistant that analyzes conversations and writes personalized follow-up messages for a business.

Your task:
1. ANALYZE the conversation history to understand:
   - What the contact is interested in
   - Any questions they've asked
   - The tone and style of the conversation
   - What stage of the relationship they're in (new lead, ongoing discussion, etc.)
   - Any specific topics or concerns mentioned

2. CREATE a follow-up message that:
   - Is relevant to the conversation context
   - Feels natural and continues the discussion
   - Is concise (under 160 characters if possible)
   - Uses a warm, conversational tone matching the previous exchanges
   - Addresses the contact by their first name naturally
   - Does NOT repeat information already discussed
   - Does NOT include formal greetings like "Dear" or formal closings

The user's prompt describes the MESSAGE STYLE and PURPOSE - use it to guide the type of message (friendly check-in, sale reminder, etc.) while making it contextual to the conversation.`;

    const userPrompt = hasHistory
        ? `Contact Name: ${firstName}

CONVERSATION HISTORY:
${conversationContext}

MESSAGE STYLE/PURPOSE FROM BUSINESS:
${prompt}

Based on the conversation history above, write a contextual follow-up message for ${firstName}. The message should:
- Reference or continue naturally from the conversation
- Match the specified style/purpose
- Feel like a genuine continuation, not a generic message
- Be personalized based on what you learned about ${firstName} from the conversation`
        : `Contact Name: ${firstName}

No previous conversation history is available.

MESSAGE STYLE/PURPOSE FROM BUSINESS:
${prompt}

Write a friendly introductory message for ${firstName} based on the style/purpose above. Since there's no conversation history, keep it warm but general.`;

    try {
        const response = await fetch(NVIDIA_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'meta/llama-3.1-8b-instruct',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 200,
                temperature: 0.7,
                top_p: 0.9
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('❌ NVIDIA API error:', {
                status: response.status,
                error: errorData
            });
            throw new Error(`NVIDIA API error: ${response.status}`);
        }

        const data = await response.json();
        const generatedMessage = data.choices?.[0]?.message?.content?.trim();

        if (!generatedMessage) {
            throw new Error('No message generated from NVIDIA API');
        }

        console.log('✅ AI generated contextual message for', firstName, ':', generatedMessage.substring(0, 50) + '...');
        return generatedMessage;
    } catch (error) {
        console.error('❌ Error generating AI message:', error);
        // Fallback: Create a simple message with the contact name
        return `Hi ${firstName}! ${prompt}`;
    }
}

/**
 * Test the NVIDIA API connection
 */
export async function testNvidiaConnection(): Promise<boolean> {
    try {
        const result = await generatePersonalizedMessage('Just checking in!', 'Test', [], '');
        return !!result;
    } catch {
        return false;
    }
}
