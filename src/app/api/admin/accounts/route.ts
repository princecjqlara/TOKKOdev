import { NextRequest, NextResponse } from 'next/server';
import { requireSystemAdmin } from '@/lib/require-system-admin';
import { getSupabaseAdmin } from '@/lib/supabase';
import { takeAccountRateLimit } from '@/lib/account-auth';
import { accountRequest } from '@/lib/account-request';
import { AccessError, accountErrorResponse, validUuid } from '@/lib/account-security';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
    try {
        await requireSystemAdmin();
        await takeAccountRateLimit('system-admin-read', 200, 900);
        const params = request.nextUrl.searchParams;
        const search = (params.get('search') || '').trim();
        const type = params.get('type') || 'all';
        const lifetime = params.get('lifetime') || 'all';
        const status = params.get('status') || 'all';
        const page = Number(params.get('page') || 1);
        const parent = params.get('parent');
        const pageId = params.get('pageId');
        const assignment = params.get('assignment') || 'all';
        const expiresWithin = params.has('expiresWithin') ? Number(params.get('expiresWithin')) : null;
        const deletion = params.get('deletion') || 'all';
        const password = params.get('password') || 'all';
        const sort = params.get('sort') || 'newest';
        if (search.length > 100 || !['all', 'parent', 'subaccount'].includes(type)
            || !['all', 'permanent', 'temporary'].includes(lifetime)
            || !['all', 'active', 'disabled', 'pending', 'expired'].includes(status)
            || !Number.isSafeInteger(page) || page < 1 || page > 100000 || parent !== null && !validUuid(parent)
            || pageId !== null && !validUuid(pageId) || !['all', 'assigned', 'unassigned'].includes(assignment)
            || expiresWithin !== null && ![7, 30, 90].includes(expiresWithin)
            || !['all', 'scheduled', 'keep'].includes(deletion) || !['all', 'set', 'unset'].includes(password)
            || !['newest', 'oldest', 'name', 'expiry'].includes(sort)) {
            throw new AccessError(400, 'Choose valid account filters.');
        }
        const { data, error } = await accountRequest(getSupabaseAdmin().rpc('tokko_admin_accounts_v2', {
            p_search: search, p_type: type, p_lifetime: lifetime, p_status: status,
            p_page: page, p_page_size: 25, p_parent: parent, p_page_id: pageId, p_assignment: assignment,
            p_expires_within: expiresWithin, p_deletion: deletion, p_password: password, p_sort: sort
        }));
        if (error) throw new AccessError(503, 'Account overview is unavailable. Verify the administrator database migration is installed.');
        return NextResponse.json(data, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}
