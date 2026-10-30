import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
// The shared cron middleware requires Authorization: Bearer <CRON_SECRET>.
export async function GET() {
    try {
    const { data, error } = await getSupabaseAdmin().rpc('tokko_delete_expired_subaccounts', { p_limit: 100 });
    if (error || !data || !Number.isInteger(data.deleted) || !Number.isInteger(data.failed)) return NextResponse.json({ message: 'Subaccount cleanup is temporarily unavailable.' }, { status: 503 });
    return NextResponse.json({ success: data?.failed === 0, ...data }, { status: data?.failed ? 503 : 200 });
    } catch { return NextResponse.json({ message: 'Subaccount cleanup is temporarily unavailable.' }, { status: 503 }); }
}
