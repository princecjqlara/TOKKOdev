import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createUtilityTemplate, getPageTemplates, UTILITY_TEMPLATES, UtilityTemplate } from '@/lib/facebook';

type BodyOnlyTemplateInput = string | { name?: string; text: string; headline?: string };

function sanitizeFooterText(rawText: string): string {
    return rawText.trim().slice(0, 60);
}

function sanitizeTemplateName(rawName: string): string {
    const normalized = rawName
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_+/g, '_');

    return (normalized || 'account_custom_notice').slice(0, 64);
}

function buildBodyOnlyTemplates(
    templateInputs: BodyOnlyTemplateInput[],
    namePrefix: string,
    defaultHeadlineBelow?: string
): Omit<UtilityTemplate, 'language'>[] {
    const usedNames = new Set<string>();

    const templates: Omit<UtilityTemplate, 'language'>[] = [];

    templateInputs.forEach((entry, index) => {
        const text = typeof entry === 'string' ? entry.trim() : entry?.text?.trim() || '';
        if (!text) {
            return;
        }

        const preferredName =
            typeof entry === 'string'
                ? `${namePrefix}_${index + 1}`
                : entry.name || `${namePrefix}_${index + 1}`;

        const baseName = sanitizeTemplateName(preferredName);
        let finalName = baseName;
        let suffix = 2;

        while (usedNames.has(finalName)) {
            const candidate = `${baseName}_${suffix}`;
            finalName = sanitizeTemplateName(candidate);
            suffix += 1;
        }

        usedNames.add(finalName);

        const entryHeadline =
            typeof entry === 'string'
                ? defaultHeadlineBelow
                : entry.headline?.trim() || defaultHeadlineBelow;

        const components: UtilityTemplate['components'] = [
            {
                type: 'BODY' as const,
                text: '{{1}}',
                example: {
                    body_text: [[text]]
                }
            }
        ];

        if (entryHeadline) {
            const footerText = sanitizeFooterText(entryHeadline);
            if (footerText) {
                components.push({
                    type: 'FOOTER' as const,
                    text: footerText
                });
            }
        }

        templates.push({
            name: finalName,
            category: 'UTILITY' as const,
            components
        });
    });

    return templates;
}

export async function GET(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { searchParams } = new URL(request.url);
        const pageId = searchParams.get('pageId');

        if (!pageId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        const { data: userPage, error: userPageError } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (userPageError || !userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const { data: page, error: pageError } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (pageError || !page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        const templates = await getPageTemplates(page.fb_page_id, page.access_token);

        return NextResponse.json({ templates });
    } catch (error) {
        console.error('Error fetching templates:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}

export async function POST(request: NextRequest) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const body = await request.json();
        const {
            pageId,
            language = 'en_US',
            templates: customTemplates,
            bodyTemplates,
            customTexts,
            namePrefix = 'account_custom_notice',
            headlineText
        } = body;

        const normalizedHeadlineText =
            typeof headlineText === 'string' ? headlineText.trim() : '';
        const headlineBelowText = normalizedHeadlineText || undefined;

        if (!pageId) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'pageId is required' },
                { status: 400 }
            );
        }

        const supabase = getSupabaseAdmin();

        const { data: userPage, error: userPageError } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (userPageError || !userPage) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page' },
                { status: 403 }
            );
        }

        const { data: page, error: pageError } = await supabase
            .from('pages')
            .select('fb_page_id, access_token')
            .eq('id', pageId)
            .single();

        if (pageError || !page) {
            return NextResponse.json(
                { error: 'Not Found', message: 'Page not found' },
                { status: 404 }
            );
        }

        let templatesToCreate: Omit<UtilityTemplate, 'language'>[] = [];

        if (Array.isArray(bodyTemplates) && bodyTemplates.length > 0) {
            templatesToCreate = buildBodyOnlyTemplates(
                bodyTemplates as BodyOnlyTemplateInput[],
                namePrefix,
                headlineBelowText
            );
        } else if (Array.isArray(customTexts) && customTexts.length > 0) {
            templatesToCreate = buildBodyOnlyTemplates(
                customTexts as BodyOnlyTemplateInput[],
                namePrefix,
                headlineBelowText
            );
        } else if (Array.isArray(customTemplates) && customTemplates.length > 0) {
            templatesToCreate = customTemplates;
        } else {
            templatesToCreate = UTILITY_TEMPLATES;
        }

        if (templatesToCreate.length === 0) {
            return NextResponse.json(
                { error: 'Bad Request', message: 'No valid templates to create' },
                { status: 400 }
            );
        }

        const results: Array<{ name: string; success: boolean; id?: string; status?: string; error?: string }> = [];

        for (const template of templatesToCreate) {
            try {
                const fullTemplate: UtilityTemplate = {
                    ...template,
                    language
                };

                const result = await createUtilityTemplate(
                    page.fb_page_id,
                    page.access_token,
                    fullTemplate
                );

                results.push({
                    name: template.name,
                    success: true,
                    id: result.id,
                    status: result.status
                });
            } catch (error) {
                results.push({
                    name: template.name,
                    success: false,
                    error: (error as Error).message
                });
            }
        }

        const successCount = results.filter(r => r.success).length;
        const failureCount = results.filter(r => !r.success).length;

        return NextResponse.json({
            message: `Created ${successCount} templates, ${failureCount} failed`,
            results
        });
    } catch (error) {
        console.error('Error creating templates:', error);
        return NextResponse.json(
            { error: 'Internal Server Error', message: (error as Error).message },
            { status: 500 }
        );
    }
}
