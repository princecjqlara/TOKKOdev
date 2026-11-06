import { getServerSession } from 'next-auth';
import type { NextRequest } from 'next/server';
import { authOptions } from './auth';
import { AccessError } from './account-security';

export async function getSessionFromRequest(_request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (session?.authenticationError === 'service_unavailable') {
        throw new AccessError(503, 'Account service is temporarily unavailable. Please retry shortly.');
    }
    // Identity/activity/version are checked by auth callbacks; requests never create accounts.
    return session?.user?.id ? session : null;
}
