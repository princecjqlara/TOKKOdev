import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createUtilityTemplate, getPageTemplates, UTILITY_TEMPLATES, UtilityTemplate } from '@/lib/facebook';

const SENDABLE_STATUSES = new Set(['APPROVED', 'ACTIVE']);

// POST /api/facebook/templates/submit-all
// Submits all predefined UTILITY_TEMPLATES to a Facebook page for approval.
// Body: { pageId: string }
// Returns the status of each template submission.
export async function POST(request: NextRequest) {
    try {
        const session = await getSessionFromRequest(request);
        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const { pageId } = body as { pageId?: string };

        if (!pageId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        // Verify user has access to page
        const { data: userPage } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        // Get page access token
        const { data: page } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (!page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        // Get existing templates on this page
        let existingTemplates: Record<string, unknown>[] = [];
        try {
            existingTemplates = await getPageTemplates(page.fb_page_id, page.access_token);
        } catch (err) {
            console.warn('[SUBMIT_ALL] Failed to fetch existing templates:', (err as Error).message);
        }

        const existingNames = new Set(
            existingTemplates
                .filter((t) => typeof t.name === 'string')
                .map((t) => (t as { name: string }).name)
        );

        const results: {
            name: string;
            status: string;
            action: 'created' | 'already_exists' | 'error';
            error?: string;
            hasButtons: boolean;
        }[] = [];

        // Submit each predefined template
        for (const template of UTILITY_TEMPLATES) {
            const hasButtons = template.components.some(
                (c) => c.type === 'BUTTONS' && Array.isArray((c as any).buttons) && (c as any).buttons.length > 0
            );

            // Skip if already exists on the page
            if (existingNames.has(template.name)) {
                const existing = existingTemplates.find(
                    (t) => (t as { name: string }).name === template.name
                ) as Record<string, unknown> | undefined;
                const existingStatus =
                    typeof existing?.status === 'string'
                        ? existing.status.toUpperCase()
                        : 'UNKNOWN';

                results.push({
                    name: template.name,
                    status: existingStatus,
                    action: 'already_exists',
                    hasButtons
                });
                continue;
            }

            // Submit for approval
            try {
                // Strip internal-only fields (paramCount) before sending to Facebook
                const { paramCount: _pc, ...templateFields } = template as any;
                const fullTemplate: UtilityTemplate = {
                    ...templateFields,
                    language: 'en_US'
                };

                const created = await createUtilityTemplate(
                    page.fb_page_id,
                    page.access_token,
                    fullTemplate
                );

                const createdStatus =
                    typeof created.status === 'string'
                        ? created.status.toUpperCase()
                        : 'PENDING';

                results.push({
                    name: template.name,
                    status: createdStatus,
                    action: 'created',
                    hasButtons
                });

                console.log(
                    `[SUBMIT_ALL] Template '${template.name}' created with status: ${createdStatus}`
                );
            } catch (err) {
                const errorMessage = (err as Error).message || 'Unknown error';
                results.push({
                    name: template.name,
                    status: 'ERROR',
                    action: 'error',
                    error: errorMessage,
                    hasButtons
                });

                console.error(
                    `[SUBMIT_ALL] Failed to submit template '${template.name}':`,
                    errorMessage
                );
            }
        }

        const approved = results.filter((r) => SENDABLE_STATUSES.has(r.status)).length;
        const pending = results.filter((r) => r.status === 'PENDING').length;
        const errors = results.filter((r) => r.action === 'error').length;

        return NextResponse.json({
            success: true,
            summary: {
                total: results.length,
                approved,
                pending,
                errors,
                alreadyExisted: results.filter((r) => r.action === 'already_exists').length
            },
            results
        });
    } catch (error) {
        console.error('[SUBMIT_ALL] Error:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}
