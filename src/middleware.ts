import { NextRequest, NextResponse } from 'next/server';

function matchesSecret(actual: string, expected: string): boolean {
    if (!expected || actual.length !== expected.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    return mismatch === 0;
}

export function middleware(request: NextRequest) {
    const path = request.nextUrl.pathname;
    if (path.startsWith('/api/cron/')) {
        const secret = process.env.CRON_SECRET;
        if (!secret) return NextResponse.json({ message: 'Worker authentication is not configured.' }, { status: 503 });
        if (!matchesSecret(request.headers.get('authorization') || '', `Bearer ${secret}`)) {
            return NextResponse.json({ message: 'Unauthorized worker request.' }, { status: 401 });
        }
        return NextResponse.next();
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !path.startsWith('/api/auth/') && path !== '/api/facebook/webhook') {
        const expected = new URL(process.env.NEXTAUTH_URL || request.url).origin;
        if (request.headers.get('origin') !== expected) return NextResponse.json({ message: 'Invalid request origin.' }, { status: 403 });
    }
    return NextResponse.next();
}
export const config = { matcher: ['/api/:path*'] };
