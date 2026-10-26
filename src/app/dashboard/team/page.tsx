'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';

type TeamPage = { id: string; name: string };
type Member = { id: string; name: string; email: string; pending: boolean; canRevoke: boolean };
export default function TeamAccessPage() {
    const { data: session } = useSession();
    const [pages, setPages] = useState<TeamPage[]>([]); const [pageId, setPageId] = useState('');
    const [selected, setSelected] = useState<string[]>([]); const [members, setMembers] = useState<Member[]>([]);
    const [name, setName] = useState(''); const [email, setEmail] = useState(''); const [message, setMessage] = useState('');
    const [ready, setReady] = useState(false); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
    const requestId = useRef<string | null>(null);
    useEffect(() => {
        let current = true;
        if (session?.user.provider !== 'facebook') { setLoading(false); return; }
        fetch('/api/team-access').then(async res => { const data = await res.json(); if (!res.ok) throw Error(data.message); if (!current) return;
            setPages(data.pages || []); setReady(data.ready && data.emailConfigured);
            if (data.pages?.length) { setPageId(data.pages[0].id); setSelected([data.pages[0].id]); }
            if (!data.ready) setMessage('Team account access is awaiting administrator setup.');
            else if (!data.emailConfigured) setMessage('The administrator must configure account emails before invitations can be sent.');
        }).catch(error => { if (current) setMessage(error.message); }).finally(() => { if (current) setLoading(false); });
        return () => { current = false; };
    }, [session?.user.provider]);
    const loadMembers = useCallback(async (signal?: AbortSignal) => {
        if (!pageId) return;
        const response = await fetch(`/api/team-access?pageId=${encodeURIComponent(pageId)}`, { signal });
        const data = await response.json(); if (!response.ok) throw Error(data.message);
        if (!signal?.aborted) setMembers(data.members || []);
    }, [pageId]);
    useEffect(() => { setMembers([]); const controller = new AbortController(); void loadMembers(controller.signal).catch(error => { if (!controller.signal.aborted) setMessage(error.message); }); return () => controller.abort(); }, [loadMembers]);
    async function invite(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setMessage('');
        if (!requestId.current) requestId.current = crypto.randomUUID();
        try {
            const response = await fetch('/api/team-access', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': requestId.current }, body: JSON.stringify({ name, email, pageIds: selected }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) { requestId.current = null; setName(''); setEmail(''); await loadMembers(); }
        } catch { setMessage('The request could not be confirmed. Retry to safely check the same request.'); } finally { setBusy(false); }
    }
    async function revoke(member: Member) {
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/team-access', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pageId, userId: member.id }) });
            const data = await response.json(); setMessage(data.message); if (response.ok) await loadMembers();
        } catch { setMessage('Could not revoke access. Please retry.'); } finally { setBusy(false); }
    }
    if (session?.user.provider !== 'facebook') return <div className="border-2 border-black p-6"><h1 className="text-2xl font-black">Team access</h1><p className="mt-4">Your Facebook Page manager creates accounts and manages Page assignments. Your assigned Pages and their tags remain available through the normal workspace.</p></div>;
    return <div className="max-w-4xl space-y-6"><h1 className="text-3xl font-black">Team access</h1>
        <p>Create an email account or give an existing account access to specific Pages you manage. Members can use all operational Page features, including tags and campaigns, but cannot create accounts or assign access.</p>
        {message && <p role="status" className="border border-black p-4 bg-gray-50">{message}</p>}
        {loading ? <p>Verifying your Facebook Page management permissions…</p> : !pages.length ? <p>No connected Pages with verified Facebook management permission were found. Connect or refresh the Facebook Page you manage.</p> : <>
            <form onSubmit={invite} className="border-2 border-black p-6 space-y-4"><h2 className="font-bold text-xl">Create or assign an account</h2>
                <label className="block font-bold text-sm">Name<input required maxLength={100} className="input-wireframe mt-2" value={name} disabled={busy} onChange={e => { setName(e.target.value); requestId.current = null; }} /></label>
                <label className="block font-bold text-sm">Email<input required type="email" className="input-wireframe mt-2" value={email} disabled={busy} onChange={e => { setEmail(e.target.value); requestId.current = null; }} /></label>
                <fieldset><legend className="font-bold mb-2">Pages to assign</legend>{pages.map(page => <label key={page.id} className="flex gap-2 py-2"><input type="checkbox" disabled={busy} checked={selected.includes(page.id)} onChange={e => { setSelected(old => e.target.checked ? [...old, page.id] : old.filter(id => id !== page.id)); requestId.current = null; }} />{page.name}</label>)}</fieldset>
                <p className="text-sm text-gray-600">New accounts receive a password setup email. Existing accounts keep their current password and other Page assignments.</p>
                <button className="btn-wireframe-dark" disabled={busy || !ready || !selected.length}>{busy ? 'Saving…' : 'Create account / assign access'}</button>
            </form>
            <section className="border-2 border-black p-6 space-y-4"><h2 className="font-bold text-xl">Page members</h2>
                <label className="block">Page<select className="input-wireframe mt-2" value={pageId} disabled={busy} onChange={e => setPageId(e.target.value)}>{pages.map(page => <option key={page.id} value={page.id}>{page.name}</option>)}</select></label>
                {members.map(member => <div key={member.id} className="border-t border-gray-300 py-4 flex flex-wrap gap-3 justify-between items-center"><div><strong>{member.name || member.email}</strong><p className="text-sm">{member.email} · {member.pending ? 'Awaiting password setup' : 'Active'}</p></div><div className="flex gap-2">
                    {member.pending && member.canRevoke && <button className="btn-wireframe" disabled={busy || !ready} onClick={() => { setName(member.name || 'Team member'); setEmail(member.email); setSelected([pageId]); requestId.current = null; setMessage('Use Create account / assign access to resend this invitation.'); }}>Resend invitation</button>}
                    {member.canRevoke && <button className="btn-wireframe text-red-700" disabled={busy || !ready} onClick={() => revoke(member)}>Revoke this Page</button>}
                </div></div>)}
            </section>
        </>}
    </div>;
}
