'use client';
import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import Link from 'next/link';
export default function VerifyFacebookPage() {
    const [token, setToken] = useState(''); const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
    useEffect(() => {
        setToken(new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
        window.history.replaceState(null, '', window.location.pathname);
    }, []);
    async function confirm() {
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/facebook-link', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
            const data = await response.json(); setMessage(data.message); setDone(response.ok);
            if (response.ok) setToken('');
        } catch { setMessage('Could not verify this connection. Please retry.'); } finally { setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
        <h1 className="text-2xl font-black">Verify your Facebook sign-in</h1>
        <p>This connects the Facebook account you just signed in with to your existing Tokko account. Your Page assignments and password stay intact.</p>
        {done ? <button className="btn-wireframe-dark" onClick={() => signIn('facebook', { callbackUrl: '/dashboard' })}>Continue with Facebook</button>
            : token ? <button className="btn-wireframe-dark" disabled={busy} onClick={confirm}>{busy ? 'Verifying…' : 'Confirm this Facebook connection'}</button>
                : <p>Open the complete verification link from your email in the browser you used to sign in.</p>}
        {message && <p role="status">{message}</p>}<Link href="/login" className="block underline">Back to sign in</Link>
    </div></main>;
}
