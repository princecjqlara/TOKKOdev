'use client';

import { SessionProvider } from 'next-auth/react';
import { ReactNode } from 'react';
import SubaccountProfileGate from './SubaccountProfileGate';

export default function Providers({ children }: { children: ReactNode }) {
    return (
        <SessionProvider 
            refetchInterval={5 * 60} // Refetch session every 5 minutes
            refetchOnWindowFocus={true} // Refetch when window gains focus
        >
            <SubaccountProfileGate>{children}</SubaccountProfileGate>
        </SessionProvider>
    );
}
