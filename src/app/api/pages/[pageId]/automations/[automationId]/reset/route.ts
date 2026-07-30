import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

async function verifyPageAccess(supabase: ReturnType<typeof getSupabaseAdmin>, userId: string, pageId: string) {
    const { data: userPage, error } = await supabase
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId)
        .eq('page_id', pageId)
        .single();

    return !error && Boolean(userPage);
}

export async function POST(
    _request: NextRequest,
    { params }: { params: Promise<{ pageId: string; automationId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { pageId, automationId } = await params;
        const supabase = getSupabaseAdmin();

        if (!(await verifyPageAccess(supabase, session.user.id, pageId))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { data: automation, error: automationError } = await supabase
            .from('workflow_automations')
            .select('id')
            .eq('id', automationId)
            .eq('page_id', pageId)
            .single();

        if (automationError || !automation) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Automation not found' },
                { status: 404 }
            );
        }

        const { error } = await supabase
            .from('workflow_automation_states')
            .delete()
            .eq('automation_id', automationId);

        if (error) {
            console.error('Error resetting workflow automation:', error);
            return NextResponse.json({ error: 'Failed to reset automation', message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Workflow automation reset error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
