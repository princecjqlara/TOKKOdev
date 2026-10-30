import { NextRequest, NextResponse } from 'next/server';
import { getServerAuthToken } from '@/lib/server-auth-token';
import { getActiveAccount, takeAccountRateLimit } from '@/lib/account-auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { AccessError, accountErrorResponse, assertSameOrigin } from '@/lib/account-security';
import { isSubaccount, needsSubaccountProfile, subaccountProfileInput } from '@/lib/subaccount-profile';

export const dynamic = 'force-dynamic';

async function profileAccount() {
    // Operational sessions intentionally have no user ID until onboarding is
    // complete. Use the signed server cookie and recheck live account state.
    const token = await getServerAuthToken();
    if (!token?.id) throw new AccessError(401, 'Please sign in to your team subaccount.');
    const version = Number(token.sessionVersion || 0);
    const provider = token.provider || (token.facebookId ? 'facebook' : 'credentials');
    const account = await getActiveAccount(token.id, version, provider);
    if (!account) throw new AccessError(401, 'Please sign in again.');
    if (provider !== 'credentials' || !isSubaccount(account)) throw new AccessError(403, 'This step is only for team subaccounts.');
    return { account, version };
}

export async function GET() {
    try {
        const { account } = await profileAccount();
        return NextResponse.json({ name: account.name || '', phone: account.phone_number || '', requiresCompletion: needsSubaccountProfile(account) },
            { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function PUT(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const { account, version } = await profileAccount();
        await takeAccountRateLimit(`profile:${account.id}`, 10, 900);
        const { name, phone } = subaccountProfileInput(await request.json());
        const { data, error } = await getSupabaseAdmin().rpc('tokko_complete_subaccount_profile', {
            p_user: account.id, p_version: version, p_name: name, p_phone: phone
        });
        if (error?.code === '22023') throw new AccessError(400, 'Enter a valid name and phone number.');
        if (error) throw error;
        if (data !== true) throw new AccessError(409, 'Your account changed. Sign in again to continue.');
        return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
