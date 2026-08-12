import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';

export const dynamic = 'force-dynamic';

// GET /api/test-sync - Test endpoint to verify sync API is accessible
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }
        
        return NextResponse.json({
            success: true,
            message: 'Sync API is accessible'
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: (error as Error).message
        }, { status: 500 });
    }
}






