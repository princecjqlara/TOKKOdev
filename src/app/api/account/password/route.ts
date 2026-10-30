import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountErrorResponse, AccessError, assertSameOrigin, digest, hashAccountPassword } from '@/lib/account-security';
import { takeAccountRateLimit } from '@/lib/account-auth';

export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const body = await request.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccessError(400, 'Enter a valid password link and password.');
        const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
        await takeAccountRateLimit(`password-ip:${ip}`, 20, 900);
        if (typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new AccessError(400, 'This password link is invalid or expired.');
        const password = await hashAccountPassword(body.password);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_set_account_password', { p_hash: digest(body.token), p_password: password });
        if (error) throw error;
        if (data !== true) throw new AccessError(400, 'This password link is invalid, expired, or already used. Ask your Page manager for a new invitation or request a password reset.');
        return NextResponse.json({ success: true, message: 'Password saved. Sign in with your email and new password.' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
