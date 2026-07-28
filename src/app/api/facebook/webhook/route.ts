import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { verifyWebhookSignature, generateVerifyToken, sendMessage, getUserProfile } from '@/lib/facebook';
import { getPhilippinesDayOfWeek, getPhilippinesHour } from '@/lib/philippines-time';
import { replaceTemplateVariables } from '@/lib/placeholders';
import { stopWorkflowAutomationsFromPageMessage, triggerReplyWorkflowAutomations } from '@/lib/workflow-automations';
import { composeContactName, hasUsableContactName, normalizeContactName, pickPreferredContactName } from '../../../../lib/contact-names';

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
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const logPrefix = `[FB_WEBHOOK][${requestId}]`;
    const logInfo = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.log(`${logPrefix} ${message}`, data);
            return;
        }
        console.log(`${logPrefix} ${message}`);
    };
    const logWarn = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.warn(`${logPrefix} ${message}`, data);
            return;
        }
        console.warn(`${logPrefix} ${message}`);
    };
    const logError = (message: string, data?: unknown) => {
        if (data !== undefined) {
            console.error(`${logPrefix} ${message}`, data);
            return;
        }
        console.error(`${logPrefix} ${message}`);
    };

    try {
        const body = await request.text();
        const signature = request.headers.get('x-hub-signature-256') || '';
        const appSecret = process.env.FACEBOOK_APP_SECRET!;

        // Verify signature in production only (skip in development for easier testing)
        const isDevelopment = process.env.NODE_ENV !== 'production';
        if (!isDevelopment && appSecret) {
            if (!verifyWebhookSignature(body, signature, appSecret)) {
                logError('Webhook signature verification failed');
                return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
            }
        } else if (isDevelopment) {
            logInfo('Webhook signature verification skipped (development mode)');
        }

        const data = JSON.parse(body);
        const supabase = getSupabaseAdmin();
        let hadCriticalFailure = false;

        let processedEntries = 0;
        let processedEvents = 0;
        let processedContacts = 0;
        let skippedEvents = 0;

        const entryCount = Array.isArray(data.entry) ? data.entry.length : 0;
        logInfo('Webhook payload parsed', {
            object: data.object,
            entryCount,
            bodyLength: body.length,
            signatureProvided: Boolean(signature)
        });

        // Process messaging events
        if (data.object === 'page') {
            for (const entry of data.entry) {
                processedEntries += 1;
                const pageId = entry.id;
                const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
                const standbyEvents = Array.isArray((entry as { standby?: unknown[] }).standby)
                    ? (entry as { standby?: unknown[] }).standby || []
                    : [];

                const inboundEvents = [...messagingEvents, ...standbyEvents];

                if (standbyEvents.length > 0) {
                    logInfo('Received standby events for contact ingestion', {
                        pageId,
                        standbyCount: standbyEvents.length
                    });
                }

                if (inboundEvents.length === 0) {
                    logInfo('Skipping entry with no inbound events', { pageId });
                    continue;
                }

                // Get our page record
                const { data: page, error: pageError } = await supabase
                    .from('pages')
                    .select('id, access_token')
                    .eq('fb_page_id', pageId)
                    .single();

                if (pageError) {
                    logError('Failed to fetch page by fb_page_id', {
                        pageId,
                        error: pageError.message
                    });
                    hadCriticalFailure = true;
                    continue;
                }

                if (!page) {
                    logWarn('No internal page record found for webhook entry', { pageId });
                    continue;
                }

                // Fetch welcome message config for this page (cached per webhook batch)
                let welcomeConfig: { enabled: boolean; message_text: string; buttons: Array<{ type: string; text: string; url?: string; payload?: string }> } | null = null;
                let welcomeConfigFetched = false;

                // Process inbound events from both messaging and standby arrays
                if (inboundEvents.length > 0) {
                    for (const event of inboundEvents) {
                        processedEvents += 1;
                        try {
                            const eventType = event.message
                                ? 'message'
                                : event.postback
                                    ? 'postback'
                                    : event.referral
                                        ? 'referral'
                                        : event.delivery
                                            ? 'delivery'
                                            : event.read
                                                ? 'read'
                                                : event.optin
                                                    ? 'optin'
                                                    : 'unknown';
                            const senderId = event.sender?.id;
                            const recipientId = event.recipient?.id;

                            if (!senderId) {
                                skippedEvents += 1;
                                logWarn('Skipping messaging event without sender id', {
                                    pageId,
                                    recipientId: recipientId ?? null,
                                    eventType,
                                    eventKeys: Object.keys(event || {})
                                });
                                continue;
                            }

                            const isFromContact = senderId !== pageId;

                            // Page echoes can carry the manual workflow stop code.
                            if (!isFromContact) {
                                skippedEvents += 1;
                                const outboundMessageText = typeof event.message?.text === 'string'
                                    ? event.message.text.trim()
                                    : '';

                                if (eventType === 'message' && outboundMessageText && recipientId) {
                                    try {
                                        const stopResult = await stopWorkflowAutomationsFromPageMessage({
                                            supabase,
                                            pageId: page.id,
                                            contactPsid: recipientId,
                                            messageText: outboundMessageText
                                        });

                                        if (stopResult.stopped > 0) {
                                            logInfo('Stopped workflow automation from outbound page code', {
                                                pageId,
                                                recipientId,
                                                stopped: stopResult.stopped
                                            });
                                        }
                                    } catch (stopError) {
                                        logWarn('Failed to process outbound workflow stop code', {
                                            pageId,
                                            recipientId,
                                            error: (stopError as Error).message
                                        });
                                    }
                                }

                                if (eventType === 'message' || eventType === 'postback' || eventType === 'referral') {
                                    logInfo('Skipping outbound page event from webhook payload', {
                                        pageId,
                                        senderId,
                                        recipientId: recipientId ?? null,
                                        eventType
                                    });
                                }
                                continue;
                            }

                        let interactionTime = new Date();
                        const rawTimestamp = event.timestamp;
                        if (rawTimestamp !== undefined && rawTimestamp !== null) {
                            let parsedTime: Date | null = null;
                            if (typeof rawTimestamp === 'number' || typeof rawTimestamp === 'string') {
                                const numericTimestamp = Number(rawTimestamp);
                                if (Number.isFinite(numericTimestamp)) {
                                    const candidate = new Date(numericTimestamp);
                                    if (!Number.isNaN(candidate.getTime())) {
                                        parsedTime = candidate;
                                    }
                                }

                                if (!parsedTime) {
                                    const candidate = new Date(rawTimestamp);
                                    if (!Number.isNaN(candidate.getTime())) {
                                        parsedTime = candidate;
                                    }
                                }
                            }

                            if (parsedTime) {
                                interactionTime = parsedTime;
                            } else {
                                logWarn('Invalid webhook event timestamp; using server time fallback', {
                                    pageId,
                                    senderId,
                                    eventType,
                                    rawTimestamp
                                });
                            }
                        } else {
                            logWarn('Webhook event missing timestamp; using server time fallback', {
                                pageId,
                                senderId,
                                eventType
                            });
                        }

                        const interactionAt = interactionTime.toISOString();

                        // Check if contact exists BEFORE upsert (to detect new contacts)
                        const { data: existingContact, error: existingContactError } = await supabase
                            .from('contacts')
                            .select('id, name')
                            .eq('page_id', page.id)
                            .eq('psid', senderId)
                            .maybeSingle();

                        if (existingContactError) {
                            logError('Failed to check existing contact before upsert', {
                                pageId,
                                senderId,
                                error: existingContactError.message
                            });
                            hadCriticalFailure = true;
                            continue;
                        }

                        const isNewContact = !existingContact;
                        const missingName = !hasUsableContactName(existingContact?.name);
                        const shouldRefreshProfile = isNewContact || missingName;

                        let profileName: string | null = null;
                        let profilePic: string | null = null;
                        const eventSenderName = normalizeContactName(event.sender?.name);

                        if (shouldRefreshProfile) {
                            try {
                                const profile = await getUserProfile(senderId, page.access_token);
                                profileName = normalizeContactName(profile.name);

                                profileName = pickPreferredContactName(
                                    profileName,
                                    composeContactName(profile.first_name, profile.last_name)
                                );

                                profilePic = typeof profile.profile_pic === 'string' ? profile.profile_pic.trim() || null : null;
                            } catch (profileError) {
                                logWarn('Failed to fetch profile for contact enrichment', {
                                    pageId,
                                    senderId,
                                    isNewContact,
                                    missingName,
                                    error: (profileError as Error).message
                                });
                            }
                        }

                        const resolvedName = pickPreferredContactName(profileName, eventSenderName, existingContact?.name);
                        const existingNameShouldBeCleared =
                            typeof existingContact?.name === 'string' &&
                            !hasUsableContactName(existingContact.name);

                        const contactPayload: Record<string, unknown> = {
                            page_id: page.id,
                            psid: senderId,
                            ...(resolvedName ? { name: resolvedName } : existingNameShouldBeCleared ? { name: null } : {}),
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

                            logWarn('Retrying contact upsert without first_interaction_at due to schema mismatch', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
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

                            logWarn('Upsert failed for new contact, retrying with direct insert', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
                            const insertResult = await supabase
                                .from('contacts')
                                .insert(insertContactPayload)
                                .select('id, name')
                                .single();

                            contact = insertResult.data;
                            contactUpsertError = insertResult.error;
                        }

                        if (contactUpsertError) {
                            logError('Failed to create or update contact from webhook', {
                                pageId,
                                senderId,
                                error: contactUpsertError.message
                            });
                            hadCriticalFailure = true;
                            continue;
                        }

                        processedContacts += 1;

                        // Send welcome message to new contacts
                        if (isNewContact && contact) {
                            // Lazy-load welcome config once per page per webhook batch
                            if (!welcomeConfigFetched) {
                                const { data: wc, error: welcomeConfigError } = await supabase
                                    .from('welcome_messages')
                                    .select('enabled, message_text, buttons')
                                    .eq('page_id', page.id)
                                    .single();

                                if (welcomeConfigError) {
                                    logWarn('Failed to fetch welcome message config', {
                                        pageId,
                                        pageDbId: page.id,
                                        error: welcomeConfigError.message
                                    });
                                } else {
                                    welcomeConfig = wc;
                                }
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

                                const mappedWelcomeButtons = Array.isArray(welcomeConfig.buttons)
                                    ? welcomeConfig.buttons
                                        .map((button) => {
                                            const text = typeof button?.text === 'string' ? button.text.trim() : '';
                                            if (!text) return null;

                                            const buttonType = typeof button?.type === 'string' ? button.type.toUpperCase() : 'URL';
                                            if (buttonType === 'QUICK_REPLY') {
                                                const payload = typeof button?.payload === 'string' && button.payload.trim().length > 0
                                                    ? button.payload.trim()
                                                    : text;
                                                return {
                                                    type: 'POSTBACK' as const,
                                                    text,
                                                    payload
                                                };
                                            }

                                            const url = typeof button?.url === 'string' ? button.url.trim() : '';
                                            if (!url) return null;

                                            return {
                                                type: 'URL' as const,
                                                text,
                                                url
                                            };
                                        })
                                        .filter((button): button is { type: 'URL'; text: string; url: string } | { type: 'POSTBACK'; text: string; payload: string } => button !== null)
                                        .slice(0, 3)
                                    : [];

                                const welcomeMessagingType = 'RESPONSE';

                                // Send welcome message (must await in serverless environment)
                                try {
                                    await sendMessage(
                                        pageId,
                                        page.access_token,
                                        senderId,
                                        welcomeText,
                                        welcomeMessagingType,
                                        undefined,
                                        undefined,
                                        undefined,
                                        mappedWelcomeButtons.length > 0 ? mappedWelcomeButtons : undefined
                                    );
                                    logInfo('Welcome message sent to new contact', {
                                        pageId,
                                        senderId,
                                        messagingType: welcomeMessagingType,
                                        buttonCount: mappedWelcomeButtons.length
                                    });
                                } catch (err) {
                                    logError('Failed to send welcome message', {
                                        pageId,
                                        senderId,
                                        error: (err as Error).message
                                    });
                                }
                            }
                        }

                        // Record interaction for best time to contact analysis
                        if (contact) {
                            const inboundMessageText = typeof event.message?.text === 'string'
                                ? event.message.text.trim()
                                : '';

                            if (eventType === 'message' && inboundMessageText) {
                                try {
                                    const workflowResult = await triggerReplyWorkflowAutomations({
                                        supabase,
                                        page: {
                                            id: page.id,
                                            fb_page_id: pageId,
                                            access_token: page.access_token
                                        },
                                        contact: {
                                            id: contact.id,
                                            psid: senderId,
                                            page_id: page.id,
                                            name: (contact as { name?: string | null }).name || null,
                                            last_interaction_at: interactionAt
                                        },
                                        messageText: inboundMessageText,
                                        interactionAt
                                    });

                                    if (workflowResult.sent > 0 || workflowResult.stopped > 0 || workflowResult.errors > 0) {
                                        logInfo('Processed reply workflow automations', {
                                            pageId,
                                            senderId,
                                            contactId: contact.id,
                                            ...workflowResult
                                        });
                                    }
                                } catch (workflowError) {
                                    logWarn('Failed to process reply workflow automations', {
                                        pageId,
                                        senderId,
                                        contactId: contact.id,
                                        error: (workflowError as Error).message
                                    });
                                }
                            }

                            const hourOfDay = getPhilippinesHour(interactionTime);
                            const dayOfWeek = getPhilippinesDayOfWeek(interactionTime);

                            const { error: insertInteractionError } = await supabase
                                .from('contact_interactions')
                                .insert({
                                    contact_id: contact.id,
                                    page_id: page.id,
                                    interaction_at: interactionAt,
                                    hour_of_day: hourOfDay,
                                    day_of_week: dayOfWeek,
                                    is_from_contact: true
                                });

                            if (insertInteractionError) {
                                logWarn('Failed to save contact interaction', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: insertInteractionError.message
                                });
                            }

                            // Automatically recalculate best time to contact
                            const { data: interactions, error: interactionsError } = await supabase
                                .from('contact_interactions')
                                .select('hour_of_day')
                                .eq('contact_id', contact.id)
                                .eq('is_from_contact', true);

                            if (interactionsError) {
                                logWarn('Failed to fetch interaction history for best-time calculation', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: interactionsError.message
                                });
                                continue;
                            }

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
                            const { error: bestTimeUpdateError } = await supabase
                                .from('contacts')
                                .update({
                                    best_contact_hour: bestHour,
                                    best_contact_confidence: confidence
                                })
                                .eq('id', contact.id);

                            if (bestTimeUpdateError) {
                                logWarn('Failed to update best-time fields for contact', {
                                    pageId,
                                    senderId,
                                    contactId: contact.id,
                                    error: bestTimeUpdateError.message
                                });
                            }
                        }
                        } catch (eventError) {
                            skippedEvents += 1;
                            hadCriticalFailure = true;
                            logError('Unhandled exception while processing inbound webhook event', {
                                pageId,
                                senderId: event?.sender?.id ?? null,
                                recipientId: event?.recipient?.id ?? null,
                                eventKeys: Object.keys(event || {}),
                                error: (eventError as Error).message
                            });
                        }
                    }
                }
            }
        } else {
            logWarn('Ignoring webhook payload with unsupported object type', { object: data.object });
        }

        logInfo('Webhook processing summary', {
            processedEntries,
            processedEvents,
            processedContacts,
            skippedEvents,
            hadCriticalFailure
        });

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
        logError('Unhandled webhook error', {
            error: (error as Error).message
        });
        return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
    }
}
