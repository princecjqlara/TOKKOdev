'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, ChevronRight, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import {
    ADS_ACTION_LABELS, ADS_GOAL_LABELS, DEFAULT_GUARD_SETTINGS, evaluateAds, ratio,
    validateGuardSettings, type AdDecision, type AdsAction, type AdsReport, type GuardSettings
} from '@/lib/ads-guard';

const ACTION_STYLES: Record<AdsAction, string> = {
    pause: 'bg-red-50 text-red-800 border-red-300', refresh: 'bg-orange-50 text-orange-800 border-orange-300',
    reduce: 'bg-amber-50 text-amber-800 border-amber-300', scale: 'bg-emerald-50 text-emerald-800 border-emerald-300',
    wait: 'bg-blue-50 text-blue-800 border-blue-300', hold: 'bg-gray-50 text-gray-700 border-gray-300',
    inactive: 'bg-gray-50 text-gray-600 border-gray-300', configure: 'bg-blue-50 text-blue-800 border-blue-300'
};

const SETTING_FIELDS: Array<{ key: keyof GuardSettings; label: string; min: number; max: number; step: number; hint: string }> = [
    { key: 'targetCpa', label: 'Maximum cost per result', min: 0.01, max: 1e9, step: 0.01, hint: 'In the ad account currency. Use your business economics, not a generic benchmark.' },
    { key: 'targetRoas', label: 'Minimum purchase ROAS', min: 0, max: 1000, step: 0.1, hint: 'Required to recommend scaling purchase ads. Revenue ÷ spend; 0 leaves this unset.' },
    { key: 'minResults', label: 'Minimum settled results', min: 5, max: 10000, step: 1, hint: 'Evidence needed before routine performance decisions.' },
    { key: 'minDays', label: 'Minimum delivery days', min: 3, max: 7, step: 1, hint: 'Counted outside the attribution delay.' },
    { key: 'attributionLagDays', label: 'Attribution delay (days)', min: 1, max: 6, step: 1, hint: 'Newest days excluded from decisive CPA rules. Increase for slower conversions.' },
    { key: 'stopLossMultiple', label: 'Stop-loss spend / target CPA', min: 3, max: 20, step: 0.5, hint: 'Settled spend needed before a statistically weak ad can trigger a pause review.' },
    { key: 'costRisePercent', label: 'Cost increase alert (%)', min: 5, max: 500, step: 1, hint: 'Last 7 completed days versus the previous 7.' },
    { key: 'fatigueFrequency', label: 'Fatigue frequency threshold', min: 1, max: 50, step: 0.1, hint: 'Only flags fatigue alongside falling CTR and rising CPA.' },
    { key: 'ctrDropPercent', label: 'Link CTR decline (%)', min: 5, max: 95, step: 1, hint: 'Minimum decline needed for a suspected fatigue signal.' }
];

