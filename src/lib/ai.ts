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

    const systemPrompt = `You write short, personalized follow-up messages for a business.

CRITICAL RULES:
1. OUTPUT ONLY THE MESSAGE TEXT - no explanations, no reasoning, no quotes, no labels
2. Keep messages SHORT - under 300 characters, 1-3 sentences max
3. Be conversational and warm, like texting a friend
4. Use the contact's first name naturally (once, if at all)
5. NO formal greetings (Dear, Hello, Hi there) or closings (Best, Regards, Sincerely)
6. Match the casual tone of a Messenger chat

BAD OUTPUT (DO NOT DO THIS):
"Here's a message for John: Hey John! How are you?"
"Based on the conversation, I suggest: Hi John..."

GOOD OUTPUT (DO THIS):
Hey John! Just checking in - did you have any questions about the property?`;

    const userPrompt = hasHistory
        ? `Contact: ${firstName}

RECENT MESSAGES:
${conversationContext}

PURPOSE: ${prompt}

Write a short follow-up message (1-3 sentences). Output ONLY the message, nothing else.`
        : `Contact: ${firstName}

PURPOSE: ${prompt}

Write a short, friendly intro message (1-2 sentences). Output ONLY the message, nothing else.`;

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
                max_tokens: 100, // Keep messages short
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
        let generatedMessage = data.choices?.[0]?.message?.content?.trim();

        if (!generatedMessage) {
            throw new Error('No message generated from NVIDIA API');
        }

        // Clean up any reasoning/prefixes the AI might have added
        // Remove common prefixes like "Here's a message:", "Message:", etc.
        generatedMessage = generatedMessage
            .replace(/^(Here('s| is) (a |the )?message:?\s*)/i, '')
            .replace(/^(Message:?\s*)/i, '')
            .replace(/^(Sure!?\s*(,|\.|\!)??\s*)/i, '')
            .replace(/^(Here you go:?\s*)/i, '')
            .replace(/^["']|["']$/g, '') // Remove surrounding quotes
            .trim();

        console.log('✅ AI generated message for', firstName, ':', generatedMessage.substring(0, 50) + '...');
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
