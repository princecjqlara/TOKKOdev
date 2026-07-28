import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageConversations, getUserProfile } from '@/lib/facebook';
import { composeContactName, normalizeContactName, pickPreferredContactName } from '../../../../lib/contact-names';
import { repairMissingContactNamesForPage } from '../../../../lib/contact-name-repair';

export const dynamic = 'force-dynamic';

// GET /api/cron/sync - Sync all pages (called by external cron service)
export async function GET(_request: NextRequest) {
    try {
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
                    50,
                    false // Keep cron lightweight; full imports use the manual paged sync route.
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
                            name = pickPreferredContactName(
                                profile.name,
                                composeContactName(profile.first_name, profile.last_name),
                                participantName
                            );
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

                const nameRepair = await repairMissingContactNamesForPage(supabase, page, {
                    limit: 200
                });

                results.push({
                    pageId: page.id,
                    pageName: page.name,
                    synced,
                    failed,
                    total: conversations.length,
                    nameRepair
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
