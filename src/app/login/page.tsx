'use client';
import { useEffect, useState } from 'react';
import { getSession, signIn, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { FACEBOOK_PERMISSION_SCOPE } from '@/lib/facebook-permissions';
import { facebookSignInCallback, loginDestination } from '@/lib/facebook-signin';
import PasswordInput from '@/components/PasswordInput';

export default function LoginPage() {
    const { data: session } = useSession();
    const router = useRouter();
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [notice, setNotice] = useState('');
    useEffect(() => {
        const destination = loginDestination(session, new URLSearchParams(window.location.search).get('method'));
        if (destination) router.replace(destination);
    }, [session, router]);
    useEffect(() => {
        const error = new URLSearchParams(window.location.search).get('error');
        if (new URLSearchParams(window.location.search).get('password') === 'updated') setNotice('Password saved. Sign in with your email and new password, or continue with Facebook.');
        if (error === 'CredentialsSignin') setError('Unable to sign in with email. Check your details and account activation.');
        else if (error) router.replace(`${facebookSignInCallback()}&${new URLSearchParams({ error })}`);
    }, [router]);
    async function submit(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setError('');
        try {
            const result = await signIn('credentials', { email, password, redirect: false });
            if (result?.error || !result?.ok) setError('Unable to sign in. Check your email and password, activate your account, or try again later.');
            else {
                const current = await getSession();
                if (!current?.accountActive) setError('Your sign-in could not be confirmed. Please retry.');
                else router.replace(loginDestination(current, 'email') || '/dashboard');
            }
        } catch { setError('Sign-in is temporarily unavailable. Please retry.'); }
        finally { setBusy(false); }
    }
    async function continueWithFacebook() {
        setBusy(true); setError('');
        try {
            await signIn('facebook', { callbackUrl: facebookSignInCallback() }, { auth_type: 'rerequest', scope: FACEBOOK_PERMISSION_SCOPE });
        } catch { setError('Could not connect to Facebook. Please retry.'); setBusy(false); }
    }
    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-6">
            <Link href="/" className="font-black text-2xl">TOKKO</Link>
            <h1 className="text-xl font-bold">Sign in to your workspace</h1>
            <button className="btn-wireframe w-full justify-center" disabled={busy}
                onClick={() => void continueWithFacebook()}>Continue with Facebook</button>
            {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
            {notice && <p role="status" className="text-sm">{notice}</p>}
            <div className="text-center text-sm text-gray-500">Team subaccount sign-in</div>
            <form onSubmit={submit} className="space-y-4">
                <label className="block text-sm font-bold">Email<input required type="email" autoComplete="username" className="input-wireframe mt-2" value={email} onChange={e => setEmail(e.target.value)} /></label>
                <label className="block text-sm font-bold">Password<PasswordInput required disabled={busy} autoComplete="current-password" className="input-wireframe mt-2" value={password} onChange={e => setPassword(e.target.value)} /></label>
                <button className="btn-wireframe-dark w-full justify-center" disabled={busy}>{busy ? 'Signing in…' : 'Sign in with email'}</button>
            </form>
            <Link href="/forgot-password" className="block text-sm underline">Forgot password?</Link>
            <p className="text-sm text-gray-600">Already had access through a Facebook Developer invitation? Continue with Facebook to open your existing parent account. Team members use the email and password created by their parent user.</p>
        </div>
    </main>;
}
