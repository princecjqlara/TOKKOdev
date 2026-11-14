import { NextRequest, NextResponse } from 'next/server';
import { requireSystemAdmin } from '@/lib/require-system-admin';
import { getSupabaseAdmin } from '@/lib/supabase';
import { takeAccountRateLimit } from '@/lib/account-auth';
import { accountRequest } from '@/lib/account-request';
import { AccessError, accountErrorResponse, assertSameOrigin, hashAccountPassword, validUuid } from '@/lib/account-security';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest, { params }: { params: { userId: string } }) {
    try {
        assertSameOrigin(request);
        const session = await requireSystemAdmin();
        if (!validUuid(params.userId)) throw new AccessError(400, 'Choose a valid subaccount.');
        await takeAccountRateLimit('system-admin-password-reset', 20, 900);
        const body = await request.json();
        const passwordHash = await hashAccountPassword(body?.password);
        const { data, error } = await accountRequest(getSupabaseAdmin().rpc('tokko_admin_reset_subaccount_password', {
            p_user: params.userId, p_password_hash: passwordHash, p_admin_email: session.user.email
        }));
        if (error) throw error;
        if (data !== true) throw new AccessError(403, 'Only activated email subaccounts can have their password reset here.');
        return NextResponse.json({ message: 'Password updated. Existing sessions and reset links have been revoked.' },
            { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
