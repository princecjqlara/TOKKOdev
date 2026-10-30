'use client';
import { useEffect, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookReturnPath, facebookSignInCallback, facebookSignInDestination, facebookSignInMessage } from '@/lib/facebook-signin';

export default function FacebookSignInPage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [next, setNext] = useState('/dashboard');
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [ready, setReady] = useState(false);
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        setNext(facebookReturnPath(params.get('next'))); setError(params.get('error')); setReady(true);
    }, []);
    const destination = error ? null : facebookSignInDestination(session, next);
    useEffect(() => {
        if (ready && status !== 'loading' && destination) router.replace(destination);
    }, [ready, status, destination, router]);
    async function retry() {
        setBusy(true);
        try { await signIn('facebook', { callbackUrl: facebookSignInCallback(next) }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE }); }
        catch { setError('OAuthSignin'); setBusy(false); }
    }
    const loading = !ready || status === 'loading' || Boolean(destination);
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-5">
            <Link href="/" className="font-black text-2xl">TOKKO</Link>
            <h1 className="text-xl font-bold">{loading ? 'Completing Facebook sign-in…' : 'Continue with Facebook'}</h1>
            {loading ? <p role="status">Checking your Facebook account and opening your workspace…</p> : <>
                <p role="alert">{facebookSignInMessage(error, error ? undefined : session?.authenticationError)}</p>
                <button className="btn-wireframe-dark w-full justify-center" disabled={busy} onClick={() => void retry()}>{busy ? 'Connecting…' : 'Continue with Facebook'}</button>
                <Link href="/login" className="block text-sm underline">Choose another sign-in method</Link>
            </>}
        </div>
    </main>;
}
