import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getServerAuthToken } from '@/lib/server-auth-token';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountsReady, takeAccountRateLimit } from '@/lib/account-auth';
import { AccessError, accountErrorResponse, assertSameOrigin, hashAccountPassword, normalizeEmail, verifyAccountPassword } from '@/lib/account-security';

export const dynamic = 'force-dynamic';

async function ownAccount(request: NextRequest) {
    const session = await getSessionFromRequest(request);
    if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
    const { data, error } = await getSupabaseAdmin().from('users')
        .select('id,email,password_hash,email_login_enabled,email_verified_at,facebook_id,session_version')
        .eq('id', session.user.id).maybeSingle();
    if (error) throw error;
    if (!data) throw new AccessError(401, 'Please sign in again.');
    return { session, account: data };
}
function usableEmail(email: unknown) {
    try { normalizeEmail(email); return true; } catch { return false; }
}

export async function GET(request: NextRequest) {
    try {
        const { account } = await ownAccount(request);
        const ready = await accountsReady();
        const hasPassword = Boolean(account.password_hash && account.email_login_enabled);
        return NextResponse.json({ email: account.email, hasPassword, ready, facebookConnected: Boolean(account.facebook_id),
            hasUsableEmail: usableEmail(account.email),
            canSetPassword: ready && usableEmail(account.email) && hasPassword,
            requiresFacebook: false
        }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function PUT(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const { session, account } = await ownAccount(request);
        await takeAccountRateLimit(`own-password:${session.user.id}`, 8, 900);
        if (!await accountsReady()) throw new AccessError(503, 'Password sign-in is awaiting administrator setup.');
        if (!usableEmail(account.email)) throw new AccessError(400, 'This Facebook account needs a verified, usable email address before password sign-in can be enabled. Continue with Facebook for now.');
        const signed = await getServerAuthToken();
        const version = Number(signed?.sessionVersion || 0);
        if (!signed || signed.id !== session.user.id || version !== Number(account.session_version)) throw new AccessError(401, 'Please sign in again.');
        const body = await request.json();
        if (!body || typeof body !== 'object') throw new AccessError(400, 'Enter your new password.');
        let expectedPassword: string | null = null;
        let subject: string | null = null;
        if (account.password_hash) {
            if (!account.email_login_enabled || !account.email_verified_at || !await verifyAccountPassword(body.currentPassword, account.password_hash)) {
                throw new AccessError(400, 'Your current password is incorrect. Use password recovery if you have forgotten it.');
            }
            expectedPassword = account.password_hash;
        } else {
            throw new AccessError(403, 'Original Facebook users continue with Facebook. Their parent account creates passwords for team subaccounts.');
        }
        const password = await hashAccountPassword(body.password);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_set_own_password', {
            p_user: session.user.id, p_subject: subject, p_version: version,
            p_expected_password: expectedPassword, p_password: password
        });
        if (error) throw error;
        if (data !== true) throw new AccessError(409, 'Your account changed. Sign in again before updating your password.');
        return NextResponse.json({ success: true, requiresSignIn: true, message: 'Password saved. Sign in again with your email and new password.' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
