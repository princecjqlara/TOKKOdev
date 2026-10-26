import { getServerSession } from 'next-auth';
import type { NextRequest } from 'next/server';
import { authOptions } from './auth';

export async function getSessionFromRequest(_request: NextRequest) {
    const session = await getServerSession(authOptions);
    // Identity/activity/version are checked by auth callbacks; requests never create accounts.
    return session?.user?.id ? session : null;
}
