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

        for (const conversation of conversations) {
            const participant = conversation.participants?.data?.find(
                p => p.id !== page.fb_page_id
            );

            if (!participant || !participant.id) {
                console.warn(`⚠️ Skipping conversation - no valid participant`);
                continue;
            }

            try {
                let profilePic: string | undefined;
                let name = participant.name;

                try {
                    const profile = await getUserProfile(participant.id, page.access_token);
                    name = profile.name || name;
                    profilePic = profile.profile_pic;
                } catch (profileError) {
                    // Profile fetch failed, use basic info
                    console.warn(`⚠️ Failed to fetch profile for ${participant.id}:`, (profileError as Error).message);
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
                    failed++;
                    errors.push(`Contact ${participant.id}: ${upsertError.message}`);
                } else {
                    synced++;
                }
            } catch (error) {
                console.error(`🔴 Error processing contact:`, error);
                failed++;
                errors.push((error as Error).message);
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
