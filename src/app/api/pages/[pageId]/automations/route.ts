import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { normalizeWorkflowKeyword } from '@/lib/workflow-automations';

export const dynamic = 'force-dynamic';

const MAX_STOP_KEYWORDS = 20;
const MAX_COOLDOWN_MINUTES = 10080;

async function verifyPageAccess(supabase: ReturnType<typeof getSupabaseAdmin>, userId: string, pageId: string) {
    const { data: userPage, error } = await supabase
        .from('user_pages')
        .select('page_id')
        .eq('user_id', userId)
        .eq('page_id', pageId)
        .single();

    if (error || !userPage) {
        return false;
    }

    return true;
}

function normalizeStopKeywords(value: unknown): string[] {
    const rawKeywords = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(',')
            : [];

    return Array.from(
        new Set(
            rawKeywords
                .filter((item): item is string => typeof item === 'string')
                .map(normalizeWorkflowKeyword)
                .filter(Boolean)
        )
    ).slice(0, MAX_STOP_KEYWORDS);
}

function normalizeCooldownMinutes(value: unknown): number {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return 60;
    }

    return Math.min(MAX_COOLDOWN_MINUTES, Math.max(0, Math.round(numericValue)));
}

function normalizeAutomationBody(body: Record<string, unknown>) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const messageText = typeof body.message_text === 'string'
        ? body.message_text.trim()
        : typeof body.messageText === 'string'
            ? body.messageText.trim()
            : '';
    const pageStopCode = typeof body.page_stop_code === 'string'
        ? body.page_stop_code.trim()
        : typeof body.pageStopCode === 'string'
            ? body.pageStopCode.trim()
            : '';

    return {
        name,
        enabled: body.enabled !== false,
        message_text: messageText,
        stop_keywords: normalizeStopKeywords(body.stop_keywords ?? body.stopKeywords),
        page_stop_code: pageStopCode || null,
        cooldown_minutes: normalizeCooldownMinutes(body.cooldown_minutes ?? body.cooldownMinutes)
    };
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        if (!(await verifyPageAccess(supabase, session.user.id, pageId))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const { data, error } = await supabase
            .from('workflow_automations')
            .select('id, page_id, name, enabled, trigger_type, message_text, stop_keywords, page_stop_code, cooldown_minutes, created_at, updated_at')
            .eq('page_id', pageId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching workflow automations:', error);
            return NextResponse.json({ error: 'Failed to fetch automations', message: error.message }, { status: 500 });
        }

        return NextResponse.json({ items: data || [] });
    } catch (error) {
        console.error('Workflow automations GET error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}

export async function POST(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

        if (!(await verifyPageAccess(supabase, session.user.id, pageId))) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        const body = (await request.json()) as Record<string, unknown>;
        const automation = normalizeAutomationBody(body);

        if (!automation.name || !automation.message_text) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Automation name and message are required' },
                { status: 400 }
            );
        }

        const { data, error } = await supabase
            .from('workflow_automations')
            .insert({
                page_id: pageId,
                name: automation.name,
                enabled: automation.enabled,
                trigger_type: 'contact_reply',
                message_text: automation.message_text,
                stop_keywords: automation.stop_keywords,
                page_stop_code: automation.page_stop_code,
                cooldown_minutes: automation.cooldown_minutes,
                created_by: session.user.id
            })
            .select('id, page_id, name, enabled, trigger_type, message_text, stop_keywords, page_stop_code, cooldown_minutes, created_at, updated_at')
            .single();

        if (error) {
            console.error('Error creating workflow automation:', error);
            return NextResponse.json({ error: 'Failed to create automation', message: error.message }, { status: 500 });
        }

        return NextResponse.json({ automation: data }, { status: 201 });
    } catch (error) {
        console.error('Workflow automations POST error:', error);
        return NextResponse.json({ error: 'Internal error' }, { status: 500 });
    }
}
