import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageTemplates } from '@/lib/facebook';

function getTemplateFetchFailure(error: unknown) {
    const message = (error as Error).message || 'Failed to fetch templates from Facebook';
    const isTokenError =
        message.includes('code=190') ||
        message.toLowerCase().includes('validating access token') ||
        message.toLowerCase().includes('access token');

    if (isTokenError) {
        return NextResponse.json(
            {
                error: 'Facebook Token Invalid',
                message: 'Facebook rejected this page token. Reconnect this page to refresh permissions before submitting or checking templates.',
                detail: message
            },
            { status: 502 }
        );
    }

    return NextResponse.json(
        {
            error: 'Facebook Template Fetch Failed',
            message: 'Facebook could not return templates for this page right now.',
            detail: message
        },
        { status: 502 }
    );
}

export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { searchParams } = new URL(request.url);
        const pageId = searchParams.get('pageId');

        if (!pageId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        const { data: userPage, error: userPageError } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (userPageError || !userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const { data: page, error: pageError } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (pageError || !page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        let rawTemplates: Record<string, unknown>[];
        try {
            rawTemplates = await getPageTemplates(page.fb_page_id, page.access_token);
        } catch (error) {
            console.warn('[TEMPLATE_STATUS] Failed to fetch Facebook templates:', {
                pageId,
                fbPageId: page.fb_page_id,
                error: (error as Error).message
            });
            return getTemplateFetchFailure(error);
        }

        const templates = rawTemplates.map((t: Record<string, unknown>) => {
            const status = typeof t.status === 'string' ? t.status.toUpperCase() : 'UNKNOWN';
            const language =
                typeof t.language === 'string'
                    ? t.language
                    : typeof t.language === 'object' && t.language !== null
                        ? (t.language as Record<string, unknown>).code || 'en_US'
                        : 'en_US';

            // Extract body text from components
            let bodyText = '';
            if (Array.isArray(t.components)) {
                const bodyComp = (t.components as Record<string, unknown>[]).find(
                    (c) => c.type === 'BODY'
                );
                if (bodyComp && typeof bodyComp.text === 'string') {
                    bodyText = bodyComp.text;
                }
            }

            return {
                id: t.id || null,
                name: t.name || null,
                status,
                category: typeof t.category === 'string' ? t.category.toUpperCase() : 'UNKNOWN',
                language,
                bodyText
            };
        });

        return NextResponse.json({ templates });
    } catch (error) {
        console.error('Error fetching template statuses:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}
