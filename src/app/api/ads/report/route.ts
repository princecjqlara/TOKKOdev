import { getServerSession } from 'next-auth';
import { NextRequest, NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import type { AdsGoal } from '@/lib/ads-guard';
import { AdsApiError, getMetaAdAccounts, getMetaAdsReport } from '@/lib/meta-ads';
import { getFacebookServerToken } from '@/lib/server-auth-token';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
    const accessToken = await getFacebookServerToken();
    if (!accessToken) return NextResponse.json({ error: 'Ads Guard requires separate Facebook ad-account permission. Assigned Page features remain available.', code: 'ADS_REAUTH_REQUIRED' }, { status: 409 });
    const accountId = request.nextUrl.searchParams.get('account');
    const goal = request.nextUrl.searchParams.get('goal') || 'messages';
    if (!accountId || !/^act_\d+$/.test(accountId) || !['messages', 'leads', 'purchases'].includes(goal)) {
        return NextResponse.json({ error: 'Choose a valid ad account and result goal.' }, { status: 400 });
    }
    try {
        // Authorize against the caller's own user token, never a stored shared Page token.
        const accounts = await getMetaAdAccounts(accessToken);
        const account = accounts.find(a => a.id === accountId);
        if (!account) return NextResponse.json({ error: 'You do not have access to this ad account.' }, { status: 403 });
        const report = await getMetaAdsReport(accessToken, account, goal as AdsGoal);
        return NextResponse.json({ report }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        return NextResponse.json({
            error: error instanceof AdsApiError ? error.message : 'Could not complete the ad report. Please retry.',
            code: error instanceof AdsApiError ? error.code : 'ADS_REPORT_FAILED'
        }, { status: error instanceof AdsApiError ? error.status : 502 });
    }
}
