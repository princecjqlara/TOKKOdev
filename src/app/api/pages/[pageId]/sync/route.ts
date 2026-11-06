import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import {
    getPageConversations,
    getPageConversationsBatch,
    getUserProfile,
    getConversationMessages,
    subscribePageToAppWebhook,
    isFacebookReauthRequired,
    type ConversationMessage
} from '@/lib/facebook';
import { getPhilippinesHour } from '@/lib/philippines-time';
import { chunkArray } from '../../../../../lib/chunking';
import { composeContactName, hasUsableContactName, normalizeContactName, pickPreferredContactName } from '../../../../../lib/contact-names';
import { SUPABASE_IN_FILTER_BATCH_SIZE } from '@/lib/supabase-pagination';
import { isExpectedFacebookProfileLookupError } from '@/lib/facebook-errors';
import { createContactMessagingAutoTagger } from '@/lib/messaging-auto-tag-sync';
import { databaseRequest } from '@/lib/database-request';
import { AccessError } from '@/lib/account-security';
import { processContactImport } from '@/lib/contact-import';

// Increase timeout for sync operations (up to 5 minutes)
export const maxDuration = 300;

type SyncLease = {
    supabase: ReturnType<typeof getSupabaseAdmin>;
    pageId: string;
    owner: string;
};

async function acquireSyncLease(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    pageId: string,
    owner: string
): Promise<boolean | null> {
    const { data, error } = await databaseRequest(supabase.rpc('acquire_page_sync_lease', {
        p_page_id: pageId,
        p_owner: owner,
        p_lease_seconds: 360
    }));

    if (error) {
        // Allow a rolling deployment before the migration reaches Supabase.
        if (error.code === 'PGRST202' || error.message?.includes('acquire_page_sync_lease')) {
            return null;
        }
        throw error;
    }

    return data === true;
}

async function releaseSyncLease(lease: SyncLease) {
    const { error } = await databaseRequest(lease.supabase.rpc('release_page_sync_lease', {
        p_page_id: lease.pageId,
        p_owner: lease.owner
    }));

    if (error && error.code !== 'PGRST202' && !error.message?.includes('release_page_sync_lease')) {
        console.warn('[CONTACT_SYNC] Failed to release sync lease', {
            pageId: lease.pageId,
            error: error.message
        });
    }
}

