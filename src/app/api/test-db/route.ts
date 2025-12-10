import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET /api/test-db - Test database connection
export async function GET(request: NextRequest) {
    try {
        const supabase = getSupabaseAdmin();
        
        // Test query
        const { data, error } = await supabase
            .from('users')
            .select('id, email')
            .limit(1);
        
        if (error) {
            return NextResponse.json({
                success: false,
                error: error.message,
                code: error.code,
                details: error
            }, { status: 500 });
        }
        
        return NextResponse.json({
            success: true,
            message: 'Database connection successful',
            userCount: data?.length || 0,
            sampleData: data
        });
    } catch (error) {
        return NextResponse.json({
            success: false,
            error: (error as Error).message,
            stack: (error as Error).stack
        }, { status: 500 });
    }
}


