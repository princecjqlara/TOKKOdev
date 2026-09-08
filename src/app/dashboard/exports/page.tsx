'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    Clock3,
    Download,
    FileSpreadsheet,
    Loader2,
    RefreshCw,
    RotateCcw
} from 'lucide-react';

type ExportJob = {
    id: string;
    page_id: string;
    page_name: string;
    scope: 'all' | 'selected';
    status: 'queued' | 'running' | 'completed' | 'failed';
    total_items: number | null;
    processed_items: number;
    conversation_count: number;
    message_count: number;
    filename: string;
    error_message: string | null;
    attempt_count: number;
    started_at: string | null;
    completed_at: string | null;
    expires_at: string;
    created_at: string;
};

const numberFormatter = new Intl.NumberFormat();

function formatDateTime(value: string | null) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    }).format(date);
}

function StatusBadge({ status }: { status: ExportJob['status'] }) {
    const styles = {
        queued: 'bg-yellow-100 text-yellow-900 border-yellow-800',
        running: 'bg-blue-100 text-blue-900 border-blue-800',
        completed: 'bg-green-100 text-green-900 border-green-800',
        failed: 'bg-red-100 text-red-900 border-red-800'
    };
    const Icon = status === 'completed'
        ? CheckCircle2
        : status === 'failed' ? AlertCircle : status === 'running' ? Loader2 : Clock3;
    return (
        <span className={`inline-flex items-center gap-1.5 border px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${styles[status]}`}>
            <Icon className={`w-3.5 h-3.5 ${status === 'running' ? 'animate-spin' : ''}`} />
            {status}
        </span>
    );
}

