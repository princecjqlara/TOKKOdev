// NVIDIA AI Message Generation Utility

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';

/**
 * Generate a personalized message for a contact using NVIDIA AI
 * @param prompt User's custom prompt template
 * @param contactName Contact's first name to personalize the message
 * @returns Generated personalized message
 */
export async function generatePersonalizedMessage(
    prompt: string,
    contactName: string
): Promise<string> {
    const apiKey = process.env.NVIDIA_API_KEY;

    if (!apiKey) {
        console.error('❌ NVIDIA_API_KEY not configured');
        throw new Error('NVIDIA API key not configured');
    }

    // Extract first name from full name
    const firstName = contactName?.split(' ')[0] || 'there';

    const systemPrompt = `You are a helpful assistant that writes short, friendly, and professional messages for a business. 
Keep messages concise (under 160 characters if possible).
Always write in a warm, conversational tone.
The message should feel personal, not automated.
Do NOT include any greetings like "Dear" or formal closings.
Just write the message body directly.`;

    const userPrompt = `Write a message for someone named "${firstName}". 
The business wants to say: ${prompt}

Requirements:
- Address them by their first name "${firstName}" naturally in the message
- Keep it short and friendly
- Make it sound human, not robotic
- Don't use emojis unless the prompt suggests a casual tone`;

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
                max_tokens: 150,
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
        const result = await generatePersonalizedMessage('Just checking in!', 'Test');
        return !!result;
    } catch {
        return false;
    }
}