export default function AdsGuard({ report, pageId = '', initialSettings = DEFAULT_GUARD_SETTINGS, storageKey, demo = false }: {
    report: AdsReport; pageId?: string; initialSettings?: GuardSettings; storageKey?: string; demo?: boolean;
}) {
    const [settings, setSettings] = useState(initialSettings);
    const [draft, setDraft] = useState(initialSettings);
    const [settingsError, setSettingsError] = useState('');
    const [saveMessage, setSaveMessage] = useState('');
    const [search, setSearch] = useState('');
    const [actionFilter, setActionFilter] = useState('all');
    const [selectedId, setSelectedId] = useState<string | null>(null);

    useEffect(() => {
        if (!storageKey) return;
        try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
                const parsed = JSON.parse(saved) as GuardSettings;
                if (validateGuardSettings(parsed)) { setSettings(parsed); setDraft(parsed); }
            }
        } catch { /* Targets remain usable if local storage is unavailable. */ }
    }, [storageKey]);

    const money = (value: number | null) => value === null ? '—' : new Intl.NumberFormat('en', {
        style: 'currency', currency: report.account.currency, maximumFractionDigits: 2
    }).format(value);
    const number = (value: number | null, suffix = '') => value === null ? '—' : `${value.toLocaleString('en', { maximumFractionDigits: 2 })}${suffix}`;
    const change = (value: number | null) => value === null ? 'No comparable baseline' : `${value > 0 ? '+' : ''}${value.toFixed(1)}% vs previous 7 days`;
    const probability = (value: number) => value < 0.01 ? 'Below 1%' : value > 0.99 ? 'Above 99%' : number(value * 100, '%');

    // Budget groups and multiple-test correction always use the whole account,
    // including ads belonging to another Page under the same campaign budget.
    const decisions = useMemo(() => evaluateAds(report, settings).filter(({ ad }) => !pageId || ad.pageId === pageId)
        .sort((a, b) => b.decision.priority - a.decision.priority || b.ad.current.spend - a.ad.current.spend), [report, pageId, settings]);
    const visible = decisions.filter(({ ad, decision }) => (actionFilter === 'all' || decision.action === actionFilter)
        && `${ad.name} ${ad.campaignName} ${ad.adsetName}`.toLowerCase().includes(search.toLowerCase()));
    const selected = visible.find(({ ad }) => ad.id === selectedId) || visible[0];
    const totals = decisions.reduce((sum, { ad }) => ({ spend: sum.spend + ad.current.spend, results: sum.results + ad.current.results }), { spend: 0, results: 0 });
    const attention = decisions.filter(({ decision }) => ['pause', 'refresh', 'reduce'].includes(decision.action)).length;
    const scaleCount = decisions.filter(({ decision }) => decision.action === 'scale').length;

    const applySettings = (event: React.FormEvent) => {
        event.preventDefault();
        if (!validateGuardSettings(draft) || draft.targetCpa <= 0) {
            setSettingsError('Enter a positive target cost and valid thresholds. Days and result counts must be whole numbers.'); return;
        }
        if (draft.minDays + draft.attributionLagDays > 7) {
            setSettingsError('Minimum delivery days plus attribution delay must fit within the 7-day window.'); return;
        }
        setSettings(draft); setSettingsError('');
        setSaveMessage(demo ? 'Example targets updated.' : 'Targets applied.');
        if (storageKey) {
            try { localStorage.setItem(storageKey, JSON.stringify(draft)); setSaveMessage('Targets saved in this browser for this account and goal.'); }
            catch { setSaveMessage('Targets applied for this session; browser storage is unavailable.'); }
        }
    };

    const metricRows = selected ? [
        ['Cost per result', money(selected.decision.cpa), money(selected.decision.previousCpa)],
        ['Spend', money(selected.ad.current.spend), money(selected.ad.previous.spend)],
        [ADS_GOAL_LABELS[report.goal], number(selected.ad.current.results), number(selected.ad.previous.results)],
        ['Link CTR', number(selected.decision.ctr, '%'), number(ratio(selected.ad.previous.linkClicks * 100, selected.ad.previous.impressions), '%')],
        ['CPM', money(selected.decision.cpm), money(ratio(selected.ad.previous.spend * 1000, selected.ad.previous.impressions))],
        ['Frequency', number(selected.ad.current.frequency), number(selected.ad.previous.frequency)],
        ...(report.goal === 'purchases' ? [['Purchase ROAS', number(selected.decision.roas, '×'), number(selected.ad.previous.revenue === null ? null : ratio(selected.ad.previous.revenue, selected.ad.previous.spend), '×')]] : [])
    ] : [];

    return <div className="space-y-5">
        {demo && <div className="border border-blue-300 bg-blue-50 p-4 text-sm text-blue-900"><strong>Example report.</strong> These are fictional ads showing how each recommendation works. Connect your ad account for real performance.</div>}
        <details className="border border-black bg-gray-50" open={settings.targetCpa <= 0 ? true : undefined}>
            <summary className="cursor-pointer p-4 font-semibold text-sm"><SlidersHorizontal className="inline w-4 h-4 mr-2" />Guard targets · {settings.targetCpa > 0 ? `${money(settings.targetCpa)} per result` : 'Set a target to unlock recommendations'}</summary>
            <form onSubmit={applySettings} className="border-t border-black p-4 space-y-4">
                <p className="text-sm text-gray-600">Define what a profitable result is for your business. Targets use {report.account.currency} and {ADS_GOAL_LABELS[report.goal].toLowerCase()}. Live targets are saved per account and goal in this browser.</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
                    {SETTING_FIELDS.filter(field => report.goal === 'purchases' || field.key !== 'targetRoas').map(field => <label key={field.key} className="block text-sm">
                        <span className="block font-medium mb-1">{field.label}</span>
                        <input className="input-wireframe bg-white" type="number" min={field.min} max={field.max} step={field.step}
                            value={draft[field.key] === 0 && field.key === 'targetCpa' ? '' : draft[field.key]} required
                            onChange={event => { setDraft({ ...draft, [field.key]: Number(event.target.value) }); setSaveMessage(''); }} />
                        <span className="block text-xs text-gray-500 mt-1">{field.hint}</span>
                    </label>)}
                </div>
                {settingsError && <p role="alert" className="text-sm text-red-700">{settingsError}</p>}
                <div className="flex items-center flex-wrap gap-3"><button type="submit" className="btn-wireframe-dark">Apply targets</button><span role="status" className="text-sm text-gray-600">{saveMessage}</span></div>
            </form>
        </details>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            {[
                ['Spend · last 7 days', money(totals.spend), `${decisions.length} ads in this view`],
                [ADS_GOAL_LABELS[report.goal], number(totals.results), `${money(ratio(totals.spend, totals.results))} per result`],
                ['Need attention', String(attention), 'Pause, cost, or creative review'],
                ['Scale candidates', String(scaleCount), 'Review the shared budget first']
            ].map(([label, value, hint]) => <div key={label} className="border border-black p-4"><p className="text-xs text-gray-600">{label}</p><p className="text-2xl font-semibold mt-2">{value}</p><p className="text-xs text-gray-500 mt-1">{hint}</p></div>)}
        </div>
        {report.warnings.map(warning => <p key={warning} className="border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{warning}</p>)}
        {report.account.account_status !== 1 && <p role="alert" className="border border-red-300 bg-red-50 p-3 text-sm text-red-800">This ad account is not active. Check account delivery and payment in Ads Manager before using performance recommendations.</p>}

        <div className="flex flex-col sm:flex-row gap-3">
            <label className="relative flex-1"><span className="sr-only">Search ads</span><Search className="absolute left-3 top-3 w-4 h-4 text-gray-500" /><input className="input-wireframe pl-9" placeholder="Search ads, campaigns, or ad sets" value={search} onChange={event => setSearch(event.target.value)} /></label>
            <label><span className="sr-only">Filter by recommendation</span><select className="input-wireframe" value={actionFilter} onChange={event => setActionFilter(event.target.value)}><option value="all">All recommendations</option>{Object.entries(ADS_ACTION_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        </div>

        {!visible.length ? <div className="border border-black p-8 text-center"><ShieldCheck className="w-7 h-7 mx-auto mb-3" /><p className="font-semibold">No ads match this view</p><p className="text-sm text-gray-600 mt-2">Try another Page, account, or recommendation filter.</p></div> : <div className="grid grid-cols-1 xl:grid-cols-5 gap-5 items-start">
            <div className="xl:col-span-3 border border-black overflow-x-auto">
                <table className="w-full text-sm text-left">
                    <thead className="bg-gray-100 border-b border-black"><tr><th className="p-3">Ad / next action</th><th className="p-3 text-right">7-day spend</th><th className="p-3 text-right">Cost / result</th></tr></thead>
                    <tbody>{visible.map(({ ad, decision }) => <tr key={ad.id} className={`border-b border-gray-200 last:border-b-0 ${selected?.ad.id === ad.id ? 'bg-gray-50' : ''}`}>
                        <td className="p-3"><button onClick={() => setSelectedId(ad.id)} className="text-left w-full" aria-pressed={selected?.ad.id === ad.id}>
                            <span className="flex items-center justify-between gap-3 font-semibold mb-1">{ad.name}<ChevronRight className="w-4 h-4 shrink-0" /></span>
                            <span className="block text-xs text-gray-500 mb-2">{ad.campaignName} · {ad.adsetName}</span>
                            <DecisionBadge decision={decision} />
                        </button></td>
                        <td className="p-3 text-right whitespace-nowrap">{money(ad.current.spend)}</td>
                        <td className="p-3 text-right whitespace-nowrap"><span className="block">{money(decision.cpa)}</span><span className="text-xs text-gray-500">{decision.cpaChange === null ? `${number(ad.current.results)} results` : `${decision.cpaChange > 0 ? '+' : ''}${decision.cpaChange.toFixed(0)}%`}</span></td>
                    </tr>)}</tbody>
                </table>
            </div>
            {selected && <article className="xl:col-span-2 border border-black" aria-label="Ad recommendation details">
                <div className="p-4 border-b border-black bg-gray-50"><p className="text-xs text-gray-500 mb-2">NEXT BEST ACTION</p><DecisionBadge decision={selected.decision} /><h2 className="text-base mt-3 normal-case">{selected.ad.name}</h2><p className="text-xs text-gray-600 mt-1">{selected.decision.evidence} evidence · {selected.ad.status.replace(/_/g, ' ')}</p></div>
                <div className="p-4 space-y-5">
                    <div><h3 className="text-xs mb-2">Why this action</h3><p className="text-sm leading-relaxed">{selected.decision.reason}</p><p className="text-xs text-gray-500 mt-2">{change(selected.decision.cpaChange)}</p></div>
                    {selected.decision.probabilityMeetingTarget !== null && <div className="border border-gray-300 bg-gray-50 p-3 space-y-2 text-xs">
                        <p className="font-semibold">Performance model · settled data</p>
                        <p>Estimated chance of meeting target: <strong>{probability(selected.decision.probabilityMeetingTarget)}</strong></p>
                        <p>90% modeled CPA range: <strong>{money(selected.decision.cpaRange?.low ?? null)} – {money(selected.decision.cpaRange?.high ?? null)}</strong></p>
                        <p>{money(selected.decision.settledSpend)} spent · {selected.decision.settledResults} settled results</p>
                        {selected.decision.costIncreaseProbability !== null && <p>Chance cost rose beyond your threshold: {probability(selected.decision.costIncreaseProbability)}</p>}
                        <p className="text-gray-500">Model estimates depend on attribution and rate assumptions; they are not a promise of future performance.</p>
                    </div>}
                    {selected.decision.diagnostics.length > 0 && <div><h3 className="text-xs mb-2">What changed</h3><ul className="list-disc pl-4 text-sm space-y-2">{selected.decision.diagnostics.map(diagnostic => <li key={diagnostic}>{diagnostic}</li>)}</ul></div>}
                    <div><h3 className="text-xs mb-2">What to fix / change</h3><ol className="list-decimal pl-5 space-y-2 text-sm">{selected.decision.fixes.map(fix => <li key={fix}>{fix}</li>)}</ol></div>
                    <div className="overflow-x-auto"><table className="w-full text-xs text-left"><thead><tr className="border-b border-black"><th className="py-2">Metric</th><th className="py-2 text-right">Last 7</th><th className="py-2 text-right">Previous 7</th></tr></thead><tbody>{metricRows.map(([label, current, previous]) => <tr key={label} className="border-b border-gray-200"><td className="py-2 pr-2">{label}</td><td className="py-2 text-right">{current}</td><td className="py-2 text-right">{previous}</td></tr>)}</tbody></table></div>
                    <div><h3 className="text-xs mb-2">Daily spend and results</h3><div className="space-y-2">{selected.ad.daily.map(day => <div key={day.date} className="grid grid-cols-[40px_1fr_80px] items-center gap-2 text-xs"><span className="text-gray-500">{day.date.slice(5)}</span><div className="h-2 bg-gray-100"><div className="h-full bg-gray-700" style={{ width: `${Math.max(0, day.spend / Math.max(1, ...selected.ad.daily.map(d => d.spend)) * 100)}%` }} /></div><span className="text-right">{money(day.spend)} · {day.results}</span></div>)}</div><p className="text-xs text-gray-500 mt-2">Bar = spend · trailing number = results. Last 3-day CPA: {money(selected.decision.recentCpa)}.</p></div>
                    <div className="bg-amber-50 p-3 border border-amber-200"><h3 className="text-xs mb-2">Before acting</h3><ul className="list-disc pl-4 text-xs space-y-2">{selected.decision.cautions.map(caution => <li key={caution}>{caution}</li>)}</ul></div>
                    <p className="text-xs text-gray-600"><strong>Next check:</strong> {selected.decision.recheck}</p>
                    {!demo && <a href={`https://adsmanager.facebook.com/adsmanager/manage/ads?act=${report.account.id.replace('act_', '')}&selected_ad_ids=${selected.ad.id}`} target="_blank" rel="noopener noreferrer" className="btn-wireframe w-full gap-2">Review in Ads Manager<ArrowUpRight className="w-4 h-4" /></a>}
                </div>
            </article>}
        </div>}
        <details className="border border-black p-4 text-sm"><summary className="cursor-pointer font-semibold">How the guard makes decisions</summary><div className="mt-4 space-y-3 text-gray-600 leading-relaxed">
            <p>CPA = spend ÷ selected results. Link CTR = link clicks ÷ impressions. CPM = spend ÷ impressions × 1,000. ROAS = reported purchase value ÷ spend. Weekly frequency comes from Meta’s full-period report; daily reach is never summed to estimate it.</p>
            <p>A Gamma/Poisson model estimates the chance of meeting target and a 90% CPA range. A weak, leave-one-out portfolio prior stabilizes small samples; uneven daily conversions widen the range. Pause reviews require settled spend above your stop-loss, a false-discovery-adjusted screening score below 5%, a modeled chance of meeting target below 5%, and zero results or CPA at least 50% above target.</p>
            <p>Suspected fatigue requires frequency above your threshold, link CTR down, and CPA up with enough results in both weeks. Matched settled days from the previous week estimate the probability of a cost increase. Scaling requires a conservative CPA range within target, stable settled delivery, low day-to-day volatility, and the complete shared campaign or ad set budget to meet target. Learning-phase ads and unknown budget owners are held back. Purchase ads also need ROAS at least 20% above your minimum.</p>
            <p>Reports use completed days in {report.account.timezone_name}, with each ad set’s attribution setting and results reported against impression dates. Targets and rules are configurable heuristics. Check tracking, lead quality, sales margin, and every ad sharing a budget before acting.</p>
            <p>This page checks ads when loaded or refreshed. Recommendations do not change ads. Continuous monitoring and automatic actions would need a scheduled worker, durable settings, and separate ad-management access.</p>
        </div></details>
    </div>;
}

function DecisionBadge({ decision }: { decision: AdDecision }) {
    return <span className={`inline-block border px-2 py-1 text-xs font-semibold ${ACTION_STYLES[decision.action]}`}>{ADS_ACTION_LABELS[decision.action]}</span>;
}
