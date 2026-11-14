import { getServerSession } from 'next-auth';
import { authOptions } from './auth';
import { AccessError } from './account-security';
import { SYSTEM_ADMIN_PROVIDER } from './system-admin-auth';

export async function requireSystemAdmin() {
    const session = await getServerSession(authOptions);
    if (!session) throw new AccessError(401, 'Please sign in as the administrator.');
    if (!session.isSystemAdmin || !session.accountActive || session.user.provider !== SYSTEM_ADMIN_PROVIDER) {
        throw new AccessError(403, 'Administrator access is required.');
    }
    return session;
}
