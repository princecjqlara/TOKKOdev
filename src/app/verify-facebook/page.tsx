'use client';
import { useEffect, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookReturnPath, facebookSignInCallback } from '@/lib/facebook-signin';
export default function VerifyFacebookPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [token, setToken] = useState(''); const [message, setMessage] = useState('');
    const [email, setEmail] = useState(''); const [next, setNext] = useState('/dashboard');
    const [busy, setBusy] = useState(false); const [done, setDone] = useState(false);
    useEffect(() => {
        setToken(new URLSearchParams(window.location.hash.slice(1)).get('token') || '');
        setNext(facebookReturnPath(new URLSearchParams(window.location.search).get('next')));
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }, []);
    useEffect(() => { if (session?.user?.id) router.replace(next); }, [session?.user?.id, next, router]);
    async function confirm() {
        setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/facebook-link', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
            const data = await response.json(); setMessage(data.message); setDone(response.ok);
            if (response.ok) setToken('');
        } catch { setMessage('Could not verify this connection. Please retry.'); } finally { setBusy(false); }
    }
    async function requestVerification(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/facebook-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
            const data = await response.json(); setMessage(data.message);
        } catch { setMessage('Could not request verification. Please retry.'); } finally { setBusy(false); }
    }
    async function continueWithFacebook() {
        setBusy(true);
        try { await signIn('facebook', { callbackUrl: facebookSignInCallback(next) }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE }); }
        catch { setMessage('Could not connect to Facebook. Please retry.'); setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
        <Link href="/" className="font-black text-2xl">TOKKO</Link>
        <h1 className="text-2xl font-black">Verify your Facebook sign-in</h1>
        {status === 'loading' ? <p>Checking your Facebook sign-in…</p> : done ? <>
            <p>Your existing Tokko account is connected. Continue with Facebook to open your Pages.</p>
            <button className="btn-wireframe-dark" disabled={busy} onClick={() => void continueWithFacebook()}>Continue with Facebook</button>
        </> : token ? <>
            <p>Confirm this Facebook connection to your existing Tokko account. Your Page assignments and password stay intact.</p>
            <button className="btn-wireframe-dark" disabled={busy} onClick={confirm}>{busy ? 'Verifying…' : 'Confirm this Facebook connection'}</button>
        </> : session?.requiresFacebookVerification ? <>
            <p>Facebook sign-in succeeded. Confirm your existing Tokko account before opening its Pages using a one-time verification link.</p>
            <form onSubmit={requestVerification} className="space-y-4">
                <label className="block text-sm font-bold">Existing Tokko email<input required type="email" autoComplete="email" className="input-wireframe mt-2" value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label>
                <button className="btn-wireframe-dark" disabled={busy}>{busy ? 'Requesting…' : 'Send verification link'}</button>
            </form>
            <button className="btn-wireframe" disabled={busy} onClick={() => void continueWithFacebook()}>Use another Facebook account</button>
        </> : <>
            <p>Start Facebook sign-in again, then open the complete verification link in the same browser.</p>
            <button className="btn-wireframe-dark" disabled={busy} onClick={() => void continueWithFacebook()}>Continue with Facebook</button>
        </>}
        {message && <p role="status">{message}</p>}
    </div></main>;
}
