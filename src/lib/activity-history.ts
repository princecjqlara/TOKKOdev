import type { SupabaseClient } from '@supabase/supabase-js';

export type PageActivityStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface RecordPageActivityInput {
    pageId: string;
    actorUserId: string;
    actionType: string;
    entityType: string;
    entityId?: string | null;
    status?: PageActivityStatus;
    summary: string;
    targetCount?: number;
    successCount?: number;
    failureCount?: number;
    details?: Record<string, unknown>;
    startedAt?: string;
    completedAt?: string | null;
}

/**
 * Audit logging must never turn an otherwise successful user action into a failure.
 * Deploy database/migration_bulk_activity_history.sql to enable persistence.
 */
export async function recordPageActivity(
    supabase: SupabaseClient<any, 'public', any>,
    input: RecordPageActivityInput
): Promise<boolean> {
    try {
        const now = new Date().toISOString();
        const { error } = await supabase
            .from('page_activity_history')
            .insert({
                page_id: input.pageId,
                actor_user_id: input.actorUserId,
                action_type: input.actionType,
                entity_type: input.entityType,
                entity_id: input.entityId || null,
                status: input.status || 'completed',
                summary: input.summary,
                target_count: Math.max(0, input.targetCount || 0),
                success_count: Math.max(0, input.successCount || 0),
                failure_count: Math.max(0, input.failureCount || 0),
                details: input.details || {},
                started_at: input.startedAt || now,
                completed_at: input.completedAt === undefined ? now : input.completedAt,
                created_at: now
            });

        if (error) {
            console.error('Unable to record page activity history:', {
                code: error.code,
                message: error.message,
                pageId: input.pageId,
                actionType: input.actionType
            });
            return false;
        }

        return true;
    } catch (error) {
        console.error('Unable to record page activity history:', {
            message: (error as Error).message,
            pageId: input.pageId,
            actionType: input.actionType
        });
        return false;
    }
}
