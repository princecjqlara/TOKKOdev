import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSupabaseAdmin } from '@/lib/supabase';

type ActivityActor = {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
};

type HistoryItem = {
    id: string;
    sourceId: string;
    source: 'campaign' | 'audit';
    pageId: string;
    kind: 'bulk_message' | 'bulk_tags' | 'bulk_delete' | 'other';
    actionType: string;
    title: string;
    status: string;
    actor: ActivityActor | null;
    targetCount: number;
    successCount: number;
    failureCount: number;
    pendingCount: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    scheduledAt: string | null;
    details: Record<string, unknown>;
};

function positiveInteger(value: string | null, fallback: number, max: number) {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function isMissingHistoryTable(error: { code?: string; message?: string } | null) {
    if (!error) return false;
    return error.code === '42P01' || error.code === 'PGRST205' || /page_activity_history/i.test(error.message || '');
}

function campaignStatus(campaign: Record<string, any>) {
    const sent = Number(campaign.sent_count || 0);
    const failed = Number(campaign.failed_count || 0);
    if (campaign.status === 'completed' && failed > 0) return sent > 0 ? 'partial' : 'failed';
    if (campaign.status === 'draft') return 'pending';
    return campaign.status || 'pending';
}

function auditKind(actionType: string): HistoryItem['kind'] {
    if (actionType.includes('message')) return 'bulk_message';
    if (actionType.includes('tag')) return 'bulk_tags';
    if (actionType.includes('delete')) return 'bulk_delete';
    return 'other';
}

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ pageId: string }> }
) {
    try {
        const session = await getServerSession(authOptions);
        if (!session?.user?.id) {
            return NextResponse.json({ error: 'Unauthorized', message: 'Please sign in' }, { status: 401 });
        }

        const { pageId } = await params;
        const supabase = getSupabaseAdmin();
        const { data: membership } = await supabase
            .from('user_pages')
            .select('page_id')
            .eq('user_id', session.user.id)
            .eq('page_id', pageId)
            .single();

        if (!membership) {
            return NextResponse.json(
                { error: 'Forbidden', message: 'You do not have access to this page history' },
                { status: 403 }
            );
        }

        const search = (request.nextUrl.searchParams.get('search') || '').trim();
        const kind = request.nextUrl.searchParams.get('kind') || 'all';
        const status = request.nextUrl.searchParams.get('status') || 'all';
        const actorId = request.nextUrl.searchParams.get('actorId') || '';
        const dateFrom = request.nextUrl.searchParams.get('dateFrom') || '';
        const dateTo = request.nextUrl.searchParams.get('dateTo') || '';
        const page = positiveInteger(request.nextUrl.searchParams.get('page'), 1, 100000);
        const pageSize = positiveInteger(request.nextUrl.searchParams.get('pageSize'), 25, 100);
        const candidateLimit = Math.min(page * pageSize, 5000);

        let campaignQuery = supabase
            .from('campaigns')
            .select('*', { count: 'exact' })
            .eq('page_id', pageId)
            .order('created_at', { ascending: false })
            .limit(candidateLimit);

        let auditQuery = supabase
            .from('page_activity_history')
            .select('*', { count: 'exact' })
            .eq('page_id', pageId)
            .order('created_at', { ascending: false })
            .limit(candidateLimit);

        if (search) {
            const safeSearch = search.replace(/[%_,()]/g, ' ').trim();
            if (safeSearch) {
                campaignQuery = campaignQuery.ilike('name', `%${safeSearch}%`);
                auditQuery = auditQuery.ilike('summary', `%${safeSearch}%`);
            }
        }
        if (actorId) {
            campaignQuery = campaignQuery.eq('created_by', actorId);
            auditQuery = auditQuery.eq('actor_user_id', actorId);
        }
        if (status !== 'all') {
            if (status === 'pending') {
                campaignQuery = campaignQuery.eq('status', 'draft');
            } else if (status === 'partial') {
                campaignQuery = campaignQuery.eq('status', 'completed').gt('sent_count', 0).gt('failed_count', 0);
            } else if (status === 'failed') {
                campaignQuery = campaignQuery.eq('status', 'completed').eq('sent_count', 0).gt('failed_count', 0);
            } else if (status === 'completed') {
                campaignQuery = campaignQuery.eq('status', 'completed').eq('failed_count', 0);
            } else {
                campaignQuery = campaignQuery.eq('status', status);
            }
            auditQuery = auditQuery.eq('status', status);
        }
        if (kind === 'bulk_tags') {
            auditQuery = auditQuery.ilike('action_type', '%tag%');
        } else if (kind === 'bulk_message') {
            auditQuery = auditQuery.ilike('action_type', '%message%');
        } else if (kind === 'bulk_delete') {
            auditQuery = auditQuery.ilike('action_type', '%delete%');
        } else if (kind === 'other') {
            auditQuery = auditQuery.not('action_type', 'ilike', '%tag%').not('action_type', 'ilike', '%delete%');
        }
        if (dateFrom) {
            const start = new Date(`${dateFrom}T00:00:00`);
            if (!Number.isNaN(start.getTime())) {
                campaignQuery = campaignQuery.gte('created_at', start.toISOString());
                auditQuery = auditQuery.gte('created_at', start.toISOString());
            }
        }
        if (dateTo) {
            const end = new Date(`${dateTo}T00:00:00`);
            if (!Number.isNaN(end.getTime())) {
                end.setDate(end.getDate() + 1);
                campaignQuery = campaignQuery.lt('created_at', end.toISOString());
                auditQuery = auditQuery.lt('created_at', end.toISOString());
            }
        }

        const includeCampaigns = kind === 'all' || kind === 'bulk_message';
        const includeAudits = true;
        const [campaignResult, auditResult, teamResult] = await Promise.all([
            includeCampaigns ? campaignQuery : Promise.resolve({ data: [], error: null, count: 0 }),
            includeAudits ? auditQuery : Promise.resolve({ data: [], error: null, count: 0 }),
            supabase.from('user_pages').select('user_id, users(id, name, email, image)').eq('page_id', pageId)
        ]);

        if (campaignResult.error) throw campaignResult.error;
        if (auditResult.error && !isMissingHistoryTable(auditResult.error)) throw auditResult.error;
        if (teamResult.error) throw teamResult.error;

        const team = (teamResult.data || []).flatMap((membershipRow: Record<string, any>) => {
            const rawUser = Array.isArray(membershipRow.users) ? membershipRow.users[0] : membershipRow.users;
            return rawUser?.id ? [rawUser as ActivityActor] : [];
        });
        const historicalActorIds = [...new Set([
            ...(campaignResult.data || []).map((row: Record<string, any>) => row.created_by),
            ...(auditResult.data || []).map((row: Record<string, any>) => row.actor_user_id)
        ].filter(Boolean))];
        const teamIds = new Set(team.map((member) => member.id));
        const missingActorIds = historicalActorIds.filter((id) => !teamIds.has(id));
        let historicalActors: ActivityActor[] = [];
        if (missingActorIds.length > 0) {
            const { data, error } = await supabase
                .from('users')
                .select('id, name, email, image')
                .in('id', missingActorIds);
            if (error) throw error;
            historicalActors = (data || []) as ActivityActor[];
        }
        const actors = new Map([...team, ...historicalActors].map((member: ActivityActor) => [member.id, member]));

        const campaignItems: HistoryItem[] = (campaignResult.data || []).map((campaign: Record<string, any>) => {
            const targetCount = Number(campaign.total_recipients || 0);
            const successCount = Number(campaign.sent_count || 0);
            const failureCount = Number(campaign.failed_count || 0);
            return {
                id: `campaign:${campaign.id}`,
                sourceId: campaign.id,
                source: 'campaign',
                pageId,
                kind: 'bulk_message',
                actionType: campaign.use_best_time || campaign.scheduled_at ? 'bulk_message_scheduled' : 'bulk_message',
                title: campaign.name || 'Bulk message',
                status: campaignStatus(campaign),
                actor: actors.get(campaign.created_by) || null,
                targetCount,
                successCount,
                failureCount,
                pendingCount: Math.max(0, targetCount - successCount - failureCount),
                createdAt: campaign.created_at,
                startedAt: campaign.started_at || null,
                completedAt: campaign.completed_at || null,
                scheduledAt: campaign.scheduled_at || null,
                details: {
                    campaignId: campaign.id,
                    messageText: campaign.message_text,
                    templateName: campaign.template_name,
                    templateLanguage: campaign.template_language,
                    audienceMode: campaign.audience_mode,
                    audienceStartDate: campaign.audience_start_date,
                    includedTagIds: campaign.audience_include_tag_ids || [],
                    excludedTagIds: campaign.audience_exclude_tag_ids || [],
                    useBestTime: Boolean(campaign.use_best_time),
                    scheduledDate: campaign.scheduled_date,
                    recurring: campaign.recurrence || 'none',
                    loop: Boolean(campaign.is_loop),
                    aiPersonalized: Boolean(campaign.use_ai_message),
                    recipientHistoryPurgedAt: campaign.recipient_history_purged_at || null,
                    lastUpdatedAt: campaign.updated_at
                }
            };
        });

        const auditItems: HistoryItem[] = (auditResult.data || [])
            .filter((activity: Record<string, any>) => kind === 'all' || auditKind(activity.action_type) === kind)
            .map((activity: Record<string, any>) => ({
                id: `audit:${activity.id}`,
                sourceId: activity.id,
                source: 'audit',
                pageId,
                kind: auditKind(activity.action_type),
                actionType: activity.action_type,
                title: activity.summary,
                status: activity.status,
                actor: actors.get(activity.actor_user_id) || null,
                targetCount: Number(activity.target_count || 0),
                successCount: Number(activity.success_count || 0),
                failureCount: Number(activity.failure_count || 0),
                pendingCount: Math.max(0, Number(activity.target_count || 0) - Number(activity.success_count || 0) - Number(activity.failure_count || 0)),
                createdAt: activity.created_at,
                startedAt: activity.started_at || null,
                completedAt: activity.completed_at || null,
                scheduledAt: null,
                details: activity.details && typeof activity.details === 'object' ? activity.details : {}
            }));

        const allItems = [...campaignItems, ...auditItems]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const offset = (page - 1) * pageSize;
        const items = allItems.slice(offset, offset + pageSize);
        const total = Number(campaignResult.count || 0) + Number(auditResult.count || 0);

        return NextResponse.json({
            items,
            page,
            pageSize,
            total,
            hasMore: offset + items.length < total,
            team: [...team, ...historicalActors],
            auditEnabled: !auditResult.error,
            summary: items.reduce((totals, item) => ({
                targets: totals.targets + item.targetCount,
                succeeded: totals.succeeded + item.successCount,
                failed: totals.failed + item.failureCount,
                pending: totals.pending + item.pendingCount
            }), { targets: 0, succeeded: 0, failed: 0, pending: 0 })
        });
    } catch (error) {
        console.error('Error fetching page activity history:', error);
        return NextResponse.json(
            { error: 'Failed to fetch history', message: (error as Error).message },
            { status: 500 }
        );
    }
}
