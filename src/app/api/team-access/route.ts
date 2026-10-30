import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { accountsReady, takeAccountRateLimit } from '@/lib/account-auth';
import { accountMailConfigured, processAccountMail, requireAccountMail } from '@/lib/account-mail';
import { accountErrorResponse, accountPasswordFingerprint, AccessError, assertSameOrigin, digest, encryptMailToken, hashAccountPassword, newAccountToken, normalizeEmail, validUuid } from '@/lib/account-security';
import { requireTeamPageAdministrator, teamAdministrationPages } from '@/lib/page-managers';
import { subaccountLifetime } from '@/lib/subaccount-lifetime';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
            const { data, error } = await db.from('user_pages').select('user_id,grant_source,users:users!user_pages_user_id_fkey(id,name,email,is_active,account_kind,created_by,facebook_id,expires_at,delete_after_expiry)').eq('page_id', pageId);
            if (error) throw error;
            const { data: managers, error: managerError } = await db.from('tokko_page_managers').select('user_id').eq('page_id', pageId);
            if (managerError) throw managerError;
            const protectedIds = new Set((managers || []).map(row => row.user_id));
            return NextResponse.json({ members: (data || []).map(row => {
                const user = Array.isArray(row.users) ? row.users[0] : row.users;
                return { id: user.id, name: user.name, email: user.email, pending: !user.is_active && user.account_kind === 'invited',
                    active: Boolean(user.is_active), parent: !user.created_by && ['facebook','legacy'].includes(user.account_kind),
                    expiresAt: user.expires_at,
                    deleteAfterExpiry: Boolean(user.delete_after_expiry),
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
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only original Facebook parent users can create subaccounts.');
        const body = await request.json();
        if (!body || typeof body !== 'object') throw new AccessError(400, 'Enter valid account details.');
        const setupMethod = body.setupMethod ?? 'email';
        if (!['email', 'password', 'existing'].includes(setupMethod)) throw new AccessError(400, 'Choose password setup, email invitation, or an existing account.');
        if (setupMethod !== 'password' && body.password !== undefined) throw new AccessError(400, 'Choose password setup to set an initial password.');
        const pages = Array.isArray(body.pageIds) ? [...new Set(body.pageIds)] as string[] : [];
        if (!pages.length || pages.length > 50 || pages.some(id => !validUuid(id))) throw new AccessError(400, 'Select the Pages to assign.');
        const email = normalizeEmail(body.email);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const { expiresAt, days, deleteAfterExpiry } = subaccountLifetime(body);
        const requestId = request.headers.get('idempotency-key');
        if (!name || name.length > 100 || !validUuid(requestId)) throw new AccessError(400, 'Enter a name and a valid request ID.');
        await takeAccountRateLimit(`invite-manager:${session.user.id}`, 30, 3600);
        await requireTeamPageAdministrator(session, pages);
        if (!await accountsReady()) throw new AccessError(503, 'Account access has not been enabled by the Tokko administrator.');
        if (setupMethod === 'email') requireAccountMail();
        await takeAccountRateLimit(`invite-email:${email}`, 8, 3600);
        const passwordHash = setupMethod === 'password' ? await hashAccountPassword(body.password) : null;
        const token = newAccountToken();
        const details = expiresAt === undefined ? [email, name, pages.sort()] : [email, name, pages.sort(), expiresAt];
        if (days !== null) details.push('lifetime-days', String(days));
        if (deleteAfterExpiry !== undefined) details.push('auto-delete', String(deleteAfterExpiry));
        const { data, error } = await getSupabaseAdmin().rpc('tokko_save_subaccount', {
            p_actor: session.user.id, p_pages: pages.sort(), p_email: email, p_name: name, p_request: requestId,
            p_fingerprint: digest(JSON.stringify(passwordHash ? [...details, 'password', accountPasswordFingerprint(body.password)] : setupMethod === 'existing' ? [...details, 'existing'] : details)),
            p_hash: token.hash, p_password: passwordHash, p_setup_method: setupMethod,
            p_encrypted: setupMethod === 'email' ? encryptMailToken(token.token) : '',
            p_expiry_set: expiresAt !== undefined, p_expires_at: expiresAt ?? null,
            p_lifetime_days: days, p_delete_after_expiry: deleteAfterExpiry ?? null
        });
        if (error?.code === '42501') throw new AccessError(403, passwordHash ? 'An initial password can only be set for a new account or your own pending invitation. Choose Assign an existing account to grant Page access.' : 'You can only set expiry for email accounts you created. Leave expiry off to assign an existing account.');
        if (error?.code === '22023') throw new AccessError(400, error.message?.includes('Existing active account required') ? 'Choose an active existing account, or create a new account first.' : 'Account details changed or the account has expired. Refresh, renew its expiry if needed, and try again.');
        if (error) throw error;
        const delivered = data.deliveryId ? await processAccountMail(data.deliveryId) : true;
        return NextResponse.json({ success: true, pending: data.pending,
            message: data.passwordCreated ? 'Account created with the chosen password. The member can sign in with their email and password.' : data.pending ? delivered ? 'Account created. A password setup email has been sent.' : 'Account saved. The setup email is queued for retry.' : 'Page access assigned. The existing account can sign in as usual.' },
            { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function PATCH(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only original Facebook parent users can change subaccount lifetimes.');
        const body = await request.json();
        if (!body || !validUuid(body.pageId) || !validUuid(body.userId)) throw new AccessError(400, 'Choose a valid Page and subaccount.');
        const { expiresAt, days, deleteAfterExpiry } = subaccountLifetime(body);
        if (expiresAt === undefined && days === null && deleteAfterExpiry === undefined) throw new AccessError(400, 'Choose a subaccount lifetime.');
        await takeAccountRateLimit(`expiry-manager:${session.user.id}`, 60, 3600);
        await requireTeamPageAdministrator(session, [body.pageId]);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_set_subaccount_lifetime', {
            p_actor: session.user.id, p_pages: [body.pageId], p_user: body.userId,
            p_expiry_set: expiresAt !== undefined, p_expires_at: expiresAt ?? null,
            p_lifetime_days: days, p_delete_after_expiry: deleteAfterExpiry ?? null
        });
        if (error?.code === '22023') throw new AccessError(400, 'Choose a future deadline for a temporary subaccount.');
        if (error) throw error;
        if (data !== true) throw new AccessError(403, 'You can only change expiry for email accounts you created.');
        return NextResponse.json({ success: true, message: deleteAfterExpiry ? 'Temporary subaccount scheduled for deletion at its deadline.' : expiresAt === null ? 'Subaccount made permanent.' : 'Subaccount lifetime updated.' }, { headers: { 'Cache-Control': 'no-store' } });
    } catch (error) { return accountErrorResponse(error); }
}

export async function DELETE(request: NextRequest) {
    try {
        assertSameOrigin(request);
        const session = await getSessionFromRequest(request);
        if (!session?.user.id) throw new AccessError(401, 'Please sign in.');
        if (session.user.provider !== 'facebook') throw new AccessError(403, 'Only original Facebook parent users can change Page assignments.');
        const body = await request.json();
        if (!body || !validUuid(body.pageId) || !validUuid(body.userId)) throw new AccessError(400, 'Choose a valid Page and member.');
        await takeAccountRateLimit(`revoke-manager:${session.user.id}`, 60, 3600);
        await requireTeamPageAdministrator(session, [body.pageId]);
        const { data, error } = await getSupabaseAdmin().rpc('tokko_revoke_member', { p_actor: session.user.id, p_page: body.pageId, p_user: body.userId });
        if (error) throw error;
        if (data !== true) throw new AccessError(409, 'This member has independent Facebook access or no delegated access to revoke.');
        return NextResponse.json({ success: true, message: 'Access to this Page has been revoked.' });
    } catch (error) { return accountErrorResponse(error); }
}
