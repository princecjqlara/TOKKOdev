import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const db = getSupabaseAdmin();
    const { data: access, error: accessError } = await db.from('user_pages').select('page_id').eq('user_id', session.user.id);
    if (accessError) return NextResponse.json({ error: 'Could not load page access' }, { status: 500 });
    const ids = (access || []).map(row => row.page_id);
    if (!ids.length) return NextResponse.json({ pages: [] });
    const { data, error } = await db.from('pages')
        .select('id,messaging_auto_tag_enabled,messaging_auto_tag_last_error')
        .in('id', ids);
    if (error) return NextResponse.json({ error: 'Could not load auto-tag settings' }, { status: 500 });
    return NextResponse.json({ pages: data });
}

export async function PUT(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const body = await request.json().catch(() => null);
    if (!body || typeof body.pageId !== 'string' || typeof body.enabled !== 'boolean') {
        return NextResponse.json({ error: 'pageId and enabled are required' }, { status: 400 });
    }
    const db = getSupabaseAdmin();
    const { data: access, error: accessError } = await db.from('user_pages').select('page_id')
        .eq('user_id', session.user.id).eq('page_id', body.pageId).maybeSingle();
    if (accessError || !access) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const { data, error } = await db.from('pages').update({ messaging_auto_tag_enabled: body.enabled })
        .eq('id', body.pageId).select('id,messaging_auto_tag_enabled').single();
    if (error) return NextResponse.json({ error: 'Could not save auto-tag setting' }, { status: 500 });
    return NextResponse.json({ page: data });
}
