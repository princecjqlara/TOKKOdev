import type { Session } from 'next-auth';
import { getFacebookPages } from './facebook';
import { getFacebookServerToken } from './server-auth-token';
import { getSupabaseAdmin } from './supabase';
import { AccessError } from './account-security';

export function hasFacebookManagementTask(page: { tasks?: string[] }): boolean {
    return Array.isArray(page.tasks) && page.tasks.includes('MANAGE');
}

async function verifyFacebookIdentity(session: Session) {
    if (!session.user?.id || session.user.provider !== 'facebook' || !session.user.facebookId) {
        throw new AccessError(403, 'Sign in with the Facebook account that administers this Page.');
    }
    const { data, error } = await getSupabaseAdmin().rpc('tokko_resolve_facebook_user', {
        p_subject: session.user.facebookId, p_email: session.user.email || null,
        p_name: session.user.name || null, p_image: session.user.image || null, p_legacy_id: session.user.id
    });
    const row = Array.isArray(data) ? data[0] : data;
    if (error || row?.user_id !== session.user.id) throw new AccessError(403, 'Your Facebook account identity could not be verified. Sign in again.');
}

/** Original Page connections may administer Tokko members without a new Meta lookup. */
export async function teamAdministrationPages(session: Session) {
    await verifyFacebookIdentity(session);
    const { data, error } = await getSupabaseAdmin().from('user_pages')
        .select('grant_source,pages(id,fb_page_id,name)').eq('user_id', session.user.id!);
    if (error) throw error;
    const originals = (data || []).flatMap(row => {
        const page = Array.isArray(row.pages) ? row.pages[0] : row.pages;
        return page && ['legacy', 'facebook'].includes(row.grant_source) ? [{ ...page, authoritySource: 'original' as const }] : [];
    });
    const delegated = (data || []).filter(row => row.grant_source === 'delegated');
    if (!delegated.length) return originals;
    try {
        const verified = await verifiedFacebookPages(session);
        return [...originals, ...delegated.flatMap(row => {
            const page = Array.isArray(row.pages) ? row.pages[0] : row.pages;
            return page && verified.some(fb => fb.id === page.fb_page_id) ? [{ ...page, authoritySource: 'facebook' as const }] : [];
        })];
    } catch (error) {
        if (originals.length) return originals;
        throw error;
    }
}

export async function requireTeamPageAdministrator(session: Session, pageIds: string[]) {
    const availablePages = await teamAdministrationPages(session);
    if (!pageIds.length || pageIds.some(id => !availablePages.some(page => page.id === id))) {
        // Delegated access alone never enables account administration. A user
        // with separate Facebook management can still verify that authority.
        return requireFacebookPageManager(session, pageIds);
    }
    const records = availablePages.filter(page => pageIds.includes(page.id));
    const { error } = await getSupabaseAdmin().from('tokko_page_managers').upsert(records.map(page => ({
        user_id: session.user.id, page_id: page.id, facebook_subject: session.user.facebookId,
        authority_source: page.authoritySource, verified_at: new Date().toISOString()
    })), { onConflict: 'user_id,page_id' });
    if (error) throw error;
    return records;
}

export async function verifiedFacebookPages(session: Session) {
    if (!session.user?.id || session.user.provider !== 'facebook' || !session.user.facebookId) {
        throw new AccessError(403, 'Sign in with the Facebook account that manages this Page.');
    }
    const token = await getFacebookServerToken();
    if (!token) throw new AccessError(403, 'Reconnect your Facebook account to manage Page access.');
    try {
        const pages = (await getFacebookPages(token)).filter(hasFacebookManagementTask);
        // Old signed Facebook sessions can safely establish their missing
        // provider binding without merging identities by email.
        await verifyFacebookIdentity(session);
        return pages;
    }
    catch { throw new AccessError(503, 'Facebook management permissions could not be verified. Please retry or reconnect Facebook.'); }
}

export async function requireFacebookPageManager(session: Session, pageIds: string[]) {
    const facebookPages = await verifiedFacebookPages(session);
    const db = getSupabaseAdmin();
    const { data: memberships, error } = await db.from('user_pages')
        .select('page_id,pages(id,fb_page_id,name)').eq('user_id', session.user.id!).in('page_id', pageIds);
    if (error) throw error;
    const records = (memberships || []).map(row => Array.isArray(row.pages) ? row.pages[0] : row.pages).filter(Boolean);
    if (records.length !== new Set(pageIds).size || records.some(page => !pageIds.includes(page.id) || !facebookPages.some(fb => fb.id === page.fb_page_id))) {
        throw new AccessError(403, 'You must be a verified Facebook manager of every selected Page.');
    }
    const { error: proofError } = await db.from('tokko_page_managers').upsert(records.map(page => ({
        user_id: session.user.id, page_id: page.id, facebook_subject: session.user.facebookId, authority_source: 'facebook', verified_at: new Date().toISOString()
    })), { onConflict: 'user_id,page_id' });
    if (proofError) throw proofError;
    return records;
}
