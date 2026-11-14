'use client';

import { useState } from 'react';
import { getSession, signIn } from 'next-auth/react';
import PasswordInput from '@/components/PasswordInput';
import { requestWithTimeout } from '@/lib/request-timeout';

export default function AdminLogin() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function submit(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            const result = await requestWithTimeout(() => signIn('system-admin', { email, password, redirect: false }),
                45_000, 'Sign-in took too long. Please retry.');
            if (result?.error === 'AccountRateLimited') throw new Error('Too many attempts. Please try again later.');
            if (result?.error === 'AccountServiceUnavailable') throw new Error('Sign-in is temporarily unavailable. Please retry.');
            if (!result?.ok || result.error) throw new Error('Invalid administrator email or password.');
            const session = await requestWithTimeout(() => getSession(), 20_000, 'Account check timed out. Please retry.');
            if (!session?.isSystemAdmin) throw new Error('Administrator access could not be confirmed.');
            window.location.replace('/admin');
        } catch (error) { setError(error instanceof Error ? error.message : 'Sign-in failed. Please retry.'); }
        finally { setPassword(''); setBusy(false); }
    }

    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-6">
            <p className="font-black text-2xl">TOKKO</p>
            <div><h1 className="text-xl font-bold">Administrator sign-in</h1>
                <p className="text-sm text-gray-600 mt-2">Private account administration.</p></div>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            <form onSubmit={submit} className="space-y-4">
                <label className="block text-sm font-bold">Email<input required type="email" autoComplete="username" disabled={busy}
                    className="input-wireframe mt-2" value={email} onChange={e => setEmail(e.target.value)} /></label>
                <label className="block text-sm font-bold">Password<PasswordInput required autoComplete="current-password" disabled={busy}
                    className="input-wireframe mt-2" value={password} onChange={e => setPassword(e.target.value)} /></label>
                <button className="btn-wireframe-dark w-full justify-center" disabled={busy}>{busy ? 'Signing in...' : 'Sign in'}</button>
            </form>
        </div>
    </main>;
}
