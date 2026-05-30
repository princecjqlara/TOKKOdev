import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

type PageRecord = {
    id: string;
    fb_page_id: string;
    name: string;
    business_id: string | null;
    created_at: string;
    updated_at: string;
    access_token?: string | null;
};

type PageTokenStatus = 'valid' | 'invalid' | 'unknown';

function withoutAccessToken(page: PageRecord) {
    const { access_token: _accessToken, ...safePage } = page;
    return safePage;
}

async function getPageTokenStatus(page: PageRecord): Promise<PageTokenStatus> {
    if (!page.access_token) {
        return 'invalid';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);

    try {
        const tokenProbeUrl = new URL(`https://graph.facebook.com/v21.0/${page.fb_page_id}`);
        tokenProbeUrl.searchParams.set('fields', 'id');
        tokenProbeUrl.searchParams.set('access_token', page.access_token);

        const response = await fetch(tokenProbeUrl, {
            signal: controller.signal
        });
        const body = await response
            .json()
            .catch(() => ({} as { id?: string; error?: { message?: string; code?: number } }));

        const errorMessage = body.error?.message || '';
        const isTokenError =
            body.error?.code === 190 ||
            errorMessage.includes('must be granted before impersonating') ||
            errorMessage.toLowerCase().includes('validating access token') ||
            errorMessage.toLowerCase().includes('access token');

        if (!response.ok) {
            if (isTokenError) {
                return 'invalid';
            }

            console.warn('[PAGES_GET] Could not verify page token status', {
                pageId: page.id,
                fbPageId: page.fb_page_id,
                status: response.status,
                error: errorMessage || null
            });
            return 'unknown';
        }

        return body.id === page.fb_page_id ? 'valid' : 'unknown';
    } catch (error) {
        console.warn('[PAGES_GET] Page token status check failed', {
            pageId: page.id,
            fbPageId: page.fb_page_id,
            error: (error as Error).message
        });
        return 'unknown';
    } finally {
        clearTimeout(timeout);
    }
}

// GET /api/pages - Get user's connected pages
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            console.error('🔴 No session found in /api/pages');
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

        console.log('🔵 Session found:', { 
            email: session.user?.email, 
            userId 
        });

        const supabase = getSupabaseAdmin();

        const { data: userPages, error } = await supabase
            .from('user_pages')
            .select(`
        page_id,
        pages (
          id,
          fb_page_id,
          name,
          business_id,
          created_at,
          updated_at,
          access_token
        )
      `)
            .eq('user_id', userId);

        if (error) throw error;

        const pageRecords = (userPages
            ?.map((up) => Array.isArray(up.pages) ? up.pages[0] : up.pages)
            .filter(Boolean) || []) as PageRecord[];

        const pageStatuses = await Promise.all(
            pageRecords.map(async (page) => ({
                page,
                tokenStatus: await getPageTokenStatus(page)
            }))
        );

        const sortedPages = pageStatuses
            .sort((a, b) => {
                if (a.tokenStatus !== b.tokenStatus) {
                    if (a.tokenStatus === 'valid') return -1;
                    if (b.tokenStatus === 'valid') return 1;
                    if (a.tokenStatus === 'invalid') return 1;
                    if (b.tokenStatus === 'invalid') return -1;
                }

                const updatedDiff = new Date(b.page.updated_at || b.page.created_at).getTime() - new Date(a.page.updated_at || a.page.created_at).getTime();
                if (updatedDiff !== 0) return updatedDiff;
                return a.page.name.localeCompare(b.page.name);
            });

        const pages = sortedPages
            .filter(({ tokenStatus }) => tokenStatus !== 'invalid')
            .map(({ page }) => withoutAccessToken(page));
        const reconnectRequiredPages = sortedPages
            .filter(({ tokenStatus }) => tokenStatus === 'invalid')
            .map(({ page }) => ({
                ...withoutAccessToken(page),
                requiresReconnect: true
            }));

        return NextResponse.json({ pages, reconnectRequiredPages });
    } catch (error) {
        console.error('Error fetching pages:', error);
        return NextResponse.json(
            { error: 'Failed to fetch pages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
