import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageConversations, getUserProfile } from '@/lib/facebook';
import { normalizeContactName, pickPreferredContactName } from '../../../../lib/contact-names';

// Secret key for cron job authentication
const CRON_SECRET = process.env.CRON_SECRET;

// GET /api/cron/sync - Sync all pages (called by external cron service)
export async function GET(request: NextRequest) {
    try {
        // Verify cron secret
        const authHeader = request.headers.get('authorization');
        const url = new URL(request.url);
        const secretParam = url.searchParams.get('secret');

        const providedSecret = authHeader?.replace('Bearer ', '') || secretParam;

        if (providedSecret !== CRON_SECRET) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Invalid cron secret' },
                { status: 401 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Get all pages
        const { data: pages, error: pagesError } = await supabase
            .from('pages')
            .select('id, fb_page_id, access_token, name');

        if (pagesError) throw pagesError;

        if (!pages?.length) {
            return NextResponse.json({
                success: true,
                message: 'No pages to sync',
                results: []
            });
        }

        const results = [];

        for (const page of pages) {
            try {
                // Fetch conversations from Facebook
                const conversations = await getPageConversations(
                    page.fb_page_id,
                    page.access_token,
                    50 // Limit for cron job
                );

                let synced = 0;
                let failed = 0;

                for (const conversation of conversations) {
                    const participant = conversation.participants.data.find(
                        p => p.id !== page.fb_page_id
                    );

                    if (!participant) continue;

                try {
                        let profilePic: string | undefined;
                        const participantName = normalizeContactName(participant.name);
                        let name = participantName;

                        try {
                            const profile = await getUserProfile(participant.id, page.access_token);
                            const first = typeof profile.first_name === 'string' ? profile.first_name.trim() : '';
                            const last = typeof profile.last_name === 'string' ? profile.last_name.trim() : '';
                            const composedProfileName = [first, last].filter(Boolean).join(' ');

                            name = pickPreferredContactName(profile.name, composedProfileName, participantName);
                            profilePic = profile.profile_pic;
                        } catch {
                            // Profile fetch failed, use basic info
                        }

                        await supabase
                            .from('contacts')
                            .upsert({
                                page_id: page.id,
                                psid: participant.id,
                                ...(name ? { name } : {}),
                                profile_pic: profilePic,
                                last_interaction_at: conversation.updated_time,
                                updated_at: new Date().toISOString()
                            }, {
                                onConflict: 'page_id,psid'
                            });

                        synced++;
                    } catch {
                        failed++;
                    }
                }

                results.push({
                    pageId: page.id,
                    pageName: page.name,
                    synced,
                    failed,
                    total: conversations.length
                });
            } catch (error) {
                results.push({
                    pageId: page.id,
                    pageName: page.name,
                    error: (error as Error).message
                });
            }
        }

        return NextResponse.json({
            success: true,
            timestamp: new Date().toISOString(),
            results
        });
    } catch (error) {
        console.error('Cron sync error:', error);
        return NextResponse.json(
            { error: 'Cron job failed', message: (error as Error).message },
            { status: 500 }
        );
    }
}
