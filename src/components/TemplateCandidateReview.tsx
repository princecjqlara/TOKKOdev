'use client';

import { useMemo, useState } from 'react';
import Pagination from './Pagination';
import { TEMPLATE_CANDIDATES } from '@/lib/facebook-template-candidates';
import { TEMPLATE_TONES, type TemplateTone } from '@/lib/facebook-template-order';

type RemoteTemplate = { name: string; status: string; language: string; bodyText: string; category: string };

export default function TemplateCandidateReview({ pageId, templates, disabled, onRefresh }: {
    pageId: string;
    templates: RemoteTemplate[];
    disabled: boolean;
    onRefresh: () => Promise<void>;
}) {
    const [tone, setTone] = useState<TemplateTone | 'all'>('all');
    const [query, setQuery] = useState('');
    const [page, setPage] = useState(1);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState('');
    const [localStatuses, setLocalStatuses] = useState<Record<string, string>>({});
    const remoteByName = useMemo(() => new Map(templates.filter(t => t.language === 'en_US').map(t => [t.name, t])), [templates]);
    const filtered = useMemo(() => TEMPLATE_CANDIDATES.filter(candidate =>
        (tone === 'all' || candidate.tone === tone) &&
        `${candidate.name} ${candidate.components[0].text}`.toLowerCase().includes(query.toLowerCase())
    ), [tone, query]);
    const visible = filtered.slice((page - 1) * 25, page * 25);
    const unsubmitted = visible.filter(candidate => !remoteByName.has(candidate.name) && !localStatuses[candidate.name]);

    async function submitVisible() {
        if (disabled || submitting || !pageId || !unsubmitted.length) return;
        setSubmitting(true);
        setMessage('');
        try {
            const response = await fetch('/api/facebook/templates/submit-all', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId, catalog: 'candidates', limit: 25, templateNames: unsubmitted.map(t => t.name) })
            });
            const data = await response.json();
            if (!response.ok || !data.success) throw new Error(data.message || 'Could not submit candidates.');
            const statuses: Record<string, string> = {};
            for (const result of data.results || []) {
                if (result.action !== 'error') statuses[result.name] = result.status || 'PENDING';
            }
            setLocalStatuses(previous => ({ ...previous, ...statuses }));
            const firstError = data.results?.find((result: { action: string }) => result.action === 'error');
            setMessage(`${Object.keys(statuses).length} submitted or already on this page. ${data.summary.errors} errors.${firstError?.error ? ` ${firstError.error}` : ''} Refresh to check Facebook approval.`);
            await onRefresh();
        } catch (error) {
            setMessage((error as Error).message);
        } finally {
            setSubmitting(false);
        }
    }

    return <section className="mb-6 border border-black bg-white p-4 space-y-4">
        <div>
            <h2 className="font-bold uppercase">Short conversational templates</h2>
            <p className="text-sm text-gray-600 mt-1">
                {TEMPLATE_CANDIDATES.length.toLocaleString()} natural message styles with {'{{1}}'}, ordered casual to formal.
                Submit a batch for Facebook review. Only approved templates can be selected for messages.
            </p>
        </div>
        <div className="flex flex-wrap gap-3">
            <select aria-label="Candidate tone" className="input-wireframe md:w-48" value={tone} onChange={event => { setTone(event.target.value as typeof tone); setPage(1); }}>
                <option value="all">Casual to formal</option>
                {TEMPLATE_TONES.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
            </select>
            <input aria-label="Search candidates" className="input-wireframe flex-1" placeholder="Search short templates..." value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
            <button type="button" className="btn-wireframe" disabled={disabled || submitting || !pageId || !unsubmitted.length} onClick={submitVisible}>
                {submitting ? 'Submitting for review...' : `Submit ${unsubmitted.length} for review`}
            </button>
        </div>
        {message && <p role="status" className="text-sm border border-gray-300 p-3">{message}</p>}
        <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
                <thead><tr className="border-b border-black"><th className="p-2">Tone</th><th className="p-2">Short message</th><th className="p-2">Page status</th></tr></thead>
                <tbody>{visible.map(candidate => {
                    const remote = remoteByName.get(candidate.name);
                    const status = remote?.status || localStatuses[candidate.name] || 'NOT SUBMITTED';
                    const changed = remote && remote.bodyText !== candidate.components[0].text;
                    return <tr key={candidate.name} className="border-b border-gray-200">
                        <td className="p-2 capitalize">{candidate.tone}</td>
                        <td className="p-2 font-mono" title={candidate.name}>{candidate.components[0].text}</td>
                        <td className="p-2 font-mono">{status}{changed ? ' (body differs)' : ''}{remote && remote.category !== 'UTILITY' ? ` (${remote.category})` : ''}</td>
                    </tr>;
                })}</tbody>
            </table>
        </div>
        <Pagination page={page} pageSize={25} total={filtered.length} onPageChange={setPage} />
    </section>;
}
