import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { databaseRequest } from '@/lib/database-request';
import { requireTeamPageAdministrator } from '@/lib/page-managers';
import { AccessError } from '@/lib/account-security';

export const dynamic = 'force-dynamic';
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v);
function validDate(value: string | null): value is string {
    return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    const { pageId } = await params;
    const from = request.nextUrl.searchParams.get('from'), to = request.nextUrl.searchParams.get('to');
    const kind = request.nextUrl.searchParams.get('kind') || 'all';
    const horizon = Number(request.nextUrl.searchParams.get('horizon') || 24);
    if (!uuid(pageId) || !validDate(from) || !validDate(to) || to < from || Date.parse(to) - Date.parse(from) > 365 * 86400000 ||
        !['all', 'new_contact', 'returning_contact'].includes(kind) || ![24, 168].includes(horizon)) return NextResponse.json({ error: 'Choose a valid Page, date range and observation window.' }, { status: 400 });
    try {
        const result = await databaseRequest<any>(getSupabaseAdmin().rpc('tokko_inquiry_insights', {
            p_actor: session.user.id, p_page: pageId, p_from: from, p_to: to, p_kind: kind, p_horizon_hours: horizon
        }));
        if (result.error) return NextResponse.json({ error: result.error.code === '42501' ? 'Page access required.' : 'Inquiry reporting is temporarily unavailable. Please retry.' }, { status: result.error.code === '42501' ? 403 : 503 });
        return NextResponse.json(result.data, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch {
        return NextResponse.json({ error: 'Inquiry reporting is temporarily unavailable. Please retry.' }, { status: 503 });
    }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
    if (request.headers.get('origin') !== request.nextUrl.origin) return NextResponse.json({ error: 'Same-origin request required.' }, { status: 403 });
    const { pageId } = await params;
    try {
        const body = await request.json();
        if (!uuid(pageId) || !Number.isInteger(body.returning_after_days) || body.returning_after_days < 1 || body.returning_after_days > 365 ||
            !Number.isInteger(body.response_sla_minutes) || body.response_sla_minutes < 1 || body.response_sla_minutes > 1440) return NextResponse.json({ error: 'Choose 1–365 returning days and a 1–1440 minute response target.' }, { status: 400 });
        await requireTeamPageAdministrator(session, [pageId]);
        const result = await databaseRequest<any>(getSupabaseAdmin().rpc('tokko_set_inquiry_policy', {
            p_actor: session.user.id, p_page: pageId, p_returning_days: body.returning_after_days, p_sla_minutes: body.response_sla_minutes
        }));
        if (result.error) return NextResponse.json({ error: result.error.code === '42501' ? 'Page administrator access required.' : 'Could not save reporting settings. Please retry.' }, { status: result.error.code === '42501' ? 403 : 503 });
        return NextResponse.json(result.data, { headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
        if (error instanceof AccessError) return NextResponse.json({ error: error.message }, { status: error.status });
        return NextResponse.json({ error: 'Could not save reporting settings. Please retry.' }, { status: 503 });
    }
}
