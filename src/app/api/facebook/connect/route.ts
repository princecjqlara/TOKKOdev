import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';

// POST /api/facebook/connect - Connect a Facebook page
export async function POST(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            console.error('🔴 No session found in /api/facebook/connect');
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

        const body = await request.json();
        const { fbPageId, name, accessToken } = body;

        if (!fbPageId || !name || !accessToken) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields: fbPageId, name, accessToken' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Check if page already exists
        const { data: existingPage } = await supabase
            .from('pages')
            .select('id')
            .eq('fb_page_id', fbPageId)
            .single();

        let pageId: string;

        if (existingPage) {
            // Update existing page with new access token
            const { error: updateError } = await supabase
                .from('pages')
                .update({
                    access_token: accessToken,
                    name,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingPage.id);

            if (updateError) throw updateError;
            pageId = existingPage.id;
        } else {
            // Create new page
            const { data: newPage, error: pageError } = await supabase
                .from('pages')
                .insert({
                    fb_page_id: fbPageId,
                    name,
                    access_token: accessToken
                })
                .select('id')
                .single();

            if (pageError) throw pageError;
            pageId = newPage.id;
        }

        // Link user to page
        const { error: linkError } = await supabase
            .from('user_pages')
            .upsert({
                user_id: userId,
                page_id: pageId
            }, {
                onConflict: 'user_id,page_id'
            });

        if (linkError) throw linkError;

        return NextResponse.json({
            success: true,
            pageId,
            message: 'Page connected successfully'
        });
    } catch (error) {
        console.error('Error connecting Facebook page:', error);
        return NextResponse.json(
            { error: 'Failed to connect page', message: (error as Error).message },
            { status: 500 }
        );
    }
}
