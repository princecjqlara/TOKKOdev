import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageConversations, getUserProfile } from '@/lib/facebook';

// Increase timeout for sync operations (up to 5 minutes)
export const maxDuration = 300;

// POST /api/pages/[pageId]/sync - Manual sync contacts
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            console.error('🔴 No session found in /api/pages/[pageId]/sync');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            console.error('🔴 No user ID in session:', session.user);
            return NextResponse.json(
                { error: 'Unauthorized', message: 'User not found. Please sign in again.' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        // Check if user wants to force a full sync (optional body parameter)
        let forceFullSync = false;
        try {
            const body = await request.json();
            forceFullSync = (body as { forceFullSync?: boolean })?.forceFullSync === true;
        } catch {
            // No body provided, use default (incremental sync)
        }

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', userId)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Get page details including last_synced_at
        const { data: page } = await supabase
            .from('pages')
            .select('fb_page_id, access_token, last_synced_at')
            .eq('id', pageId)
            .single();

        if (!page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        // Determine if this is a full sync or incremental sync
        const isIncremental = !forceFullSync && !!page.last_synced_at;
        const syncStartTime = new Date().toISOString();
        
        console.log(`🔵 Starting ${isIncremental ? 'incremental' : 'full'} sync for page: ${page.fb_page_id} (${pageId})`);
        if (isIncremental) {
            console.log(`🔵 Last synced: ${page.last_synced_at}, fetching only new/updated conversations`);
        } else if (forceFullSync) {
            console.log(`🔵 Force full sync requested - syncing all conversations`);
        }

        // Fetch conversations from Facebook (only new ones if incremental)
        let conversations;
        try {
            conversations = await getPageConversations(
                page.fb_page_id,
                page.access_token,
                100,
                true,
                isIncremental ? page.last_synced_at : undefined
            );
            console.log(`🔵 Fetched ${conversations.length} ${isIncremental ? 'new/updated' : ''} conversations from Facebook`);
        } catch (error) {
            console.error('🔴 Error fetching conversations from Facebook:', error);
            return NextResponse.json(
                { error: 'Failed to fetch conversations', message: (error as Error).message },
                { status: 500 }
            );
        }

        // Filter valid conversations first
        const validConversations = conversations.filter(conv => {
            const participant = conv.participants?.data?.find(p => p.id !== page.fb_page_id);
            return participant && participant.id;
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
        if (conversationPsids.size > 0) {
            try {
                const { data: existingContacts } = await supabase
                    .from('contacts')
                    .select('psid')
                    .eq('page_id', pageId)
                    .in('psid', Array.from(conversationPsids));

                const existingPsids = new Set((existingContacts || []).map(c => c.psid));
                const missingPsids = Array.from(conversationPsids).filter(psid => !existingPsids.has(psid));

                if (missingPsids.length > 0) {
                    restoredCount = missingPsids.length;
                    console.log(`🔵 Found ${restoredCount} deleted contacts to restore (they still exist in Facebook conversations)`);
                }
            } catch (error) {
                // Don't fail the sync if checking for deleted contacts fails
                console.warn('⚠️ Error checking for deleted contacts (non-critical):', (error as Error).message);
            }
        }

        let synced = 0;
        let failed = 0;
        const errors: string[] = [];

        // Process contacts in parallel batches to avoid timeout
        const SYNC_BATCH_SIZE = 10; // Process 10 contacts in parallel (reduced for faster processing)
        const DELAY_BETWEEN_BATCHES = 30; // 30ms delay between batches
        const MAX_PROCESSING_TIME = 240000; // 4 minutes (leave 1 minute buffer before 5 min timeout)
        const PROFILE_FETCH_TIMEOUT = 3000; // 3 seconds max per profile fetch
        const startTime = Date.now();

        console.log(`Processing ${validConversations.length} valid conversations in batches of ${SYNC_BATCH_SIZE}`);

        for (let i = 0; i < validConversations.length; i += SYNC_BATCH_SIZE) {
            // Check if we're approaching timeout
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_PROCESSING_TIME) {
                console.warn(`⚠️ Approaching timeout, processed ${i}/${validConversations.length} conversations. Returning partial results.`);
                return NextResponse.json({
                    success: true,
                    partial: true,
                    message: `Processed ${i} of ${validConversations.length} conversations before timeout. Please sync again to continue.`,
                    synced,
                    failed,
                    total: conversations.length,
                    processed: i,
                    errors: errors.slice(0, 10)
                });
            }

            const batch = validConversations.slice(i, i + SYNC_BATCH_SIZE);

            // Process batch in parallel - use allSettled to continue even if some fail
            const batchPromises = batch.map(async (conversation) => {
                const participant = conversation.participants?.data?.find(
                    p => p.id !== page.fb_page_id
                );

                if (!participant || !participant.id) {
                    return { success: false, psid: 'unknown', error: 'No valid participant' };
                }

                try {
                    let profilePic: string | undefined;
                    let name = participant.name;

                    // Try to fetch profile with timeout, but don't let it block the sync
                    try {
                        const profilePromise = getUserProfile(participant.id, page.access_token);
                        const timeoutPromise = new Promise((_, reject) => 
                            setTimeout(() => reject(new Error('Profile fetch timeout')), PROFILE_FETCH_TIMEOUT)
                        );
                        
                        const profile = await Promise.race([profilePromise, timeoutPromise]) as { name: string; profile_pic?: string };
                        name = profile.name || name;
                        profilePic = profile.profile_pic;
                    } catch (profileError) {
                        // Profile fetch failed or timed out, use basic info - continue anyway
                        // These are common for users with privacy settings or invalid PSIDs
                        // Only log if it's not a timeout or permission issue (reduce noise)
                        const errorMsg = (profileError as Error).message || String(profileError);
                        const isExpectedError = 
                            errorMsg.includes('timeout') || 
                            errorMsg.includes('does not exist') || 
                            errorMsg.includes('missing permissions') ||
                            errorMsg.includes('does not support this operation');
                        
                        if (!isExpectedError) {
                            console.warn(`⚠️ Failed to fetch profile for ${participant.id}:`, errorMsg);
                        }
                    }

                    const { error: upsertError } = await supabase
                        .from('contacts')
                        .upsert({
                            page_id: pageId,
                            psid: participant.id,
                            name,
                            profile_pic: profilePic,
                            last_interaction_at: conversation.updated_time,
                            updated_at: new Date().toISOString()
                        }, {
                            onConflict: 'page_id,psid'
                        });

                    if (upsertError) {
                        console.error(`🔴 Error upserting contact ${participant.id}:`, upsertError);
                        return { success: false, psid: participant.id, error: upsertError.message };
                    } else {
                        return { success: true, psid: participant.id };
                    }
                } catch (error) {
                    console.error(`🔴 Error processing contact ${participant.id}:`, error);
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

            // Add delay between batches to avoid rate limiting
            if (i + SYNC_BATCH_SIZE < validConversations.length) {
                await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_BATCHES));
            }

            // Log progress every 50 contacts
            if ((i + SYNC_BATCH_SIZE) % 50 === 0 || i + SYNC_BATCH_SIZE >= validConversations.length) {
                const elapsed = Date.now() - startTime;
                const remaining = validConversations.length - (i + SYNC_BATCH_SIZE);
                const estimatedTimeRemaining = remaining > 0 ? Math.round((elapsed / (i + SYNC_BATCH_SIZE)) * remaining / 1000) : 0;
                console.log(`Progress: ${Math.min(i + SYNC_BATCH_SIZE, validConversations.length)}/${validConversations.length} conversations processed (Synced: ${synced}, Failed: ${failed}, Elapsed: ${Math.round(elapsed/1000)}s, Est. remaining: ${estimatedTimeRemaining}s)`);
            }
        }

        console.log(`✅ Sync complete: ${synced} synced, ${failed} failed${restoredCount > 0 ? `, ${restoredCount} deleted contacts restored` : ''}`);

        // Update last_synced_at timestamp
        await supabase
            .from('pages')
            .update({
                last_synced_at: syncStartTime,
                updated_at: new Date().toISOString()
            })
            .eq('id', pageId);

        return NextResponse.json({
            success: true,
            synced,
            failed,
            total: conversations.length,
            incremental: isIncremental,
            restored: restoredCount, // Number of deleted contacts that were re-added
            last_synced_at: syncStartTime,
            errors: errors.slice(0, 10) // Return first 10 errors
        });
    } catch (error) {
        console.error('Error syncing contacts:', error);
        return NextResponse.json(
            { error: 'Failed to sync contacts', message: (error as Error).message },
            { status: 500 }
        );
    }
}