// POST /api/pages/[pageId]/sync - Manual sync contacts
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    const requestStartedAt = Date.now();
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logPrefix = `[CONTACT_SYNC][${requestId}]`;
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

    let syncLease: SyncLease | null = null;
    let keepSyncLease = false;

    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            logError('No session found in /api/pages/[pageId]/sync');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            logError('No user ID in session', {
                hasSessionUser: Boolean(session.user),
                userEmail: session.user?.email ?? null
            });
            return NextResponse.json(
                { error: 'Unauthorized', message: 'User not found. Please sign in again.' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        // Check if user wants to force a full sync (optional body parameter)
        let forceFullSync = false;
        let resumePsids: string[] = [];
        let usePagedSync = true;
        let cursor: string | null = null;
        let requestedSyncStartedAt: string | null = null;
        let requestedSyncRunId: string | null = null;
        let syncHadFailures = false;
        let autoTag = true;
        let importOnly = false;
        try {
            const body = await request.json();
            syncHadFailures = body?.syncHadFailures === true;
            autoTag = body?.autoTag !== false;
            importOnly = body?.importOnly === true;
            forceFullSync = (body as { forceFullSync?: boolean })?.forceFullSync === true;
            usePagedSync = (body as { paged?: boolean })?.paged !== false;
            cursor = typeof (body as { cursor?: unknown }).cursor === 'string'
                ? ((body as { cursor?: string }).cursor || '').trim() || null
                : null;
            requestedSyncStartedAt = typeof (body as { syncStartedAt?: unknown }).syncStartedAt === 'string'
                ? ((body as { syncStartedAt?: string }).syncStartedAt || '').trim() || null
                : null;
            requestedSyncRunId = typeof (body as { syncRunId?: unknown }).syncRunId === 'string'
                ? ((body as { syncRunId?: string }).syncRunId || '').trim() || null
                : null;
            resumePsids = Array.isArray((body as { resumePsids?: unknown }).resumePsids)
                ? [
                    ...new Set(
                        ((body as { resumePsids?: unknown[] }).resumePsids || [])
                            .map((value) => (typeof value === 'string' ? value.trim() : ''))
                            .filter(Boolean)
                    )
                ]
                : [];
        } catch {
            // No body provided, use default (incremental sync)
        }

        logInfo('Sync request received', {
            userId,
            pageId,
            forceFullSync,
            usePagedSync,
            hasCursor: Boolean(cursor),
            requestedSyncStartedAt,
            resumePsidCount: resumePsids.length
        });

        // Verify user has access to page
        const { data: userPage, error: membershipError } = await databaseRequest(supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', userId)
            .eq('page_id', pageId)
            .single());
        if (membershipError && membershipError.code !== 'PGRST116') throw membershipError;

        if (!userPage) {
            logWarn('User attempted sync for page without access', {
                userId,
                pageId
            });
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Get page details including last_synced_at
        const { data: page, error: pageError } = await databaseRequest(supabase
            .from('pages')
            .select('fb_page_id, access_token, last_synced_at, messaging_auto_tag_enabled')
            .eq('id', pageId)
            .single());
        if (pageError && pageError.code !== 'PGRST116') throw pageError;

        if (!page) {
            logWarn('Page not found for sync request', {
                userId,
                pageId
            });
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        if (importOnly) {
            if (!requestedSyncStartedAt) {
                try { await subscribePageToAppWebhook(page.fb_page_id, page.access_token, ['messages', 'messaging_postbacks', 'message_echoes']); }
                catch { logWarn('Webhook subscription could not be refreshed; continuing the contact import', { pageId }); }
            }
            return NextResponse.json(await processContactImport({ pageId, syncRunId: requestedSyncRunId || undefined, autoTag, supabase }));
        }

        const autoTagEnabled = autoTag && page.messaging_auto_tag_enabled !== false;
        const applyMessengerTags = createContactMessagingAutoTagger(supabase, {
            ...page, id: pageId, messaging_auto_tag_enabled: autoTagEnabled
        });

        // Determine if this is a full sync or incremental sync
        const isIncremental = !forceFullSync && !!page.last_synced_at;
        const parsedRequestedSyncStart = requestedSyncStartedAt ? new Date(requestedSyncStartedAt) : null;
        const syncStartTime =
            parsedRequestedSyncStart && !Number.isNaN(parsedRequestedSyncStart.getTime())
                ? parsedRequestedSyncStart.toISOString()
                : new Date().toISOString();
        const syncRunId = requestedSyncRunId || (
            typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
        const syncLeaseOwner = `${userId}:${syncRunId}`;
        const leaseAcquired = await acquireSyncLease(supabase, pageId, syncLeaseOwner);
        if (leaseAcquired === false) {
            logWarn('Rejected overlapping contact sync', { pageId, userId, syncRunId });
            return NextResponse.json(
                {
                    error: 'Sync already running',
                    message: 'A contact sync is already running for this page. Wait for it to finish before starting another one.'
                },
                { status: 409 }
            );
        }
        if (leaseAcquired === true) {
            syncLease = { supabase, pageId, owner: syncLeaseOwner };
        } else {
            logError('Sync lease migration is not installed; refusing an unprotected contact sync', {
                pageId,
                userId,
                syncRunId
            });
            return NextResponse.json(
                {
                    error: 'Sync safety migration required',
                    message: 'Contact sync is temporarily unavailable while the database safety migration is being installed. Please try again shortly.'
                },
                { status: 503 }
            );
        }

        if (!cursor && resumePsids.length === 0) {
            try {
                await subscribePageToAppWebhook(page.fb_page_id, page.access_token, ['messages', 'messaging_postbacks', 'message_echoes']);
                logInfo('Verified page webhook subscription before sync', {
                    pageId,
                    fbPageId: page.fb_page_id
                });
            } catch (subscriptionError) {
                logWarn('Failed to verify page webhook subscription before sync', {
                    pageId,
                    fbPageId: page.fb_page_id,
                    error: (subscriptionError as Error).message
                });
            }
        }

        logInfo('Starting sync run', {
            syncMode: isIncremental ? 'incremental' : 'full',
            fbPageId: page.fb_page_id,
            pageId,
            lastSyncedAt: page.last_synced_at ?? null,
            forceFullSync,
            usePagedSync,
            hasCursor: Boolean(cursor)
        });
        if (isIncremental) {
            logInfo('Incremental sync using last_synced_at checkpoint', {
                lastSyncedAt: page.last_synced_at
            });
        } else if (forceFullSync) {
            logInfo('Force full sync requested - syncing all conversations');
        }

        // Fetch conversations from Facebook (only new ones if incremental)
        let conversations;
        let nextCursor: string | null = null;
        try {
            if (usePagedSync) {
                const batch = await getPageConversationsBatch(
                    page.fb_page_id,
                    page.access_token,
                    {
                        limit: 100,
                        after: cursor,
                        sinceTimestamp: isIncremental ? page.last_synced_at : undefined
                    }
                );
                conversations = batch.conversations;
                nextCursor = batch.nextCursor;
            } else {
                conversations = await getPageConversations(
                    page.fb_page_id,
                    page.access_token,
                    100,
                    true,
                    isIncremental ? page.last_synced_at : undefined
                );
            }
            logInfo('Fetched conversations from Facebook', {
                conversationCount: conversations.length,
                incremental: isIncremental,
                usePagedSync,
                hasNextCursor: Boolean(nextCursor)
            });
        } catch (error) {
            logError('Error fetching conversations from Facebook', {
                error: (error as Error).message
            });
            const errorMessage = (error as Error).message || String(error);

            // Check if it's a permissions error
            if (isFacebookReauthRequired(error) || errorMessage.toLowerCase().includes('permission') || errorMessage.includes('must be granted')) {
                return NextResponse.json(
                    {
                        error: 'Permission Error',
                        message: 'The page access token is missing required permissions. Reconnect this Page in Connect Pages to refresh its permissions.',
                        requiresReconnect: true
                    },
                    { status: 403 }
                );
            }

            return NextResponse.json(
                { error: 'Failed to fetch conversations', message: errorMessage },
                { status: 500 }
            );
        }

        // Filter valid conversations first
        const seenPsids = new Set<string>();
        let validConversations = conversations.filter(conv => {
            const participants = conv.participants?.data?.filter(p => p.id && p.id !== page.fb_page_id) || [];
            if (participants.length !== 1 || seenPsids.has(participants[0].id)) return false;
            seenPsids.add(participants[0].id);
            return true;
        });

        if (resumePsids.length > 0) {
            const resumePsidSet = new Set(resumePsids);
            validConversations = validConversations.filter(conv => {
                const participant = conv.participants?.data?.find(p => p.id !== page.fb_page_id);
                return participant?.id ? resumePsidSet.has(participant.id) : false;
            });
        }

        const invalidConversationCount = conversations.length - validConversations.length;
        logInfo('Conversation validation complete', {
            totalConversations: conversations.length,
            validConversations: validConversations.length,
            invalidConversations: invalidConversationCount,
            resumePsidCount: resumePsids.length
        });

        // Persist basic contact rows before slower enrichment work. Large pages can exceed
        // serverless time limits while fetching profiles/messages, but the leads should
        // still appear as soon as conversations have been fetched from Facebook.
        const basicContactRows = validConversations
            .map(conversation => {
                const participant = conversation.participants?.data?.find(p => p.id !== page.fb_page_id);
                if (!participant?.id) return null;

                const interactionDate = conversation.updated_time ? new Date(conversation.updated_time) : null;
                const bestContactHour = interactionDate && !Number.isNaN(interactionDate.getTime())
                    ? getPhilippinesHour(interactionDate)
                    : null;
                const participantName = normalizeContactName(participant.name);

                return {
                    page_id: pageId,
                    psid: participant.id,
                    ...(participantName ? { name: participantName } : {}),
                    last_interaction_at: conversation.updated_time,
                    best_contact_hour: bestContactHour,
                    best_contact_confidence: bestContactHour === null ? 'none' : 'inferred',
                    best_contact_hours: bestContactHour === null ? [] : [{ hour: bestContactHour, count: 1 }],
                    interaction_count: bestContactHour === null ? 0 : 1,
                    updated_at: new Date().toISOString()
                };
            })
            .filter((contact): contact is NonNullable<typeof contact> => contact !== null);

        const BASIC_CONTACT_UPSERT_CHUNK_SIZE = 500;
        const basicContactRowGroups = [
            basicContactRows.filter((contact) => Object.prototype.hasOwnProperty.call(contact, 'name')),
            basicContactRows.filter((contact) => !Object.prototype.hasOwnProperty.call(contact, 'name'))
        ];

        for (const rows of basicContactRowGroups) {
            for (let i = 0; i < rows.length; i += BASIC_CONTACT_UPSERT_CHUNK_SIZE) {
                const chunk = rows.slice(i, i + BASIC_CONTACT_UPSERT_CHUNK_SIZE);
                const { error: basicUpsertError } = await databaseRequest(supabase
                    .from('contacts')
                    .upsert(chunk, {
                        onConflict: 'page_id,psid',
                        ignoreDuplicates: false
                    }));

                if (basicUpsertError) throw basicUpsertError;
            }
        }

        logInfo('Basic contact sync persisted contacts before enrichment', {
            contactCount: basicContactRows.length
        });

        // Check for deleted contacts that should be re-added
        // Get all PSIDs from fetched conversations
        const conversationPsids = new Set<string>();
        validConversations.forEach(conv => {
            const participant = conv.participants?.data?.find(p => p.id !== page.fb_page_id);
            if (participant?.id) {
                conversationPsids.add(participant.id);
            }
        });

        // Check which PSIDs are missing from database (deleted contacts)
        let restoredCount = 0;
        const existingContactsByPsid = new Map<string, { name: string | null; profile_pic: string | null }>();
        if (conversationPsids.size > 0) {
            try {
                const existingContacts: Array<{ psid?: string | null; name?: string | null; profile_pic?: string | null }> = [];
                for (const psidBatch of chunkArray(Array.from(conversationPsids), SUPABASE_IN_FILTER_BATCH_SIZE)) {
                    const { data: batchContacts, error: existingContactsError } = await databaseRequest(supabase
                        .from('contacts')
                        .select('psid,name,profile_pic')
                        .eq('page_id', pageId)
                        .in('psid', psidBatch));

                    if (existingContactsError) {
                        throw existingContactsError;
                    }

                    existingContacts.push(...(batchContacts || []));
                }

                for (const existingContact of existingContacts || []) {
                    if (typeof existingContact.psid !== 'string' || existingContact.psid.trim() === '') {
                        continue;
                    }

                    existingContactsByPsid.set(existingContact.psid, {
                        name: typeof existingContact.name === 'string' ? existingContact.name : null,
                        profile_pic:
                            typeof existingContact.profile_pic === 'string' && existingContact.profile_pic.trim() !== ''
                                ? existingContact.profile_pic
                                : null
                    });
                }

                const existingPsids = new Set(existingContactsByPsid.keys());
                const missingPsids = Array.from(conversationPsids).filter(psid => !existingPsids.has(psid));

                if (missingPsids.length > 0) {
                    restoredCount = missingPsids.length;
                    logInfo('Found deleted contacts to restore from Facebook conversations', {
                        restoredCount
                    });
                }
            } catch (error) {
                // Don't fail the sync if checking for deleted contacts fails
                logWarn('Error checking for deleted contacts (non-critical)', {
                    error: (error as Error).message
                });
            }
        }

        let synced = 0;
        let failed = 0;
        let tagged = 0;
        const errors: string[] = [];

        // Process contacts in parallel batches to avoid timeout
        const SYNC_BATCH_SIZE = 15; // Process 15 contacts in parallel (increased for faster processing)
        const DELAY_BETWEEN_BATCHES = 20; // 20ms delay between batches (reduced for faster processing)
        const MAX_PROCESSING_TIME = 45000; // Return partials early so the client can continue before hosting timeouts.
        const PROFILE_FETCH_TIMEOUT = 4000; // 4 seconds max per profile fetch for more reliable name enrichment
        const startTime = requestStartedAt;

        logInfo('Beginning conversation processing', {
            validConversations: validConversations.length,
            batchSize: SYNC_BATCH_SIZE,
            delayBetweenBatchesMs: DELAY_BETWEEN_BATCHES,
            maxProcessingTimeMs: MAX_PROCESSING_TIME,
            profileFetchTimeoutMs: PROFILE_FETCH_TIMEOUT
        });

        for (let i = 0; i < validConversations.length; i += SYNC_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
                const remainingConversations = validConversations.slice(i);
                const remainingPsids = remainingConversations
                    .map(conv => {
                        const participant = conv.participants?.data?.find(p => p.id !== page.fb_page_id);
                        return participant?.id;
                    })
                    .filter((psid): psid is string => !!psid);

                logWarn('Approaching timeout, returning partial sync response', {
                    processedConversations: i,
                    totalConversations: validConversations.length,
                    remainingConversations: remainingConversations.length,
                    synced,
                    failed,
                    elapsedMs: elapsed
                });
                keepSyncLease = true;
                return NextResponse.json({
                    success: true,
                    partial: true,
                    message: `Processed ${i} of ${validConversations.length} conversations before timeout. ${remainingConversations.length} conversations remaining.`,
                    synced,
                    failed,
                    total: conversations.length,
                    tagged,
                    syncHadFailures: syncHadFailures || failed > 0,
                    processed: i,
                    remaining: remainingConversations.length,
                    remainingPsids: remainingPsids, // Return remaining PSIDs for automatic retry
                    cursor,
                    nextCursor,
                    syncStartedAt: syncStartTime,
                    syncRunId,
                    errors: errors.slice(0, 10)
                });
            }

            const batch = validConversations.slice(i, i + SYNC_BATCH_SIZE);
            const batchNumber = Math.floor(i / SYNC_BATCH_SIZE) + 1;
            const totalBatches = Math.ceil(validConversations.length / SYNC_BATCH_SIZE);

            if (batchNumber === 1 || batchNumber % 10 === 0 || batchNumber === totalBatches) {
                logInfo('Starting batch', {
                    batchNumber,
                    totalBatches,
                    batchSize: batch.length,
                    processedBeforeBatch: i,
                    synced,
                    failed
                });
            }

            // Process batch in parallel - use allSettled to continue even if some fail
            const batchPromises = batch.map(async (conversation) => {
                const participant = conversation.participants?.data?.find(
                    p => p.id !== page.fb_page_id
                );

                if (!participant || !participant.id) {
                    return { success: false, psid: 'unknown', error: 'No valid participant' };
                }

                try {
                    const existingContact = existingContactsByPsid.get(participant.id);
                    const existingName = normalizeContactName(existingContact?.name);
                    const participantName = normalizeContactName(participant.name);
                    const existingNameShouldBeCleared =
                        typeof existingContact?.name === 'string' &&
                        !hasUsableContactName(existingContact.name);

                    let name = pickPreferredContactName(existingName, participantName);
                    let profilePic = existingContact?.profile_pic || null;

                    // Try to fetch profile with timeout, but don't let it block the sync
                    const shouldFetchProfile = !hasUsableContactName(name) || !profilePic;
                    if (shouldFetchProfile) {
                        try {
                            const profile = await getUserProfile(participant.id, page.access_token, { timeoutMs: PROFILE_FETCH_TIMEOUT });
                            name = pickPreferredContactName(
                                profile.name,
                                composeContactName(profile.first_name, profile.last_name),
                                name
                            );
                            profilePic =
                                typeof profile.profile_pic === 'string' && profile.profile_pic.trim().length > 0
                                    ? profile.profile_pic.trim()
                                    : profilePic;
                        } catch (profileError) {
                            // Profile fetch failed or timed out, use basic info - continue anyway
                            // These are common for users with privacy settings or invalid PSIDs
                            // Only log if it's not a timeout or permission issue (reduce noise)
                            const errorMsg = (profileError as Error).message || String(profileError);
                            const isExpectedError = isExpectedFacebookProfileLookupError(errorMsg);

                            if (!isExpectedError) {
                                logWarn('Unexpected profile fetch error', {
                                    psid: participant.id,
                                    error: errorMsg
                                });
                            }
                        }
                    }

                    // Fetch conversation messages to analyze hour distribution
                    let bestContactHour: number | null = null;
                    let bestContactConfidence: string = 'none';
                    let bestContactHours: { hour: number; count: number }[] = [];
                    let interactionCount = 0;
                    let firstInteractionAt: string | null = null;
                    let lastInboundAt: string | null = null;
                    let messageSenderName: string | null = null;
                    let messages: ConversationMessage[] = [];
                    let historyError: unknown;

                    try {
                        // Reuse the history for timing, names, and Messenger lead/order tags.
                        messages = await getConversationMessages(
                            conversation.id,
                            page.access_token,
                            500,
                            { throwOnError: true, timeoutMs: 5_000, signal: AbortSignal.timeout(12_000) }
                        );

                        // Filter messages FROM the contact (not from the page)
                        const contactMessages = messages.filter(msg =>
                            msg.from?.id === participant.id && msg.created_time
                        );

                        messageSenderName = pickPreferredContactName(
                            ...contactMessages.map(msg => msg.from?.name)
                        );
                        name = pickPreferredContactName(name, messageSenderName);

                        if (contactMessages.length > 0) {
                            // Build hour distribution from all contact messages
                            // Convert to PHT (UTC+8)
                            const hourCounts: Record<number, number> = {};

                            for (const msg of contactMessages) {
                                const msgDate = new Date(msg.created_time);
                                const phtHour = getPhilippinesHour(msgDate);
                                hourCounts[phtHour] = (hourCounts[phtHour] || 0) + 1;
                            }

                            // Convert to sorted array of {hour, count}
                            bestContactHours = Object.entries(hourCounts)
                                .map(([hour, count]) => ({ hour: parseInt(hour), count }))
                                .sort((a, b) => b.count - a.count) // Sort by count descending
                                .slice(0, 5); // Keep top 5 hours

                            interactionCount = contactMessages.length;

                            // Find the earliest message — this is when the contact first interacted
                            const sortedByTime = [...contactMessages].sort((a, b) =>
                                new Date(a.created_time).getTime() - new Date(b.created_time).getTime()
                            );
                            firstInteractionAt = sortedByTime[0].created_time;
                            lastInboundAt = sortedByTime[sortedByTime.length - 1].created_time;

                            // Set primary best hour (most common)
                            if (bestContactHours.length > 0) {
                                bestContactHour = bestContactHours[0].hour;

                                // Determine confidence based on interaction count
                                if (interactionCount >= 10) {
                                    bestContactConfidence = 'high';
                                } else if (interactionCount >= 5) {
                                    bestContactConfidence = 'medium';
                                } else if (interactionCount >= 2) {
                                    bestContactConfidence = 'low';
                                } else {
                                    bestContactConfidence = 'inferred';
                                }
                            }
                        }
                    } catch (msgError) {
                        historyError = msgError;
                        // Message fetch failed, fallback to last interaction time
                        logWarn('Could not fetch conversation messages; using fallback heuristics', {
                            psid: participant.id,
                            conversationId: conversation.id,
                            error: (msgError as Error).message
                        });
                    }

                    // Fallback: if no messages analyzed, use last interaction time
                    if (bestContactHour === null && conversation.updated_time) {
                        const interactionDate = new Date(conversation.updated_time);
                        bestContactHour = getPhilippinesHour(interactionDate);
                        bestContactConfidence = 'inferred';
                        bestContactHours = [{ hour: bestContactHour, count: 1 }];
                        interactionCount = 1;
                    }

                    const { error: upsertError } = await databaseRequest(supabase
                        .from('contacts')
                        .upsert({
                            page_id: pageId,
                            psid: participant.id,
                            ...(name ? { name } : existingNameShouldBeCleared ? { name: null } : {}),
                            ...(profilePic ? { profile_pic: profilePic } : {}),
                            last_interaction_at: conversation.updated_time,
                            ...(lastInboundAt ? { last_inbound_at: lastInboundAt } : {}),
                            best_contact_hour: bestContactHour,
                            best_contact_confidence: bestContactConfidence,
                            best_contact_hours: bestContactHours,
                            interaction_count: interactionCount,
                            ...(firstInteractionAt && { first_interaction_at: firstInteractionAt }),
                            updated_at: new Date().toISOString()
                        }, {
                            onConflict: 'page_id,psid',
                            ignoreDuplicates: false
                        }));

                    if (!upsertError) {
                        existingContactsByPsid.set(participant.id, {
                            name: name || existingContact?.name || null,
                            profile_pic: profilePic || existingContact?.profile_pic || null
                        });
                    }

                    if (upsertError) {
                        logError('Error upserting contact', {
                            psid: participant.id,
                            conversationId: conversation.id,
                            error: upsertError.message
                        });
                        return { success: false, psid: participant.id, error: upsertError.message };
                    } else {
                        if (historyError && autoTagEnabled) {
                            throw new Error('Messenger history could not be checked for lead/order tags. Retry contact sync.');
                        }
                        const contactTagged = await applyMessengerTags(participant.id, messages);
                        return { success: true, psid: participant.id, tagged: contactTagged };
                    }
                } catch (error) {
                    logError('Unhandled error processing contact', {
                        psid: participant.id,
                        conversationId: conversation.id,
                        error: (error as Error).message
                    });
                    return { success: false, psid: participant.id, error: (error as Error).message };
                }
            });

            // Wait for all promises to settle (complete or fail)
            const batchResults = await Promise.allSettled(batchPromises);

            // Process results
            for (const result of batchResults) {
                if (result.status === 'fulfilled') {
                    if (result.value.success) {
                        synced++;
                        if (result.value.tagged) tagged++;
                    } else {
                        failed++;
                        if (result.value.error) {
                            errors.push(`Contact ${result.value.psid}: ${result.value.error}`);
                        }
                    }
                } else {
                    // Promise itself was rejected
                    failed++;
                    const errorMsg = result.reason instanceof Error ? result.reason.message : String(result.reason || 'Unknown error');
                    errors.push(`Unknown contact: ${errorMsg}`);
                }
            }

            const batchSynced = batchResults.filter(
                (result) => result.status === 'fulfilled' && result.value.success
            ).length;
            const batchFailed = batchResults.length - batchSynced;
            if (batchFailed > 0 || batchNumber % 10 === 0 || batchNumber === totalBatches) {
                logInfo('Batch completed', {
                    batchNumber,
                    totalBatches,
                    batchSynced,
                    batchFailed,
                    cumulativeSynced: synced,
                    cumulativeFailed: failed,
                    errorSamples: errors.slice(-3)
                });
            }

            // Add delay between batches to avoid rate limiting
            if (i + SYNC_BATCH_SIZE < validConversations.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }

            // Log progress every 50 contacts
            if ((i + SYNC_BATCH_SIZE) % 50 === 0 || i + SYNC_BATCH_SIZE >= validConversations.length) {
                const elapsed = Date.now() - startTime;
                const remaining = validConversations.length - (i + SYNC_BATCH_SIZE);
                const estimatedTimeRemaining = remaining > 0 ? Math.round((elapsed / (i + SYNC_BATCH_SIZE)) * remaining / 1000) : 0;
                logInfo('Sync progress', {
                    processed: Math.min(i + SYNC_BATCH_SIZE, validConversations.length),
                    total: validConversations.length,
                    synced,
                    failed,
                    elapsedSeconds: Math.round(elapsed / 1000),
                    estimatedRemainingSeconds: estimatedTimeRemaining
                });
            }
        }

        logInfo('Sync complete before metadata update', {
            synced,
            failed,
            restoredCount,
            totalValidConversations: validConversations.length,
            hasNextCursor: Boolean(nextCursor),
            elapsedMs: Date.now() - startTime,
            errorCount: errors.length,
            errorSamples: errors.slice(0, 5)
        });

        if (usePagedSync && nextCursor) {
            keepSyncLease = true;
            const responsePayload = {
                success: true,
                partial: true,
                message: `Processed ${validConversations.length} conversations. Continuing with next Facebook page.`,
                synced,
                failed,
                tagged,
                syncHadFailures: syncHadFailures || failed > 0,
                total: conversations.length,
                processed: validConversations.length,
                remaining: 0,
                remainingPsids: [],
                restored: restoredCount,
                incremental: isIncremental,
                cursor: nextCursor,
                nextCursor,
                syncStartedAt: syncStartTime,
                syncRunId,
                errors: errors.slice(0, 10)
            };

            logInfo('Returning paged sync continuation response', {
                ...responsePayload,
                fullErrorCount: errors.length
            });

            return NextResponse.json(responsePayload);
        }

        // Keep failed contact/tag work eligible for the next incremental sync.
        let checkpointSaved = false;
        if (!syncHadFailures && failed === 0) {
            const { error: checkpointError } = await databaseRequest(supabase
                .from('pages')
                .update({
                    last_synced_at: syncStartTime,
                    updated_at: new Date().toISOString()
                })
                .eq('id', pageId));

            if (checkpointError) {
                logWarn('Failed to update last_synced_at checkpoint', {
                    pageId,
                    syncStartTime,
                    error: checkpointError.message
                });
            } else {
                checkpointSaved = true;
                logInfo('Updated last_synced_at checkpoint', {
                    pageId,
                    syncStartTime
                });
            }
        }

        if (synced + failed < validConversations.length) {
            logWarn('Partial sync completed', {
                processed: synced + failed,
                totalValidConversations: validConversations.length,
                syncStartTime
            });
        }

        const responsePayload = {
            success: true,
            synced,
            failed,
            tagged,
            syncHadFailures: syncHadFailures || failed > 0,
            total: conversations.length,
            incremental: isIncremental,
            restored: restoredCount, // Number of deleted contacts that were re-added
            last_synced_at: checkpointSaved ? syncStartTime : page.last_synced_at,
            cursor: null,
            nextCursor: null,
            syncStartedAt: syncStartTime,
            syncRunId,
            errors: errors.slice(0, 10) // Return first 10 errors
        };

        logInfo('Returning sync response', {
            ...responsePayload,
            fullErrorCount: errors.length
        });

        return NextResponse.json(responsePayload);
    } catch (error) {
        logError('Unhandled error syncing contacts', {
            error: (error as Error).message
        });
        return NextResponse.json(
            { error: 'Failed to sync contacts', message: (error as Error).message,
                ...(error instanceof AccessError && error.status === 403 ? { requiresReconnect: true } : {}) },
            { status: error instanceof AccessError ? error.status : 500 }
        );
    } finally {
        if (syncLease && !keepSyncLease) {
            try { await releaseSyncLease(syncLease); }
            catch (error) { logWarn('Failed to release sync lease; it will expire automatically', { error: (error as Error).message }); }
        }
    }
}
