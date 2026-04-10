import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

// GET /api/pages/[pageId]/welcome - Get welcome message config
export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        // Verify user has access to this page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { data, error } = await supabase
            .from('welcome_messages')
            .select('*')
            .eq('page_id', pageId)
            .single();

        if (error && error.code !== 'PGRST116') {
            // PGRST116 = no rows found, which is fine
            console.error('Error fetching welcome config:', error);
            return NextResponse.json({ error: 'Failed to fetch' }, { status: 500 });
        }

        // Return config or defaults
        return NextResponse.json({
            config: data || {
                page_id: pageId,
                enabled: false,
                message_text: '',
                buttons: []
            }
        });
    } catch (error) {
        console.error('Welcome GET error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}

// PUT /api/pages/[pageId]/welcome - Create or update welcome message config
export async function PUT(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        // Verify user has access to this page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = await request.json();
        const { enabled, message_text, buttons } = body;

        const { data, error } = await supabase
            .from('welcome_messages')
            .upsert({
                page_id: pageId,
                enabled: enabled ?? false,
                message_text: message_text ?? '',
                buttons: buttons ?? [],
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'page_id'
            })
            .select()
            .single();

        if (error) {
            console.error('Error saving welcome config:', error);
            return NextResponse.json({ error: 'Failed to save' }, { status: 500 });
        }

        return NextResponse.json({ config: data });
    } catch (error) {
        console.error('Welcome PUT error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
