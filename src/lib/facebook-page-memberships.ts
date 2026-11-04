import type { Session } from 'next-auth';
import type { getSupabaseAdmin } from './supabase';
import { verifiedFacebookPages } from './page-managers';
import { hasFacebookManagementTask } from './facebook-page-capabilities';
import { chunkArray } from './chunking';
import { AccessError } from './account-security';

/** Recover existing shared Pages for a direct Facebook login, without changing
 * Page tokens, connections, sync checkpoints, or another user's assignments. */
export async function restoreFacebookPageMemberships(session: Session, db: ReturnType<typeof getSupabaseAdmin>) {
    if (!session.user?.id || session.user.provider !== 'facebook') return 0;
    const pages = await verifiedFacebookPages(session);
    const managed = pages.filter(hasFacebookManagementTask);
    if (managed.length && !managed.some(page => page.access_token)) throw new AccessError(409,
        'Facebook recognizes your Page management access, but Tokko needs its Page permissions refreshed. Open Connect Pages, refresh Facebook permissions, and select the Page.');
    const facebookIds = [...new Set(managed.filter(page => page.access_token)
        .map(page => page.id).filter(Boolean))];
    let restored = 0;
    for (const batch of chunkArray(facebookIds, 100)) {
        const { data: existing, error } = await db.from('pages').select('id,fb_page_id').in('fb_page_id', batch);
        if (error) throw error;
        // Scope results again so only the server-verified Facebook IDs can grant access.
        const matches = (existing || []).filter(page => batch.includes(page.fb_page_id));
        if (!matches.length) continue;
        const { error: grantError } = await db.from('user_pages').upsert(matches.map(page => ({
            user_id: session.user.id, page_id: page.id, grant_source: 'facebook'
        })), { onConflict: 'user_id,page_id', ignoreDuplicates: true });
        if (grantError) throw grantError;
        restored += matches.length;
    }
    return restored;
}
