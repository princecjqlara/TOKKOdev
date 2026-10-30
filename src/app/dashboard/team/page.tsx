'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { accountHasExpired } from '@/lib/account-expiry';
import { facebookSignInCallback } from '@/lib/facebook-signin';
import PasswordInput from '@/components/PasswordInput';

type TeamPage = { id: string; name: string };
type Member = { id: string; name: string; email: string; pending: boolean; active: boolean; parent: boolean; canRevoke: boolean; expiresAt: string | null; deleteAfterExpiry: boolean; canManageExpiry: boolean };

function localDateTime(value: Date) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}
function ExpiryFields({ enabled, value, disabled, preserveExisting, onChange, mode, days, onModeChange, onDaysChange, deleteAfterExpiry, onDeleteChange }: {
    enabled: boolean; value: string; disabled: boolean; preserveExisting?: boolean; onChange: (enabled: boolean, value: string) => void;
    mode: 'days' | 'date'; days: string; onModeChange: (mode: 'days' | 'date') => void; onDaysChange: (days: string) => void;
    deleteAfterExpiry: boolean; onDeleteChange: (remove: boolean) => void;
}) {
    return <fieldset className="space-y-3" disabled={disabled}>
        <legend className="font-bold text-sm mb-2">Subaccount lifetime (optional)</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked, value)} />Make this a temporary subaccount</label>
        {enabled && <>
            <label className="block text-sm">Deadline<select className="input-wireframe mt-2" value={mode} onChange={event => onModeChange(event.target.value as 'days' | 'date')}><option value="days">After a number of days</option><option value="date">On a specific date</option></select></label>
            {mode === 'days' ? <label className="block text-sm">Number of days<input type="number" min={1} max={3650} step={1} required className="input-wireframe mt-2" value={days} onChange={event => onDaysChange(event.target.value)} /></label>
                : <label className="block text-sm">Deadline (your local time)<input type="datetime-local" required className="input-wireframe mt-2" value={value} min={localDateTime(new Date())} onChange={event => onChange(true, event.target.value)} /></label>}
            <div className="flex flex-wrap gap-2">{[7, 30, 90].map(days => <button key={days} type="button" className="btn-wireframe text-sm" onClick={() => {
                onModeChange('days'); onDaysChange(String(days));
            }}>{days} days</button>)}</div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deleteAfterExpiry} onChange={event => onDeleteChange(event.target.checked)} />Delete this subaccount automatically at its deadline</label>
        </>}
        <p className="text-sm text-gray-600">{enabled ? deleteAfterExpiry ? 'Access stops at the deadline. The cleanup worker deletes the subaccount, while shared Pages and their data stay available to the team.' : 'Access stops at the deadline. Keep the account so you can renew it later.' : preserveExisting ? 'New subaccounts are permanent by default. Existing accounts keep their current lifetime.' : 'Save to make this subaccount permanent and cancel its deletion schedule.'}</p>
    </fieldset>;
}

