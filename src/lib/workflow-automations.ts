import { sendMessage, sendMessengerMediaAttachment } from './facebook';
import { ContactRecord, replaceTemplateVariables } from './placeholders';

const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FOLLOW_UP_STEPS = 10;
const MAX_STEP_DELAY_MINUTES = 10080;

export type WorkflowReplyAction = 'stop' | 'reset' | 'continue';
export type WorkflowAutomationMediaType = 'image' | 'video';

export type WorkflowAutomationStep = {
    message_text: string;
    delay_minutes: number;
    media_type?: WorkflowAutomationMediaType | null;
    media_url?: string | null;
};

export type WorkflowAutomationRecord = {
    id: string;
    page_id: string;
    name: string;
    enabled: boolean;
    trigger_type: 'contact_reply' | 'follow_up';
    message_text?: string | null;
    steps?: unknown;
    stop_keywords?: unknown;
    page_stop_code: string | null;
    cooldown_minutes?: number | null;
    reply_action?: WorkflowReplyAction | null;
};

type WorkflowAutomationState = {
    id?: string;
    automation_id: string;
    contact_id?: string;
    status: string;
    stopped_reason?: string | null;
    current_step_index?: number | null;
    next_step_at?: string | null;
    last_triggered_at?: string | null;
};

type SupabaseLike = {
    from: (table: string) => any;
};

type PageForAutomation = {
    id: string;
    fb_page_id: string;
    access_token: string;
};

export type WorkflowAutomationRunResult = {
    checked: number;
    scheduled: number;
    continued: number;
    reset: number;
    sent: number;
    stopped: number;
    completed: number;
    skipped: number;
    errors: number;
};

export type FollowUpCronResult = {
    checked: number;
    sent: number;
    completed: number;
    stopped: number;
    skipped: number;
    errors: number;
};

function createRunResult(): WorkflowAutomationRunResult {
    return {
        checked: 0,
        scheduled: 0,
        continued: 0,
        reset: 0,
        sent: 0,
        stopped: 0,
        completed: 0,
        skipped: 0,
        errors: 0
    };
}

function isMissingWorkflowTableError(error: { message?: string; code?: string } | null | undefined): boolean {
    const message = (error?.message || '').toLowerCase();
    return (
        error?.code === '42P01' ||
        message.includes('workflow_automations') ||
        message.includes('workflow_automation_states') ||
        message.includes('schema cache')
    );
}

export function normalizeWorkflowKeyword(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function workflowTextMatchesCode(messageText: string, code: string | null | undefined): boolean {
    if (!code) return false;
    return normalizeWorkflowKeyword(messageText) === normalizeWorkflowKeyword(code);
}

function isWithinHumanAgentWindow(lastInteractionAt: string | null | undefined, now: Date): boolean {
    if (!lastInteractionAt) return false;
    const lastInteractionTime = new Date(lastInteractionAt).getTime();
    if (!Number.isFinite(lastInteractionTime)) return false;
    return now.getTime() - lastInteractionTime <= HUMAN_AGENT_WINDOW_MS;
}

function addMinutes(date: Date, minutes: number): string {
    return new Date(date.getTime() + Math.max(0, minutes) * 60 * 1000).toISOString();
}

function normalizeStepDelay(value: unknown): number {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return 0;
    }
    return Math.min(MAX_STEP_DELAY_MINUTES, Math.max(0, Math.round(numericValue)));
}

function normalizeStepMediaType(value: unknown): WorkflowAutomationMediaType | null {
    return value === 'image' || value === 'video' ? value : null;
}

