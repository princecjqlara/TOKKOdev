import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';

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
          created_at
        )
      `)
            .eq('user_id', userId);

        if (error) throw error;

        const pages = userPages?.map(up => up.pages) || [];

        return NextResponse.json({ pages });
    } catch (error) {
        console.error('Error fetching pages:', error);
        return NextResponse.json(
            { error: 'Failed to fetch pages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
