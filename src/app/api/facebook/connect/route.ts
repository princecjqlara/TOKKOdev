import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { subscribePageToAppWebhook, getPageTemplates, createUtilityTemplate } from '@/lib/facebook';
import { UTILITY_TEMPLATES } from '@/lib/facebook-templates';
import { selectTemplateStarterSet } from '@/lib/facebook-template-order';
import type { UtilityTemplate } from '@/lib/facebook';
import { verifiedFacebookPages } from '@/lib/page-managers';
import { AccessError } from '@/lib/account-security';
import { hasFacebookManagementTask, hasFacebookMessagingTask } from '@/lib/facebook-page-capabilities';

type WebhookRefreshWarning = {
    code: 'WEBHOOK_SUBSCRIPTION_FAILED';
    message: string;
};

// POST /api/facebook/connect - Connect a Facebook page
export async function POST(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);

        if (!session) {
            console.error('🔴 No session found in /api/facebook/connect');
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const userId = session.user?.id;
        if (!userId) {
            console.error('🔴 No user ID in session:', session.user);
            return NextResponse.json(
                { error: 'Unauthorized', message: 'User not found. Please sign in again.' },
                { status: 401 }
            );
        }

        console.log('🔵 Session found:', { 
            email: session.user?.email, 
            userId 
        });

        const body = await request.json();
        const fbPageId = typeof body?.fbPageId === 'string' ? body.fbPageId.trim() : '';
        if (!fbPageId) throw new AccessError(400, 'Choose a Facebook Page.');
        const refreshConnection = body?.refreshConnection === true;
        const supabase = getSupabaseAdmin();

        // A Tokko invitation already authorizes use of this shared connection.
        // It does not require a second Facebook login or change the owner token.
        const { data: membership, error: membershipError } = await supabase.from('user_pages')
            .select('page_id,pages!inner(id,fb_page_id)').eq('user_id', userId)
            .eq('pages.fb_page_id', fbPageId).maybeSingle();
        if (membershipError) throw membershipError;
        if (membership && !refreshConnection) {
            return NextResponse.json({ success: true, pageId: membership.page_id, needsInitialSync: false,
                reusedConnection: true, warning: null, message: 'This Page is already assigned to you. Open Contacts to use its existing contacts and tags.' });
        }

        const facebookPage = (await verifiedFacebookPages(session, 'messaging')).find(page => page.id === fbPageId);
        if (!facebookPage || !hasFacebookMessagingTask(facebookPage)) throw new AccessError(403, membership
            ? 'This Page is already assigned to you. Open Contacts without reconnecting, or ask its Facebook Page administrator to refresh the shared connection.'
            : 'Facebook has not granted this account messaging access to this Page. Accept the Page invitation on Facebook, then refresh permissions and select the Page. A Facebook app tester invitation alone does not grant Page access.');
        const canManage = hasFacebookManagementTask(facebookPage);
        if (refreshConnection && !canManage) throw new AccessError(403,
            'Your Facebook messaging access lets you use this Page in Tokko. Open Contacts without reconnecting. Refreshing its shared connection requires Facebook Page management access.');
        if (!facebookPage.access_token) throw new AccessError(409,
            'Facebook recognizes your Page access but did not provide a Page connection token. Refresh Facebook permissions, select this Page, and approve Tokko’s requested Page permissions.');
        const name = facebookPage.name;
        const accessToken = facebookPage.access_token;

        if (!fbPageId || !name || !accessToken) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields: fbPageId, name, accessToken' },
                { status: 400 }
            );
        }

        // Messaging staff can join an existing shared Page without replacing its
        // connection or starting another import. Tokko parent identity controls
        // team administration. New Page creation preserves concurrent connects.
        if (!canManage) {
            const findSharedPage = () => supabase.from('pages').select('id,last_synced_at')
                .eq('fb_page_id', fbPageId).maybeSingle();
            let { data: sharedPage, error: sharedError } = await findSharedPage();
            if (sharedError) throw sharedError;
            let created = false;
            if (!sharedPage) {
                const result = await supabase.from('pages').upsert({ fb_page_id: fbPageId, name,
                    access_token: accessToken }, { onConflict: 'fb_page_id', ignoreDuplicates: true })
                    .select('id,last_synced_at').maybeSingle();
                if (result.error) throw result.error;
                sharedPage = result.data;
                created = !!sharedPage;
                if (!sharedPage) {
                    const resolved = await findSharedPage();
                    if (resolved.error) throw resolved.error;
                    sharedPage = resolved.data;
                }
            }
            if (!sharedPage) throw new Error('Could not resolve the shared Facebook Page');
            const { error: grantError } = await supabase.from('user_pages').upsert({
                user_id: userId, page_id: sharedPage.id, grant_source: 'facebook_messaging'
            }, { onConflict: 'user_id,page_id', ignoreDuplicates: true });
            if (grantError) throw grantError;
            let warning: WebhookRefreshWarning | null = null;
            if (created) {
                try {
                    await subscribePageToAppWebhook(fbPageId, accessToken, ['messages', 'messaging_postbacks', 'message_echoes']);
                } catch {
                    warning = { code: 'WEBHOOK_SUBSCRIPTION_FAILED',
                        message: 'Page connected. Facebook did not allow webhook setup with these permissions. A Facebook Page manager can reconnect to enable live updates.' };
                }
            }
            return NextResponse.json({ success: true, pageId: sharedPage.id,
                needsInitialSync: created, reusedConnection: !created, warning,
                message: warning?.message || 'Facebook Page connected. Open Contacts to use its shared contacts and tags.' });
        }

        // One shared Page row even when two managers connect concurrently.
        // Preserve its contacts, tags, settings and existing sync checkpoint.
        const { data: page, error: pageError } = await supabase.from('pages').upsert({
            fb_page_id: fbPageId, name, access_token: accessToken, updated_at: new Date().toISOString()
        }, { onConflict: 'fb_page_id' }).select('id,last_synced_at').single();
        if (pageError) throw pageError;
        if (!page) throw new Error('Could not resolve the shared Facebook Page');
        const pageId = page.id;

        // Link user to page
        const { error: linkError } = await supabase
            .from('user_pages')
            .upsert({
                user_id: userId,
                page_id: pageId,
                grant_source: 'facebook'
            }, {
                onConflict: 'user_id,page_id'
            });

        if (linkError) throw linkError;

        let needsInitialSync = !page.last_synced_at;
        if (needsInitialSync) {
            const existing = await supabase.from('contacts').select('id').eq('page_id', pageId).limit(1).maybeSingle();
            if (existing.error) throw existing.error;
            needsInitialSync = !existing.data;
        }

        let warning: WebhookRefreshWarning | null = null;
        try {
            await subscribePageToAppWebhook(fbPageId, accessToken, ['messages', 'messaging_postbacks', 'message_echoes']);
        } catch (subscriptionError) {
            console.error('🔴 Failed to subscribe page to webhook events:', subscriptionError);
            warning = {
                code: 'WEBHOOK_SUBSCRIPTION_FAILED',
                message: `Page token was refreshed, but webhook subscription could not be refreshed. ${(subscriptionError as Error).message}`
            };
        }

        // Seed a bounded set of templates on the newly connected page.
        autoSubmitTemplates(fbPageId, accessToken, name).catch((err) =>
            console.error(`[AUTO_SUBMIT] Background template submission failed for page "${name}":`, err)
        );

        return NextResponse.json({
            success: true,
            pageId,
            needsInitialSync,
            warning,
            message: warning?.message || 'Page connected successfully'
        });
    } catch (error) {
        if (error instanceof AccessError) return NextResponse.json({ message: error.message,
            ...(error.status === 409 ? { code: 'FACEBOOK_REAUTH_REQUIRED', requiresReauth: true } : {}) }, { status: error.status });
        console.error('Error connecting Facebook page:', error);
        return NextResponse.json(
            { error: 'Failed to connect page', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// ---------------------------------------------------------------------------
//  Submit a small starter set to a Facebook page (background task).
//  Skips templates that already exist on the page.
// ---------------------------------------------------------------------------
async function autoSubmitTemplates(fbPageId: string, accessToken: string, pageName: string) {
    console.log(`[AUTO_SUBMIT] Starting template submission for page "${pageName}" (${fbPageId})...`);

    let existingNames: Set<string>;
    try {
        const existingTemplates = await getPageTemplates(fbPageId, accessToken);
        existingNames = new Set(
            existingTemplates
                .filter((t: Record<string, unknown>) => typeof t.name === 'string')
                .map((t: Record<string, unknown>) => t.name as string)
        );
    } catch (err) {
        console.warn(`[AUTO_SUBMIT] Could not fetch existing templates for "${pageName}":`, (err as Error).message);
        existingNames = new Set();
    }

    let submitted = 0;
    let skipped = 0;
    let failed = 0;

    for (const template of selectTemplateStarterSet(UTILITY_TEMPLATES)) {
        if (existingNames.has(template.name)) {
            skipped++;
            continue;
        }

        try {
            const { paramCount: _pc, ...templateFields } = template as any;
            const fullTemplate: UtilityTemplate = { ...templateFields, language: 'en_US' };
            await createUtilityTemplate(fbPageId, accessToken, fullTemplate);
            submitted++;
        } catch (err) {
            const msg = (err as Error).message || '';
            if (msg.includes('2018423') || msg.includes('already exists')) {
                skipped++;
            } else {
                failed++;
                console.warn(`[AUTO_SUBMIT] Template "${template.name}" failed for "${pageName}":`, msg);
            }
        }
    }

    console.log(
        `[AUTO_SUBMIT] Done for "${pageName}": ${submitted} submitted, ${skipped} already existed, ${failed} failed`
    );
}
