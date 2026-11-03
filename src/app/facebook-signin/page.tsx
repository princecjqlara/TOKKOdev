'use client';
import React, { useEffect, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookReturnPath, facebookSignInCallback, facebookSignInDestination, facebookSignInMessage } from '@/lib/facebook-signin';

const SIGN_IN_TIMEOUT_MS = 15_000;

export default function FacebookSignInPage() {
    const { data: session, status } = useSession();
    const [next, setNext] = useState('/dashboard');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [ready, setReady] = useState(false);
    const [timedOut, setTimedOut] = useState(false);
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setNext(facebookReturnPath(params.get('next'))); setError(params.get('error')); setReady(true);
    }, []);
    const destination = ready && status !== 'loading' && !error ? facebookSignInDestination(session, next) : null;
    useEffect(() => {
        // A full navigation avoids waiting indefinitely on a dashboard RSC transition.
        if (destination) window.location.replace(destination);
    }, [destination]);
    useEffect(() => {
        if (!ready) return;
        const timer = setTimeout(() => setTimedOut(true), SIGN_IN_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [ready]);
    async function retry() {
        setBusy(true);
        try { await signIn('facebook', { callbackUrl: facebookSignInCallback(next) }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE }); }
        catch { setError('OAuthSignin'); }
        finally { setBusy(false); }
    }
    useEffect(() => {
        if (!busy) return;
        const timer = setTimeout(() => { setError('OAuthSignin'); setBusy(false); }, SIGN_IN_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [busy]);
    const loading = !ready || (!error && !timedOut && (status === 'loading' || Boolean(destination)));
    const retryAccountCheck = !error && !destination && ((timedOut && status === 'loading') || session?.authenticationError === 'service_unavailable');
    const message = facebookSignInMessage(error || (timedOut && status === 'loading' ? 'SessionTimeout' : null), error ? undefined : session?.authenticationError);
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
            <Link href="/" className="font-black text-2xl">TOKKO</Link>
            <h1 className="text-xl font-bold">{loading ? 'Completing Facebook sign-in…' : destination ? 'Open your workspace' : 'Continue with Facebook'}</h1>
            {loading ? <p role="status">Checking your Facebook account and opening your workspace…</p> : <>
                {destination ? <>
                    <p role="status">Your Facebook sign-in is ready. Open your workspace to continue.</p>
                    <a href={destination} className="btn-wireframe-dark w-full justify-center">Open your workspace</a>
                </> : <>
                    <p role="alert">{message}</p>
                    {retryAccountCheck && <button className="btn-wireframe-dark w-full justify-center" onClick={() => window.location.reload()}>Retry account check</button>}
                    <button className="btn-wireframe-dark w-full justify-center" disabled={busy} onClick={() => void retry()}>{busy ? 'Connecting…' : 'Continue with Facebook'}</button>
                </>}
                <Link href="/login?method=email" className="block text-sm underline">Sign in to a team subaccount</Link>
            </>}
        </div>
    </main>;
}
