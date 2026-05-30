import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { subscribePageToAppWebhook, getPageTemplates, createUtilityTemplate } from '@/lib/facebook';
import { UTILITY_TEMPLATES } from '@/lib/facebook-templates';
import type { UtilityTemplate } from '@/lib/facebook';

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
        const { fbPageId, name, accessToken } = body;

        if (!fbPageId || !name || !accessToken) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'Missing required fields: fbPageId, name, accessToken' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Check if page already exists
        const { data: existingPage } = await supabase
            .from('pages')
            .select('id')
            .eq('fb_page_id', fbPageId)
            .single();

        let pageId: string;

        if (existingPage) {
            // Update existing page with new access token
            const { error: updateError } = await supabase
                .from('pages')
                .update({
                    access_token: accessToken,
                    name,
                    updated_at: new Date().toISOString()
                })
                .eq('id', existingPage.id);

            if (updateError) throw updateError;
            pageId = existingPage.id;
        } else {
            // Create new page
            const { data: newPage, error: pageError } = await supabase
                .from('pages')
                .insert({
                    fb_page_id: fbPageId,
                    name,
                    access_token: accessToken
                })
                .select('id')
                .single();

            if (pageError) throw pageError;
            pageId = newPage.id;
        }

        // Link user to page
        const { error: linkError } = await supabase
            .from('user_pages')
            .upsert({
                user_id: userId,
                page_id: pageId
            }, {
                onConflict: 'user_id,page_id'
            });

        if (linkError) throw linkError;

        let warning: WebhookRefreshWarning | null = null;
        try {
            await subscribePageToAppWebhook(fbPageId, accessToken, ['messages', 'messaging_postbacks']);
        } catch (subscriptionError) {
            console.error('🔴 Failed to subscribe page to webhook events:', subscriptionError);
            warning = {
                code: 'WEBHOOK_SUBSCRIPTION_FAILED',
                message: `Page token was refreshed, but webhook subscription could not be refreshed. ${(subscriptionError as Error).message}`
            };
        }

        // Fire-and-forget: auto-submit all UTILITY_TEMPLATES to the newly connected page
        autoSubmitTemplates(fbPageId, accessToken, name).catch((err) =>
            console.error(`[AUTO_SUBMIT] Background template submission failed for page "${name}":`, err)
        );

        return NextResponse.json({
            success: true,
            pageId,
            warning,
            message: warning?.message || 'Page connected successfully'
        });
    } catch (error) {
        console.error('Error connecting Facebook page:', error);
        return NextResponse.json(
            { error: 'Failed to connect page', message: (error as Error).message },
            { status: 500 }
        );
    }
}

// ---------------------------------------------------------------------------
//  Auto-submit all UTILITY_TEMPLATES to a Facebook page (background task)
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

    for (const template of UTILITY_TEMPLATES) {
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
