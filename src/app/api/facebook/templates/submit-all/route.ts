import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageTemplates, UTILITY_TEMPLATES, UtilityTemplate } from '@/lib/facebook';

const SENDABLE_STATUSES = new Set(['APPROVED', 'ACTIVE']);
const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const DEFAULT_BATCH_LIMIT = 10;

function isFacebookTokenError(message: string) {
    return (
        message.includes('code=190') ||
        message.toLowerCase().includes('validating access token') ||
        message.toLowerCase().includes('access token')
    );
}

function getTemplateBody(template: UtilityTemplate) {
    return new URLSearchParams({
        name: template.name,
        category: template.category,
        language: template.language,
        components: JSON.stringify(template.components)
    }).toString();
}

function parseBatchEntryBody(body: unknown): Record<string, any> {
    if (typeof body !== 'string' || body.length === 0) {
        return {};
    }

    try {
        return JSON.parse(body);
    } catch {
        return { error: { message: body } };
    }
}

async function createUtilityTemplatesBatch(
    pageId: string,
    pageAccessToken: string,
    templates: UtilityTemplate[]
): Promise<Array<{ name: string; status: string; action: 'created' | 'already_exists' | 'error'; error?: string }>> {
    if (templates.length === 0) {
        return [];
    }

    const batch = templates.map((template) => ({
        method: 'POST',
        relative_url: `${pageId}/message_templates`,
        body: getTemplateBody(template)
    }));

    const response = await fetch(`${FACEBOOK_GRAPH_URL}/`, {
        method: 'POST',
        body: new URLSearchParams({
            access_token: pageAccessToken,
            batch: JSON.stringify(batch),
            include_headers: 'false'
        })
    });

    const responseBody = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = responseBody.error?.message || `HTTP ${response.status}: ${response.statusText}`;
        throw new Error(message);
    }

    if (!Array.isArray(responseBody)) {
        throw new Error('Facebook returned an unexpected batch response');
    }

    return responseBody.map((entry, index) => {
        const template = templates[index];
        const body = parseBatchEntryBody(entry?.body);

        if (entry?.code >= 200 && entry?.code < 300) {
            return {
                name: template.name,
                status: typeof body.status === 'string' ? body.status.toUpperCase() : 'PENDING',
                action: 'created' as const
            };
        }

        const errorMessage = body.error?.message || `HTTP ${entry?.code || 'unknown'}`;
        const alreadyExists =
            body.error?.error_subcode === 2018423 ||
            body.error?.error_user_msg?.includes('already exists') ||
            errorMessage.includes('already exists');

        if (alreadyExists) {
            return {
                name: template.name,
                status: 'ALREADY_EXISTS',
                action: 'already_exists' as const
            };
        }

        return {
            name: template.name,
            status: 'ERROR',
            action: 'error' as const,
            error: errorMessage
        };
    });
}

// POST /api/facebook/templates/submit-all
// Submits all predefined UTILITY_TEMPLATES to a Facebook page for approval.
// Body: { pageId: string, limit?: number, templateNames?: string[] }
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
        const { pageId, limit, templateNames } = body as {
            pageId?: string;
            limit?: number;
            templateNames?: string[];
        };

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
            const message = (err as Error).message;
            console.warn('[SUBMIT_ALL] Failed to fetch existing templates:', message);

            if (isFacebookTokenError(message)) {
                return NextResponse.json(
                    {
                        error: 'Facebook Token Invalid',
                        message: 'Facebook rejected this page token. Reconnect this page to refresh permissions before submitting templates.',
                        detail: message
                    },
                    { status: 502 }
                );
            }
        }

        const existingNames = new Set(
            existingTemplates
                .filter((t) => typeof t.name === 'string')
                .map((t) => (t as { name: string }).name)
        );

        const candidateNameSet =
            Array.isArray(templateNames) && templateNames.length > 0
                ? new Set(templateNames.filter((name) => typeof name === 'string'))
                : null;
        const candidateTemplates = candidateNameSet
            ? UTILITY_TEMPLATES.filter((template) => candidateNameSet.has(template.name))
            : UTILITY_TEMPLATES;

        const results: {
            name: string;
            status: string;
            action: 'created' | 'already_exists' | 'error';
            error?: string;
            hasButtons: boolean;
        }[] = [];

        const missingTemplates = candidateTemplates.filter((template) => !existingNames.has(template.name));
        const batchLimit =
            typeof limit === 'number' && Number.isFinite(limit)
                ? Math.max(1, Math.min(25, Math.floor(limit)))
                : DEFAULT_BATCH_LIMIT;
        const templatesToCreate = missingTemplates.slice(0, batchLimit);

        // Report existing templates immediately so callers still get useful status counts.
        for (const template of candidateTemplates.filter((template) => existingNames.has(template.name))) {
            const hasButtons = template.components.some(
                (c) => c.type === 'BUTTONS' && Array.isArray((c as any).buttons) && (c as any).buttons.length > 0
            );
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
        }

        try {
            const fullTemplates: UtilityTemplate[] = templatesToCreate.map((template) => {
                const { paramCount: _pc, ...templateFields } = template as any;
                return {
                    ...templateFields,
                    language: 'en_US'
                };
            });
            const createdResults = await createUtilityTemplatesBatch(
                page.fb_page_id,
                page.access_token,
                fullTemplates
            );

            for (const created of createdResults) {
                const template = templatesToCreate.find((t) => t.name === created.name);
                const hasButtons = !!template?.components.some(
                    (c) => c.type === 'BUTTONS' && Array.isArray((c as any).buttons) && (c as any).buttons.length > 0
                );
                results.push({
                    ...created,
                    hasButtons
                });
            }
        } catch (err) {
            const errorMessage = (err as Error).message || 'Unknown error';
            if (isFacebookTokenError(errorMessage)) {
                return NextResponse.json(
                    {
                        error: 'Facebook Token Invalid',
                        message: 'Facebook rejected this page token. Reconnect this page to refresh permissions before submitting templates.',
                        detail: errorMessage
                    },
                    { status: 502 }
                );
            }

            console.error('[SUBMIT_ALL] Failed to submit template batch:', errorMessage);
            for (const template of templatesToCreate) {
                const hasButtons = template.components.some(
                    (c) => c.type === 'BUTTONS' && Array.isArray((c as any).buttons) && (c as any).buttons.length > 0
                );
                results.push({
                    name: template.name,
                    status: 'ERROR',
                    action: 'error',
                    error: errorMessage,
                    hasButtons
                });
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
                alreadyExisted: results.filter((r) => r.action === 'already_exists').length,
                submittedThisRequest: templatesToCreate.length,
                remaining: Math.max(0, missingTemplates.length - templatesToCreate.length),
                hasMore: missingTemplates.length > templatesToCreate.length
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
