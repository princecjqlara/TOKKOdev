'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';

export default function SetupPasswordPage() {
    const [token, setToken] = useState('');
    const [password, setPassword] = useState('');
    const [confirmation, setConfirmation] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [done, setDone] = useState(false);
    useEffect(() => {
        setToken(new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
        window.history.replaceState(null, '', window.location.pathname);
    }, []);
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        if (password !== confirmation) { setMessage('The passwords do not match.'); return; }
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password }) });
            const data = await response.json(); setMessage(data.message); setDone(response.ok);
            if (response.ok) { setToken(''); setPassword(''); setConfirmation(''); }
        } catch { setMessage('Could not save your password. Please retry.'); }
        finally { setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
        <h1 className="text-2xl font-black">Choose your Tokko password</h1>
        {!done && (token ? <form onSubmit={submit} className="space-y-4">
            <p className="text-sm text-gray-600">Use at least 12 characters. Only Pages assigned by your manager will be available.</p>
            <label className="block font-bold text-sm">New password<input className="input-wireframe mt-2" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={e => setPassword(e.target.value)} /></label>
            <label className="block font-bold text-sm">Confirm password<input className="input-wireframe mt-2" type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></label>
            <button className="btn-wireframe-dark" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form> : <p>Open the complete setup or reset link from your email. If it has expired, request a new link.</p>)}
        {message && <p role="status" className="text-sm">{message}</p>}
        <Link className="block underline" href="/login">Go to sign in</Link>
    </div></main>;
}
