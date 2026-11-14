'use client';

import React, { useState } from 'react';
import { Ban, CalendarClock, CheckCircle2, Trash2 } from 'lucide-react';
import type { AdminAccount } from '@/lib/admin-accounts';

export default function AdminAccountActions({ account, onChanged }: { account: AdminAccount; onChanged: (message: string) => void }) {
    const [panel, setPanel] = useState<'status' | 'lifetime' | 'delete' | null>(null);
    const [confirmation, setConfirmation] = useState('');
    const [duration, setDuration] = useState('keep');
    const [days, setDays] = useState('30');
    const [deadline, setDeadline] = useState('');
    const [deleteAfterExpiry, setDeleteAfterExpiry] = useState(account.deleteAfterExpiry);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const target = account.email || account.id;

    function open(next: typeof panel) { setPanel(next); setError(''); setConfirmation(''); }

    async function perform(method: 'PATCH' | 'DELETE', body: Record<string, unknown>) {
        setBusy(true); setError('');
        try {
            const response = await fetch(`/api/admin/accounts/${account.id}`, {
                method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
            });
            if (response.status === 401) { window.location.replace('/admin/login'); return; }
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || 'The account could not be updated.');
            setPanel(null); setConfirmation(''); onChanged(result.message);
        } catch (error) { setError(error instanceof Error ? error.message : 'The account could not be updated.'); }
        finally { setBusy(false); }
    }

    function saveLifetime(event: React.FormEvent) {
        event.preventDefault();
        const body: Record<string, unknown> = { action: 'lifetime' };
        if (duration === 'permanent') body.expiresAt = null;
        if (duration === 'days') body.lifetimeDays = Number(days);
        if (duration === 'deadline') {
            const expiry = new Date(deadline);
            if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) { setError('Choose a future expiry date.'); return; }
            body.expiresAt = expiry.toISOString();
        }
        if (account.canScheduleDeletion) body.deleteAfterExpiry = duration === 'permanent' ? false : deleteAfterExpiry;
        void perform('PATCH', body);
    }

    return <section className="border-t border-gray-300 pt-4 space-y-3" aria-label="Manage account">
        <h3 className="text-sm font-bold">Manage account</h3>
        <div className="flex flex-wrap gap-2">
            <button className="btn-wireframe text-sm" disabled={busy || !account.active && !account.canEnable} onClick={() => open('status')}>
                {account.active ? <Ban className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}{account.active ? 'Disable account' : 'Enable account'}</button>
            <button className="btn-wireframe text-sm" disabled={busy} onClick={() => open('lifetime')}><CalendarClock className="w-4 h-4" />Change access duration</button>
            <button className="btn-wireframe text-sm text-red-700" disabled={busy || !account.canDelete} onClick={() => open('delete')}><Trash2 className="w-4 h-4" />Delete account</button>
        </div>
        {!account.active && !account.canEnable && <p className="text-xs text-gray-600">The account must finish password setup before it can be enabled.</p>}
        {!account.canDelete && <p className="text-xs text-gray-600">Handle this account&apos;s subaccounts before deleting their parent. You can disable the parent immediately.</p>}
        {panel === 'status' && <div className="max-w-xl border border-black bg-white p-4 space-y-3">
            <p className="font-bold text-sm">{account.active ? 'Disable' : 'Enable'} {target}?</p>
            <p className="text-sm text-gray-600">{account.active
                ? 'This blocks sign-in and revokes existing sessions. Account data and Page assignments are kept.'
                : 'This allows sign-in again. Expired access must also be renewed; pending password setup is still required.'}</p>
            <div className="flex gap-2"><button className="btn-wireframe-dark text-sm" disabled={busy} onClick={() => void perform('PATCH', { action: 'status', active: !account.active })}>
                {busy ? 'Saving...' : account.active ? 'Confirm disable' : 'Confirm enable'}</button>
                <button className="btn-wireframe text-sm" disabled={busy} onClick={() => open(null)}>Cancel</button></div>
        </div>}
        {panel === 'lifetime' && <form onSubmit={saveLifetime} className="max-w-xl border border-black bg-white p-4 space-y-3">
            <p className="font-bold text-sm">Access duration for {target}</p>
            <label className="block text-sm">Duration<select className="input-wireframe mt-1" value={duration} disabled={busy} onChange={event => setDuration(event.target.value)}>
                <option value="keep">Keep current expiry</option><option value="permanent">Permanent access</option>
                <option value="days">Number of days from today</option><option value="deadline">Specific expiry date</option></select></label>
            {duration === 'days' && <label className="block text-sm">Days from today<input className="input-wireframe mt-1" type="number" required min={1} max={3650} step={1} value={days} disabled={busy} onChange={event => setDays(event.target.value)} /></label>}
            {duration === 'deadline' && <label className="block text-sm">Expiry in your local timezone<input className="input-wireframe mt-1" type="datetime-local" required value={deadline} disabled={busy} onChange={event => setDeadline(event.target.value)} /></label>}
            {account.canScheduleDeletion && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={duration !== 'permanent' && deleteAfterExpiry}
                disabled={busy || duration === 'permanent' || duration === 'keep' && !account.expiresAt} onChange={event => setDeleteAfterExpiry(event.target.checked)} />Automatically delete this subaccount when its access expires</label>}
            <p className="text-xs text-gray-600">Changing expiry does not enable a disabled account. Automatic deletion runs through the existing cleanup worker.</p>
            <div className="flex gap-2"><button className="btn-wireframe-dark text-sm" disabled={busy || duration === 'keep' && (!account.canScheduleDeletion || deleteAfterExpiry === account.deleteAfterExpiry)}>{busy ? 'Saving...' : 'Save access duration'}</button>
                <button type="button" className="btn-wireframe text-sm" disabled={busy} onClick={() => open(null)}>Cancel</button></div>
        </form>}
        {panel === 'delete' && <form onSubmit={event => { event.preventDefault(); void perform('DELETE', { confirmation }); }} className="max-w-xl border-2 border-red-700 bg-white p-4 space-y-3">
            <p className="font-bold text-sm text-red-800">Permanently delete {target}?</p>
            <p className="text-sm">This removes the account, its credentials, and its Page assignments. Shared Pages, contacts, campaigns, and history are preserved. This cannot be undone.</p>
            {account.type === 'parent' && <p className="text-xs text-gray-600">To prevent future Facebook sign-in, disable the account instead. Deleting it does not revoke its permissions on Facebook.</p>}
            <label className="block text-sm">Type <strong className="break-all">{target}</strong> to confirm<input className="input-wireframe mt-1" required autoComplete="off" value={confirmation} disabled={busy} onChange={event => setConfirmation(event.target.value)} /></label>
            <div className="flex gap-2"><button className="btn-wireframe-dark bg-red-800 text-sm" disabled={busy || confirmation.trim().toLowerCase() !== target.toLowerCase()}>{busy ? 'Deleting...' : 'Permanently delete account'}</button>
                <button type="button" className="btn-wireframe text-sm" disabled={busy} onClick={() => open(null)}>Cancel</button></div>
        </form>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </section>;
}
