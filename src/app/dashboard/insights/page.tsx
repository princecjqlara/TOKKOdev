'use client';
import { useEffect, useState } from 'react';
import InquiryInsights from '@/components/InquiryInsights';
import type { InquiryReport } from '@/lib/inquiry-insights';
type PageOption = { id: string; name: string };
function today(offset = 0) { return new Date(Date.now() + 8 * 3600000 + offset * 86400000).toISOString().slice(0, 10); }
export default function InquiryInsightsPage() {
    const [pages, setPages] = useState<PageOption[]>([]), [page, setPage] = useState('');
    const [from, setFrom] = useState(() => today(-29)), [to, setTo] = useState(() => today());
    const [kind, setKind] = useState('all'), [horizon, setHorizon] = useState('24'), [version, setVersion] = useState(0);
    const [report, setReport] = useState<InquiryReport | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false);
    const [returnDays, setReturnDays] = useState('30'), [sla, setSla] = useState('60'), [saving, setSaving] = useState(false), [saveMessage, setSaveMessage] = useState('');
    useEffect(() => {
        const c = new AbortController();
        fetch('/api/pages?membershipOnly=1', { signal: c.signal }).then(async r => { if (!r.ok) throw Error('Could not load assigned Pages.');return r.json(); })
            .then(b => { if (!c.signal.aborted) { setPages(b.pages || []);setPage(current => current || b.pages?.[0]?.id || ''); } })
            .catch(e => { if (!c.signal.aborted) setError(e.message); });
        return () => c.abort();
    }, [version]);
    useEffect(() => {
        setReport(null);setError('');setSaveMessage('');if (!page) return;
        const c = new AbortController();setLoading(true);
        fetch('/api/pages/' + page + '/insights?' + new URLSearchParams({ from, to, kind, horizon }), { signal: c.signal })
            .then(async r => { const b = await r.json();if (!r.ok) throw Error(b.error || 'Could not load inquiry insights.');return b; })
            .then(b => { if (!c.signal.aborted) { setReport(b);setReturnDays(String(b.collection.returning_after_days || 30));setSla(String(b.collection.response_sla_minutes || 60)); } })
            .catch(e => { if (!c.signal.aborted) setError(e.message); }).finally(() => { if (!c.signal.aborted) setLoading(false); });
        return () => c.abort();
    }, [page, from, to, kind, horizon, version]);
    async function save() {
        setSaving(true);setSaveMessage('');
        try { const r = await fetch('/api/pages/' + page + '/insights', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ returning_after_days: Number(returnDays), response_sla_minutes: Number(sla) }) });const b = await r.json();if (!r.ok) throw Error(b.error);setVersion(v => v + 1); }
        catch (e) { setSaveMessage(e instanceof Error ? e.message : 'Settings could not be saved.'); }
        finally { setSaving(false); }
    }
    const input = 'border-2 border-black bg-white px-3 py-2 w-full';
    return <div className="space-y-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-3xl font-black uppercase">Inquiry insights</h1><p className="mt-2 text-sm">New and returning contacts, observed CRM stages, reply times and source coverage.</p></div><button className="btn-wireframe" onClick={() => setVersion(v => v + 1)} disabled={loading}>Refresh report</button></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5"><label className="text-sm font-bold">Page<select className={input} value={page} onChange={e => setPage(e.target.value)}><option value="">Choose a Page</option>{pages.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="text-sm font-bold">From · PHT<input className={input} type="date" value={from} onChange={e => setFrom(e.target.value)} /></label><label className="text-sm font-bold">Through · PHT<input className={input} type="date" value={to} onChange={e => setTo(e.target.value)} /></label><label className="text-sm font-bold">Inquiry type<select className={input} value={kind} onChange={e => setKind(e.target.value)}><option value="all">All inquiries</option><option value="new_contact">New contacts</option><option value="returning_contact">Returning inquiries</option></select></label><label className="text-sm font-bold">Observation window<select className={input} value={horizon} onChange={e => setHorizon(e.target.value)}><option value="24">24 hours</option><option value="168">7 days</option></select></label></div>
        {loading && <p role="status">Loading inquiry insights…</p>}{error && <div role="alert" className="border-2 border-red-700 p-4"><p>{error}</p><button className="btn-wireframe mt-3" onClick={() => setVersion(v => v + 1)}>Retry</button></div>}
        {!loading && !error && !page && <p role="status">Choose an assigned Page to see its inquiry report.</p>}
        {report && <><InquiryInsights report={report} />{report.can_manage && <details className="border-2 border-black p-4"><summary className="font-bold cursor-pointer">Page reporting settings</summary><p className="text-sm mt-3">Page administrators can change these reporting rules. Returning gaps are saved with each new message; changing this setting does not regroup older messages.</p><div className="grid gap-3 sm:grid-cols-3 mt-4"><label className="text-sm font-bold">Returning after days<input className={input} type="number" min="1" max="365" value={returnDays} onChange={e => setReturnDays(e.target.value)} /></label><label className="text-sm font-bold">Response target · minutes<input className={input} type="number" min="1" max="1440" value={sla} onChange={e => setSla(e.target.value)} /></label><button className="btn-wireframe self-end" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save reporting settings'}</button></div>{saveMessage && <p role="alert" className="mt-3 text-sm">{saveMessage}</p>}</details>}</>}
    </div>;
}
