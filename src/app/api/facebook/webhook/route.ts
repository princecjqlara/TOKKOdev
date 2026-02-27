import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature, generateVerifyToken, sendMessage, getUserProfile } from '@/lib/facebook';
import { replaceTemplateVariables } from '@/lib/placeholders';

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
        let hadCriticalFailure = false;

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
                        if (!senderId) continue;

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

                        let profileName: string | null = null;
                        let profilePic: string | null = null;

                        if (isNewContact) {
                            try {
                                const profile = await getUserProfile(senderId, page.access_token);
                                profileName = profile.name || null;
                                profilePic = profile.profile_pic || null;
                            } catch (profileError) {
                                console.warn(`⚠️ Failed to fetch profile for new contact ${senderId}:`, (profileError as Error).message);
                            }
                        }

                        const contactPayload: Record<string, unknown> = {
                            page_id: page.id,
                            psid: senderId,
                            ...(profileName ? { name: profileName } : {}),
                            ...(profilePic ? { profile_pic: profilePic } : {}),
                            last_interaction_at: interactionAt,
                            updated_at: new Date().toISOString(),
                            ...(isNewContact ? { first_interaction_at: interactionAt } : {})
                        };

                        let { data: contact, error: contactUpsertError } = await supabase
                            .from('contacts')
                            .upsert(contactPayload, {
                                onConflict: 'page_id,psid'
                            })
                            .select('id, name')
                            .single();

                        if (
                            contactUpsertError &&
                            isNewContact &&
                            Object.prototype.hasOwnProperty.call(contactPayload, 'first_interaction_at') &&
                            /first_interaction_at/i.test(contactUpsertError.message || '')
                        ) {
                            const { first_interaction_at: _ignored, ...legacyContactPayload } = contactPayload;

                            console.warn('⚠️ Retrying contact upsert without first_interaction_at due to schema mismatch');
                            const retryResult = await supabase
                                .from('contacts')
                                .upsert(legacyContactPayload, {
                                    onConflict: 'page_id,psid'
                                })
                                .select('id, name')
                                .single();

                            contact = retryResult.data;
                            contactUpsertError = retryResult.error;
                        }

                        if (contactUpsertError && isNewContact) {
                            const { first_interaction_at: _ignored, ...insertContactPayload } = contactPayload;

                            console.warn('⚠️ Upsert failed for new contact, retrying with direct insert');
                            const insertResult = await supabase
                                .from('contacts')
                                .insert(insertContactPayload)
                                .select('id, name')
                                .single();

                            contact = insertResult.data;
                            contactUpsertError = insertResult.error;
                        }

                        if (contactUpsertError) {
                            console.error(`🔴 Failed to upsert contact ${senderId}:`, contactUpsertError);
                            hadCriticalFailure = true;
                            continue;
                        }

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

                                let welcomeText = replaceTemplateVariables(welcomeConfig.message_text, {
                                    id: (contact as { id: string }).id || '',
                                    psid: senderId,
                                    page_id: page.id,
                                    name: contactName,
                                    last_interaction_at: null
                                });

                                // Send welcome message (must await in serverless environment)
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

        if (hadCriticalFailure) {
            return NextResponse.json(
                {
                    error: 'Webhook processing partially failed',
                    message: 'One or more contact upserts failed. Returning 500 so Facebook can retry delivery.'
                },
                { status: 500 }
            );
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Webhook error:', error);
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    }
}
