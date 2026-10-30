import { getFacebookPages } from './facebook';
import { hasFacebookManagementTask } from './page-managers';
import { getSupabaseAdmin } from './supabase';

/** Recover email-only legacy rows only after independent proof of every Page. */
export async function recoverLegacyFacebookLogin(identity: {
    subject: string; email: string | null | undefined; name: string | null | undefined;
    image: string | null | undefined; accessToken: string | undefined;
}) {
    if (!identity.accessToken) return null;
    // Earlier Facebook logins without email used a reserved, subject-derived
    // address. The authenticated subject itself proves that legacy identity.
    const pages = identity.email ? (await getFacebookPages(identity.accessToken)).filter(hasFacebookManagementTask) : [];
    if (identity.email && !pages.length) return null;
    const { data, error } = await getSupabaseAdmin().rpc('tokko_recover_legacy_facebook_login', {
        p_subject: identity.subject, p_email: identity.email || `fb_${identity.subject}@facebook.local`, p_name: identity.name || null,
        p_image: identity.image || null, p_facebook_pages: pages.map(page => page.id)
    });
    if (error) throw new Error('Facebook account recovery is temporarily unavailable.');
    const row = Array.isArray(data) ? data[0] : data;
    return row?.user_id ? row : null;
}
