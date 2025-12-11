import { NextRequest, NextResponse } from 'next/server';

// GET /api/test-logging - Test endpoint to verify server logging works
export async function GET(request: NextRequest) {
    console.log('🔵🔵🔵 TEST LOGGING ENDPOINT CALLED');
    console.log('🔵 Request URL:', request.url);
    console.log('🔵 Request method:', request.method);
    console.log('🔵 Timestamp:', new Date().toISOString());
    
    return NextResponse.json({
        success: true,
        message: 'Logging test successful',
        timestamp: new Date().toISOString(),
        instructions: 'Check your terminal for messages starting with 🔵'
    });
}





