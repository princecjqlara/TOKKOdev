'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertTriangle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    Clock3,
    History as HistoryIcon,
    Loader2,
    MessageSquare,
    RefreshCw,
    Search,
    Tag,
    Trash2,
    User,
    Users,
    XCircle
} from 'lucide-react';
import Pagination from '@/components/Pagination';
import type { Page } from '@/types';

type ActivityActor = {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
};

type HistoryItem = {
    id: string;
    sourceId: string;
    source: 'campaign' | 'audit';
    pageId: string;
    kind: 'bulk_message' | 'bulk_tags' | 'bulk_delete' | 'other';
    actionType: string;
    title: string;
    status: string;
    actor: ActivityActor | null;
    targetCount: number;
    successCount: number;
    failureCount: number;
    pendingCount: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    scheduledAt: string | null;
    details: Record<string, unknown>;
};

type HistoryResponse = {
    items: HistoryItem[];
    page: number;
    pageSize: number;
    total: number;
    hasMore?: boolean;
    team: ActivityActor[];
    auditEnabled: boolean;
    summary: { targets: number; succeeded: number; failed: number; pending: number };
    message?: string;
};

type RecipientError = {
    id: string;
    contact_id: string;
    contact_name: string | null;
    psid: string | null;
    status: string;
    error_message: string;
    error_code?: number | null;
    error_type?: string | null;
    error_subcode?: number | null;
};

const numberFormatter = new Intl.NumberFormat();

function formatDateTime(value: string | null) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZoneName: 'short'
    }).format(date);
}

function durationBetween(start: string | null, end: string | null) {
    if (!start || !end) return '—';
    const milliseconds = new Date(end).getTime() - new Date(start).getTime();
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
    const seconds = Math.floor(milliseconds / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}

function humanize(value: string) {
    return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function detailValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'object') return JSON.stringify(value, null, 2);
    return String(value);
}

function StatusBadge({ status }: { status: string }) {
    const styles: Record<string, string> = {
        completed: 'bg-green-100 text-green-900 border-green-800',
        partial: 'bg-amber-100 text-amber-900 border-amber-800',
        failed: 'bg-red-100 text-red-900 border-red-800',
        cancelled: 'bg-gray-200 text-gray-800 border-gray-600',
        sending: 'bg-blue-100 text-blue-900 border-blue-800',
        running: 'bg-blue-100 text-blue-900 border-blue-800',
        scheduled: 'bg-purple-100 text-purple-900 border-purple-800',
        pending: 'bg-yellow-100 text-yellow-900 border-yellow-800'
    };
    return (
        <span className={`inline-flex border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${styles[status] || 'bg-white text-black border-black'}`}>
            {status}
        </span>
    );
}

function ActivityIcon({ kind }: { kind: HistoryItem['kind'] }) {
    const Icon = kind === 'bulk_message' ? MessageSquare : kind === 'bulk_tags' ? Tag : kind === 'bulk_delete' ? Trash2 : HistoryIcon;
    return <Icon className="w-4 h-4" />;
}

