import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';
import { createUtilityTemplate, getPageTemplates, UTILITY_TEMPLATES, UtilityTemplate } from '@/lib/facebook';

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
        const { pageId, language = 'en', templates: customTemplates } = body;

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

        const templatesToCreate = customTemplates || UTILITY_TEMPLATES;
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
