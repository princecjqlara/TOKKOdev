import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getSessionFromRequest } from '@/lib/get-session';

export const dynamic = 'force-dynamic';

// GET /api/test-db - Test database connection
export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const supabase = getSupabaseAdmin();
        
        // Test query
        const { error } = await supabase
            .from('users')
            .select('id', { head: true })
            .limit(1);
        
        if (error) {
            console.error('Database connection check failed:', error);
            return NextResponse.json({
                success: false,
                message: 'Database connection check failed'
            }, { status: 500 });
        }
        
        return NextResponse.json({
            success: true,
            message: 'Database connection successful'
        });
    } catch (error) {
        console.error('Database connection check failed:', error);
        return NextResponse.json({
            success: false,
            message: 'Database connection check failed'
        }, { status: 500 });
    }
}






