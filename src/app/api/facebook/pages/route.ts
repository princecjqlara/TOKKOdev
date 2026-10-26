import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getFacebookPages, isFacebookReauthRequired } from '@/lib/facebook';
import { FACEBOOK_REAUTH_MESSAGE } from '@/lib/facebook-permissions';
import { getFacebookServerToken } from '@/lib/server-auth-token';

export const dynamic = 'force-dynamic';

// GET /api/facebook/pages - Get user's Facebook pages
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        // Note: Facebook pages functionality requires Facebook OAuth
        // With email/password login, this endpoint returns empty pages
        // Pages should be connected via the admin or API with stored tokens
        const accessToken = await getFacebookServerToken();
        if (!accessToken) {
            return NextResponse.json({ pages: [], message: 'No Facebook token available' });
        }

        const facebookPages = await getFacebookPages(accessToken);
        const pages = facebookPages.map(({ access_token: _token, ...page }) => page);

        return NextResponse.json({ pages });
    } catch (error) {
        console.error('Error fetching Facebook pages:', error);
        if (isFacebookReauthRequired(error)) {
            return NextResponse.json(
                {
                    error: 'Facebook authorization required',
                    code: 'FACEBOOK_REAUTH_REQUIRED',
                    requiresReauth: true,
                    message: FACEBOOK_REAUTH_MESSAGE
                },
                { status: 409 }
            );
        }

        return NextResponse.json(
            { error: 'Failed to fetch pages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
