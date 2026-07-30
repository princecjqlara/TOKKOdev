import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { normalizeWorkflowReplyAction, normalizeWorkflowSteps } from '@/lib/workflow-automations';

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

function buildPatchPayload(body: Record<string, unknown>) {
    const payload: Record<string, unknown> = {};

    if (typeof body.name === 'string') {
        const name = body.name.trim();
        if (!name) {
            throw new Error('Automation name is required');
        }
        payload.name = name;
    }

    if (typeof body.enabled === 'boolean') {
        payload.enabled = body.enabled;
    }

    const hasMessageText = typeof body.message_text === 'string' || typeof body.messageText === 'string';
    const messageText = typeof body.message_text === 'string' ? body.message_text.trim() : String(body.messageText || '').trim();

    if (hasMessageText) {
        if (!messageText) {
            throw new Error('Automation message is required');
        }
        payload.message_text = messageText;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'steps')) {
        const steps = normalizeWorkflowSteps(body.steps, messageText, body.cooldown_minutes ?? body.cooldownMinutes);
        if (steps.length === 0) {
            throw new Error('At least one follow-up step is required');
        }
        payload.steps = steps;
        payload.message_text = steps[0].message_text;
        payload.cooldown_minutes = steps[0].delay_minutes;
        payload.trigger_type = 'follow_up';
    }

    if (Object.prototype.hasOwnProperty.call(body, 'page_stop_code') || Object.prototype.hasOwnProperty.call(body, 'pageStopCode')) {
        const pageStopCode = typeof body.page_stop_code === 'string'
            ? body.page_stop_code.trim()
            : typeof body.pageStopCode === 'string'
                ? body.pageStopCode.trim()
                : '';
        payload.page_stop_code = pageStopCode || null;
    }

    if (Object.prototype.hasOwnProperty.call(body, 'reply_action') || Object.prototype.hasOwnProperty.call(body, 'replyAction')) {
        payload.reply_action = normalizeWorkflowReplyAction(body.reply_action ?? body.replyAction);
    }

    if (Object.keys(payload).length === 0) {
        throw new Error('No changes provided');
    }

    payload.updated_at = new Date().toISOString();
    return payload;
}

export async function PATCH(
    request: NextRequest,
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

        let payload: Record<string, unknown>;
        try {
            payload = buildPatchPayload((await request.json()) as Record<string, unknown>);
        } catch (error) {
            return NextResponse.json(
                { error: 'Bad Request', message: (error as Error).message },
                { status: 400 }
            );
        }

        const { data, error } = await supabase
            .from('workflow_automations')
            .update(payload)
            .eq('id', automationId)
            .eq('page_id', pageId)
            .select('id, page_id, name, enabled, trigger_type, message_text, steps, reply_action, page_stop_code, cooldown_minutes, created_at, updated_at')
            .single();

        if (error) {
            console.error('Error updating workflow automation:', error);
            return NextResponse.json({ error: 'Failed to update automation', message: error.message }, { status: 500 });
        }

        return NextResponse.json({ automation: data });
    } catch (error) {
        console.error('Workflow automation PATCH error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}

export async function DELETE(
    request: NextRequest,
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

        const { error } = await supabase
            .from('workflow_automations')
            .delete()
            .eq('id', automationId)
            .eq('page_id', pageId);

        if (error) {
            console.error('Error deleting workflow automation:', error);
            return NextResponse.json({ error: 'Failed to delete automation', message: error.message }, { status: 500 });
        }

        return NextResponse.json({ success: true });
    } catch (error) {
        console.error('Workflow automation DELETE error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