function normalizeStepMediaUrl(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeWorkflowSteps(
    steps: unknown,
    fallbackMessageText?: string | null,
    fallbackDelayMinutes?: unknown
): WorkflowAutomationStep[] {
    const rawSteps = Array.isArray(steps) ? steps : [];
    const normalized = rawSteps
        .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
        .map((step) => ({
            message_text: typeof step.message_text === 'string'
                ? step.message_text.trim()
                : typeof step.messageText === 'string'
                    ? step.messageText.trim()
                    : '',
            delay_minutes: normalizeStepDelay(step.delay_minutes ?? step.delayMinutes),
            media_type: normalizeStepMediaType(step.media_type ?? step.mediaType),
            media_url: normalizeStepMediaUrl(step.media_url ?? step.mediaUrl)
        }))
        .filter((step) => step.message_text.length > 0 || Boolean(step.media_url))
        .map((step) => ({
            ...step,
            media_type: step.media_url ? (step.media_type || 'image') : null
        }))
        .slice(0, MAX_FOLLOW_UP_STEPS);

    if (normalized.length > 0) {
        return normalized;
    }

    const fallbackText = typeof fallbackMessageText === 'string' ? fallbackMessageText.trim() : '';
    if (!fallbackText) {
        return [];
    }

    return [{
        message_text: fallbackText,
        delay_minutes: normalizeStepDelay(fallbackDelayMinutes),
        media_type: null,
        media_url: null
    }];
}

export function normalizeWorkflowReplyAction(value: unknown): WorkflowReplyAction {
    return value === 'stop' || value === 'continue' || value === 'reset'
        ? value
        : 'reset';
}

function normalizeAutomation(automation: WorkflowAutomationRecord) {
    return {
        ...automation,
        trigger_type: automation.trigger_type || 'follow_up',
        reply_action: normalizeWorkflowReplyAction(automation.reply_action),
        steps: normalizeWorkflowSteps(
            automation.steps,
            automation.message_text,
            automation.cooldown_minutes
        )
    };
}

async function upsertAutomationState(
    supabase: SupabaseLike,
    automationId: string,
    contactId: string,
    payload: Record<string, unknown>
): Promise<boolean> {
    const { error } = await supabase
        .from('workflow_automation_states')
        .upsert(
            {
                automation_id: automationId,
                contact_id: contactId,
                ...payload,
                updated_at: new Date().toISOString()
            },
            { onConflict: 'automation_id,contact_id' }
        );

    if (error) {
        if (isMissingWorkflowTableError(error)) return false;
        throw error;
    }

    return true;
}

async function updateAutomationState(
    supabase: SupabaseLike,
    stateId: string,
    payload: Record<string, unknown>
): Promise<boolean> {
    const { error } = await supabase
        .from('workflow_automation_states')
        .update({
            ...payload,
            updated_at: new Date().toISOString()
        })
        .eq('id', stateId);

    if (error) {
        if (isMissingWorkflowTableError(error)) return false;
        throw error;
    }

    return true;
}

async function fetchFollowUpAutomations(
    supabase: SupabaseLike,
    pageId: string
): Promise<WorkflowAutomationRecord[] | null> {
    const { data, error } = await supabase
        .from('workflow_automations')
        .select('id, page_id, name, enabled, trigger_type, message_text, steps, page_stop_code, cooldown_minutes, reply_action')
        .eq('page_id', pageId)
        .eq('enabled', true)
        .order('created_at', { ascending: true });

    if (error) {
        if (isMissingWorkflowTableError(error)) return null;
        throw error;
    }

    return ((data || []) as WorkflowAutomationRecord[]).filter((automation) =>
        automation.trigger_type === 'follow_up' || automation.trigger_type === 'contact_reply'
    );
}

async function fetchAutomationStates(
    supabase: SupabaseLike,
    automationIds: string[],
    contactId: string
): Promise<Map<string, WorkflowAutomationState> | null> {
    if (automationIds.length === 0) {
        return new Map();
    }

    const { data, error } = await supabase
        .from('workflow_automation_states')
        .select('id, automation_id, status, stopped_reason, current_step_index, next_step_at, last_triggered_at')
        .eq('contact_id', contactId)
        .in('automation_id', automationIds);

    if (error) {
        if (isMissingWorkflowTableError(error)) return null;
        throw error;
    }

    return new Map(
        ((data || []) as WorkflowAutomationState[]).map((state) => [state.automation_id, state])
    );
}

function buildSchedulePayload(params: {
    stepIndex: number;
    steps: WorkflowAutomationStep[];
    now: Date;
    interactionAt: string;
}) {
    const step = params.steps[params.stepIndex];
    return {
        status: 'active',
        stopped_at: null,
        stopped_reason: null,
        completed_at: null,
        current_step_index: params.stepIndex,
        next_step_at: addMinutes(params.now, step?.delay_minutes || 0),
        last_triggered_at: params.now.toISOString(),
        last_contact_reply_at: params.interactionAt || params.now.toISOString()
    };
}

export async function handleFollowUpWorkflowContactReply(params: {
    supabase: SupabaseLike;
    page: PageForAutomation;
    contact: ContactRecord;
    messageText: string;
    interactionAt: string;
    now?: Date;
}): Promise<WorkflowAutomationRunResult> {
    const { supabase, page, contact, interactionAt } = params;
    const now = params.now ?? new Date();
    const result = createRunResult();

    const automations = await fetchFollowUpAutomations(supabase, page.id);
    if (!automations?.length) {
        return result;
    }

    result.checked = automations.length;
    const states = await fetchAutomationStates(supabase, automations.map((automation) => automation.id), contact.id);
    if (!states) {
        result.skipped = automations.length;
        return result;
    }

    for (const rawAutomation of automations) {
        const automation = normalizeAutomation(rawAutomation);
        const existingState = states.get(automation.id);

        try {
            if (automation.steps.length === 0) {
                result.skipped += 1;
                continue;
            }

            if (existingState?.status === 'stopped' && existingState.stopped_reason === 'page_stop_code') {
                result.skipped += 1;
                continue;
            }

            if (automation.reply_action === 'stop') {
                await upsertAutomationState(supabase, automation.id, contact.id, {
                    status: 'stopped',
                    stopped_at: now.toISOString(),
                    stopped_reason: 'contact_reply',
                    last_contact_reply_at: interactionAt || now.toISOString(),
                    next_step_at: null
                });
                result.stopped += 1;
                continue;
            }

            if (automation.reply_action === 'continue' && existingState?.status === 'active') {
                await upsertAutomationState(supabase, automation.id, contact.id, {
                    status: 'active',
                    current_step_index: existingState.current_step_index ?? 0,
                    next_step_at: existingState.next_step_at || addMinutes(now, automation.steps[existingState.current_step_index || 0]?.delay_minutes || 0),
                    last_contact_reply_at: interactionAt || now.toISOString()
                });
                result.continued += 1;
                continue;
            }

            await upsertAutomationState(supabase, automation.id, contact.id, buildSchedulePayload({
                stepIndex: 0,
                steps: automation.steps,
                now,
                interactionAt
            }));

            if (automation.reply_action === 'reset') {
                result.reset += 1;
            } else {
                result.scheduled += 1;
            }
        } catch (error) {
            result.errors += 1;
            console.error('[FOLLOW_UP_AUTOMATION] Failed to process contact reply', {
                automationId: automation.id,
                contactId: contact.id,
                error: (error as Error).message
            });
        }
    }

    return result;
}

// Kept as a compatibility export for older webhook tests/imports.
export const triggerReplyWorkflowAutomations = handleFollowUpWorkflowContactReply;

export async function processDueFollowUpAutomationSteps(params: {
    supabase: SupabaseLike;
    now?: Date;
    limit?: number;
}): Promise<FollowUpCronResult> {
    const { supabase } = params;
    const now = params.now ?? new Date();
    const limit = Math.max(1, Math.min(params.limit || 10, 50));
    const result: FollowUpCronResult = {
        checked: 0,
        sent: 0,
        completed: 0,
        stopped: 0,
        skipped: 0,
        errors: 0
    };

    const { data, error } = await supabase
        .from('workflow_automation_states')
        .select(`
            id,
            automation_id,
            contact_id,
            status,
            current_step_index,
            next_step_at,
            workflow_automations(
                id,
                page_id,
                name,
                enabled,
                trigger_type,
                message_text,
                steps,
                page_stop_code,
                cooldown_minutes,
                reply_action,
                pages(fb_page_id, access_token)
            ),
            contacts(id, psid, page_id, name, last_interaction_at)
        `)
        .eq('status', 'active')
        .lte('next_step_at', now.toISOString())
        .order('next_step_at', { ascending: true })
        .limit(limit);

    if (error) {
        if (isMissingWorkflowTableError(error)) return result;
        throw error;
    }

    const states = (data || []) as Array<Record<string, any>>;
    result.checked = states.length;

    for (const state of states) {
        try {
            const rawAutomation = Array.isArray(state.workflow_automations)
                ? state.workflow_automations[0]
                : state.workflow_automations;
            const contact = Array.isArray(state.contacts) ? state.contacts[0] : state.contacts;
            const page = Array.isArray(rawAutomation?.pages) ? rawAutomation.pages[0] : rawAutomation?.pages;

            if (!state.id || !rawAutomation?.enabled || !contact?.psid || !page?.access_token) {
                result.skipped += 1;
                continue;
            }

            const automation = normalizeAutomation(rawAutomation as WorkflowAutomationRecord);
            const stepIndex = Math.max(0, Number(state.current_step_index || 0));
            const step = automation.steps[stepIndex];

            if (!step) {
                await updateAutomationState(supabase, state.id, {
                    status: 'completed',
                    completed_at: now.toISOString(),
                    next_step_at: null
                });
                result.completed += 1;
                continue;
            }

            if (!isWithinHumanAgentWindow(contact.last_interaction_at, now)) {
                await updateAutomationState(supabase, state.id, {
                    status: 'stopped',
                    stopped_at: now.toISOString(),
                    stopped_reason: 'outside_human_agent_window',
                    next_step_at: null
                });
                result.stopped += 1;
                continue;
            }

            const placeholderContact = {
                id: contact.id,
                psid: contact.psid,
                page_id: contact.page_id,
                name: contact.name || null,
                last_interaction_at: contact.last_interaction_at || null
            };
            const messageToSend = replaceTemplateVariables(step.message_text, placeholderContact).trim();
            const mediaUrl = step.media_url
                ? replaceTemplateVariables(step.media_url, placeholderContact).trim()
                : '';

            if (!messageToSend && !mediaUrl) {
                result.skipped += 1;
                continue;
            }

            if (messageToSend) {
                await sendMessage(
                    page.fb_page_id,
                    page.access_token,
                    contact.psid,
                    messageToSend,
                    'HUMAN_AGENT'
                );
            }

            if (mediaUrl) {
                await sendMessengerMediaAttachment(
                    page.fb_page_id,
                    page.access_token,
                    contact.psid,
                    {
                        type: step.media_type || 'image',
                        url: mediaUrl
                    },
                    'HUMAN_AGENT'
                );
            }

            const nextStepIndex = stepIndex + 1;
            const nextStep = automation.steps[nextStepIndex];

            if (!nextStep) {
                await updateAutomationState(supabase, state.id, {
                    status: 'completed',
                    current_step_index: nextStepIndex,
                    next_step_at: null,
                    completed_at: now.toISOString(),
                    last_sent_at: now.toISOString()
                });
                result.completed += 1;
            } else {
                await updateAutomationState(supabase, state.id, {
                    status: 'active',
                    current_step_index: nextStepIndex,
                    next_step_at: addMinutes(now, nextStep.delay_minutes),
                    last_sent_at: now.toISOString()
                });
            }

            result.sent += 1;
        } catch (error) {
            result.errors += 1;
            console.error('[FOLLOW_UP_AUTOMATION] Failed to send due step', {
                stateId: state.id,
                automationId: state.automation_id,
                error: (error as Error).message
            });
        }
    }

    return result;
}

export async function stopWorkflowAutomationsFromPageMessage(params: {
    supabase: SupabaseLike;
    pageId: string;
    contactPsid: string | null | undefined;
    messageText: string;
    now?: Date;
}): Promise<{ checked: number; stopped: number; skipped: number }> {
    const { supabase, pageId, contactPsid, messageText } = params;
    const now = params.now ?? new Date();

    if (!contactPsid || !messageText.trim()) {
        return { checked: 0, stopped: 0, skipped: 0 };
    }

    const { data: contact, error: contactError } = await supabase
        .from('contacts')
        .select('id')
        .eq('page_id', pageId)
        .eq('psid', contactPsid)
        .maybeSingle();

    if (contactError) {
        throw contactError;
    }

    if (!contact?.id) {
        return { checked: 0, stopped: 0, skipped: 1 };
    }

    const { data: automations, error } = await supabase
        .from('workflow_automations')
        .select('id, page_stop_code')
        .eq('page_id', pageId)
        .eq('enabled', true)
        .not('page_stop_code', 'is', null);

    if (error) {
        if (isMissingWorkflowTableError(error)) {
            return { checked: 0, stopped: 0, skipped: 1 };
        }
        throw error;
    }

    let stopped = 0;
    const matchedAutomations = (automations || []).filter((automation: { id: string; page_stop_code: string | null }) =>
        workflowTextMatchesCode(messageText, automation.page_stop_code)
    );

    for (const automation of matchedAutomations) {
        const saved = await upsertAutomationState(supabase, automation.id, contact.id, {
            status: 'stopped',
            stopped_at: now.toISOString(),
            stopped_reason: 'page_stop_code',
            next_step_at: null
        });
        if (saved) stopped += 1;
    }

    return {
        checked: automations?.length || 0,
        stopped,
        skipped: Math.max(0, (automations?.length || 0) - stopped)
    };
}
