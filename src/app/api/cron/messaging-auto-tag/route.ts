import { NextResponse } from 'next/server';
import { processOneMessagingAutoTagPage } from '@/lib/messaging-auto-tag-worker';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        return NextResponse.json({ success: true, ...await processOneMessagingAutoTagPage() });
    } catch (error) {
        console.error('[MESSAGING_AUTO_TAG] Failed:', error);
        return NextResponse.json({ error: 'Messaging auto-tag sync failed' }, { status: 500 });
    }
}
