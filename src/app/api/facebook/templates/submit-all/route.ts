import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromRequest } from '@/lib/get-session';
import { getSupabaseAdmin } from '@/lib/supabase';
import { getPageTemplates, UTILITY_TEMPLATES, UtilityTemplate } from '@/lib/facebook';
import {
    DEFAULT_MEDIA_TEMPLATE_SAMPLE_URL,
    DEFAULT_VIDEO_TEMPLATE_SAMPLE_URL,
    buildMediaTemplateVariant,
    getBaseTemplateName,
    getMediaTemplateName
} from '@/lib/facebook-templates';
import type { TemplateMediaType } from '@/lib/facebook-templates';

const SENDABLE_STATUSES = new Set(['APPROVED', 'ACTIVE']);
const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const DEFAULT_BATCH_LIMIT = 10;

function getFileNameFromUrl(url: string) {
    try {
        const parsedUrl = new URL(url);
        const lastSegment = parsedUrl.pathname.split('/').filter(Boolean).pop();
        return lastSegment && lastSegment.includes('.') ? lastSegment : 'template-media.png';
    } catch {
        return 'template-media.png';
    }
}

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

function normalizeMediaType(value: unknown): TemplateMediaType {
    return value === 'video' ? 'video' : 'image';
}

async function createResumableUploadHandle(pageAccessToken: string, sampleMediaUrl: string) {
    const appId = process.env.FACEBOOK_CLIENT_ID;
    if (!appId) {
        throw new Error('FACEBOOK_CLIENT_ID is required to upload media template samples.');
    }

    const mediaResponse = await fetch(sampleMediaUrl);
    if (!mediaResponse.ok) {
        throw new Error(`Failed to fetch media template sample (HTTP ${mediaResponse.status}).`);
    }

    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
    const fileType = mediaResponse.headers.get('content-type') || 'application/octet-stream';
    const fileName = getFileNameFromUrl(sampleMediaUrl);

    const sessionResponse = await fetch(
        `${FACEBOOK_GRAPH_URL}/${appId}/uploads?` +
        new URLSearchParams({
            file_name: fileName,
            file_length: String(mediaBuffer.length),
            file_type: fileType
        }).toString(),
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${pageAccessToken}`
            }
        }
    );
    const sessionData = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || typeof sessionData.id !== 'string') {
        throw new Error(sessionData.error?.message || `Failed to create media upload session (HTTP ${sessionResponse.status}).`);
    }

    const uploadResponse = await fetch(`${FACEBOOK_GRAPH_URL}/${sessionData.id}`, {
        method: 'POST',
        headers: {
            Authorization: `OAuth ${pageAccessToken}`,
            file_offset: '0',
            'Content-Type': 'application/octet-stream'
        },
        body: mediaBuffer
    });
    const uploadData = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || typeof uploadData.h !== 'string') {
        throw new Error(uploadData.error?.message || `Failed to upload media template sample (HTTP ${uploadResponse.status}).`);
    }

    return uploadData.h as string;
}

function hasTemplateButtons(template: UtilityTemplate | Omit<UtilityTemplate, 'language'>) {
    return template.components.some(
        (c) => c.type === 'BUTTONS' && Array.isArray((c as any).buttons) && (c as any).buttons.length > 0
    );
}

function hasMediaHeader(template: UtilityTemplate | Omit<UtilityTemplate, 'language'>) {
    return template.components.some(
        (c) => c.type === 'HEADER' && ['IMAGE', 'VIDEO'].includes(String((c as any).format || '').toUpperCase())
    );
}

function getMediaHeaderType(template: UtilityTemplate | Omit<UtilityTemplate, 'language'>): TemplateMediaType | null {
    const header = template.components.find(
        (c) => c.type === 'HEADER' && ['IMAGE', 'VIDEO'].includes(String((c as any).format || '').toUpperCase())
    );
    const format = String((header as any)?.format || '').toUpperCase();
    if (format === 'VIDEO') return 'video';
    if (format === 'IMAGE') return 'image';
    return null;
}

function getStoredMediaHeaderType(template: Record<string, unknown>): TemplateMediaType | null {
    const components = Array.isArray(template.components)
        ? template.components as Array<Record<string, unknown>>
        : [];
    const header = components.find((component) => (
        String(component.type || '').toUpperCase() === 'HEADER' &&
        ['IMAGE', 'VIDEO'].includes(String(component.format || '').toUpperCase())
    ));
    const format = String(header?.format || '').toUpperCase();
    return format === 'VIDEO' ? 'video' : format === 'IMAGE' ? 'image' : null;
}

function resolveMediaVariantName(
    baseTemplateName: string,
    mediaType: TemplateMediaType,
    existingTemplates: Record<string, unknown>[]
): string {
    const matchingMediaTemplate = existingTemplates.find((template) => (
        typeof template.name === 'string' &&
        getBaseTemplateName(template.name) === baseTemplateName &&
        getStoredMediaHeaderType(template) === mediaType &&
        String(template.status || '').toUpperCase() !== 'REJECTED'
    ));

    if (typeof matchingMediaTemplate?.name === 'string') {
        return matchingMediaTemplate.name;
    }

    const existingNames = new Set(
        existingTemplates
            .map((template) => typeof template.name === 'string' ? template.name : null)
            .filter((name): name is string => Boolean(name))
    );
    let version = 1;
    let candidateName = getMediaTemplateName(baseTemplateName, mediaType, version);
    while (existingNames.has(candidateName)) {
        version += 1;
        candidateName = getMediaTemplateName(baseTemplateName, mediaType, version);
    }
    return candidateName;
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
        const { pageId, limit, templateNames, mediaVariant, sampleImageUrl, sampleMediaUrl } = body as {
            pageId?: string;
            limit?: number;
            templateNames?: string[];
            mediaVariant?: boolean;
            mediaType?: TemplateMediaType;
            sampleImageUrl?: string;
            sampleMediaUrl?: string;
        };
        const mediaType = normalizeMediaType((body as { mediaType?: unknown }).mediaType);

        if (!pageId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId is required' },
                { status: 400 }
            );
        }

        if (mediaVariant && mediaType === 'video') {
            return NextResponse.json(
                {
                    error: 'Bad Request',
                    message: 'Facebook Messenger utility templates do not support video media components. Use a utility message followed by a direct Messenger video attachment.'
                },
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
        const sourceTemplates = candidateNameSet
            ? UTILITY_TEMPLATES.filter(
                (template) =>
                    candidateNameSet.has(template.name) ||
                    candidateNameSet.has(getMediaTemplateName(template.name, mediaType))
            )
            : UTILITY_TEMPLATES;
        const defaultSampleUrl = mediaType === 'video'
            ? DEFAULT_VIDEO_TEMPLATE_SAMPLE_URL
            : DEFAULT_MEDIA_TEMPLATE_SAMPLE_URL;
        const mediaSample =
            typeof sampleMediaUrl === 'string' && sampleMediaUrl.trim()
                ? sampleMediaUrl.trim()
                : typeof sampleImageUrl === 'string' && sampleImageUrl.trim()
                    ? sampleImageUrl.trim()
                    : defaultSampleUrl;
        const mediaSampleHandle = mediaVariant
            ? await createResumableUploadHandle(page.access_token, mediaSample)
            : null;
        const candidateTemplates = mediaVariant
            ? sourceTemplates.map((template) => ({
                ...buildMediaTemplateVariant(template, mediaSampleHandle || mediaSample, mediaType),
                name: resolveMediaVariantName(template.name, mediaType, existingTemplates)
            }))
            : sourceTemplates;

        const results: {
            name: string;
            status: string;
            action: 'created' | 'already_exists' | 'error';
            error?: string;
            hasButtons: boolean;
            hasMediaHeader: boolean;
            mediaHeaderType: TemplateMediaType | null;
        }[] = [];

        const missingTemplates = candidateTemplates.filter((template) => !existingNames.has(template.name));
        const batchLimit =
            typeof limit === 'number' && Number.isFinite(limit)
                ? Math.max(1, Math.min(25, Math.floor(limit)))
                : DEFAULT_BATCH_LIMIT;
        const templatesToCreate = missingTemplates.slice(0, batchLimit);

        // Report existing templates immediately so callers still get useful status counts.
        for (const template of candidateTemplates.filter((template) => existingNames.has(template.name))) {
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
                hasButtons: hasTemplateButtons(template),
                hasMediaHeader: existing ? getStoredMediaHeaderType(existing) !== null : false,
                mediaHeaderType: existing ? getStoredMediaHeaderType(existing) : null
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
                results.push({
                    ...created,
                    hasButtons: template ? hasTemplateButtons(template) : false,
                    hasMediaHeader: template ? hasMediaHeader(template) : false,
                    mediaHeaderType: template ? getMediaHeaderType(template) : null
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
                results.push({
                    name: template.name,
                    status: 'ERROR',
                    action: 'error',
                    error: errorMessage,
                    hasButtons: hasTemplateButtons(template),
                    hasMediaHeader: hasMediaHeader(template),
                    mediaHeaderType: getMediaHeaderType(template)
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
