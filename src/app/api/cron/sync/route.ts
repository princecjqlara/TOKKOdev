import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageConversations, getUserProfile } from '@/lib/facebook';
import { composeContactName, normalizeContactName, pickPreferredContactName } from '../../../../lib/contact-names';
import { repairMissingContactNamesForPage } from '../../../../lib/contact-name-repair';

export const dynamic = 'force-dynamic';

const MAX_PAGES_PER_RUN = 1;
const CONVERSATION_LIMIT_PER_PAGE = 5;
const NAME_REPAIR_LIMIT_PER_PAGE = 5;
const CONVERSATION_FETCH_TIMEOUT_MS = 5000;
const PROFILE_FETCH_TIMEOUT_MS = 1500;
const NAME_REPAIR_TIMEOUT_MS = 5000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
            })
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

async function markPageAttempted(supabase: any, pageId: string) {
    try {
        const { error } = await supabase
            .from('pages')
            .update({
                updated_at: new Date().toISOString()
            })
            .eq('id', pageId);

        if (error) {
            console.warn('Failed to update cron sync checkpoint:', error);
        }
    } catch (error) {
        console.warn('Failed to update cron sync checkpoint:', error);
    }
}

// GET /api/cron/sync - Sync all pages (called by external cron service)
export async function GET(request: NextRequest) {
    try {
        const supabase = getSupabaseAdmin();
        const url = new URL(request.url);
        const requestedPageLimit = Number(url.searchParams.get('pageLimit'));
        const pageLimit =
            Number.isFinite(requestedPageLimit) && requestedPageLimit > 0
                ? Math.min(Math.floor(requestedPageLimit), MAX_PAGES_PER_RUN)
                : MAX_PAGES_PER_RUN;

        // Process the least recently touched page first so public cron runs rotate quickly.
        const { data: pages, error: pagesError } = await supabase
            .from('pages')
            .select('id, fb_page_id, access_token, name, updated_at')
            .order('updated_at', { ascending: true, nullsFirst: true })
            .limit(pageLimit);

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
                const conversations = await withTimeout(
                    getPageConversations(
                        page.fb_page_id,
                        page.access_token,
                        CONVERSATION_LIMIT_PER_PAGE,
                        false // Keep cron lightweight; full imports use the manual paged sync route.
                    ),
                    CONVERSATION_FETCH_TIMEOUT_MS,
                    'Facebook conversation fetch'
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
                            const profile = await withTimeout(
                                getUserProfile(participant.id, page.access_token),
                                PROFILE_FETCH_TIMEOUT_MS,
                                'Facebook profile fetch'
                            );
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

                const nameRepair = await withTimeout(
                    repairMissingContactNamesForPage(supabase, page, {
                        limit: NAME_REPAIR_LIMIT_PER_PAGE
                    }),
                    NAME_REPAIR_TIMEOUT_MS,
                    'Contact name repair'
                );

                await markPageAttempted(supabase, page.id);

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
                await markPageAttempted(supabase, page.id);
            }
        }

        return NextResponse.json({
            success: true,
            timestamp: new Date().toISOString(),
            pageLimit,
            conversationLimitPerPage: CONVERSATION_LIMIT_PER_PAGE,
            nameRepairLimitPerPage: NAME_REPAIR_LIMIT_PER_PAGE,
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
