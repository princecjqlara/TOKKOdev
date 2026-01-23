import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getFacebookPages } from '@/lib/facebook';

// GET /api/facebook/pages - Get user's Facebook pages
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        // Note: Facebook pages functionality requires Facebook OAuth
        // With email/password login, this endpoint returns empty pages
        // Pages should be connected via the admin or API with stored tokens
        if (!session.accessToken) {
            return NextResponse.json({ pages: [], message: 'No Facebook token available' });
        }

        const pages = await getFacebookPages(session.accessToken);

        return NextResponse.json({ pages });
    } catch (error) {
        console.error('Error fetching Facebook pages:', error);
        return NextResponse.json(
            { error: 'Failed to fetch pages', message: (error as Error).message },
            { status: 500 }
        );
    }
}
