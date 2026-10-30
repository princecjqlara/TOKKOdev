'use client';
import { useEffect, type ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { usePathname, useRouter } from 'next/navigation';

export default function SubaccountProfileGate({ children }: { children: ReactNode }) {
    const { data: session } = useSession();
    const pathname = usePathname();
    const router = useRouter();
    const redirect = Boolean(session?.requiresProfileCompletion && pathname !== '/complete-profile');
    useEffect(() => {
        if (redirect) router.replace('/complete-profile');
    }, [redirect, router]);
    if (redirect) return <main className="min-h-screen flex items-center justify-center bg-gray-50 p-6"><p role="status">Opening your account details…</p></main>;
    return <>{children}</>;
}
