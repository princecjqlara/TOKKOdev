import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthToken } from '@/lib/server-auth-token';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountsReady, takeAccountRateLimit } from '@/lib/account-auth';
import { requireAccountMail } from '@/lib/account-mail';
import { AccessError, accountErrorResponse, assertSameOrigin, digest, encryptMailToken, newAccountToken, normalizeEmail } from '@/lib/account-security';

async function pendingIdentity() {
    const token = await getServerAuthToken();
    if (token?.provider !== 'facebook' || !token.facebookId || !token.pendingFacebookLinkAt ||
        Date.now() - token.pendingFacebookLinkAt >= 15 * 60 * 1000 || token.id) {
        throw new AccessError(403, 'Start Facebook sign-in again, then open the verification email in the same browser.');
    }
    if (!await accountsReady()) throw new AccessError(503, 'Account verification is awaiting administrator setup.');
    return token.facebookId;
}

export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request); const subject = await pendingIdentity(); requireAccountMail();
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'Enter a valid email address.');
        const email = normalizeEmail(body.email);
        await takeAccountRateLimit(`facebook-link:${subject}`, 5, 3600);
        await takeAccountRateLimit(`facebook-link-email:${email}`, 3, 3600);
        const token = newAccountToken();
        const { error } = await getSupabaseAdmin().rpc('tokko_queue_facebook_link', {
            p_email: email, p_subject: subject, p_hash: token.hash, p_encrypted: encryptMailToken(token.token)
        });
        if (error) throw error;
        return NextResponse.json({ message: 'If this email belongs to an eligible Tokko account, a verification link will be sent. Open it in this same browser.' }, { status: 202 });
    } catch (error) { return accountErrorResponse(error); }
}

export async function PUT(request: NextRequest) {
    try {
        assertSameOrigin(request); const subject = await pendingIdentity();
        await takeAccountRateLimit(`facebook-link-confirm:${subject}`, 10, 900);
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'This verification link is invalid or expired.');
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new AccessError(400, 'This verification link is invalid or expired.');
        const { data, error } = await getSupabaseAdmin().rpc('tokko_confirm_facebook_link', { p_hash: digest(body.token), p_subject: subject });
        if (error) throw error;
        if (data !== true) throw new AccessError(400, 'This link is invalid, expired, used, or belongs to a different Facebook sign-in.');
        return NextResponse.json({ success: true, message: 'Facebook verified. Continue with Facebook again to open your existing Tokko account.' });
    } catch (error) { return accountErrorResponse(error); }
}
