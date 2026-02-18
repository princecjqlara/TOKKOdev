import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { sendUtilityMessage } from '@/lib/facebook';

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { pageId, recipientPsid, templateName, language = 'en', messageText } = body;

        if (!pageId || !recipientPsid || !templateName || !messageText) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId, recipientPsid, templateName, and messageText are required' },
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

        const result = await sendUtilityMessage(
            page.fb_page_id,
            page.access_token,
            recipientPsid,
            templateName,
            language,
            messageText
        );

        return NextResponse.json({
            success: true,
            messageId: result.message_id,
            recipientId: result.recipient_id
        });
    } catch (error) {
        console.error('Error sending utility message:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}
