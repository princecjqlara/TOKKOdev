'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, CheckCircle, XCircle, Clock, FileText, AlertTriangle } from 'lucide-react';

type Page = {
    id: string;
    name: string;
    fb_page_id: string;
};

type TemplateStatus = {
    id: string | null;
    name: string;
    status: string;
    category: string;
    language: string;
    bodyText: string;
};

// Known template names from our system (the ones we care about)
const SYSTEM_TEMPLATE_NAMES = new Set([
    // Legacy wrappers
    'general_msg_v1', 'general_notice_v1', 'general_alert_v1',
    'instant_meeting_btn_v1', 'instant_meeting_btn_v2', 'instant_meeting_btn_v3',
    // Natural conversational
    'friendly_msg_v1', 'friendly_msg_v2', 'friendly_msg_v3',
    'friendly_msg_v4', 'friendly_msg_v5', 'friendly_msg_v6',
    'casual_update_v1', 'casual_update_v3', 'casual_update_v4',
    'simple_msg_v4',
    // 2-param (usually rejected but we track them)
    'general_msg_v2', 'general_notice_v2', 'general_alert_v2',
    'general_msg_v3', 'general_notice_v3',
    'status_update_v1', 'support_team_v1',
]);

export default function TemplatesPage() {
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState<string>('');
    const [templates, setTemplates] = useState<TemplateStatus[]>([]);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [filter, setFilter] = useState<'all' | 'system' | 'approved' | 'rejected'>('system');

    // Fetch pages
    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/pages');
                const data = await res.json();
                const pgs: Page[] = data.pages || [];
                setPages(pgs);
                if (pgs.length > 0) {
                    setSelectedPageId(pgs[0].id);
                }
            } catch (err) {
                console.error('Failed to fetch pages:', err);
            }
        })();
    }, []);

    // Fetch templates when page changes
    const fetchTemplates = useCallback(async () => {
        if (!selectedPageId) return;
        setLoading(true);
        try {
            const res = await fetch(`/api/facebook/templates/status?pageId=${selectedPageId}`);
            const data = await res.json();
            setTemplates(data.templates || []);
        } catch (err) {
            console.error('Failed to fetch templates:', err);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId]);

    useEffect(() => {
        fetchTemplates();
    }, [fetchTemplates]);

    // Submit all templates to current page
    const handleSubmitAll = async () => {
        if (!selectedPageId || submitting) return;
        setSubmitting(true);
        try {
            const res = await fetch('/api/facebook/templates/submit-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId: selectedPageId })
            });
            const data = await res.json();
            if (data.success) {
                let msg = `Templates submitted!\n\n✅ Approved: ${data.summary.approved}\n⏳ Pending: ${data.summary.pending}\n❌ Errors: ${data.summary.errors}\n📋 Already existed: ${data.summary.alreadyExisted}`;

                // Show first error reason if there are errors
                if (data.summary.errors > 0 && Array.isArray(data.results)) {
                    const firstError = data.results.find((r: any) => r.action === 'error');
                    if (firstError?.error) {
                        msg += `\n\n⚠️ Error reason: ${firstError.error}`;
                    }
                }

                alert(msg);
                await fetchTemplates();
            } else {
                alert(`Failed: ${data.message || 'Unknown error'}`);
            }
        } catch (err) {
            alert(`Error: ${(err as Error).message}`);
        } finally {
            setSubmitting(false);
        }
    };

    // Filter templates
    const filteredTemplates = templates.filter(t => {
        if (filter === 'system') return SYSTEM_TEMPLATE_NAMES.has(t.name);
        if (filter === 'approved') return t.status === 'APPROVED' || t.status === 'ACTIVE';
        if (filter === 'rejected') return t.status === 'REJECTED';
        return true; // 'all'
    });

    // Count stats
    const systemTemplates = templates.filter(t => SYSTEM_TEMPLATE_NAMES.has(t.name));
    const approvedCount = systemTemplates.filter(t => t.status === 'APPROVED' || t.status === 'ACTIVE').length;
    const rejectedCount = systemTemplates.filter(t => t.status === 'REJECTED').length;
    const pendingCount = systemTemplates.filter(t => t.status === 'PENDING').length;

    const getStatusBadge = (status: string) => {
        switch (status) {
            case 'APPROVED':
            case 'ACTIVE':
                return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase border border-green-700 bg-green-50 text-green-800">
                        <CheckCircle className="w-3 h-3" /> APPROVED
                    </span>
                );
            case 'REJECTED':
                return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase border border-red-700 bg-red-50 text-red-700">
                        <XCircle className="w-3 h-3" /> REJECTED
                    </span>
                );
            case 'PENDING':
                return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase border border-yellow-700 bg-yellow-50 text-yellow-800">
                        <Clock className="w-3 h-3" /> PENDING
                    </span>
                );
            default:
                return (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-bold uppercase border border-gray-500 bg-gray-50 text-gray-600">
                        <AlertTriangle className="w-3 h-3" /> {status}
                    </span>
                );
        }
    };

    return (
        <div className="p-6 md:p-8 max-w-[1400px] mx-auto fade-in">
            {/* Header */}
            <div className="flex flex-col md:flex-row items-start md:items-center justify-between mb-8 gap-4">
                <div>
                    <h1 className="text-3xl font-black uppercase mb-2">Templates</h1>
                    <p className="font-mono text-sm text-gray-500 uppercase tracking-wide">
                        Facebook message template status & management
                    </p>
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                    {/* Page Selector */}
                    <select
                        value={selectedPageId}
                        onChange={(e) => setSelectedPageId(e.target.value)}
                        className="input-wireframe h-10 w-full md:w-64"
                    >
                        {pages.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                    </select>

                    {/* Refresh */}
                    <button
                        onClick={fetchTemplates}
                        disabled={loading}
                        className="btn-wireframe h-10 px-3"
                        title="Refresh statuses"
                    >
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>

                    {/* Submit All */}
                    <button
                        onClick={handleSubmitAll}
                        disabled={submitting || !selectedPageId}
                        className="btn-wireframe h-10 bg-black text-white hover:bg-gray-800 px-4 whitespace-nowrap"
                    >
                        {submitting ? 'Submitting...' : 'Submit Missing'}
                    </button>
                </div>
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <div className="border border-black p-4 bg-white">
                    <p className="text-xs font-bold uppercase text-gray-500 mb-1">Total (System)</p>
                    <p className="text-2xl font-black">{systemTemplates.length}</p>
                </div>
                <div className="border border-green-700 p-4 bg-green-50">
                    <p className="text-xs font-bold uppercase text-green-700 mb-1">Approved</p>
                    <p className="text-2xl font-black text-green-800">{approvedCount}</p>
                </div>
                <div className="border border-red-700 p-4 bg-red-50">
                    <p className="text-xs font-bold uppercase text-red-700 mb-1">Rejected</p>
                    <p className="text-2xl font-black text-red-700">{rejectedCount}</p>
                </div>
                <div className="border border-yellow-700 p-4 bg-yellow-50">
                    <p className="text-xs font-bold uppercase text-yellow-700 mb-1">Pending</p>
                    <p className="text-2xl font-black text-yellow-800">{pendingCount}</p>
                </div>
            </div>

            {/* Filter Tabs */}
            <div className="flex items-center gap-0 border border-black mb-4 bg-white w-fit">
                {([
                    { key: 'system', label: 'System Templates' },
                    { key: 'approved', label: 'Approved Only' },
                    { key: 'rejected', label: 'Rejected Only' },
                    { key: 'all', label: 'All Templates' },
                ] as const).map(({ key, label }) => (
                    <button
                        key={key}
                        onClick={() => setFilter(key)}
                        className={`px-4 py-2 text-xs font-bold uppercase border-r border-black last:border-r-0 transition-colors ${
                            filter === key
                                ? 'bg-black text-white'
                                : 'bg-white text-black hover:bg-gray-100'
                        }`}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Templates Table */}
            <div className="border border-black bg-white overflow-x-auto">
                {loading ? (
                    <div className="flex items-center justify-center py-12 gap-3">
                        <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
                        <span className="font-mono text-sm text-gray-500">Loading templates from Facebook...</span>
                    </div>
                ) : filteredTemplates.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-12 gap-2">
                        <FileText className="w-8 h-8 text-gray-300" />
                        <span className="font-mono text-sm text-gray-500">
                            {filter === 'system'
                                ? 'No system templates found on this page. Click "Submit Missing" to add them.'
                                : 'No templates match the current filter.'}
                        </span>
                    </div>
                ) : (
                    <table className="w-full">
                        <thead>
                            <tr className="border-b-2 border-black bg-gray-50">
                                <th className="text-left px-4 py-3 text-xs font-bold uppercase text-gray-600 w-10">#</th>
                                <th className="text-left px-4 py-3 text-xs font-bold uppercase text-gray-600">Status</th>
                                <th className="text-left px-4 py-3 text-xs font-bold uppercase text-gray-600">Template Name</th>
                                <th className="text-left px-4 py-3 text-xs font-bold uppercase text-gray-600">Category</th>
                                <th className="text-left px-4 py-3 text-xs font-bold uppercase text-gray-600 min-w-[300px]">Message Body</th>
                            </tr>
                        </thead>
                        <tbody>
                            {filteredTemplates.map((t, idx) => {
                                const isSystem = SYSTEM_TEMPLATE_NAMES.has(t.name);
                                return (
                                    <tr
                                        key={t.id || t.name + idx}
                                        className={`border-b border-gray-200 hover:bg-gray-50 transition-colors ${
                                            !isSystem ? 'opacity-50' : ''
                                        }`}
                                    >
                                        <td className="px-4 py-3 text-xs text-gray-400 font-mono">{idx + 1}</td>
                                        <td className="px-4 py-3">{getStatusBadge(t.status)}</td>
                                        <td className="px-4 py-3">
                                            <span className="font-mono font-bold text-sm">{t.name}</span>
                                            {isSystem && (
                                                <span className="ml-2 text-[10px] font-bold uppercase px-1.5 py-0.5 bg-blue-100 text-blue-700 border border-blue-300">
                                                    SYSTEM
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span className="text-xs font-mono text-gray-600 uppercase">{t.category}</span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <p className="text-xs font-mono text-gray-700 leading-relaxed max-w-md">
                                                {t.bodyText ? (
                                                    t.bodyText.split(/(\{\{\d+\}\})/).map((part, i) =>
                                                        /\{\{\d+\}\}/.test(part) ? (
                                                            <span key={i} className="inline-block bg-blue-100 text-blue-700 border border-blue-300 px-1 py-0.5 mx-0.5 rounded font-bold text-[11px]">
                                                                {part}
                                                            </span>
                                                        ) : (
                                                            <span key={i}>{part}</span>
                                                        )
                                                    )
                                                ) : (
                                                    <span className="text-gray-400 italic">No body text</span>
                                                )}
                                            </p>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>

            {/* Footer Info */}
            <div className="mt-4 p-3 border border-gray-300 bg-gray-50">
                <p className="text-xs font-mono text-gray-500">
                    <strong>Tip:</strong> Templates are automatically submitted when you connect a new page. 
                    Use &quot;Submit Missing&quot; to manually push any templates that haven&apos;t been submitted yet. 
                    Facebook reviews templates instantly — approved ones can be used for messaging outside the 24h window.
                </p>
            </div>
        </div>
    );
}
