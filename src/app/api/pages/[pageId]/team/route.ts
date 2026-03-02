import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

interface TeamMember {
    id: string;
    name: string | null;
    email: string | null;
}

// GET /api/pages/[pageId]/team - Get page team members
export async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);

        if (!session?.user?.id) {
            return NextResponse.json(
                { error: 'Unauthorized', message: 'Please sign in' },
                { status: 401 }
            );
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();

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

        const { data: members, error } = await supabase
            .from('user_pages')
            .select('user_id, users(id, name, email)')
            .eq('page_id', pageId);

        if (error) throw error;

        const normalizedMembers: TeamMember[] = (members || [])
            .map((member) => {
                const user = member.users as { id?: string; name?: string | null; email?: string | null } | null;

                if (!user?.id) {
                    return null;
                }

                return {
                    id: user.id,
                    name: user.name || null,
                    email: user.email || null
                };
            })
            .filter((member): member is TeamMember => member !== null);

        return NextResponse.json({
            members: normalizedMembers,
            total: normalizedMembers.length
        });
    } catch (error) {
        console.error('Error fetching page team members:', error);
        return NextResponse.json(
            { error: 'Failed to fetch page team', message: (error as Error).message },
            { status: 500 }
        );
    }
}