export default function ExportsPage() {
    const [jobs, setJobs] = useState<ExportJob[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [retryingId, setRetryingId] = useState('');
    const [error, setError] = useState('');

    const fetchJobs = useCallback(async (quiet = false) => {
        if (!quiet) setRefreshing(true);
        try {
            const response = await fetch('/api/exports', { cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Could not load exports.');
            setJobs(data.jobs || []);
            setError('');
        } catch (loadError) {
            setError((loadError as Error).message);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    useEffect(() => { fetchJobs(); }, [fetchJobs]);

    const activeJobId = useMemo(
        () => [...jobs]
            .reverse()
            .find((job) => job.status === 'queued' || job.status === 'running')?.id || '',
        [jobs]
    );

    useEffect(() => {
        if (!activeJobId) return;
        let cancelled = false;
        let nextRun: number | undefined;

        const processNextBatch = async () => {
            if (cancelled) return;
            let retryDelay = 100;
            try {
                const response = await fetch(`/api/exports/${activeJobId}/process`, { method: 'POST' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok && response.status !== 409) {
                    throw new Error(data.message || 'Could not continue the export.');
                }
                retryDelay = data.result ? 100 : 1000;
                if (!cancelled) await fetchJobs(true);
            } catch (processError) {
                retryDelay = 5000;
                if (!cancelled) setError((processError as Error).message);
            } finally {
                if (!cancelled) nextRun = window.setTimeout(processNextBatch, retryDelay);
            }
        };

        void processNextBatch();
        return () => {
            cancelled = true;
            if (typeof nextRun !== 'undefined') window.clearTimeout(nextRun);
        };
    }, [activeJobId, fetchJobs]);

    const retry = async (jobId: string) => {
        setRetryingId(jobId);
        try {
            const response = await fetch(`/api/exports/${jobId}/retry`, { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Could not retry the export.');
            await fetchJobs(true);
        } catch (retryError) {
            setError((retryError as Error).message);
        } finally {
            setRetryingId('');
        }
    };

    return (
        <div className="space-y-5">
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b-2 border-black pb-4">
                <div>
                    <div className="flex items-center gap-3">
                        <FileSpreadsheet className="w-7 h-7" />
                        <h1 className="text-2xl md:text-3xl font-bold text-black">Exports</h1>
                    </div>
                    <p className="text-sm text-gray-600 mt-2">
                        Conversation exports continue in the background. Finished files remain available for 7 days.
                    </p>
                </div>
                <button
                    type="button"
                    className="btn-wireframe self-start sm:self-auto"
                    onClick={() => fetchJobs()}
                    disabled={refreshing}
                >
                    <RefreshCw className={`w-4 h-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="border-2 border-red-700 bg-red-50 p-4 text-sm text-red-900 flex gap-3">
                    <AlertCircle className="w-5 h-5 flex-shrink-0" />
                    <span>{error}</span>
                </div>
            )}

            {loading ? (
                <div className="wireframe-card p-12 text-center">
                    <Loader2 className="w-7 h-7 animate-spin mx-auto mb-3" />
                    <p className="text-sm text-gray-600">Loading exports…</p>
                </div>
            ) : jobs.length === 0 ? (
                <div className="wireframe-card p-12 text-center">
                    <FileSpreadsheet className="w-10 h-10 mx-auto mb-4 text-gray-500" />
                    <h2 className="font-bold text-lg">No exports yet</h2>
                    <p className="text-sm text-gray-600 mt-2">Create one from the Contacts page.</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {jobs.map((job) => {
                        const total = Number(job.total_items || 0);
                        const processed = Number(job.processed_items || 0);
                        const percent = job.status === 'completed'
                            ? 100
                            : total > 0 ? Math.min(99, Math.round((processed / total) * 100)) : 0;
                        const expired = new Date(job.expires_at).getTime() <= Date.now();

                        return (
                            <article key={job.id} className="wireframe-card p-4 md:p-5">
                                <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex flex-wrap items-center gap-2 mb-2">
                                            <StatusBadge status={job.status} />
                                            <span className="text-xs font-semibold uppercase text-gray-600">
                                                {job.scope === 'selected' ? 'Selected contacts' : 'All conversations'}
                                            </span>
                                        </div>
                                        <h2 className="font-bold text-black truncate" title={job.filename}>{job.filename}</h2>
                                        <p className="text-sm text-gray-600 mt-1">{job.page_name}</p>

                                        {(job.status === 'queued' || job.status === 'running') && (
                                            <div className="mt-4 max-w-2xl">
                                                <div className="h-2.5 border border-black bg-white overflow-hidden">
                                                    <div
                                                        className={`h-full bg-black transition-all ${total === 0 ? 'w-1/4 animate-pulse' : ''}`}
                                                        style={total > 0 ? { width: `${percent}%` } : undefined}
                                                    />
                                                </div>
                                                <div className="flex justify-between gap-4 mt-1.5 text-xs text-gray-600">
                                                    <span>
                                                        {job.status === 'queued' && processed === 0
                                                            ? 'Waiting for background worker'
                                                            : `${numberFormatter.format(processed)} processed${total > 0 ? ` of about ${numberFormatter.format(total)}` : ''}`}
                                                    </span>
                                                    <span>{total > 0 ? `${percent}%` : 'Working…'}</span>
                                                </div>
                                            </div>
                                        )}

                                        {job.error_message && (
                                            <p className="mt-3 text-sm text-red-800 border-l-4 border-red-700 pl-3">{job.error_message}</p>
                                        )}

                                        <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4 text-sm">
                                            <div><dt className="text-xs uppercase text-gray-500">Conversations</dt><dd className="font-semibold mt-0.5">{numberFormatter.format(job.conversation_count)}</dd></div>
                                            <div><dt className="text-xs uppercase text-gray-500">Messages</dt><dd className="font-semibold mt-0.5">{numberFormatter.format(job.message_count)}</dd></div>
                                            <div><dt className="text-xs uppercase text-gray-500">Created</dt><dd className="font-semibold mt-0.5">{formatDateTime(job.created_at)}</dd></div>
                                            <div><dt className="text-xs uppercase text-gray-500">{job.completed_at ? 'Completed' : 'Expires'}</dt><dd className="font-semibold mt-0.5">{formatDateTime(job.completed_at || job.expires_at)}</dd></div>
                                        </dl>
                                    </div>

                                    <div className="flex lg:flex-col gap-2 flex-shrink-0">
                                        {job.status === 'completed' && !expired && (
                                            <a href={`/api/exports/${job.id}/download`} className="btn-wireframe">
                                                <Download className="w-4 h-4 mr-2" />
                                                Download CSV
                                            </a>
                                        )}
                                        {job.status === 'failed' && (
                                            <button
                                                type="button"
                                                className="btn-wireframe"
                                                onClick={() => retry(job.id)}
                                                disabled={retryingId === job.id}
                                            >
                                                {retryingId === job.id
                                                    ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                                                    : <RotateCcw className="w-4 h-4 mr-2" />}
                                                Retry
                                            </button>
                                        )}
                                        {expired && <span className="text-xs text-gray-500 font-semibold uppercase">Expired</span>}
                                    </div>
                                </div>
                            </article>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
