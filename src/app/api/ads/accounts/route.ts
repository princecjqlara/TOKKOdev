import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';
import { authOptions } from '@/lib/auth';
import { AdsApiError, getMetaAdAccounts } from '@/lib/meta-ads';

export const dynamic = 'force-dynamic';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
    if (!session.accessToken) return NextResponse.json({ error: 'Connect Facebook ad access first.', code: 'ADS_REAUTH_REQUIRED' }, { status: 409 });
    try {
        const accounts = await getMetaAdAccounts(session.accessToken);
        return NextResponse.json({ accounts }, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        return NextResponse.json({
            error: error instanceof AdsApiError ? error.message : 'Could not load ad accounts. Retry the connection.',
            code: error instanceof AdsApiError ? error.code : 'ADS_REPORT_FAILED'
        }, { status: error instanceof AdsApiError ? error.status : 502 });
    }
}
