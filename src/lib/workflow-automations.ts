import { sendMessage } from './facebook';
import { ContactRecord, replaceTemplateVariables } from './placeholders';

const HUMAN_AGENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type WorkflowAutomationRecord = {
    id: string;
    page_id: string;
    name: string;
    enabled: boolean;
    trigger_type: 'contact_reply';
    message_text: string;
    stop_keywords: unknown;
    page_stop_code: string | null;
    cooldown_minutes: number | null;
};

type WorkflowAutomationState = {
    automation_id: string;
    status: string;
    last_triggered_at: string | null;
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
    sent: number;
    stopped: number;
    skipped: number;
    errors: number;
};

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

export function getWorkflowKeywords(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string')
        .map(normalizeWorkflowKeyword)
        .filter(Boolean);
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

async function fetchReplyAutomations(
    supabase: SupabaseLike,
    pageId: string
): Promise<WorkflowAutomationRecord[] | null> {
    const { data, error } = await supabase
        .from('workflow_automations')
        .select('id, page_id, name, enabled, trigger_type, message_text, stop_keywords, page_stop_code, cooldown_minutes')
        .eq('page_id', pageId)
        .eq('enabled', true)
        .eq('trigger_type', 'contact_reply')
        .order('created_at', { ascending: true });

    if (error) {
        if (isMissingWorkflowTableError(error)) return null;
        throw error;
    }

    return (data || []) as WorkflowAutomationRecord[];
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
        .select('automation_id, status, last_triggered_at')
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

export async function triggerReplyWorkflowAutomations(params: {
    supabase: SupabaseLike;
    page: PageForAutomation;
    contact: ContactRecord;
    messageText: string;
    interactionAt: string;
    now?: Date;
}): Promise<WorkflowAutomationRunResult> {
    const { supabase, page, contact, messageText, interactionAt } = params;
    const now = params.now ?? new Date();
    const result: WorkflowAutomationRunResult = {
        checked: 0,
        sent: 0,
        stopped: 0,
        skipped: 0,
        errors: 0
    };

    const automations = await fetchReplyAutomations(supabase, page.id);
    if (!automations?.length) {
        return result;
    }

    result.checked = automations.length;
    const states = await fetchAutomationStates(supabase, automations.map((automation) => automation.id), contact.id);
    if (!states) {
        result.skipped = automations.length;
        return result;
    }

    const effectiveLastInteractionAt = interactionAt || contact.last_interaction_at;
    const isHumanAgentAllowed = isWithinHumanAgentWindow(effectiveLastInteractionAt, now);

    for (const automation of automations) {
        const existingState = states.get(automation.id);
        const stopKeywords = getWorkflowKeywords(automation.stop_keywords);
        const normalizedMessage = normalizeWorkflowKeyword(messageText);

        try {
            if (stopKeywords.includes(normalizedMessage)) {
                await upsertAutomationState(supabase, automation.id, contact.id, {
                    status: 'stopped',
                    stopped_at: now.toISOString(),
                    stopped_reason: 'contact_stop_keyword'
                });
                result.stopped += 1;
                continue;
            }

            if (existingState?.status === 'stopped') {
                result.skipped += 1;
                continue;
            }

            if (!isHumanAgentAllowed) {
                result.skipped += 1;
                continue;
            }

            const cooldownMinutes = Math.max(0, Number(automation.cooldown_minutes || 0));
            if (cooldownMinutes > 0 && existingState?.last_triggered_at) {
                const lastTriggeredAt = new Date(existingState.last_triggered_at).getTime();
                const cooldownMs = cooldownMinutes * 60 * 1000;
                if (Number.isFinite(lastTriggeredAt) && now.getTime() - lastTriggeredAt < cooldownMs) {
                    result.skipped += 1;
                    continue;
                }
            }

            const messageToSend = replaceTemplateVariables(automation.message_text, contact).trim();
            if (!messageToSend) {
                result.skipped += 1;
                continue;
            }

            await sendMessage(
                page.fb_page_id,
                page.access_token,
                contact.psid,
                messageToSend,
                'HUMAN_AGENT'
            );

            await upsertAutomationState(supabase, automation.id, contact.id, {
                status: 'active',
                stopped_at: null,
                stopped_reason: null,
                last_triggered_at: now.toISOString(),
                last_sent_at: now.toISOString()
            });
            result.sent += 1;
        } catch (error) {
            result.errors += 1;
            console.error('[WORKFLOW_AUTOMATION] Failed to process reply automation', {
                automationId: automation.id,
                contactId: contact.id,
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
            stopped_reason: 'page_stop_code'
        });
        if (saved) stopped += 1;
    }

    return {
        checked: automations?.length || 0,
        stopped,
        skipped: Math.max(0, (automations?.length || 0) - stopped)
    };
}