export default function HistoryPage() {
    const [pages, setPages] = useState<Page[]>([]);
    const [selectedPageId, setSelectedPageId] = useState('');
    const [items, setItems] = useState<HistoryItem[]>([]);
    const [team, setTeam] = useState<ActivityActor[]>([]);
    const [summary, setSummary] = useState({ targets: 0, succeeded: 0, failed: 0, pending: 0 });
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(25);
    const [kind, setKind] = useState('all');
    const [statusFilter, setStatusFilter] = useState('all');
    const [actorId, setActorId] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [auditEnabled, setAuditEnabled] = useState(true);
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [recipientErrors, setRecipientErrors] = useState<Record<string, RecipientError[]>>({});
    const [recipientErrorTotals, setRecipientErrorTotals] = useState<Record<string, number>>({});
    const [loadingErrors, setLoadingErrors] = useState<Set<string>>(new Set());

    useEffect(() => {
        const loadPages = async () => {
            try {
                const response = await fetch('/api/pages');
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || 'Failed to load pages');
                const nextPages = data.pages || [];
                setPages(nextPages);
                setSelectedPageId((current) => current || nextPages[0]?.id || '');
            } catch (loadError) {
                setError((loadError as Error).message);
                setLoading(false);
            }
        };
        loadPages();
    }, []);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setSearch(searchInput.trim());
            setPage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [searchInput]);

    const fetchHistory = useCallback(async () => {
        if (!selectedPageId) {
            setItems([]);
            setLoading(false);
            return;
        }
        setLoading(true);
        setError('');
        try {
            const params = new URLSearchParams({
                page: String(page), pageSize: String(pageSize), kind, status: statusFilter
            });
            if (search) params.set('search', search);
            if (actorId) params.set('actorId', actorId);
            if (dateFrom) params.set('dateFrom', dateFrom);
            if (dateTo) params.set('dateTo', dateTo);
            const response = await fetch(`/api/pages/${selectedPageId}/history?${params.toString()}`, { cache: 'no-store' });
            const data: HistoryResponse = await response.json();
            if (!response.ok) throw new Error(data.message || 'Failed to load history');
            setItems(data.items || []);
            setTotal(data.total || 0);
            setTeam(data.team || []);
            setSummary(data.summary || { targets: 0, succeeded: 0, failed: 0, pending: 0 });
            setAuditEnabled(data.auditEnabled !== false);
        } catch (loadError) {
            setError((loadError as Error).message);
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [selectedPageId, page, pageSize, kind, statusFilter, actorId, dateFrom, dateTo, search]);

    useEffect(() => { fetchHistory(); }, [fetchHistory]);

    const selectedPage = useMemo(() => pages.find((candidate) => candidate.id === selectedPageId), [pages, selectedPageId]);

    const resetFilters = () => {
        setKind('all'); setStatusFilter('all'); setActorId('');
        setDateFrom(''); setDateTo(''); setSearchInput(''); setSearch(''); setPage(1);
    };

    const toggleExpanded = (id: string) => {
        setExpanded((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const loadRecipientErrors = async (item: HistoryItem) => {
        if (recipientErrors[item.sourceId] || loadingErrors.has(item.sourceId)) return;
        setLoadingErrors((current) => new Set(current).add(item.sourceId));
        try {
            const response = await fetch(`/api/campaigns/${item.sourceId}/recipients?page=1&pageSize=25&status=failed`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Failed to load recipient errors');
            setRecipientErrors((current) => ({ ...current, [item.sourceId]: data.items || [] }));
            setRecipientErrorTotals((current) => ({ ...current, [item.sourceId]: data.total || 0 }));
        } catch (loadError) {
            setError((loadError as Error).message);
        } finally {
            setLoadingErrors((current) => {
                const next = new Set(current); next.delete(item.sourceId); return next;
            });
        }
    };

    const statCards = [
        { label: 'Selected activities', value: items.length, icon: HistoryIcon },
        { label: 'Targeted', value: summary.targets, icon: Users },
        { label: 'Succeeded', value: summary.succeeded, icon: CheckCircle2 },
        { label: 'Failed', value: summary.failed, icon: XCircle }
    ];

    return (
        <div className="space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 border-b-2 border-black pb-4">
                <div>
                    <div className="flex items-center gap-2 mb-1">
                        <HistoryIcon className="w-6 h-6" />
                        <h1 className="text-2xl md:text-3xl font-bold text-black">Bulk History</h1>
                    </div>
                    <p className="font-mono text-xs text-gray-600">
                        Shared audit trail for everyone with access to {selectedPage?.name || 'this page'}.
                    </p>
                </div>
                <div className="flex gap-2">
                    <select
                        value={selectedPageId}
                        onChange={(event) => { setSelectedPageId(event.target.value); setPage(1); setExpanded(new Set()); }}
                        className="input-wireframe h-10 min-w-52"
                        aria-label="Facebook page"
                    >
                        {pages.length === 0 && <option value="">No connected pages</option>}
                        {pages.map((connectedPage) => <option key={connectedPage.id} value={connectedPage.id}>{connectedPage.name}</option>)}
                    </select>
                    <button onClick={fetchHistory} disabled={loading || !selectedPageId} className="btn-wireframe h-10" title="Refresh history">
                        <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                        <span className="hidden sm:inline ml-2">Refresh</span>
                    </button>
                </div>
            </div>

            {!auditEnabled && (
                <div className="border border-amber-700 bg-amber-50 p-3 flex gap-2 text-sm">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-800" />
                    <div><b>Campaign history is available.</b> Run <code>database/migration_bulk_activity_history.sql</code> to also retain bulk tag and contact deletion events.</div>
                </div>
            )}

            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {statCards.map(({ label, value, icon: Icon }) => (
                    <div key={label} className="border border-black bg-white p-4">
                        <div className="flex items-center justify-between gap-2">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-600">{label}</span>
                            <Icon className="w-4 h-4" />
                        </div>
                        <p className="mt-2 font-mono text-2xl font-bold">{numberFormatter.format(value)}</p>
                        <p className="text-[10px] text-gray-500 mt-1">On this result page</p>
                    </div>
                ))}
            </div>

            <div className="border border-black bg-[#f7f7f7] p-3 space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-2">
                    <div className="relative xl:col-span-2">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                        <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search activity name..." className="input-wireframe h-10 w-full pl-9" />
                    </div>
                    <select value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }} className="input-wireframe h-10">
                        <option value="all">All bulk actions</option>
                        <option value="bulk_message">Messages</option>
                        <option value="bulk_tags">Tag changes</option>
                        <option value="bulk_delete">Deletions</option>
                    </select>
                    <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="input-wireframe h-10">
                        <option value="all">All statuses</option>
                        <option value="completed">Completed</option>
                        <option value="partial">Partial</option>
                        <option value="failed">Failed</option>
                        <option value="sending">Sending</option>
                        <option value="scheduled">Scheduled</option>
                        <option value="pending">Pending</option>
                        <option value="cancelled">Cancelled</option>
                    </select>
                    <select value={actorId} onChange={(event) => { setActorId(event.target.value); setPage(1); }} className="input-wireframe h-10">
                        <option value="">All team members</option>
                        {team.map((member) => <option key={member.id} value={member.id}>{member.name || member.email || 'Unknown user'}</option>)}
                    </select>
                    <button onClick={resetFilters} className="btn-wireframe h-10">Clear filters</button>
                </div>
                <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
                    <span className="text-[10px] font-bold uppercase text-gray-600">Activity date</span>
                    <input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(1); }} className="input-wireframe h-9" aria-label="From date" />
                    <span className="text-xs text-gray-500">to</span>
                    <input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(1); }} className="input-wireframe h-9" aria-label="To date" />
                    <span className="sm:ml-auto font-mono text-xs text-gray-600">{numberFormatter.format(total)} matching activities</span>
                </div>
            </div>

            {error && <div className="border border-red-700 bg-red-50 p-3 text-sm text-red-900"><b>Could not load history:</b> {error}</div>}

            <div className="border border-black overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="table-wireframe w-full min-w-[1050px]">
                        <thead>
                            <tr>
                                <th className="w-10"></th><th>Activity</th><th>Who</th><th>Status</th><th>Recipients / Items</th><th>When</th><th>Duration</th>
                            </tr>
                        </thead>
                        <tbody>
                            {loading ? (
                                <tr><td colSpan={7}><div className="flex items-center justify-center gap-2 py-12 font-mono text-sm"><Loader2 className="w-5 h-5 animate-spin" /> Loading shared history...</div></td></tr>
                            ) : items.length === 0 ? (
                                <tr><td colSpan={7}><div className="text-center py-14"><HistoryIcon className="w-9 h-9 mx-auto mb-3 text-gray-400" /><p className="font-bold">No matching bulk activity</p><p className="font-mono text-xs text-gray-500 mt-1">Try another page, date, or filter.</p></div></td></tr>
                            ) : items.map((item) => {
                                const isExpanded = expanded.has(item.id);
                                return (
                                    <ActivityRows
                                        key={item.id}
                                        item={item}
                                        expanded={isExpanded}
                                        onToggle={() => toggleExpanded(item.id)}
                                        errors={recipientErrors[item.sourceId]}
                                        errorTotal={recipientErrorTotals[item.sourceId] || 0}
                                        errorsLoading={loadingErrors.has(item.sourceId)}
                                        onLoadErrors={() => loadRecipientErrors(item)}
                                    />
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            <Pagination page={page} pageSize={pageSize} total={total} onPageChange={setPage} onPageSizeChange={(next) => { setPageSize(next); setPage(1); }} />
        </div>
    );
}

function ActivityRows({ item, expanded, onToggle, errors, errorTotal, errorsLoading, onLoadErrors }: {
    item: HistoryItem; expanded: boolean; onToggle: () => void; errors?: RecipientError[];
    errorTotal: number; errorsLoading: boolean; onLoadErrors: () => void;
}) {
    const actorLabel = item.actor?.name || item.actor?.email || 'Former / unknown user';
    return (
        <>
            <tr className="hover:bg-gray-50 align-top">
                <td><button onClick={onToggle} className="p-1" aria-label={expanded ? 'Collapse details' : 'Expand details'}>{expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></td>
                <td>
                    <button onClick={onToggle} className="text-left max-w-md">
                        <span className="flex items-center gap-2 font-bold"><ActivityIcon kind={item.kind} />{item.title}</span>
                        <span className="block mt-1 font-mono text-[10px] uppercase text-gray-500">{humanize(item.actionType)} · ID {item.sourceId}</span>
                    </button>
                </td>
                <td>
                    <div className="flex items-center gap-2">
                        {item.actor?.image ? <img src={item.actor.image} alt="" className="w-7 h-7 object-cover border border-black" /> : <span className="w-7 h-7 border border-black flex items-center justify-center"><User className="w-4 h-4" /></span>}
                        <span><span className="block text-xs font-bold">{actorLabel}</span>{item.actor?.email && item.actor.name && <span className="block font-mono text-[10px] text-gray-500">{item.actor.email}</span>}</span>
                    </div>
                </td>
                <td><StatusBadge status={item.status} /></td>
                <td className="font-mono text-xs">
                    <span className="font-bold">{numberFormatter.format(item.targetCount)}</span> total
                    <span className="block text-green-700">{numberFormatter.format(item.successCount)} succeeded</span>
                    {(item.failureCount > 0 || item.pendingCount > 0) && <span className="block text-gray-600">{numberFormatter.format(item.failureCount)} failed · {numberFormatter.format(item.pendingCount)} pending</span>}
                </td>
                <td className="font-mono text-[11px] whitespace-nowrap"><span className="block font-bold">{formatDateTime(item.createdAt)}</span>{item.scheduledAt && <span className="block mt-1 text-purple-800">Scheduled: {formatDateTime(item.scheduledAt)}</span>}</td>
                <td className="font-mono text-xs">{durationBetween(item.startedAt || item.createdAt, item.completedAt)}</td>
            </tr>
            {expanded && (
                <tr className="bg-[#f7f7f7]"><td colSpan={7} className="!p-0">
                    <div className="p-4 border-t border-black space-y-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                            <Detail label="Created" value={formatDateTime(item.createdAt)} />
                            <Detail label="Started" value={formatDateTime(item.startedAt)} />
                            <Detail label="Completed" value={formatDateTime(item.completedAt)} />
                            <Detail label="Scheduled" value={formatDateTime(item.scheduledAt)} />
                        </div>
                        <div>
                            <p className="text-[10px] font-bold uppercase tracking-wider mb-2">Recorded details</p>
                            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-px bg-black border border-black">
                                {Object.entries(item.details).map(([key, value]) => <Detail key={key} label={humanize(key)} value={detailValue(value)} boxed />)}
                            </div>
                        </div>
                        {item.source === 'campaign' && item.failureCount > 0 && (
                            <div>
                                <button onClick={onLoadErrors} disabled={errorsLoading} className="btn-wireframe text-xs">
                                    {errorsLoading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <AlertTriangle className="w-4 h-4 mr-2" />} View recipient failures
                                </button>
                                {errors && <div className="mt-3 border border-black bg-white overflow-x-auto">
                                    <table className="table-wireframe w-full min-w-[700px]"><thead><tr><th>Contact</th><th>PSID</th><th>Error</th><th>Code</th></tr></thead>
                                        <tbody>{errors.map((entry) => <tr key={entry.id}><td className="font-bold">{entry.contact_name || 'Unknown contact'}</td><td className="font-mono text-xs">{entry.psid || '—'}</td><td className="text-xs text-red-800">{entry.error_message}</td><td className="font-mono text-xs">{entry.error_code || '—'}{entry.error_subcode ? ` / ${entry.error_subcode}` : ''}</td></tr>)}</tbody>
                                    </table>
                                    {errorTotal > errors.length && <p className="p-2 font-mono text-[10px] border-t border-black">Showing {errors.length} of {errorTotal} failures. Open Campaigns for full pagination and retry controls.</p>}
                                </div>}
                            </div>
                        )}
                    </div>
                </td></tr>
            )}
        </>
    );
}

function Detail({ label, value, boxed = false }: { label: string; value: string; boxed?: boolean }) {
    return <div className={boxed ? 'bg-white p-3 min-w-0' : 'border border-black bg-white p-3'}><p className="text-[10px] font-bold uppercase tracking-wide text-gray-500">{label}</p><pre className="font-mono text-xs mt-1 whitespace-pre-wrap break-all">{value}</pre></div>;
}
