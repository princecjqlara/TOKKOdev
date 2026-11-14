import { NextRequest, NextResponse } from 'next/server';
import { requireSystemAdmin } from '@/lib/require-system-admin';
import { getSupabaseAdmin } from '@/lib/supabase';
import { takeAccountRateLimit } from '@/lib/account-auth';
import { accountRequest } from '@/lib/account-request';
import { AccessError, accountErrorResponse, assertSameOrigin, validUuid } from '@/lib/account-security';
import { subaccountLifetime } from '@/lib/subaccount-lifetime';

export const dynamic = 'force-dynamic';
type Context = { params: { userId: string } };

async function actor(request: NextRequest, { params }: Context) {
    assertSameOrigin(request);
    const session = await requireSystemAdmin();
    if (!validUuid(params.userId)) throw new AccessError(400, 'Choose a valid account.');
    await takeAccountRateLimit('system-admin-manage', 60, 900);
    return session.user.email;
}

export async function PATCH(request: NextRequest, context: Context) {
    try {
        const email = await actor(request, context);
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'Choose an account action.');
        let operation: string;
        let args: Record<string, unknown> = { p_user: context.params.userId, p_admin_email: email };
        let message: string;
        if (body.action === 'status') {
            if (typeof body.active !== 'boolean') throw new AccessError(400, 'Choose whether the account is enabled.');
            operation = 'tokko_admin_set_account_active'; args.p_active = body.active;
            message = body.active ? 'Account enabled. The member can sign in if their access has not expired.' : 'Account disabled. Existing sessions have been revoked.';
        } else if (body.action === 'lifetime') {
            const { days, expiresAt, deleteAfterExpiry } = subaccountLifetime(body);
            if (days === null && expiresAt === undefined && deleteAfterExpiry === undefined) throw new AccessError(400, 'Choose a new access duration.');
            operation = 'tokko_admin_set_account_lifetime';
            args = { ...args, p_expiry_set: expiresAt !== undefined, p_expires_at: expiresAt ?? null,
                p_lifetime_days: days, p_delete_after_expiry: deleteAfterExpiry ?? null };
            message = expiresAt === null ? 'Account access made permanent.' : 'Account expiry and deletion schedule updated.';
        } else throw new AccessError(400, 'Choose a valid account action.');
        const { data, error } = await accountRequest(getSupabaseAdmin().rpc(operation, args));
        if (error?.code === '22023') throw new AccessError(400, body.action === 'status'
            ? 'This account must finish password setup before it can be enabled.'
            : 'Choose a future expiry. Scheduled deletion is available only for email subaccounts with an expiry.');
        if (error) throw error;
        if (data !== true) throw new AccessError(404, 'Account unavailable or protected. Refresh the account list.');
        return NextResponse.json({ message }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function DELETE(request: NextRequest, context: Context) {
    try {
        const email = await actor(request, context);
        const body = await request.json();
        if (!body || typeof body.confirmation !== 'string' || !body.confirmation.trim() || body.confirmation.length > 254) {
            throw new AccessError(400, 'Type the account email or ID to confirm deletion.');
        }
        const { data, error } = await accountRequest(getSupabaseAdmin().rpc('tokko_admin_delete_account', {
            p_user: context.params.userId, p_confirmation: body.confirmation.trim(), p_admin_email: email
        }));
        if (error?.code === '22023') throw new AccessError(400, 'The confirmation must match the account email or ID. Refresh if the account has changed.');
        if (error?.code === '23503') throw new AccessError(409, 'This account still has subaccounts or linked records. Handle those before deleting it.');
        if (error) throw error;
        if (data !== true) throw new AccessError(404, 'Account unavailable or protected. Refresh the account list.');
        return NextResponse.json({ message: 'Account deleted. Shared Pages, contacts, campaigns, and history were preserved.' },
            { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
