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

        // Get page details
        const { data: page } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (!page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        console.log(`🔵 Starting sync for page: ${page.fb_page_id} (${pageId})`);

        // Fetch conversations from Facebook
        let conversations;
        try {
            conversations = await getPageConversations(
                page.fb_page_id,
                page.access_token
            );
            console.log(`🔵 Fetched ${conversations.length} conversations from Facebook`);
        } catch (error) {
            console.error('🔴 Error fetching conversations from Facebook:', error);
            return NextResponse.json(
                { error: 'Failed to fetch conversations', message: (error as Error).message },
                { status: 500 }
            );
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

        // Filter valid conversations first
        const validConversations = conversations.filter(conv => {
            const participant = conv.participants?.data?.find(p => p.id !== page.fb_page_id);
            return participant && participant.id;
        });

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
                        // Don't log timeout errors to reduce noise
                        if (!(profileError as Error).message.includes('timeout')) {
                            console.warn(`⚠️ Failed to fetch profile for ${participant.id}:`, (profileError as Error).message);
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

        console.log(`✅ Sync complete: ${synced} synced, ${failed} failed`);

        return NextResponse.json({
            success: true,
            synced,
            failed,
            total: conversations.length,
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
