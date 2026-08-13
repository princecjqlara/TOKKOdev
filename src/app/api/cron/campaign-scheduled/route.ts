import { NextRequest, NextResponse } from 'next/server';
import { sendCampaignById } from '@/lib/campaign-send';
import { getSupabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
// Process one immediate campaign per invocation. This keeps the route within
// the external scheduler/serverless execution window and prevents one call
// from spending minutes walking several large queues.
const MAX_CAMPAIGNS_PER_CRON_RUN = 2;
const MAX_RECIPIENTS_PER_CAMPAIGN_RUN = 25;
const MAX_IMMEDIATE_RECIPIENTS_PER_CAMPAIGN_RUN = 250;
const MAX_DUE_RECIPIENT_ROWS_TO_SCAN = 500;
// cron-jobs.org can stop waiting around the 30-second mark. Leave enough
// headroom for campaign discovery and the JSON response.
const MAX_CRON_SEND_MS = 15000;

type ScheduledCampaign = {
    id: string;
    page_id: string;
    audience_mode: string | null;
    audience_start_date: string | null;
    audience_include_tag_ids: string[] | null;
    audience_exclude_tag_ids: string[] | null;
    audience_materialized_at: string | null;
    recurrence: string | null;
    recurrence_end_at: string | null;
    scheduled_at: string | null;
    next_attempt_at: string | null;
    background_delivery_enabled: boolean;
    status: string;
    updated_at: string | null;
};

const SCHEDULED_CAMPAIGN_SELECT =
    'id, page_id, audience_mode, audience_start_date, audience_include_tag_ids, audience_exclude_tag_ids, audience_materialized_at, recurrence, recurrence_end_at, scheduled_at, next_attempt_at, background_delivery_enabled, status, updated_at';

async function claimCampaign(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    campaign: ScheduledCampaign,
    now: string,
    staleSendingCutoff: string
) {
    let query = supabase
        .from('campaigns')
        .update({
            status: 'sending',
            updated_at: now
        })
        .eq('id', campaign.id);

    if (campaign.status === 'sending') {
        query = query
            .eq('status', 'sending')
            .lte('updated_at', staleSendingCutoff);
    } else {
        query = query.eq('status', 'scheduled');
    }

    const { data, error } = await query.select('id');

    if (error) {
        throw error;
    }

    return Array.isArray(data) && data.length > 0;
}

async function getDueCampaignLevelCampaigns(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    now: string,
    staleSendingCutoff: string
) {
    const { data: scheduledCampaigns, error: scheduledError } = await supabase
        .from('campaigns')
        .select(SCHEDULED_CAMPAIGN_SELECT)
        .eq('status', 'scheduled')
        .eq('is_loop', false)
        .lte('scheduled_at', now)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
        .order('scheduled_at', { ascending: true, nullsFirst: true });

    if (scheduledError) {
        throw scheduledError;
    }

    const { data: staleSendingCampaigns, error: staleSendingError } = await supabase
        .from('campaigns')
        .select(SCHEDULED_CAMPAIGN_SELECT)
        .eq('status', 'sending')
        .eq('is_loop', false)
        .lte('scheduled_at', now)
        .lte('updated_at', staleSendingCutoff)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
        .order('scheduled_at', { ascending: true, nullsFirst: true });

    if (staleSendingError) {
        throw staleSendingError;
    }

    return [...(scheduledCampaigns || []), ...(staleSendingCampaigns || [])] as ScheduledCampaign[];
}

async function getDueRecipientLevelCampaigns(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    now: string,
    staleSendingCutoff: string
) {
    const { data: dueRecipients, error } = await supabase
        .from('campaign_recipients')
        .select(`campaign_id, campaigns!inner(${SCHEDULED_CAMPAIGN_SELECT}, is_loop)`)
        .in('status', ['pending', 'processing'])
        .lte('scheduled_at', now)
        .eq('campaigns.is_loop', false)
        .in('campaigns.status', ['scheduled', 'sending'])
        .order('scheduled_at', { ascending: true, nullsFirst: true })
        .limit(MAX_DUE_RECIPIENT_ROWS_TO_SCAN);

    if (error) {
        throw error;
    }

    const campaignsById = new Map<string, ScheduledCampaign>();
    for (const row of dueRecipients || []) {
        const campaignData = Array.isArray(row.campaigns) ? row.campaigns[0] : row.campaigns;
        if (!campaignData?.id) {
            continue;
        }

        if (
            campaignData.status === 'sending' &&
            (!campaignData.updated_at || campaignData.updated_at > staleSendingCutoff)
        ) {
            continue;
        }

        campaignsById.set(campaignData.id, campaignData as ScheduledCampaign);
    }

    return Array.from(campaignsById.values());
}

async function getResumableImmediateCampaigns(
    supabase: ReturnType<typeof getSupabaseAdmin>,
    now: string
) {
    const { data, error } = await supabase
        .from('campaigns')
        .select(SCHEDULED_CAMPAIGN_SELECT)
        .eq('status', 'sending')
        .eq('is_loop', false)
        .is('scheduled_at', null)
        .eq('background_delivery_enabled', true)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
        .order('updated_at', { ascending: true, nullsFirst: true })
        .limit(MAX_CAMPAIGNS_PER_CRON_RUN);

    if (error) throw error;
    return (data || []) as ScheduledCampaign[];
}

// GET /api/cron/campaign-scheduled - Called by cron-jobs.org for due one-time campaigns
export async function GET(_request: NextRequest) {
    try {
        const supabase = getSupabaseAdmin();
        const now = new Date().toISOString();
        const staleSendingCutoff = new Date(Date.now() - STALE_SENDING_AFTER_MS).toISOString();

        const campaignLevelCampaigns = await getDueCampaignLevelCampaigns(supabase, now, staleSendingCutoff);
        const recipientLevelCampaigns = await getDueRecipientLevelCampaigns(supabase, now, staleSendingCutoff);
        const immediateCampaigns = await getResumableImmediateCampaigns(supabase, now);
        const dueCampaigns = Array.from(
            new Map(
                // Always give an explicitly-enabled immediate campaign the
                // first worker slot. The second slot remains available for a
                // due scheduled/best-time campaign.
                [...immediateCampaigns.slice(0, 1), ...campaignLevelCampaigns, ...recipientLevelCampaigns]
                    .filter((campaign) => (
                        !campaign.next_attempt_at || campaign.next_attempt_at <= now
                    ))
                    .map((campaign) => [campaign.id, campaign])
            ).values()
        ).slice(0, MAX_CAMPAIGNS_PER_CRON_RUN);

        const results = [];

        for (const campaign of dueCampaigns) {
            try {
            const isImmediateResume =
                campaign.status === 'sending' &&
                campaign.scheduled_at === null;
            // Recipient claims are already atomic and use SKIP LOCKED. An
            // immediate campaign therefore remains safe if a browser worker
            // and cron overlap; they receive disjoint recipient batches.
            const claimed = isImmediateResume || await claimCampaign(supabase, campaign, now, staleSendingCutoff);
            if (!claimed) {
                results.push({
                    campaignId: campaign.id,
                    skipped: true,
                    reason: 'Campaign is already being processed'
                });
                continue;
            }

            if (campaign.audience_mode === 'dynamic' && !campaign.audience_materialized_at) {
                const { data: materializedRows, error: materializationError } = await supabase.rpc(
                    'materialize_dynamic_campaign_audience',
                    { p_campaign_id: campaign.id }
                );

                if (materializationError) throw materializationError;
                const materialized = Array.isArray(materializedRows)
                    ? materializedRows[0]
                    : materializedRows;
                if (!materialized) {
                    throw new Error('Database did not return dynamic audience materialization progress.');
                }

                campaign.audience_materialized_at = materialized.audience_materialized_at;
            }

            const sendResult = await sendCampaignById({
                campaignId: campaign.id,
                supabase,
                allowScheduled: !isImmediateResume,
                dueAt: isImmediateResume ? undefined : now,
                sendBatchSize: isImmediateResume ? 25 : 10,
                delayBetweenBatchesMs: 0,
                maxRecipientsPerRun: isImmediateResume
                    ? MAX_IMMEDIATE_RECIPIENTS_PER_CAMPAIGN_RUN
                    : MAX_RECIPIENTS_PER_CAMPAIGN_RUN,
                maxProcessingTimeMs: MAX_CRON_SEND_MS,
                includeUnscheduledRecipients: !isImmediateResume &&
                    Boolean(campaign.scheduled_at) &&
                    new Date(campaign.scheduled_at as string).getTime() <= new Date(now).getTime()
            });

            // Daily-recurring campaigns: re-arm for tomorrow at the same time
            // unless we've passed the end date.
            if (campaign.recurrence === 'daily' && sendResult.success && !sendResult.body.partial) {
                const baseTime = campaign.scheduled_at ? new Date(campaign.scheduled_at) : new Date();
                const nextRun = new Date(baseTime);
                // Roll forward in 1-day increments until we land in the future.
                const nowMs = Date.now();
                while (nextRun.getTime() <= nowMs) {
                    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
                }
                const endsAt = campaign.recurrence_end_at ? new Date(campaign.recurrence_end_at) : null;

                if (endsAt && nextRun > endsAt) {
                    // Past the recurrence end — leave the campaign as completed.
                } else {
                    // Re-arm: clear sent/failed counters on recipients and reset campaign.
                    await supabase
                        .from('campaign_recipients')
                        .update({ status: 'pending', sent_at: null, error_message: null })
                        .eq('campaign_id', campaign.id);

                    await supabase
                        .from('campaigns')
                        .update({
                            status: 'scheduled',
                            scheduled_at: nextRun.toISOString(),
                            sent_count: 0,
                            failed_count: 0,
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', campaign.id);
                }
            }

            results.push({
                campaignId: campaign.id,
                ...sendResult
            });
            } catch (campaignError) {
                const message = campaignError instanceof Error
                    ? campaignError.message
                    : String((campaignError as { message?: string })?.message || campaignError);
                const retryAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

                await supabase
                    .from('campaigns')
                    .update({
                        status: campaign.scheduled_at ? 'scheduled' : 'sending',
                        next_attempt_at: retryAt,
                        last_error: message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaign.id);

                results.push({
                    campaignId: campaign.id,
                    success: false,
                    retryable: true,
                    message: `Campaign remains queued after a temporary worker error: ${message}`
                });
            }
        }

        return NextResponse.json({
            success: true,
            processed: results.length,
            results
        });
    } catch (error) {
        return NextResponse.json(
            {
                error: 'Scheduled campaign cron failed',
                message: (error as Error).message
            },
            { status: 500 }
        );
    }
}
