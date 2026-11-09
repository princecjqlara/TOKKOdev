import { NextResponse } from 'next/server';
import { accountMailConfigured, processAccountMail } from '@/lib/account-mail';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// Public scheduler endpoint; processes only previously queued account mail.
export async function GET() {
    if (!accountMailConfigured()) return NextResponse.json({ message: 'Account email sender is not configured.' }, { status: 503 });
    let sent = 0;
    try { for (let i = 0; i < 3; i++) { if (!await processAccountMail()) break; sent++; }
        return NextResponse.json({ success: true, sent });
    } catch { return NextResponse.json({ message: 'Email queue is temporarily unavailable.' }, { status: 503 }); }
}
