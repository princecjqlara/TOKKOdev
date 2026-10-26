import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountErrorResponse, assertSameOrigin, encryptMailToken, newAccountToken, normalizeEmail } from '@/lib/account-security';
import { takeAccountRateLimit } from '@/lib/account-auth';
import { requireAccountMail } from '@/lib/account-mail';

export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request);
        requireAccountMail();
        const body = await request.json();
        const email = normalizeEmail(body.email);
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
        await takeAccountRateLimit(`reset-ip:${ip}`, 20, 3600);
        await takeAccountRateLimit(`reset-email:${email}`, 3, 3600);
        const token = newAccountToken();
        const { error } = await getSupabaseAdmin().rpc('tokko_queue_password_reset', {
            p_email: email, p_hash: token.hash, p_encrypted: encryptMailToken(token.token)
        });
        if (error) throw error;
        // Delivery is handled by the outbox worker so response time and body
        // do not disclose whether this email has an active password account.
        return NextResponse.json({ message: 'If this email has an active email account, a password reset link will be sent.' }, { status: 202 });
    } catch (error) { return accountErrorResponse(error); }
}
