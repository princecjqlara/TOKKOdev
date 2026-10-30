'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { accountHasExpired } from '@/lib/account-expiry';
import { facebookSignInCallback } from '@/lib/facebook-signin';

type TeamPage = { id: string; name: string };
type Member = { id: string; name: string; email: string; pending: boolean; canRevoke: boolean; expiresAt: string | null; canManageExpiry: boolean };

function localDateTime(value: Date) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
    return local.toISOString().slice(0, 16);
}
function ExpiryFields({ enabled, value, disabled, preserveExisting, onChange }: {
    enabled: boolean; value: string; disabled: boolean; preserveExisting?: boolean; onChange: (enabled: boolean, value: string) => void;
}) {
    return <fieldset className="space-y-3" disabled={disabled}>
        <legend className="font-bold text-sm mb-2">Account expiry (optional)</legend>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={event => onChange(event.target.checked, value)} />Set an expiry date</label>
        {enabled && <>
            <label className="block text-sm">Expires at (your local time)<input type="datetime-local" required className="input-wireframe mt-2" value={value} min={localDateTime(new Date())} onChange={event => onChange(true, event.target.value)} /></label>
            <div className="flex flex-wrap gap-2">{[7, 30, 90].map(days => <button key={days} type="button" className="btn-wireframe text-sm" onClick={() => {
                const date = new Date(); date.setDate(date.getDate() + days); onChange(true, localDateTime(date));
            }}>In {days} days</button>)}</div>
        </>}
        <p className="text-sm text-gray-600">{enabled ? 'The entire account stops working at this time, including signed-in sessions. You can extend or remove expiry later.' : preserveExisting ? 'No expiry by default. Existing accounts keep their current expiry.' : 'Save to give this account no expiry.'}</p>
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
    const [hasExpiry, setHasExpiry] = useState(false);
    const [expiryDate, setExpiryDate] = useState('');
    const [editing, setEditing] = useState<Member | null>(null);
    const [editHasExpiry, setEditHasExpiry] = useState(false);
    const [editExpiryDate, setEditExpiryDate] = useState('');
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
        if (status === 'loading' || session?.user.provider !== 'facebook') return;
        const controller = new AbortController();
        void loadPages(controller.signal);
        return () => controller.abort();
    }, [status, session?.user.id, session?.user.provider, loadPages]);

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
        event.preventDefault(); setBusy(true); setMessage('');
        if (!requestId.current) requestId.current = crypto.randomUUID();
        try {
            const response = await fetch('/api/team-access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId.current },
                body: JSON.stringify({ name, email, pageIds: selected, ...(hasExpiry ? { expiresAt: new Date(expiryDate).toISOString() } : {}) }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) {
                requestId.current = null; setName(''); setEmail(''); setHasExpiry(false); setExpiryDate('');
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
                body: JSON.stringify({ pageId, userId: editing.id, expiresAt: editHasExpiry ? new Date(editExpiryDate).toISOString() : null }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) { setEditing(null); await loadMembers().catch(() => {}); }
        } catch { setMessage('Could not update account expiry. Please retry.'); }
        finally { setBusy(false); }
    }
    if (status === 'loading') return <p>Loading team access…</p>;
    if (session?.user.provider !== 'facebook') return <div className="border-2 border-black p-6"><h1 className="text-2xl font-black">Team access</h1><p className="mt-4">Your Facebook Page administrator creates accounts and manages Page assignments. Your assigned Pages and their tags remain available through the workspace.</p></div>;

    return <div className="max-w-4xl space-y-6">
        <h1 className="text-3xl font-black">Team access</h1>
        <p>Original Facebook users can create email accounts and assign their connected Pages. Members can use operational Page features, including tags and campaigns. Account creation and access assignments remain with Facebook Page administrators.</p>
        <div className="flex flex-wrap gap-3">
            <button type="button" className="btn-wireframe" disabled={busy || loading} onClick={() => void loadPages()}>Refresh Page access</button>
            <button type="button" className="btn-wireframe" disabled={busy} onClick={() => void signIn('facebook', { callbackUrl: facebookSignInCallback('/dashboard/team') }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE })}>Reconnect Facebook</button>
            <Link className="btn-wireframe" href="/dashboard/connect">Connect or refresh a Page</Link>
        </div>
        {message && <p role="status" className="border border-black p-4 bg-gray-50">{message}</p>}
        {loadError && <p role="alert" className="border border-red-700 p-4 text-red-700">{loadError}</p>}
        {loading ? <p>Loading your Facebook Page access…</p> : !loadError && !pages.length ? <p>No Pages available for team administration. Connect a Page you manage, then refresh Page access.</p> : pages.length > 0 && <>
            {!ready && <p role="status" className="border border-amber-600 bg-amber-50 p-4">Team account access is awaiting administrator setup.</p>}
            {ready && !emailConfigured && <p role="status" className="border border-amber-600 bg-amber-50 p-4">The administrator must configure account emails before invitations can be sent.</p>}
            <form onSubmit={invite} className="border-2 border-black p-6 space-y-4">
                <h2 className="font-bold text-xl">Create or assign an account</h2>
                <label className="block font-bold text-sm">Name<input required maxLength={100} className="input-wireframe mt-2" value={name} disabled={busy} onChange={event => { setName(event.target.value); requestId.current = null; }} /></label>
                <label className="block font-bold text-sm">Email<input required type="email" className="input-wireframe mt-2" value={email} disabled={busy} onChange={event => { setEmail(event.target.value); requestId.current = null; }} /></label>
                <fieldset disabled={busy}><legend className="font-bold mb-2">Pages to assign</legend>{pages.map(page => <label key={page.id} className="flex gap-2 py-2"><input type="checkbox" checked={selected.includes(page.id)} onChange={event => {
                    setSelected(previous => event.target.checked ? [...previous, page.id] : previous.filter(id => id !== page.id)); requestId.current = null;
                }} />{page.name}</label>)}</fieldset>
                <ExpiryFields enabled={hasExpiry} value={expiryDate} disabled={busy} preserveExisting onChange={(enabled, value) => { setHasExpiry(enabled); setExpiryDate(value); requestId.current = null; }} />
                <p className="text-sm text-gray-600">New accounts receive a password setup email. You can manage expiry for email accounts you created. Existing accounts keep their password and other Page assignments.</p>
                <button className="btn-wireframe-dark" disabled={busy || !ready || !emailConfigured || !selected.length}>{busy ? 'Saving…' : 'Create account / assign access'}</button>
            </form>
            <section className="border-2 border-black p-6 space-y-4">
                <h2 className="font-bold text-xl">Page members</h2>
                <label className="block">Page<select className="input-wireframe mt-2" value={pageId} disabled={busy} onChange={event => setPageId(event.target.value)}>{pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
                {membersError && <p role="alert" className="text-red-700">{membersError}</p>}
                {membersLoading ? <p>Loading members…</p> : !membersError && !members.length && <p>No members on this Page.</p>}
                {members.map(member => <div key={member.id} className="border-t border-gray-300 py-4 space-y-4">
                    <div className="flex flex-wrap gap-3 justify-between items-center">
                        <div><strong>{member.name || member.email}</strong><p className="text-sm">{member.email} · {accountHasExpired(member.expiresAt) ? 'Expired' : member.pending ? 'Awaiting password setup' : 'Active'}</p>
                            <p className="text-sm text-gray-600">{member.expiresAt ? `Expires: ${new Date(member.expiresAt).toLocaleString()}` : 'No account expiry'}</p></div>
                        <div className="flex flex-wrap gap-2">
                            {member.pending && member.canRevoke && <button className="btn-wireframe" disabled={busy || !ready || !emailConfigured} onClick={() => {
                                setName(member.name || 'Team member'); setEmail(member.email); setSelected([pageId]); setHasExpiry(false); setExpiryDate(''); requestId.current = null;
                                setMessage('Use Create account / assign access to resend this invitation. The current expiry will be preserved.');
                            }}>Resend invitation</button>}
                            {member.canManageExpiry && <button className="btn-wireframe" disabled={busy || !ready} onClick={() => {
                                setEditing(member); setEditHasExpiry(Boolean(member.expiresAt)); setEditExpiryDate(member.expiresAt ? localDateTime(new Date(member.expiresAt)) : '');
                            }}>{accountHasExpired(member.expiresAt) ? 'Renew account' : 'Edit expiry'}</button>}
                            {member.canRevoke && <button className="btn-wireframe text-red-700" disabled={busy || !ready} onClick={() => void revoke(member)}>Revoke this Page</button>}
                        </div>
                    </div>
                    {editing?.id === member.id && <form onSubmit={saveExpiry} className="bg-gray-50 border border-gray-300 p-4 space-y-4">
                        <ExpiryFields enabled={editHasExpiry} value={editExpiryDate} disabled={busy} onChange={(enabled, value) => { setEditHasExpiry(enabled); setEditExpiryDate(value); }} />
                        <div className="flex gap-2"><button className="btn-wireframe-dark" disabled={busy || !ready}>Save expiry</button><button type="button" className="btn-wireframe" disabled={busy} onClick={() => setEditing(null)}>Cancel</button></div>
                    </form>}
                </div>)}
            </section>
        </>}
    </div>;
}
