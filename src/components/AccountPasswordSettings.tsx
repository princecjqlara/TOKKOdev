'use client';
import { useEffect, useState } from 'react';
import { signIn, signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import PasswordInput from './PasswordInput';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookSignInCallback } from '@/lib/facebook-signin';

type PasswordStatus = { email: string; hasPassword: boolean; hasUsableEmail: boolean; canSetPassword: boolean; requiresFacebook: boolean; ready: boolean; facebookConnected: boolean };
export default function AccountPasswordSettings() {
    const { data: session } = useSession();
    const [status, setStatus] = useState<PasswordStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [currentPassword, setCurrentPassword] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    useEffect(() => {
        if (!session?.user.id) return;
        const controller = new AbortController();
        setLoading(true); setStatus(null); setMessage(''); setDone(false);
        setCurrentPassword(''); setPassword(''); setConfirmation('');
        fetch('/api/account/sign-in-password', { signal: controller.signal, cache: 'no-store' }).then(async response => {
            const data = await response.json(); if (!response.ok) throw Error(data.message);
            if (!controller.signal.aborted) setStatus(data);
        }).catch(error => { if (!controller.signal.aborted) setMessage(error.message || 'Could not load password settings.'); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [session?.user.id]);
    async function save(event: React.FormEvent) {
        event.preventDefault(); setMessage('');
        if (password !== confirmation) { setMessage('The passwords do not match.'); return; }
        setBusy(true);
        try {
            const response = await fetch('/api/account/sign-in-password', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password, ...(status?.hasPassword ? { currentPassword } : {}) }) });
            const data = await response.json(); setMessage(data.message);
            if (response.ok) {
                setDone(true); setPassword(''); setCurrentPassword(''); setConfirmation('');
                await signOut({ callbackUrl: '/login?password=updated' }).catch(() => setMessage('Password saved. Use the sign-in link to continue.'));
            }
        } catch { setMessage('Could not complete the password request. Sign in again if it was already saved.'); }
        finally { setBusy(false); }
    }
    return <section className="wireframe-card mb-6 space-y-4">
        <h2 className="text-xl font-bold uppercase">Password sign-in</h2>
        {loading ? <p>Loading password settings…</p> : done ? <Link href="/login?password=updated" className="underline">Sign in with your new password</Link> : status && <>
            {status.hasUsableEmail && <p className="text-sm">Use {status.email} and a Tokko password to sign in.{status.facebookConnected && ' Facebook sign-in keeps working. Use Facebook for Team Access and Page connections.'}</p>}
            {!status.ready ? <p>Password sign-in is awaiting administrator setup.</p> : !status.hasUsableEmail ? <p>This Facebook account has no usable email address. Continue with Facebook and contact your administrator to verify an account email.</p> : status.canSetPassword ? <form onSubmit={save} className="space-y-4 max-w-md">
                {status.hasPassword && <label className="block text-sm font-bold">Current password<PasswordInput required disabled={busy} autoComplete="current-password" className="input-wireframe mt-2" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></label>}
                <label className="block text-sm font-bold">New password<PasswordInput required minLength={12} disabled={busy} autoComplete="new-password" className="input-wireframe mt-2" value={password} onChange={event => setPassword(event.target.value)} /></label>
                <label className="block text-sm font-bold">Confirm password<PasswordInput required minLength={12} disabled={busy} autoComplete="new-password" className="input-wireframe mt-2" value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>
                <p className="text-sm text-gray-600">Use at least 12 characters. Saving signs out existing sessions so you can sign in with your new password.</p>
                <button className="btn-wireframe-dark" disabled={busy}>{busy ? 'Saving…' : status.hasPassword ? 'Change password' : 'Set password'}</button>
                {status.hasPassword && <Link href="/forgot-password" className="block text-sm underline">Forgot your current password?</Link>}
            </form> : status.requiresFacebook ? <button type="button" className="btn-wireframe" onClick={() => void signIn('facebook', { callbackUrl: facebookSignInCallback('/dashboard/settings') }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE })}>Reconnect Facebook to set a password</button> : <p>Contact your administrator to review this account’s password settings.</p>}
        </>}
        {message && <p role="status" className="text-sm">{message}</p>}
    </section>;
}
