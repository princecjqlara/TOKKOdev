'use client';

import { useSession } from 'next-auth/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Check,
    Copy,
    Power,
    PowerOff,
    RefreshCw,
    Save,
    Trash2,
    Workflow,
    Plus,
    X
} from 'lucide-react';

type PageOption = {
    id: string;
    fb_page_id: string;
    name: string;
};

type WorkflowAutomation = {
    id: string;
    page_id: string;
    name: string;
    enabled: boolean;
    trigger_type: 'contact_reply' | 'follow_up';
    message_text: string;
    steps?: AutomationStep[];
    reply_action?: ReplyAction;
    page_stop_code: string | null;
    cooldown_minutes: number;
    created_at: string;
    updated_at: string;
};

type ReplyAction = 'stop' | 'reset' | 'continue';

type AutomationStep = {
    message_text: string;
    delay_minutes: number;
};

type AutomationForm = {
    id?: string;
    name: string;
    enabled: boolean;
    steps: AutomationStep[];
    reply_action: ReplyAction;
    page_stop_code: string;
};

const emptyForm: AutomationForm = {
    name: 'Follow-up workflow',
    enabled: true,
    steps: [
        {
            message_text: 'Hi {{first_name}}, just following up on your inquiry. Are you still interested?',
            delay_minutes: 60
        },
        {
            message_text: 'Hi {{first_name}}, we still have slots available today. Would you like us to reserve one?',
            delay_minutes: 1440
        }
    ],
    reply_action: 'stop',
    page_stop_code: '#stopauto'
};

function normalizeSteps(value: unknown, fallbackMessageText?: string, fallbackDelayMinutes?: number): AutomationStep[] {
    const steps = Array.isArray(value)
        ? value
            .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
            .map((step) => ({
                message_text: typeof step.message_text === 'string'
                    ? step.message_text
                    : typeof step.messageText === 'string'
                        ? step.messageText
                        : '',
                delay_minutes: Number(step.delay_minutes ?? step.delayMinutes ?? 0)
            }))
            .filter((step) => step.message_text.trim())
        : [];

    if (steps.length > 0) {
        return steps.slice(0, 10).map((step) => ({
            message_text: step.message_text,
            delay_minutes: Math.min(10080, Math.max(0, Math.round(Number.isFinite(step.delay_minutes) ? step.delay_minutes : 0)))
        }));
    }

    if (fallbackMessageText?.trim()) {
        return [{
            message_text: fallbackMessageText,
            delay_minutes: Math.min(10080, Math.max(0, Math.round(fallbackDelayMinutes || 0)))
        }];
    }

    return emptyForm.steps;
}

function normalizeReplyAction(value: unknown): ReplyAction {
    return value === 'reset' || value === 'continue' || value === 'stop' ? value : 'stop';
}

