import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { subscribePageToAppWebhook } from '@/lib/facebook';

// POST /api/pages/[pageId]/webhook - Re-subscribe page to app webhook
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    const requestId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const logPrefix = `[PAGE_WEBHOOK_REFRESH][${requestId}]`;
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
        const session = await getSessionFromRequest(request);

        if (!session) {
            logWarn('Unauthorized webhook refresh request');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            logWarn('Session missing user id during webhook refresh', {
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

        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', userId)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            logWarn('Webhook refresh forbidden for user/page pair', {
                userId,
                pageId
            });
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const { data: page } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (!page) {
            logWarn('Webhook refresh target page not found', {
                userId,
                pageId
            });
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        try {
            await subscribePageToAppWebhook(page.fb_page_id, page.access_token, ['messages', 'messaging_postbacks']);
            logInfo('Successfully refreshed page webhook subscription', {
                userId,
                pageId,
                fbPageId: page.fb_page_id
            });
        } catch (subscriptionError) {
            logError('Failed to re-subscribe page webhook', {
                userId,
                pageId,
                fbPageId: page.fb_page_id,
                error: (subscriptionError as Error).message
            });
            return NextResponse.json(
                {
                    error: 'Webhook Subscription Failed',
                    message: `Could not subscribe this page to webhook events. ${(subscriptionError as Error).message}`
                },
                { status: 502 }
            );
        }

        return NextResponse.json({
            success: true,
            message: 'Page webhook subscription refreshed'
        });
    } catch (error) {
        logError('Unhandled error re-subscribing page webhook', {
            error: (error as Error).message
        });
        return NextResponse.json(
            { error: 'Failed to resubscribe webhook', message: (error as Error).message },
            { status: 500 }
        );
    }
}
