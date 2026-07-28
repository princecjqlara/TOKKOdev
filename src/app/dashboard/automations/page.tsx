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
    Workflow
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
    trigger_type: 'contact_reply';
    message_text: string;
    stop_keywords: string[];
    page_stop_code: string | null;
    cooldown_minutes: number;
    created_at: string;
    updated_at: string;
};

type AutomationForm = {
    id?: string;
    name: string;
    enabled: boolean;
    message_text: string;
    stop_keywords: string;
    page_stop_code: string;
    cooldown_minutes: number;
};

const emptyForm: AutomationForm = {
    name: 'Reply follow-up',
    enabled: true,
    message_text: 'Hi {{first_name}}, thanks for replying. A human agent will help you shortly.',
    stop_keywords: 'stop, unsubscribe, pause',
    page_stop_code: '#stopauto',
    cooldown_minutes: 60
};

function keywordsToText(value: unknown): string {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').join(', ')
        : '';
}

function splitKeywords(value: string): string[] {
    return Array.from(
        new Set(
            value
                .split(',')
                .map((item) => item.trim().replace(/\s+/g, ' ').toLowerCase())
                .filter(Boolean)
        )
    ).slice(0, 20);
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
            message_text: automation.message_text,
            stop_keywords: keywordsToText(automation.stop_keywords),
            page_stop_code: automation.page_stop_code || '',
            cooldown_minutes: automation.cooldown_minutes ?? 60
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
                message_text: form.message_text,
                stop_keywords: splitKeywords(form.stop_keywords),
                page_stop_code: form.page_stop_code.trim() || null,
                cooldown_minutes: form.cooldown_minutes
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

    const toggleAutomation = async (automation: WorkflowAutomation) => {
        setForm({
            id: automation.id,
            name: automation.name,
            enabled: !automation.enabled,
            message_text: automation.message_text,
            stop_keywords: keywordsToText(automation.stop_keywords),
            page_stop_code: automation.page_stop_code || '',
            cooldown_minutes: automation.cooldown_minutes ?? 60
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
                            Contact reply trigger using Messenger Human Agent within the 7 day window
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
                                                {automation.enabled ? 'Active' : 'Disabled'} / {automation.cooldown_minutes || 0}m cooldown
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
                            <p className="font-mono text-xs font-bold uppercase text-gray-500">Contact Reply Workflow</p>
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
                                placeholder="Reply follow-up"
                            />
                        </div>

                        <div>
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Auto Message</label>
                            <textarea
                                value={form.message_text}
                                onChange={(event) => setForm((current) => ({ ...current, message_text: event.target.value }))}
                                className="input-wireframe w-full text-sm min-h-[130px] resize-y"
                                placeholder="Hi {{first_name}}, thanks for replying. A human agent will help you shortly."
                            />
                            <div className="flex flex-wrap gap-2 mt-2">
                                {['{{name}}', '{{first_name}}', '{{last_name}}'].map((token) => (
                                    <button
                                        type="button"
                                        key={token}
                                        onClick={() => setForm((current) => ({ ...current, message_text: `${current.message_text}${token}` }))}
                                        className="border border-black px-2 py-1 text-[11px] font-mono hover:bg-[#f5f5f5]"
                                    >
                                        {token}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div>
                                <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Contact Stop Keywords</label>
                                <input
                                    value={form.stop_keywords}
                                    onChange={(event) => setForm((current) => ({ ...current, stop_keywords: event.target.value }))}
                                    className="input-wireframe w-full text-sm"
                                    placeholder="stop, unsubscribe, pause"
                                />
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

                        <div>
                            <label className="font-mono text-xs font-bold uppercase text-gray-500 mb-2 block">Cooldown Minutes</label>
                            <input
                                type="number"
                                min={0}
                                max={10080}
                                value={form.cooldown_minutes}
                                onChange={(event) => setForm((current) => ({ ...current, cooldown_minutes: Number(event.target.value) }))}
                                className="input-wireframe w-full md:w-48 text-sm"
                            />
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
                            Human Agent can reply inside Messenger's 7 day window after the contact interacts.
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
                                disabled={saving || !selectedPageId || !form.name.trim() || !form.message_text.trim()}
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
