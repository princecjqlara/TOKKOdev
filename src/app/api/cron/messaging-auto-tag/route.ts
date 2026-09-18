import { NextRequest, NextResponse } from 'next/server';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    const secret = process.env.CRON_SECRET;
    if (!secret) return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
    if (request.headers.get('authorization') !== `Bearer ${secret}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        return NextResponse.json({ success: true, ...await processOneMessagingAutoTagPage() });
    } catch (error) {
        console.error('[MESSAGING_AUTO_TAG] Failed:', error);
        return NextResponse.json({ error: 'Messaging auto-tag sync failed' }, { status: 500 });
    }
}
