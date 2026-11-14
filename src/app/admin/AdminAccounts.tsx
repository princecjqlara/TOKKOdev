'use client';

import { useEffect, useState } from 'react';
import { signOut } from 'next-auth/react';
import { ChevronDown, ChevronUp, LogOut, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import PasswordInput from '@/components/PasswordInput';
import type { AdminAccount, AdminAccountsResponse, AdminIdentity } from '@/lib/admin-accounts';

function date(value: string | null) {
    return value ? new Date(value).toLocaleString() : '—';
}
function identity(value: AdminIdentity | null) {
    return value ? [value.name, value.email].filter(Boolean).join(' · ') || value.id : '—';
}
const statusColors = { active: 'bg-green-50 text-green-800', expired: 'bg-red-50 text-red-800',
    disabled: 'bg-gray-100 text-gray-700', pending: 'bg-amber-50 text-amber-800' };

function AccountDetails({ account, onReset }: { account: AdminAccount; onReset: (message: string) => void }) {
    const [resetOpen, setResetOpen] = useState(false);
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function resetPassword(event: React.FormEvent) {
        event.preventDefault(); setError('');
        if (password !== confirmation) { setError('The passwords do not match.'); return; }
        setBusy(true);
        try {
            const response = await fetch(`/api/admin/accounts/${account.id}/password`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
            });
            if (response.status === 401) {
                window.location.replace('/admin/login'); return;
            }
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'Password could not be reset.');
            setResetOpen(false); onReset(result.message);
        } catch (error) { setError(error instanceof Error ? error.message : 'Password could not be reset.'); }
        finally { setPassword(''); setConfirmation(''); setBusy(false); }
    }

    const details = [
        ['Account ID', account.id], ['Account kind', account.kind], ['Created', date(account.createdAt)],
        ['Created by', account.creator ? identity(account.creator) : account.type === 'parent' ? 'Original Facebook account' : 'Creator unavailable'],
        ['Phone', account.phone || 'Not provided'], ['Email verified', date(account.emailVerifiedAt)],
        ['Email sign-in', account.emailLoginEnabled ? 'Enabled' : 'Disabled'],
        ['Password', account.hasPassword ? 'Configured (hidden)' : 'Not configured'],
        ['Password last changed', date(account.passwordChangedAt)],
        ['Access expires', account.expiresAt ? date(account.expiresAt) : 'Permanent'],
        ['Days remaining', account.daysRemaining === null ? 'Unlimited' : String(account.daysRemaining)],
        ['Days from creation to expiry', account.lifetimeDays === null ? 'Unlimited' : String(account.lifetimeDays)],
        ['Delete after expiry', account.deleteAfterExpiry ? 'Scheduled for deletion at expiry' : 'No automatic deletion']
    ];

    return <div className="bg-gray-50 border-t border-black p-5 space-y-5">
        <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {details.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-gray-500">{label}</dt>
                <dd className="text-sm mt-1 break-words">{value}</dd></div>)}
        </dl>
        <div><h3 className="text-sm font-bold mb-2">Assigned Pages ({account.pages.length})</h3>
            {account.pages.length === 0 ? <p className="text-sm text-gray-500">No assigned Pages.</p> : <ul className="grid gap-2 sm:grid-cols-2">
                {account.pages.map(page => <li key={page.id} className="border border-gray-300 bg-white p-3 text-sm break-words">
                    <p className="font-semibold">{page.name}</p><p className="text-xs text-gray-500">Facebook ID: {page.facebookId}</p>
                    <p className="text-xs mt-2">Assigned {date(page.assignedAt)} · {page.source}</p>
                    <p className="text-xs text-gray-600">Assigned by: {identity(page.assignedBy)}</p>
                </li>)}
            </ul>}
        </div>
        <p className="text-xs text-gray-600">Existing passwords are stored as one-way hashes and cannot be displayed.</p>
        {account.canResetPassword && !resetOpen && <button className="btn-wireframe text-sm" onClick={() => { setResetOpen(true); setError(''); }}>Reset subaccount password</button>}
        {resetOpen && <form onSubmit={resetPassword} className="max-w-lg border border-black bg-white p-4 space-y-3">
            <p className="font-bold text-sm">Reset password for {account.email}</p>
            <p className="text-xs text-gray-600">This signs the subaccount out of all devices and invalidates its existing reset links. Its access expiry stays the same.</p>
            <label className="block text-sm">New password<PasswordInput required disabled={busy} autoComplete="new-password" className="input-wireframe mt-1" value={password} onChange={e => setPassword(e.target.value)} /></label>
            <label className="block text-sm">Confirm new password<PasswordInput required disabled={busy} autoComplete="new-password" className="input-wireframe mt-1" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
            <div className="flex gap-2"><button className="btn-wireframe-dark text-sm" disabled={busy}>{busy ? 'Saving...' : 'Save new password'}</button>
                <button type="button" className="btn-wireframe text-sm" disabled={busy} onClick={() => { setResetOpen(false); setPassword(''); setConfirmation(''); }}>Cancel</button></div>
        </form>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </div>;
}

