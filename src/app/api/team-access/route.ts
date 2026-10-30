import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountsReady, takeAccountRateLimit } from '@/lib/account-auth';
import { accountMailConfigured, processAccountMail, requireAccountMail } from '@/lib/account-mail';
import { accountErrorResponse, AccessError, assertSameOrigin, digest, encryptMailToken, newAccountToken, normalizeEmail, validUuid } from '@/lib/account-security';
import { requireTeamPageAdministrator, teamAdministrationPages } from '@/lib/page-managers';
import { parseAccountExpiry } from '@/lib/account-expiry';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function expiryFromBody(value: unknown) {
    try { return parseAccountExpiry(value); }
    catch { throw new AccessError(400, 'Choose a valid expiry date and time in the future.'); }
}

export async function GET(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') return NextResponse.json({ canManageAccounts: false, pages: [] });
        await takeAccountRateLimit(`team-read:${session.user.id}`, 100, 900);
        const pageId = request.nextUrl.searchParams.get('pageId');
        const db = getSupabaseAdmin();
        const ready = await accountsReady();
        if (pageId) {
            if (!validUuid(pageId)) throw new AccessError(400, 'Choose a valid Page.');
            await requireTeamPageAdministrator(session, [pageId]);
            const { data, error } = await db.from('user_pages').select('user_id,grant_source,users(id,name,email,is_active,account_kind,created_by,facebook_id,expires_at)').eq('page_id', pageId);
            if (error) throw error;
            const { data: managers, error: managerError } = await db.from('tokko_page_managers').select('user_id').eq('page_id', pageId);
            if (managerError) throw managerError;
            const protectedIds = new Set((managers || []).map(row => row.user_id));
            return NextResponse.json({ members: (data || []).map(row => {
                const user = Array.isArray(row.users) ? row.users[0] : row.users;
                return { id: user.id, name: user.name, email: user.email, pending: !user.is_active,
                    expiresAt: user.expires_at,
                    canManageExpiry: user.created_by === session.user.id && ['invited', 'email'].includes(user.account_kind) && !user.facebook_id,
                    canRevoke: row.grant_source === 'delegated' && !protectedIds.has(user.id) };
            }), ready }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const pages = (await teamAdministrationPages(session)).map(page => ({ id: page.id, name: page.name }));
        return NextResponse.json({ canManageAccounts: pages.length > 0, pages, ready, emailConfigured: accountMailConfigured() }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function POST(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only Facebook Page administrators can create accounts.');
        const body = await request.json();
        const pages = Array.isArray(body.pageIds) ? [...new Set(body.pageIds)] as string[] : [];
        if (!pages.length || pages.length > 50 || pages.some(id => !validUuid(id))) throw new AccessError(400, 'Select the Pages to assign.');
        const email = normalizeEmail(body.email);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const expiresAt = expiryFromBody(body.expiresAt);
        const requestId = request.headers.get('idempotency-key');
        if (!name || name.length > 100 || !validUuid(requestId)) throw new AccessError(400, 'Enter a name and a valid request ID.');
        await takeAccountRateLimit(`invite-manager:${session.user.id}`, 30, 3600);
        await requireTeamPageAdministrator(session, pages);
        if (!await accountsReady()) throw new AccessError(503, 'Account access has not been enabled by the Tokko administrator.');
        requireAccountMail();
        await takeAccountRateLimit(`invite-email:${email}`, 8, 3600);
        const token = newAccountToken();
        const { data, error } = await getSupabaseAdmin().rpc('tokko_provision_member_with_expiry', {
            p_actor: session.user.id, p_pages: pages.sort(), p_email: email, p_name: name, p_request: requestId,
            p_fingerprint: digest(JSON.stringify(expiresAt === undefined ? [email, name, pages] : [email, name, pages, expiresAt])),
            p_hash: token.hash, p_encrypted: encryptMailToken(token.token), p_expiry_set: expiresAt !== undefined, p_expires_at: expiresAt ?? null
        });
        if (error?.code === '42501') throw new AccessError(403, 'You can only set expiry for email accounts you created. Leave expiry off to assign an existing account.');
        if (error) throw error;
        const delivered = data.deliveryId ? await processAccountMail(data.deliveryId) : true;
        return NextResponse.json({ success: true, pending: data.pending,
            message: data.pending ? delivered ? 'Account created. A password setup email has been sent.' : 'Account saved. The setup email is queued for retry.' : 'Page access assigned. The existing account can sign in as usual.' },
            { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function PATCH(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only Facebook Page administrators can change account expiry.');
        const body = await request.json();
        if (!validUuid(body.pageId) || !validUuid(body.userId) || body.expiresAt === undefined) throw new AccessError(400, 'Choose a valid Page, account, and expiry.');
        const expiresAt = expiryFromBody(body.expiresAt);
        await takeAccountRateLimit(`expiry-manager:${session.user.id}`, 60, 3600);
        await requireTeamPageAdministrator(session, [body.pageId]);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_set_member_expiry', {
            p_actor: session.user.id, p_pages: [body.pageId], p_user: body.userId, p_expires_at: expiresAt
        });
        if (error) throw error;
        if (data !== true) throw new AccessError(403, 'You can only change expiry for email accounts you created.');
        return NextResponse.json({ success: true, message: expiresAt ? 'Account expiry updated.' : 'Account expiry removed.' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function DELETE(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only Facebook Page administrators can change assignments.');
        const body = await request.json();
        if (!validUuid(body.pageId) || !validUuid(body.userId)) throw new AccessError(400, 'Choose a valid Page and member.');
        await takeAccountRateLimit(`revoke-manager:${session.user.id}`, 60, 3600);
        await requireTeamPageAdministrator(session, [body.pageId]);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_revoke_member', { p_actor: session.user.id, p_page: body.pageId, p_user: body.userId });
        if (error) throw error;
        if (data !== true) throw new AccessError(409, 'This member has independent Facebook access or no delegated access to revoke.');
        return NextResponse.json({ success: true, message: 'Access to this Page has been revoked.' });
    } catch (error) { return accountErrorResponse(error); }
}
