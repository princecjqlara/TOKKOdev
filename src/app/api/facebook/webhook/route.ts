import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature, generateVerifyToken, sendMessage } from '@/lib/facebook';

// GET /api/facebook/webhook - Verify webhook
export async function GET(request: NextRequest) {
    const searchParams = request.nextUrl.searchParams;
    const mode = searchParams.get('hub.mode');
    const token = searchParams.get('hub.verify_token');
    const challenge = searchParams.get('hub.challenge');
    const showToken = searchParams.get('show_token') === 'true';

    const appSecret = process.env.FACEBOOK_APP_SECRET;
    const appId = process.env.FACEBOOK_CLIENT_ID;

    if (!appSecret || !appId) {
        return NextResponse.json({ error: 'Facebook app credentials not configured' }, { status: 500 });
    }

    // Auto-generate verify token from app secret and app id
    const verifyToken = generateVerifyToken(appSecret, appId);

    // Show token in development mode for Facebook webhook setup
    const isDevelopment = process.env.NODE_ENV !== 'production';
    if (showToken && isDevelopment) {
        console.log('🔵 Webhook verify token requested (development mode)');
        return NextResponse.json({
            verify_token: verifyToken,
            message: 'Use this token when setting up your Facebook webhook',
            webhook_url: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/api/facebook/webhook`,
            app_id: appId,
            environment: 'development'
        });
    }

    if (mode === 'subscribe' && token === verifyToken) {
        console.log('✅ Webhook verified successfully');
        if (isDevelopment) {
            console.log('🔵 Webhook verification details:', {
                mode,
                challenge_length: challenge?.length,
                app_id: appId
            });
        }
        return new NextResponse(challenge, { status: 200 });
    }

    if (isDevelopment) {
        console.warn('⚠️ Webhook verification failed:', {
            mode,
            token_provided: !!token,
            token_match: token === verifyToken
        });
    }
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}

// POST /api/facebook/webhook - Receive webhook events
export async function POST(request: NextRequest) {
    try {
        const body = await request.text();
        const signature = request.headers.get('x-hub-signature-256') || '';
        const appSecret = process.env.FACEBOOK_APP_SECRET!;

        // Verify signature in production only (skip in development for easier testing)
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (!isDevelopment && appSecret) {
            if (!verifyWebhookSignature(body, signature, appSecret)) {
                console.error('🔴 Webhook signature verification failed');
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
            }
        } else if (isDevelopment) {
            console.log('🔵 Webhook signature verification skipped (development mode)');
        }

        const data = JSON.parse(body);
        const supabase = getSupabaseAdmin();

        // Process messaging events
        if (data.object === 'page') {
            for (const entry of data.entry) {
                const pageId = entry.id;

                // Get our page record
                const { data: page } = await supabase
                    .from('pages')
                    .select('id, access_token')
                    .eq('fb_page_id', pageId)
                    .single();

                if (!page) continue;

                // Fetch welcome message config for this page (cached per webhook batch)
                let welcomeConfig: { enabled: boolean; message_text: string; buttons: Array<{ type: string; text: string; url?: string; payload?: string }> } | null = null;
                let welcomeConfigFetched = false;

                // Process messaging events
                if (entry.messaging) {
                    for (const event of entry.messaging) {
                        const senderId = event.sender?.id;
                        const isFromContact = senderId !== pageId;

                        // Skip if sender is the page itself (for contact upsert)
                        if (!isFromContact) continue;

                        const interactionTime = new Date(event.timestamp);
                        const interactionAt = interactionTime.toISOString();

                        // Check if contact exists BEFORE upsert (to detect new contacts)
                        const { data: existingContact } = await supabase
                            .from('contacts')
                            .select('id')
                            .eq('page_id', page.id)
                            .eq('psid', senderId)
                            .maybeSingle();

                        const isNewContact = !existingContact;

                        // Upsert contact
                        const { data: contact } = await supabase
                            .from('contacts')
                            .upsert({
                                page_id: page.id,
                                psid: senderId,
                                last_interaction_at: interactionAt,
                                updated_at: new Date().toISOString(),
                                // Set first_interaction_at only for brand-new contacts
                                ...(isNewContact ? { first_interaction_at: interactionAt } : {})
                            }, {
                                onConflict: 'page_id,psid'
                            })
                            .select('id, name')
                            .single();

                        // Send welcome message to new contacts
                        if (isNewContact && contact) {
                            // Lazy-load welcome config once per page per webhook batch
                            if (!welcomeConfigFetched) {
                                const { data: wc } = await supabase
                                    .from('welcome_messages')
                                    .select('enabled, message_text, buttons')
                                    .eq('page_id', page.id)
                                    .single();
                                welcomeConfig = wc;
                                welcomeConfigFetched = true;
                            }

                            if (welcomeConfig?.enabled && welcomeConfig.message_text?.trim()) {
                                // Personalize the message
                                const contactName = (contact as { id: string; name?: string }).name || '';
                                const nameParts = contactName.split(' ');
                                const firstName = nameParts[0] || '';
                                const lastName = nameParts.slice(1).join(' ') || '';

                                let welcomeText = welcomeConfig.message_text
                                    .replace(/\{name\}/g, contactName || 'there')
                                    .replace(/\{first_name\}/g, firstName || 'there')
                                    .replace(/\{last_name\}/g, lastName);

                                // Fire-and-forget: send welcome message after a short delay
                                setTimeout(async () => {
                                    try {
                                        await sendMessage(
                                            pageId,
                                            page.access_token,
                                            senderId,
                                            welcomeText,
                                            'HUMAN_AGENT'
                                        );
                                        console.log(`👋 Welcome message sent to new contact ${senderId} on page ${pageId}`);
                                    } catch (err) {
                                        console.error(`❌ Failed to send welcome message to ${senderId}:`, err);
                                    }
                                }, 1000);
                            }
                        }

                        // Record interaction for best time to contact analysis
                        if (contact) {
                            const hourOfDay = interactionTime.getUTCHours();
                            const dayOfWeek = interactionTime.getUTCDay();

                            await supabase
                                .from('contact_interactions')
                                .insert({
                                    contact_id: contact.id,
                                    page_id: page.id,
                                    interaction_at: interactionAt,
                                    hour_of_day: hourOfDay,
                                    day_of_week: dayOfWeek,
                                    is_from_contact: true
                                });

                            // Automatically recalculate best time to contact
                            const { data: interactions } = await supabase
                                .from('contact_interactions')
                                .select('hour_of_day')
                                .eq('contact_id', contact.id)
                                .eq('is_from_contact', true);

                            const interactionCount = interactions?.length || 0;
                            const hourDistribution: Record<number, number> = {};

                            for (const interaction of interactions || []) {
                                const hour = interaction.hour_of_day;
                                hourDistribution[hour] = (hourDistribution[hour] || 0) + 1;
                            }

                            // Find most common hour
                            let bestHour: number | null = null;
                            let maxCount = 0;
                            for (const [hour, count] of Object.entries(hourDistribution)) {
                                if (count > maxCount) {
                                    maxCount = count;
                                    bestHour = parseInt(hour);
                                }
                            }

                            // Determine confidence level
                            let confidence: string;
                            if (interactionCount >= 5) {
                                confidence = 'high';
                            } else if (interactionCount >= 2) {
                                confidence = 'medium';
                            } else if (interactionCount === 1) {
                                confidence = 'inferred';
                                // For single interaction, use neighbor inference (simplified - use this hour)
                                bestHour = hourOfDay;
                            } else {
                                confidence = 'none';
                            }

                            // Update contact with best time data
                            await supabase
                                .from('contacts')
                                .update({
                                    best_contact_hour: bestHour,
                                    best_contact_confidence: confidence
                                })
                                .eq('id', contact.id);
                        }
                    }
                }
            }
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    }
}
