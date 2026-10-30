'use client';
import { useEffect, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';

export default function CompleteProfilePage() {
    const { data: session, status } = useSession();
    const router = useRouter();
    const [name, setName] = useState('');
    const [phone, setPhone] = useState('');
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        if (status === 'loading') return;
        if (status === 'unauthenticated' || !session?.accountActive) { router.replace('/login?method=email'); return; }
        if (!session.requiresProfileCompletion && session.user.id) { router.replace('/dashboard'); return; }
        const controller = new AbortController();
        setLoading(true); setMessage('');
        fetch('/api/account/profile', { cache: 'no-store', signal: controller.signal }).then(async response => {
            const data = await response.json();
            if (!response.ok) throw Error(data.message || 'Could not load your account details.');
            if (controller.signal.aborted) return;
            // Reload the session when another tab already completed this step.
            if (!data.requiresCompletion) { window.location.replace('/dashboard'); return; }
            setName(data.name || ''); setPhone(data.phone || '');
        }).catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : 'Could not load your account details.'); })
            .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
    }, [status, session?.accountActive, session?.requiresProfileCompletion, session?.user.id, retry, router]);

    async function submit(event: React.FormEvent) {
        event.preventDefault(); setBusy(true); setMessage('');
        try {
            const response = await fetch('/api/account/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, phone }) });
            const data = await response.json();
            if (!response.ok) throw Error(data.message || 'Could not save your details.');
            // A fresh session now grants access to the assigned workspace.
            window.location.replace('/dashboard');
        } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save your details. Please retry.'); setBusy(false); }
    }

    return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6">
        <div className="w-full max-w-md border-2 border-black bg-white p-8 space-y-6">
            <div className="font-black text-2xl">TOKKO</div>
            <h1 className="text-2xl font-black">Welcome to your team account</h1>
            <p className="text-sm text-gray-600">Before you enter the workspace, confirm your name and phone number. You only need to do this once.</p>
            {loading || status === 'loading' ? <p role="status">Loading your details…</p> : <form onSubmit={submit} className="space-y-4">
                <label className="block text-sm font-bold">Your name<input required maxLength={100} autoComplete="name" className="input-wireframe mt-2" disabled={busy} value={name} onChange={event => setName(event.target.value)} /></label>
                <label className="block text-sm font-bold">Phone number<input required type="tel" maxLength={40} autoComplete="tel" placeholder="+63 912 345 6789" className="input-wireframe mt-2" disabled={busy} value={phone} onChange={event => setPhone(event.target.value)} /></label>
                <p className="text-sm text-gray-600">Include your country code. Philippine mobile numbers starting with 09 are also accepted.</p>
                <button className="btn-wireframe-dark w-full justify-center" disabled={busy}>{busy ? 'Saving…' : 'Save and enter workspace'}</button>
            </form>}
            {message && <div className="space-y-2"><p role="alert" className="text-sm text-red-700">{message}</p><button type="button" className="underline text-sm" disabled={busy} onClick={() => setRetry(value => value + 1)}>Reload details</button></div>}
            <button type="button" className="underline text-sm" disabled={busy} onClick={() => void signOut({ callbackUrl: '/login?method=email' })}>Sign out</button>
        </div>
    </main>;
}
