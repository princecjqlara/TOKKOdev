import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getFacebookPages } from '@/lib/facebook';

// GET /api/facebook/pages - Get user's Facebook pages
export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.accessToken) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in with Facebook' },
                { status: 401 }
            );
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
