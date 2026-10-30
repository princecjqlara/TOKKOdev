'use client';

import { signIn, useSession } from 'next-auth/react';
import { facebookSignInCallback } from '@/lib/facebook-signin';
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import AdsGuard from '@/components/AdsGuard';
import { ADS_GOAL_LABELS, type AdsAccount, type AdsGoal, type AdsReport } from '@/lib/ads-guard';
import { createAdsGuardDemo, DEMO_GUARD_SETTINGS } from '@/lib/ads-guard-demo';
import { FACEBOOK_ADS_PERMISSION_SCOPE } from '@/lib/facebook-permissions';

type PageOption = { id: string; fb_page_id: string; name: string };

export default function AdsGuardPage() {
    const { data: session, status } = useSession();
    const [accounts, setAccounts] = useState<AdsAccount[]>([]);
    const [pages, setPages] = useState<PageOption[]>([]);
    const [accountId, setAccountId] = useState('');
    const [goal, setGoal] = useState<AdsGoal>('messages');
    const [pageId, setPageId] = useState('');
    const [reportState, setReportState] = useState<{ key: string; report: AdsReport } | null>(null);
    const [loadingAccounts, setLoadingAccounts] = useState(true);
    const [loadingReport, setLoadingReport] = useState(false);
    const [error, setError] = useState('');
    const [accountsError, setAccountsError] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [demo, setDemo] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const demoReport = useMemo(() => createAdsGuardDemo(), []);
    const selectionKey = `${accountId}:${goal}`;
    const report = reportState?.key === selectionKey ? reportState.report : null;

    useEffect(() => {
        if (status !== 'authenticated') return;
        const controller = new AbortController();
        setLoadingAccounts(true); setAccountsError('');
        const load = async () => {
            const results = await Promise.allSettled([
                fetch('/api/ads/accounts', { signal: controller.signal, cache: 'no-store' }).then(async response => {
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Could not load ad accounts.');
                    return data.accounts as AdsAccount[];
                }),
                fetch('/api/pages', { signal: controller.signal }).then(async response => {
                    if (!response.ok) return [];
                    const data = await response.json();
                    return (data.pages || []) as PageOption[];
                })
            ]);
            if (controller.signal.aborted) return;
            if (results[0].status === 'fulfilled') {
                const loadedAccounts = results[0].value;
                setAccounts(loadedAccounts);
                setAccountId(current => loadedAccounts.some(account => account.id === current)
                    ? current : (loadedAccounts.find(account => account.account_status === 1) || loadedAccounts[0])?.id || '');
            } else { setAccountsError(results[0].reason instanceof Error ? results[0].reason.message : 'Could not load ad accounts.'); }
            if (results[1].status === 'fulfilled') setPages(results[1].value);
            setLoadingAccounts(false);
        };
        void load();
        return () => controller.abort();
    }, [status]);

    useEffect(() => {
        if (!accountId || demo || status !== 'authenticated') return;
        const controller = new AbortController();
        setLoadingReport(true); setError(''); setReportState(null);
        const load = async () => {
            try {
                const response = await fetch(`/api/ads/report?account=${encodeURIComponent(accountId)}&goal=${goal}`, { signal: controller.signal, cache: 'no-store' });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Could not load ad performance.');
                if (!controller.signal.aborted) setReportState({ key: `${accountId}:${goal}`, report: data.report });
            } catch (loadError) {
                if (!controller.signal.aborted) setError(loadError instanceof Error ? loadError.message : 'Could not load ad performance.');
            } finally { if (!controller.signal.aborted) setLoadingReport(false); }
        };
        void load();
        return () => controller.abort();
    }, [accountId, goal, demo, refresh, status]);

    const connect = async () => {
        setConnecting(true);
        try { await signIn('facebook', { callbackUrl: facebookSignInCallback('/dashboard/ads') }, { scope: FACEBOOK_ADS_PERMISSION_SCOPE, auth_type: 'rerequest' }); }
        catch { setConnecting(false); setAccountsError('Facebook connection did not complete. Please try again.'); }
    };

    return <div className="max-w-[1500px] mx-auto space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
            <div><div className="flex items-center gap-3"><ShieldCheck className="w-7 h-7" /><h1 className="text-2xl">Ads Guard</h1><span className="border border-gray-300 px-2 py-1 text-xs text-gray-600">Recommendations</span></div><p className="text-sm text-gray-600 mt-3 max-w-2xl">See which ads need attention, what to do next, and why. Compare the last 7 completed days with the previous 7 using targets that fit your business.</p></div>
            <div className="flex flex-wrap gap-2"><button onClick={() => setDemo(!demo)} className="btn-wireframe">{demo ? 'Return to live ads' : 'Try example report'}</button><button onClick={connect} disabled={connecting} className="btn-wireframe-dark">{connecting ? 'Connecting…' : 'Connect ad access'}</button></div>
        </div>
        {!demo && <>
            <div className="border border-black p-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto] gap-4 items-end">
                <label className="text-sm"><span className="block font-semibold mb-2">Ad account</span><select className="input-wireframe" value={accountId} disabled={loadingAccounts || accounts.length === 0} onChange={event => { setAccountId(event.target.value); setPageId(''); }}><option value="">{loadingAccounts ? 'Loading accounts…' : 'Choose an ad account'}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}</select></label>
                <label className="text-sm"><span className="block font-semibold mb-2">Facebook Page</span><select className="input-wireframe" value={pageId} onChange={event => setPageId(event.target.value)}><option value="">All account ads</option>{pages.map(page => <option key={page.id} value={page.fb_page_id}>{page.name}</option>)}</select></label>
                <label className="text-sm"><span className="block font-semibold mb-2">Result to optimize</span><select className="input-wireframe" value={goal} onChange={event => setGoal(event.target.value as AdsGoal)}>{Object.entries(ADS_GOAL_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
                <button className="btn-wireframe h-10 gap-2" disabled={!accountId || loadingReport} onClick={() => setRefresh(value => value + 1)}><RefreshCw className={`w-4 h-4 ${loadingReport ? 'animate-spin' : ''}`} />Refresh</button>
            </div>
            {(accountsError || error) && <div role="alert" className="border border-red-300 bg-red-50 p-4 text-sm text-red-800"><p>{accountsError || error}</p><p className="mt-2">Use Connect ad access to approve reporting permissions. Your Facebook login must have access to the ad account.</p></div>}
            {loadingReport && <div role="status" className="border border-black p-8 flex items-center justify-center gap-3 text-sm"><RefreshCw className="w-5 h-5 animate-spin" />Checking delivery and fetching both reporting periods…</div>}
            {!loadingAccounts && !accountId && <div className="border border-black p-6 space-y-3"><h2 className="text-lg">Connect the account behind your ads</h2><p className="text-sm text-gray-600">Page access and advertising access are separate. Connect a Facebook login with reporting access to the ad account that pays for your Page’s ads.</p><p className="text-sm text-gray-600">The Meta app needs the Marketing API enabled and permission to request <code>ads_read</code>. Existing logins may need to reconnect. No ad-management permission is requested.</p><a href="https://developers.facebook.com/docs/marketing-api/get-started/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm underline">Meta setup guide<ExternalLink className="w-3 h-3" /></a></div>}
            {report && <p className="text-xs text-gray-500">{report.currentRange.since} – {report.currentRange.until} compared with {report.previousRange.since} – {report.previousRange.until} · {report.account.timezone_name} · Checked {new Date(report.fetchedAt).toLocaleString()}</p>}
        </>}
        {demo ? <AdsGuard key="demo" report={demoReport} initialSettings={DEMO_GUARD_SETTINGS} demo /> : report && <AdsGuard key={selectionKey} report={report} pageId={pageId} storageKey={`tokko:ads-guard:v1:${session?.user?.id || session?.user?.facebookId}:${selectionKey}`} />}
    </div>;
}
