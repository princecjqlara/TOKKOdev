'use client';
import { useEffect, useState } from 'react';
import { signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';

export default function LoginPage() {
    const { data: session } = useSession();
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [verificationEmail, setVerificationEmail] = useState('');
    useEffect(() => { if (session?.user?.id) router.replace('/dashboard'); }, [session, router]);
    useEffect(() => { if (new URLSearchParams(window.location.search).has('error')) setError('Sign-in could not be completed. Retry Facebook, or use your activated email account.'); }, []);
    async function submit(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            const result = await signIn('credentials', { email, password, redirect: false });
            if (result?.error || !result?.ok) setError('Unable to sign in. Check your email and password, activate your account, or try again later.');
            else router.replace('/dashboard');
        } catch { setError('Sign-in is temporarily unavailable. Please retry.'); }
        finally { setBusy(false); }
    }
    async function requestVerification(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            const response = await fetch('/api/account/facebook-link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: verificationEmail }) });
            const data = await response.json(); setError(data.message);
        } catch { setError('Could not request verification. Please retry.'); } finally { setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-6">
            <Link href="/" className="font-black text-2xl">TOKKO</Link>
            <h1 className="text-xl font-bold">Sign in to your workspace</h1>
            {session?.requiresFacebookVerification && <form onSubmit={requestVerification} className="border border-amber-600 bg-amber-50 p-4 space-y-3">
                <p className="text-sm">Confirm your existing Tokko account before connecting this Facebook sign-in. We will email a verification link; matching email alone never connects accounts.</p>
                <label className="block text-sm font-bold">Existing Tokko email<input required type="email" autoComplete="email" className="input-wireframe mt-2" value={verificationEmail} onChange={e => setVerificationEmail(e.target.value)} /></label>
                <button className="btn-wireframe" disabled={busy}>{busy ? 'Requesting…' : 'Send verification link'}</button>
            </form>}
            <button className="btn-wireframe w-full justify-center" disabled={busy}
                onClick={() => signIn('facebook', { callbackUrl: '/dashboard' }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE })}>Continue with Facebook</button>
            <div className="text-center text-sm text-gray-500">or sign in with email</div>
            <form onSubmit={submit} className="space-y-4">
                <label className="block text-sm font-bold">Email<input required type="email" autoComplete="username" className="input-wireframe mt-2" value={email} onChange={e => setEmail(e.target.value)} /></label>
                <label className="block text-sm font-bold">Password<input required type="password" autoComplete="current-password" className="input-wireframe mt-2" value={password} onChange={e => setPassword(e.target.value)} /></label>
                {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
                <button className="btn-wireframe-dark w-full justify-center" disabled={busy}>{busy ? 'Signing in…' : 'Sign in with email'}</button>
            </form>
            <Link href="/forgot-password" className="block text-sm underline">Forgot password?</Link>
            <p className="text-sm text-gray-600">New to Tokko? Your Facebook Page manager creates your account and assigns your Pages. Use the setup link in your invitation first.</p>
        </div>
    </main>;
}