export default function AutomationsPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<PageOption[]>([]);
    const [selectedPageId, setSelectedPageId] = useState('');
    const [automations, setAutomations] = useState<WorkflowAutomation[]>([]);
    const [form, setForm] = useState<AutomationForm>(emptyForm);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [resettingId, setResettingId] = useState<string | null>(null);
    const [status, setStatus] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!session) return;

        fetch('/api/pages')
            .then((response) => response.json())
            .then((data) => {
                const nextPages = data.pages || [];
                setPages(nextPages);
                if (nextPages.length > 0) {
                    setSelectedPageId((current) => current || nextPages[0].id);
                }
            })
            .catch((loadError) => {
                console.error('Failed to load pages:', loadError);
                setError('Failed to load pages');
            });
    }, [session]);

    const fetchAutomations = useCallback(async () => {
        if (!selectedPageId) return;

        setLoading(true);
        setError(null);
        try {
            const response = await fetch(`/api/pages/${selectedPageId}/automations`);
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to load automations');
            }

            setAutomations(data.items || []);
        } catch (loadError) {
            console.error('Failed to load automations:', loadError);
            setError((loadError as Error).message);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId]);

    useEffect(() => {
        void fetchAutomations();
    }, [fetchAutomations]);

    const selectedPageName = useMemo(
        () => pages.find((page) => page.id === selectedPageId)?.name || 'Selected page',
        [pages, selectedPageId]
    );

    const activeCount = automations.filter((automation) => automation.enabled).length;

    const resetForm = () => {
        setForm(emptyForm);
        setStatus(null);
        setError(null);
    };

    const editAutomation = (automation: WorkflowAutomation) => {
        setForm({
            id: automation.id,
            name: automation.name,
            enabled: automation.enabled,
            steps: normalizeSteps(automation.steps, automation.message_text, automation.cooldown_minutes),
            reply_action: normalizeReplyAction(automation.reply_action),
            page_stop_code: automation.page_stop_code || '',
        });
        setStatus(null);
        setError(null);
    };

    const saveAutomation = async () => {
        if (!selectedPageId) return;

        setSaving(true);
        setStatus(null);
        setError(null);

        try {
            const payload = {
                name: form.name,
                enabled: form.enabled,
                steps: normalizeSteps(form.steps),
                reply_action: form.reply_action,
                page_stop_code: form.page_stop_code.trim() || null,
            };

            const response = await fetch(
                form.id
                    ? `/api/pages/${selectedPageId}/automations/${form.id}`
                    : `/api/pages/${selectedPageId}/automations`,
                {
                    method: form.id ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }
            );
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to save automation');
            }

            setStatus(form.id ? 'Automation updated' : 'Automation created');
            setForm((current) => ({ ...current, id: data.automation?.id || current.id }));
            await fetchAutomations();
        } catch (saveError) {
            console.error('Failed to save automation:', saveError);
            setError((saveError as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const deleteAutomation = async (automationId: string) => {
        if (!selectedPageId) return;

        setDeletingId(automationId);
        setStatus(null);
        setError(null);

        try {
            const response = await fetch(`/api/pages/${selectedPageId}/automations/${automationId}`, {
                method: 'DELETE'
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to delete automation');
            }

            setStatus('Automation deleted');
            if (form.id === automationId) {
                resetForm();
            }
            await fetchAutomations();
        } catch (deleteError) {
            console.error('Failed to delete automation:', deleteError);
            setError((deleteError as Error).message);
        } finally {
            setDeletingId(null);
        }
    };

    const resetAutomation = async (automationId: string) => {
        if (!selectedPageId) return;

        setResettingId(automationId);
        setStatus(null);
        setError(null);

        try {
            const response = await fetch(`/api/pages/${selectedPageId}/automations/${automationId}/reset`, {
                method: 'POST'
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to reset automation');
            }

            setStatus('Automation progress reset');
        } catch (resetError) {
            console.error('Failed to reset automation:', resetError);
            setError((resetError as Error).message);
        } finally {
            setResettingId(null);
        }
    };

    const toggleAutomation = async (automation: WorkflowAutomation) => {
        setForm({
            id: automation.id,
            name: automation.name,
            enabled: !automation.enabled,
            steps: normalizeSteps(automation.steps, automation.message_text, automation.cooldown_minutes),
            reply_action: normalizeReplyAction(automation.reply_action),
            page_stop_code: automation.page_stop_code || '',
        });

        setSaving(true);
        setStatus(null);
        setError(null);

        try {
            const response = await fetch(`/api/pages/${selectedPageId}/automations/${automation.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: !automation.enabled })
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.message || data.error || 'Failed to update automation');
            }

            setStatus(!automation.enabled ? 'Automation enabled' : 'Automation disabled');
            await fetchAutomations();
        } catch (toggleError) {
            console.error('Failed to toggle automation:', toggleError);
            setError((toggleError as Error).message);
        } finally {
            setSaving(false);
        }
    };

    const copyStopCode = async () => {
        if (!form.page_stop_code.trim()) return;
        await navigator.clipboard.writeText(form.page_stop_code.trim());
        setStatus('Stop code copied');
    };

    const updateStep = (index: number, patch: Partial<AutomationStep>) => {
        setForm((current) => ({
            ...current,
            steps: current.steps.map((step, stepIndex) =>
                stepIndex === index ? { ...step, ...patch } : step
            )
        }));
    };

    const addStep = () => {
        setForm((current) => ({
            ...current,
            steps: [
                ...current.steps,
                { message_text: 'Hi {{first_name}}, following up again. Let us know if you want help.', delay_minutes: 1440 }
            ].slice(0, 10)
        }));
    };

    const removeStep = (index: number) => {
        setForm((current) => ({
            ...current,
            steps: current.steps.length <= 1
                ? current.steps
                : current.steps.filter((_, stepIndex) => stepIndex !== index)
        }));
    };

    const hasValidStep = form.steps.some((step) => step.message_text.trim());

    return (
        <div className="max-w-6xl mx-auto">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4 mb-6">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-white border-2 border-black flex items-center justify-center">
                        <Workflow className="w-5 h-5" />
                    </div>
                    <div>
                        <h1 className="text-2xl font-black uppercase text-black">Automations</h1>
                        <p className="text-xs text-gray-500 font-mono">
                            Multi-step follow-up workflows using Messenger Human Agent within the 7 day window
                        </p>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={() => void fetchAutomations()}
                        disabled={loading || !selectedPageId}
                        className="btn-ghost-wireframe flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        Refresh
                    </button>
                    <button
                        type="button"
                        onClick={resetForm}
                        className="btn-wireframe bg-black text-white hover:bg-gray-800 px-3 py-2 text-xs font-bold uppercase"
                    >
                        New Automation
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-5">
                <section className="border-2 border-black bg-white">
                    <div className="border-b-2 border-black p-4">
                        <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Page</label>
                        <select
                            value={selectedPageId}
                            onChange={(event) => setSelectedPageId(event.target.value)}
                            className="input-wireframe w-full text-sm"
                        >
                            {pages.map((page) => (
                                <option key={page.id} value={page.id}>
                                    {page.name}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 border-b-2 border-black">
                        <div className="p-4 border-r-2 border-black">
                            <p className="font-mono text-[10px] uppercase text-gray-500">Active</p>
                            <p className="text-3xl font-black">{activeCount}</p>
                        </div>
                        <div className="p-4">
                            <p className="font-mono text-[10px] uppercase text-gray-500">Total</p>
                            <p className="text-3xl font-black">{automations.length}</p>
                        </div>
                    </div>

                    <div className="max-h-[520px] overflow-auto">
                        {loading ? (
                            <div className="p-5 text-sm font-mono text-gray-500">Loading automations...</div>
                        ) : automations.length === 0 ? (
                            <div className="p-5 text-sm font-mono text-gray-500">No automations for {selectedPageName}</div>
                        ) : (
                            automations.map((automation) => (
                                <button
                                    key={automation.id}
                                    type="button"
                                    onClick={() => editAutomation(automation)}
                                    className={`w-full text-left p-4 border-b border-black hover:bg-[#f5f5f5] ${form.id === automation.id ? 'bg-[#f0f0f0]' : 'bg-white'}`}
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="font-bold text-sm truncate">{automation.name}</p>
                                            <p className="font-mono text-[10px] uppercase text-gray-500 mt-1">
                                                {automation.enabled ? 'Active' : 'Disabled'} / {normalizeSteps(automation.steps, automation.message_text, automation.cooldown_minutes).length} steps
                                            </p>
                                        </div>
                                        <span className={`w-3 h-3 border border-black flex-shrink-0 ${automation.enabled ? 'bg-green-500' : 'bg-gray-200'}`} />
                                    </div>
                                </button>
                            ))
                        )}
                    </div>
                </section>

                <section className="border-2 border-black bg-white">
                    <div className="border-b-2 border-black p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                        <div>
                            <p className="font-mono text-xs font-bold uppercase text-gray-500">Follow-Up Workflow</p>
                            <h2 className="text-lg font-black uppercase">{form.id ? 'Edit Automation' : 'New Automation'}</h2>
                        </div>
                        <button
                            type="button"
                            onClick={() => setForm((current) => ({ ...current, enabled: !current.enabled }))}
                            className={`flex items-center gap-2 border border-black px-3 py-2 text-xs font-bold uppercase ${form.enabled ? 'bg-green-50' : 'bg-gray-100'}`}
                        >
                            {form.enabled ? <Power className="w-4 h-4 text-green-700" /> : <PowerOff className="w-4 h-4" />}
                            {form.enabled ? 'Enabled' : 'Disabled'}
                        </button>
                    </div>

                    <div className="p-4 space-y-4">
                        <div>
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Automation Name</label>
                            <input
                                value={form.name}
                                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                                className="input-wireframe w-full text-sm"
                                placeholder="Follow-up workflow"
                            />
                        </div>

                        <div>
                            <div className="flex items-center justify-between gap-3 mb-2">
                                <label className="font-mono text-xs font-bold uppercase text-gray-500">Follow-Up Steps</label>
                                <button
                                    type="button"
                                    onClick={addStep}
                                    disabled={form.steps.length >= 10}
                                    className="border border-black px-2 py-1 text-[11px] font-bold uppercase hover:bg-[#f5f5f5] flex items-center gap-1 disabled:opacity-40"
                                >
                                    <Plus className="w-3 h-3" />
                                    Step
                                </button>
                            </div>
                            <div className="space-y-3">
                                {form.steps.map((step, index) => (
                                    <div key={index} className="border border-black">
                                        <div className="border-b border-black px-3 py-2 flex items-center justify-between bg-[#f8f8f8]">
                                            <p className="font-mono text-xs font-bold uppercase">Step {index + 1}</p>
                                            <button
                                                type="button"
                                                onClick={() => removeStep(index)}
                                                disabled={form.steps.length <= 1}
                                                className="border border-black p-1 hover:bg-white disabled:opacity-30"
                                                title="Remove step"
                                            >
                                                <X className="w-3 h-3" />
                                            </button>
                                        </div>
                                        <div className="p-3 space-y-3">
                                            <div>
                                                <label className="font-mono text-[10px] font-bold uppercase text-gray-500 mb-1 block">Send After Minutes</label>
                                                <input
                                                    type="number"
                                                    min={0}
                                                    max={10080}
                                                    value={step.delay_minutes}
                                                    onChange={(event) => updateStep(index, { delay_minutes: Number(event.target.value) })}
                                                    className="input-wireframe w-full md:w-48 text-sm"
                                                />
                                            </div>
                                            <div>
                                                <label className="font-mono text-[10px] font-bold uppercase text-gray-500 mb-1 block">Message</label>
                                                <textarea
                                                    value={step.message_text}
                                                    onChange={(event) => updateStep(index, { message_text: event.target.value })}
                                                    className="input-wireframe w-full text-sm min-h-[100px] resize-y"
                                                    placeholder="Hi {{first_name}}, just following up."
                                                />
                                                <div className="flex flex-wrap gap-2 mt-2">
                                                    {['{{name}}', '{{first_name}}', '{{last_name}}'].map((token) => (
                                                        <button
                                                            type="button"
                                                            key={token}
                                                            onClick={() => updateStep(index, { message_text: `${step.message_text}${token}` })}
                                                            className="border border-black px-2 py-1 text-[11px] font-mono hover:bg-[#f5f5f5]"
                                                        >
                                                            {token}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">When Contact Replies</label>
                                <select
                                    value={form.reply_action}
                                    onChange={(event) => setForm((current) => ({ ...current, reply_action: event.target.value as ReplyAction }))}
                                    className="input-wireframe w-full text-sm"
                                >
                                    <option value="stop">Stop workflow</option>
                                    <option value="reset">Reset to step 1</option>
                                    <option value="continue">Continue current step</option>
                                </select>
                            </div>

                            <div>
                                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Manual Page Stop Code</label>
                                <div className="flex">
                                    <input
                                        value={form.page_stop_code}
                                        onChange={(event) => setForm((current) => ({ ...current, page_stop_code: event.target.value }))}
                                        className="input-wireframe w-full text-sm border-r-0"
                                        placeholder="#stopauto"
                                    />
                                    <button
                                        type="button"
                                        onClick={copyStopCode}
                                        disabled={!form.page_stop_code.trim()}
                                        className="border border-black px-3 hover:bg-[#f5f5f5] disabled:opacity-40"
                                        title="Copy stop code"
                                    >
                                        <Copy className="w-4 h-4" />
                                    </button>
                                </div>
                            </div>
                        </div>

                        {(status || error) && (
                            <div className={`border-2 p-3 text-sm font-mono flex items-center gap-2 ${error ? 'border-red-500 text-red-700 bg-red-50' : 'border-green-600 text-green-700 bg-green-50'}`}>
                                {error ? <PowerOff className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                                {error || status}
                            </div>
                        )}
                    </div>

                    <div className="border-t-2 border-black p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <div className="font-mono text-[11px] text-gray-500">
                            cron-jobs.org should call the follow-up automation cron every minute.
                        </div>
                        <div className="flex items-center gap-2">
                            {form.id && (
                                <>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const automation = automations.find((item) => item.id === form.id);
                                            if (automation) void toggleAutomation(automation);
                                        }}
                                        disabled={saving}
                                        className="btn-ghost-wireframe flex items-center gap-2 px-3 py-2 text-xs font-bold uppercase"
                                    >
                                        {form.enabled ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                                        {form.enabled ? 'Disable' : 'Enable'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void resetAutomation(form.id as string)}
                                        disabled={resettingId === form.id}
                                        className="border border-black px-3 py-2 text-xs font-bold uppercase hover:bg-[#f5f5f5] flex items-center gap-2"
                                    >
                                        <RefreshCw className="w-4 h-4" />
                                        {resettingId === form.id ? 'Resetting...' : 'Reset'}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void deleteAutomation(form.id as string)}
                                        disabled={deletingId === form.id}
                                        className="border border-black px-3 py-2 text-xs font-bold uppercase text-red-700 hover:bg-red-50 flex items-center gap-2"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        {deletingId === form.id ? 'Deleting...' : 'Delete'}
                                    </button>
                                </>
                            )}
                            <button
                                type="button"
                                onClick={() => void saveAutomation()}
                                disabled={saving || !selectedPageId || !form.name.trim() || !hasValidStep}
                                className="btn-wireframe bg-black text-white hover:bg-gray-800 flex items-center gap-2 px-4 py-2 text-xs font-bold uppercase disabled:opacity-40"
                            >
                                <Save className="w-4 h-4" />
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}
