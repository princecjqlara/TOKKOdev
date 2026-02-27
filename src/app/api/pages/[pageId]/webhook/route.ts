import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { subscribePageToAppWebhook } from '@/lib/facebook';

// POST /api/pages/[pageId]/webhook - Re-subscribe page to app webhook
export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
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
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        try {
            await subscribePageToAppWebhook(page.fb_page_id, page.access_token, ['messages', 'messaging_postbacks']);
        } catch (subscriptionError) {
            console.error('🔴 Failed to re-subscribe page webhook:', subscriptionError);
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
        console.error('Error re-subscribing page webhook:', error);
        return NextResponse.json(
            { error: 'Failed to resubscribe webhook', message: (error as Error).message },
            { status: 500 }
        );
    }
}
