import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';

// GET /api/test-sync - Test endpoint to verify sync API is accessible
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        
        return NextResponse.json({
            success: true,
            message: 'Sync API is accessible',
            hasSession: !!session,
            userId: session?.user?.id || null
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: (error as Error).message
        }, { status: 500 });
    }
}

