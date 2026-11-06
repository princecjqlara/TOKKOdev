import { NextRequest, NextResponse } from 'next/server';
import { processContactImport } from '@/lib/contact-import';
import { AccessError } from '@/lib/account-security';

export const dynamic = 'force-dynamic';

// One bounded slice per invocation; the database retains the folder/cursor.
// Subsequent invocations continue instead of rereading the latest five threads.
export async function GET(_request: NextRequest) {
    try {
        return NextResponse.json({ success: true, timestamp: new Date().toISOString(), results: [await processContactImport()] });
    } catch (error) {
        console.error('[CONTACT_IMPORT] Scheduled import failed', { status: error instanceof AccessError ? error.status : 500 });
        return NextResponse.json({ success: false, error: 'Contact import could not continue',
            message: error instanceof AccessError ? error.message : 'Import progress is retained. Retry shortly.' },
            { status: error instanceof AccessError ? error.status : 500 });
    }
}
