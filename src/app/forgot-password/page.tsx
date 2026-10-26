'use client';
import { useState } from 'react';
import Link from 'next/link';
export default function ForgotPasswordPage() {
    const [email, setEmail] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
    async function submit(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
            const data = await response.json(); setMessage(data.message);
        } catch { setMessage('Could not request a reset. Please retry.'); } finally { setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
        <h1 className="text-2xl font-black">Reset your password</h1>
        <form onSubmit={submit} className="space-y-4"><label className="block text-sm font-bold">Account email<input className="input-wireframe mt-2" type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label><button className="btn-wireframe-dark" disabled={busy}>{busy ? 'Requesting…' : 'Send reset link'}</button></form>
        {message && <p role="status" className="text-sm">{message}</p>}<Link href="/login" className="block underline">Back to sign in</Link>
    </div></main>;
}
