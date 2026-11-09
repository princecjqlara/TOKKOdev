import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
    const path = request.nextUrl.pathname;
    // Cron endpoints are intentionally public so schedulers need only the URL.
    if (path.startsWith('/api/cron/')) {
        return NextResponse.next();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !path.startsWith('/api/auth/') && path !== '/api/facebook/webhook') {
        const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
        if (request.headers.get('origin') !== expected) return NextResponse.json({ message: 'Invalid request origin.' }, { status: 403 });
    }
    return NextResponse.next();
}
export const config = { matcher: ['/api/:path*'] };