export default function AdminAccounts() {
    const [data, setData] = useState<AdminAccountsResponse | null>(null);
    const [search, setSearch] = useState('');
    const [query, setQuery] = useState('');
    const [type, setType] = useState('all');
    const [lifetime, setLifetime] = useState('all');
    const [status, setStatus] = useState('all');
    const [parent, setParent] = useState<AdminIdentity | null>(null);
    const [page, setPage] = useState(1);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [refresh, setRefresh] = useState(0);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        setLoading(true); setError('');
        const params = new URLSearchParams({ search: query, type, lifetime, status, page: String(page) });
        if (parent) params.set('parent', parent.id);
        void (async () => {
            try {
                const response = await fetch(`/api/admin/accounts?${params}`, { signal: controller.signal, cache: 'no-store' });
                if (response.status === 401 || response.status === 403) { window.location.replace('/admin/login'); return; }
                const result = await response.json();
                if (!response.ok) throw new Error(result.message || 'Accounts could not be loaded.');
                if (!controller.signal.aborted) setData(result);
            } catch (error) {
                if (!controller.signal.aborted) { setData(null); setError(error instanceof Error ? error.message : 'Accounts could not be loaded.'); }
            } finally { if (!controller.signal.aborted) setLoading(false); }
        })();
        return () => controller.abort();
    }, [query, type, lifetime, status, parent, page, refresh]);

    const totalPages = Math.max(1, Math.ceil((data?.total || 0) / (data?.pageSize || 25)));
    const summary = data?.summary;

    return <main className="min-h-screen bg-white text-black">
        <header className="border-b-2 border-black px-4 py-5 sm:px-8 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3"><ShieldCheck className="h-7 w-7" /><div><p className="text-xs font-bold tracking-widest text-gray-500">TOKKO ADMIN</p>
                <h1 className="text-xl font-bold">Account overview</h1></div></div>
            <div className="flex gap-2"><button className="btn-wireframe text-sm" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw className="w-4 h-4" />Refresh</button>
                <button className="btn-wireframe text-sm" onClick={() => void signOut({ callbackUrl: '/admin/login' })}><LogOut className="w-4 h-4" />Sign out</button></div>
        </header>
        <div className="max-w-screen-2xl mx-auto p-4 sm:p-8 space-y-6">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                {([['All accounts', summary?.accounts], ['Parents', summary?.parents], ['Subaccounts', summary?.subaccounts],
                    ['Permanent', summary?.permanent], ['With expiry', summary?.temporary], ['Expired', summary?.expired]] as const).map(([label, count]) =>
                    <div key={label} className="border border-black p-4"><p className="text-xs text-gray-600">{label}</p><p className="text-2xl font-bold mt-2">{count ?? '—'}</p></div>)}
            </div>
            <form className="flex flex-wrap gap-3 items-end" onSubmit={event => { event.preventDefault(); setQuery(search.trim()); setPage(1); setExpanded(null); }}>
                <label className="text-xs font-semibold flex-1 min-w-48">Search accounts, creators, or Pages
                    <input type="search" maxLength={100} value={search} onChange={e => setSearch(e.target.value)} className="input-wireframe mt-1" placeholder="Name, email, Page, or account ID" /></label>
                <button className="btn-wireframe" type="submit"><Search className="w-4 h-4" />Search</button>
                <label className="text-xs font-semibold">Account type<select value={type} className="input-wireframe mt-1" onChange={e => { setType(e.target.value); setPage(1); setExpanded(null); }}>
                    <option value="all">All types</option><option value="parent">Parents</option><option value="subaccount">Subaccounts</option></select></label>
                <label className="text-xs font-semibold">Access duration<select value={lifetime} className="input-wireframe mt-1" onChange={e => { setLifetime(e.target.value); setPage(1); setExpanded(null); }}>
                    <option value="all">All durations</option><option value="permanent">Permanent</option><option value="temporary">With expiry</option></select></label>
                <label className="text-xs font-semibold">Status<select value={status} className="input-wireframe mt-1" onChange={e => { setStatus(e.target.value); setPage(1); setExpanded(null); }}>
                    <option value="all">All statuses</option><option value="active">Active</option><option value="pending">Pending</option><option value="disabled">Disabled</option><option value="expired">Expired</option></select></label>
            </form>
            {parent && <div className="flex flex-wrap items-center gap-3 border border-black bg-gray-50 p-3 text-sm"><p>Subaccounts created by <strong>{identity(parent)}</strong></p>
                <button className="underline inline-flex items-center gap-1" onClick={() => { setParent(null); setPage(1); setExpanded(null); }}><X className="w-4 h-4" />Clear parent filter</button></div>}
            <p className="text-xs text-gray-600">Times use your browser timezone. Days remaining round up to the next whole day. Permanent accounts have no expiry.</p>
            {error && <div role="alert" className="border border-red-300 bg-red-50 p-4 text-sm text-red-800">{error} <button className="underline ml-2" onClick={() => setRefresh(value => value + 1)}>Retry</button></div>}
            {notice && <p role="status" className="border border-green-300 bg-green-50 p-4 text-sm text-green-800">{notice}</p>}
            {loading ? <p role="status" className="py-12 text-center text-gray-500">Loading accounts...</p> : data && <>
                <p className="text-sm text-gray-600">{data.total} matching {data.total === 1 ? 'account' : 'accounts'}</p>
                <div className="border border-black divide-y divide-black">
                    {data.accounts.length === 0 && <p className="p-10 text-center text-sm text-gray-500">No accounts match these filters.</p>}
                    {data.accounts.map(account => <article key={account.id}>
                        <div className="p-4 grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,2fr)_minmax(0,1fr)_auto] md:items-center">
                            <div className="min-w-0"><div className="flex flex-wrap gap-2 items-center"><h2 className="font-bold break-words">{account.name || 'Unnamed account'}</h2>
                                <span className={`text-xs px-2 py-1 ${statusColors[account.status]}`}>{account.status}</span></div>
                                <p className="text-sm mt-1 break-words">{account.email || 'No email'}</p><p className="text-xs text-gray-500 capitalize mt-1">{account.type} · {account.hasPassword ? 'Password configured' : 'No password'}</p></div>
                            <div className="min-w-0 text-sm"><p className="text-xs text-gray-500">Created by</p><p className="break-words mt-1">{account.creator ? identity(account.creator) : account.type === 'parent' ? 'Original Facebook account' : 'Creator unavailable'}</p>
                                <p className="text-xs text-gray-500 mt-1">{account.pages.length} assigned {account.pages.length === 1 ? 'Page' : 'Pages'}</p></div>
                            <div className="text-sm"><p className="font-semibold">{account.expiresAt ? account.daysRemaining === 0 ? 'Expired' : `${account.daysRemaining} days left` : 'Permanent'}</p>
                                <p className="text-xs text-gray-500 mt-1">{account.expiresAt ? date(account.expiresAt) : 'No expiry'}</p>
                                {account.deleteAfterExpiry && <p className="text-xs text-red-700 mt-1">Deletion scheduled at expiry</p>}</div>
                            <div className="flex flex-wrap md:flex-col gap-2">
                                <button className="btn-wireframe text-xs" aria-expanded={expanded === account.id} aria-controls={`account-${account.id}`} onClick={() => setExpanded(expanded === account.id ? null : account.id)}>
                                    Details {expanded === account.id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}</button>
                                {account.subaccountCount > 0 && <button className="btn-wireframe text-xs" onClick={() => {
                                    setParent({ id: account.id, name: account.name, email: account.email }); setPage(1); setType('all'); setLifetime('all'); setStatus('all'); setQuery(''); setSearch(''); setExpanded(null);
                                }}>{account.subaccountCount} subaccounts</button>}
                            </div>
                        </div>
                        {expanded === account.id && <div id={`account-${account.id}`}><AccountDetails account={account} onReset={message => { setNotice(message); setRefresh(value => value + 1); }} /></div>}
                    </article>)}
                </div>
                <div className="flex items-center justify-between gap-3 text-sm"><p>Page {page} of {totalPages}</p><div className="flex gap-2">
                    <button className="btn-wireframe" disabled={page <= 1} onClick={() => { setPage(value => value - 1); setExpanded(null); }}>Previous</button>
                    <button className="btn-wireframe" disabled={page >= totalPages} onClick={() => { setPage(value => value + 1); setExpanded(null); }}>Next</button>
                </div></div>
            </>}
        </div>
    </main>;
}