export default function TeamAccessPage() {
    const { data: session, status } = useSession();
    const [pages, setPages] = useState<TeamPage[]>([]);
    const [pageId, setPageId] = useState('');
    const [selected, setSelected] = useState<string[]>([]);
    const [members, setMembers] = useState<Member[]>([]);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [setupMethod, setSetupMethod] = useState<'password' | 'email' | 'existing'>('password');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [hasExpiry, setHasExpiry] = useState(false);
    const [expiryDate, setExpiryDate] = useState('');
    const [lifetimeMode, setLifetimeMode] = useState<'days' | 'date'>('days');
    const [lifetimeDays, setLifetimeDays] = useState('7');
    const [deleteAfterExpiry, setDeleteAfterExpiry] = useState(true);
    const [editing, setEditing] = useState<Member | null>(null);
    const [editHasExpiry, setEditHasExpiry] = useState(false);
    const [editExpiryDate, setEditExpiryDate] = useState('');
    const [editLifetimeMode, setEditLifetimeMode] = useState<'days' | 'date'>('date');
    const [editLifetimeDays, setEditLifetimeDays] = useState('7');
    const [editDeleteAfterExpiry, setEditDeleteAfterExpiry] = useState(true);
    const [message, setMessage] = useState('');
    const [loadError, setLoadError] = useState('');
    const [ready, setReady] = useState(false);
    const [emailConfigured, setEmailConfigured] = useState(false);
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [membersLoading, setMembersLoading] = useState(false);
    const [membersError, setMembersError] = useState('');
    const [memberRefresh, setMemberRefresh] = useState(0);
    const requestId = useRef<string | null>(null);

    const loadPages = useCallback(async (signal?: AbortSignal) => {
        setLoading(true); setLoadError('');
        try {
            const response = await fetch('/api/team-access', { signal, cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw Error(data.message || 'Could not load Page access.');
            if (signal?.aborted) return;
            const nextPages: TeamPage[] = data.pages || [];
            setPages(nextPages); setReady(Boolean(data.ready)); setEmailConfigured(Boolean(data.emailConfigured));
            setPageId(previous => nextPages.some(page => page.id === previous) ? previous : nextPages[0]?.id || '');
            setSelected(previous => {
                const kept = previous.filter(id => nextPages.some(page => page.id === id));
                return kept.length ? kept : nextPages.length ? [nextPages[0].id] : [];
            });
            requestId.current = null;
            setMemberRefresh(previous => previous + 1);
        } catch (error) {
            if (!signal?.aborted) { setPages([]); setLoadError(error instanceof Error ? error.message : 'Could not load Page access.'); }
        } finally { if (!signal?.aborted) setLoading(false); }
    }, []);
    useEffect(() => {
        if (status === 'loading' || session?.user.provider !== 'facebook' || session.accountType === 'subaccount') return;
        const controller = new AbortController();
        void loadPages(controller.signal);
        return () => controller.abort();
    }, [status, session?.user.id, session?.user.provider, session?.accountType, loadPages]);

    const loadMembers = useCallback(async (signal?: AbortSignal) => {
        if (!pageId) return;
        setMembersLoading(true); setMembersError('');
        try {
            const response = await fetch(`/api/team-access?pageId=${encodeURIComponent(pageId)}`, { signal, cache: 'no-store' });
            const data = await response.json();
            if (!response.ok) throw Error(data.message || 'Could not load members.');
            if (!signal?.aborted) setMembers(data.members || []);
        } catch (error) {
            if (!signal?.aborted) setMembersError(error instanceof Error ? error.message : 'Could not load members.');
            throw error;
        } finally { if (!signal?.aborted) setMembersLoading(false); }
    }, [pageId]);
    useEffect(() => {
        setMembers([]); setEditing(null);
        const controller = new AbortController();
        void loadMembers(controller.signal).catch(() => {});
        return () => controller.abort();
    }, [loadMembers, memberRefresh]);

    async function invite(event: React.FormEvent) {
        event.preventDefault(); setMessage('');
        if (setupMethod === 'password' && password !== confirmation) { setMessage('The passwords do not match.'); return; }
        setBusy(true);
        if (!requestId.current) requestId.current = crypto.randomUUID();
        try {
            const response = await fetch('/api/team-access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId.current },
                body: JSON.stringify({ name, email, pageIds: selected, setupMethod,
                    ...(setupMethod === 'password' ? { password } : {}), ...(hasExpiry ? {
                        ...(lifetimeMode === 'days' ? { lifetimeDays: Number(lifetimeDays) } : { expiresAt: new Date(expiryDate).toISOString() }), deleteAfterExpiry
                    } : {}) }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) {
                requestId.current = null; setName(''); setEmail(''); setHasExpiry(false); setExpiryDate('');
                setPassword(''); setConfirmation('');
                await loadMembers().catch(() => {});
            }
        } catch { setMessage('The request could not be confirmed. Retry to safely check the same request.'); }
        finally { setBusy(false); }
    }
    async function revoke(member: Member) {
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/team-access', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, userId: member.id }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) await loadMembers().catch(() => {});
        } catch { setMessage('Could not revoke access. Please retry.'); }
        finally { setBusy(false); }
    }
    async function saveExpiry(event: React.FormEvent) {
        event.preventDefault(); if (!editing) return;
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/team-access', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pageId, userId: editing.id, ...(editHasExpiry ? {
                    ...(editLifetimeMode === 'days' ? { lifetimeDays: Number(editLifetimeDays) } : { expiresAt: new Date(editExpiryDate).toISOString() }), deleteAfterExpiry: editDeleteAfterExpiry
                } : { expiresAt: null, deleteAfterExpiry: false }) }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) { setEditing(null); await loadMembers().catch(() => {}); }
        } catch { setMessage('Could not update account expiry. Please retry.'); }
        finally { setBusy(false); }
    }
    if (status === 'loading') return <p>Loading team access…</p>;
    if (session?.user.provider !== 'facebook' || session.accountType === 'subaccount') return <div className="border-2 border-black p-6"><h1 className="text-2xl font-black">Team subaccounts</h1><p className="mt-4">Your parent user creates subaccounts and assigns their Pages. Use your assigned Pages through the workspace. Original Facebook users continue with Facebook to manage their team.</p></div>;

    return <div className="max-w-4xl space-y-6">
        <h1 className="text-3xl font-black">Team subaccounts</h1>
        <p>Original users admitted through Facebook Developer invitations are parent users. Create email/password subaccounts for your team and assign one or more Pages. Several subaccounts can share the same Page. Only parent users create and manage subaccounts.</p>
        <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-wireframe" disabled={busy || loading} onClick={() => void loadPages()}>Refresh Page access</button>
            <button type="button" className="btn-wireframe" disabled={busy} onClick={() => void signIn('facebook', { callbackUrl: facebookSignInCallback('/dashboard/team') }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE })}>Reconnect Facebook</button>
            <Link className="btn-wireframe" href="/dashboard/connect">Connect or refresh a Page</Link>
        </div>
        {message && <p role="status" className="border border-black p-4 bg-gray-50">{message}</p>}
        {loadError && <p role="alert" className="border border-red-700 p-4 text-red-700">{loadError}</p>}
        {loading ? <p>Loading your Facebook Page access…</p> : !loadError && !pages.length ? <p>No Pages available for team administration. Connect a Page you manage, then refresh Page access.</p> : pages.length > 0 && <>
            {!ready && <p role="status" className="border border-amber-600 bg-amber-50 p-4">Team account access is awaiting administrator setup.</p>}
            {ready && !emailConfigured && <p role="status" className="border border-amber-600 bg-amber-50 p-4">Email invitations are unavailable until the administrator configures the sender. You can set an initial password or assign an existing account.</p>}
            <form onSubmit={invite} className="border-2 border-black p-6 space-y-4">
                <h2 className="font-bold text-xl">Create or assign an account</h2>
                <label className="block font-bold text-sm">Name<input required maxLength={100} className="input-wireframe mt-2" value={name} disabled={busy} onChange={event => { setName(event.target.value); requestId.current = null; }} /></label>
                <label className="block font-bold text-sm">Email<input required type="email" className="input-wireframe mt-2" value={email} disabled={busy} onChange={event => { setEmail(event.target.value); requestId.current = null; }} /></label>
                <label className="block font-bold text-sm">Account setup<select className="input-wireframe mt-2" value={setupMethod} disabled={busy} onChange={event => {
                    setSetupMethod(event.target.value as 'password' | 'email' | 'existing'); setPassword(''); setConfirmation(''); requestId.current = null;
                }}><option value="password">Set an initial password</option><option value="email" disabled={!emailConfigured}>Send a password setup email</option><option value="existing">Assign an existing account</option></select></label>
                {setupMethod === 'password' && <>
                    <label className="block font-bold text-sm">Initial password<PasswordInput required minLength={12} disabled={busy} autoComplete="new-password" className="input-wireframe mt-2" value={password} onChange={event => { setPassword(event.target.value); requestId.current = null; }} /></label>
                    <label className="block font-bold text-sm">Confirm password<PasswordInput required minLength={12} disabled={busy} autoComplete="new-password" className="input-wireframe mt-2" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                    <p className="text-sm text-gray-600">Use at least 12 characters and share the initial password privately. The member can change it in Settings. Existing account passwords cannot be replaced here.</p>
                </>}
                <fieldset disabled={busy}><legend className="font-bold mb-2">Pages to assign</legend>{pages.map(page => <label key={page.id} className="flex gap-2 py-2"><input type="checkbox" checked={selected.includes(page.id)} onChange={event => {
                    setSelected(previous => event.target.checked ? [...previous, page.id] : previous.filter(id => id !== page.id)); requestId.current = null;
                }} />{page.name}</label>)}</fieldset>
                <ExpiryFields enabled={hasExpiry} value={expiryDate} disabled={busy} preserveExisting onChange={(enabled, value) => { setHasExpiry(enabled); setExpiryDate(value); requestId.current = null; }}
                    mode={lifetimeMode} days={lifetimeDays} onModeChange={mode => { setLifetimeMode(mode); requestId.current = null; }} onDaysChange={days => { setLifetimeDays(days); requestId.current = null; }}
                    deleteAfterExpiry={deleteAfterExpiry} onDeleteChange={remove => { setDeleteAfterExpiry(remove); requestId.current = null; }} />
                <p className="text-sm text-gray-600">You can manage expiry for email accounts you created. Existing accounts keep their password and other Page assignments.</p>
                <button className="btn-wireframe-dark" disabled={busy || !ready || setupMethod === 'email' && !emailConfigured || !selected.length}>{busy ? 'Saving…' : setupMethod === 'existing' ? 'Assign Page access' : 'Create account / assign access'}</button>
            </form>
            <section className="border-2 border-black p-6 space-y-4">
                <h2 className="font-bold text-xl">Page members</h2>
                <label className="block">Page<select className="input-wireframe mt-2" value={pageId} disabled={busy} onChange={event => setPageId(event.target.value)}>{pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
                {membersError && <p role="alert" className="text-red-700">{membersError}</p>}
                {membersLoading ? <p>Loading members…</p> : !membersError && !members.length && <p>No members on this Page.</p>}
                {members.map(member => <div key={member.id} className="border-t border-gray-300 py-4 space-y-4">
                    <div className="flex flex-wrap gap-3 justify-between items-center">
                        <div><strong>{member.name || member.email}</strong><p className="text-sm">{member.email} · {member.parent ? 'Facebook parent · ' : ''}{accountHasExpired(member.expiresAt) ? 'Expired' : member.pending ? 'Awaiting password setup' : member.active ? 'Active' : 'Inactive'}</p>
                            <p className="text-sm text-gray-600">{member.expiresAt ? `${member.deleteAfterExpiry ? 'Scheduled deletion' : 'Access deadline'}: ${new Date(member.expiresAt).toLocaleString()}` : 'Permanent account'}</p></div>
                        <div className="flex flex-wrap gap-2">
                            {member.pending && member.canRevoke && <button className="btn-wireframe" disabled={busy || !ready || !emailConfigured} onClick={() => {
                                setName(member.name || 'Team member'); setEmail(member.email); setSelected([pageId]); setHasExpiry(false); setExpiryDate(''); requestId.current = null;
                                setSetupMethod('email'); setPassword(''); setConfirmation('');
                                setMessage('Use Create account / assign access to resend this invitation. The current expiry will be preserved.');
                            }}>Resend invitation</button>}
                            {member.canManageExpiry && <button className="btn-wireframe" disabled={busy || !ready} onClick={() => {
                                setEditing(member); setEditHasExpiry(Boolean(member.expiresAt)); setEditExpiryDate(member.expiresAt ? localDateTime(new Date(member.expiresAt)) : '');
                                setEditLifetimeMode('date'); setEditLifetimeDays('7'); setEditDeleteAfterExpiry(member.deleteAfterExpiry);
                            }}>{accountHasExpired(member.expiresAt) ? 'Renew account' : 'Edit lifetime'}</button>}
                            {member.canRevoke && <button className="btn-wireframe text-red-700" disabled={busy || !ready} onClick={() => void revoke(member)}>Revoke this Page</button>}
                        </div>
                    </div>
                    {editing?.id === member.id && <form onSubmit={saveExpiry} className="bg-gray-50 border border-gray-300 p-4 space-y-4">
                        <ExpiryFields enabled={editHasExpiry} value={editExpiryDate} disabled={busy} onChange={(enabled, value) => { setEditHasExpiry(enabled); setEditExpiryDate(value); }}
                            mode={editLifetimeMode} days={editLifetimeDays} onModeChange={setEditLifetimeMode} onDaysChange={setEditLifetimeDays}
                            deleteAfterExpiry={editDeleteAfterExpiry} onDeleteChange={setEditDeleteAfterExpiry} />
                        <div className="flex gap-2"><button className="btn-wireframe-dark" disabled={busy || !ready}>Save lifetime</button><button type="button" className="btn-wireframe" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
                    </form>}
                </div>)}
            </section>
        </>}
    </div>;
}
