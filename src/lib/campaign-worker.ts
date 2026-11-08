import { sendCampaignById } from './campaign-send';
import { getSupabaseAdmin } from './supabase';
import { databaseRequest } from './database-request';

const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
// Each campaign gets a bounded slice. Run the independent slices together
// so two queues do not consume two consecutive scheduler timeout windows.
const MAX_CAMPAIGNS_PER_CRON_RUN = 2;
const MAX_RECIPIENTS_PER_CAMPAIGN_RUN = 250;
const MAX_IMMEDIATE_RECIPIENTS_PER_CAMPAIGN_RUN = 250;
const MAX_DUE_RECIPIENT_ROWS_TO_SCAN = 500;
const MAX_IMMEDIATE_CAMPAIGNS_TO_SCAN = 100;
// cron-jobs.org can stop waiting around the 30-second mark. Leave enough
// headroom for campaign discovery and the JSON response.
const MAX_CRON_SEND_MS = 15000;
const WORKER_RETRY_DELAY_MS = 60_000;

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

    const { data, error } = await databaseRequest(query.select('id'));

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
    const [{ data: scheduledCampaigns, error: scheduledError }, { data: staleSendingCampaigns, error: staleSendingError }] = await Promise.all([
        databaseRequest(supabase
            .from('campaigns')
            .select(SCHEDULED_CAMPAIGN_SELECT)
            .eq('status', 'scheduled')
            .eq('is_loop', false)
            .lte('scheduled_at', now)
            .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
            .order('scheduled_at', { ascending: true, nullsFirst: true })),
        databaseRequest(supabase
            .from('campaigns')
            .select(SCHEDULED_CAMPAIGN_SELECT)
            .eq('status', 'sending')
            .eq('is_loop', false)
            .lte('scheduled_at', now)
            .lte('updated_at', staleSendingCutoff)
            .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
            .order('scheduled_at', { ascending: true, nullsFirst: true }))
    ]);

    if (scheduledError) throw scheduledError;

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
    const { data: dueRecipients, error } = await databaseRequest(supabase
        .from('campaign_recipients')
        .select(`campaign_id, campaigns!inner(${SCHEDULED_CAMPAIGN_SELECT}, is_loop)`)
        .in('status', ['pending', 'processing'])
        .lte('scheduled_at', now)
        .eq('campaigns.is_loop', false)
        .in('campaigns.status', ['scheduled', 'sending'])
        .order('scheduled_at', { ascending: true, nullsFirst: true })
        .limit(MAX_DUE_RECIPIENT_ROWS_TO_SCAN));

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
    const { data, error } = await databaseRequest(supabase
        .from('campaigns')
        .select(SCHEDULED_CAMPAIGN_SELECT)
        .eq('status', 'sending')
        .eq('is_loop', false)
        .is('scheduled_at', null)
        .eq('background_delivery_enabled', true)
        .or(`next_attempt_at.is.null,next_attempt_at.lte.${now}`)
        .order('updated_at', { ascending: true, nullsFirst: true })
        // Several campaigns on one Page must not occupy the entire discovery
        // window and hide work belonging to other Pages.
        .limit(MAX_IMMEDIATE_CAMPAIGNS_TO_SCAN));

    if (error) throw error;
    return (data || []) as ScheduledCampaign[];
}

export async function processCampaignQueue() {
    const supabase = getSupabaseAdmin();
    const now = new Date().toISOString();
    const staleSendingCutoff = new Date(Date.now() - STALE_SENDING_AFTER_MS).toISOString();

    // A failed scheduled/best-time lookup must not strand a healthy immediate
    // queue. Every lookup has its own database deadline and reports its error.
    const discovery = await Promise.allSettled([
        getDueCampaignLevelCampaigns(supabase, now, staleSendingCutoff),
        getDueRecipientLevelCampaigns(supabase, now, staleSendingCutoff),
        getResumableImmediateCampaigns(supabase, now)
    ]);
    const [campaignLevelCampaigns, recipientLevelCampaigns, immediateCampaigns] = discovery.map(result =>
        result.status === 'fulfilled' ? result.value : []);
    const discoveryFailures = discovery.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    const seenPages = new Set<string>();
    const dueCampaigns = Array.from(
        new Map(
            // Always give an explicitly-enabled immediate campaign the
            // first worker slot. The second slot remains available for a
            // due scheduled/best-time campaign.
            [...immediateCampaigns.slice(0, 1), ...campaignLevelCampaigns, ...recipientLevelCampaigns, ...immediateCampaigns.slice(1)]
                .filter((campaign) => (
                    !campaign.next_attempt_at || campaign.next_attempt_at <= now
                ))
                .map((campaign) => [campaign.id, campaign])
        ).values()
    ).filter(campaign => {
        if (seenPages.has(campaign.page_id)) return false;
        seenPages.add(campaign.page_id); return true;
    }).slice(0, MAX_CAMPAIGNS_PER_CRON_RUN);

    if (!dueCampaigns.length && discoveryFailures.length) throw discoveryFailures[0];

    const results = await Promise.all(dueCampaigns.map(async (campaign) => {
        const isImmediateResume =
            campaign.status === 'sending' &&
            campaign.scheduled_at === null &&
            campaign.background_delivery_enabled;
        try {
            // Recipient claims are already atomic and use SKIP LOCKED. An
            // immediate campaign therefore remains safe if a browser worker
            // and cron overlap; they receive disjoint recipient batches.
            const claimed = isImmediateResume || await claimCampaign(supabase, campaign, now, staleSendingCutoff);
            if (!claimed) {
                return {
                    campaignId: campaign.id,
                    skipped: true,
                    reason: 'Campaign is already being processed'
                };
            }

            if (campaign.audience_mode === 'dynamic' && !campaign.audience_materialized_at) {
                const { data: materializedRows, error: materializationError } = await databaseRequest(supabase.rpc(
                    'materialize_dynamic_campaign_audience',
                    { p_campaign_id: campaign.id }
                ));

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
                backgroundOnly: true,
                allowScheduled: !isImmediateResume,
                dueAt: isImmediateResume ? undefined : now,
                sendBatchSize: 25,
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

            return {
                campaignId: campaign.id,
                ...sendResult
            };
        } catch (campaignError) {
            const message = campaignError instanceof Error
                ? campaignError.message
                : String((campaignError as { message?: string })?.message || campaignError);
            const retryAt = new Date(Date.now() + WORKER_RETRY_DELAY_MS).toISOString();

            try {
                const { error: recoveryError } = await databaseRequest(supabase
                    .from('campaigns')
                    .update({
                        status: isImmediateResume ? 'sending' : 'scheduled',
                        next_attempt_at: retryAt,
                        last_error: message,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaign.id)
                    .eq('status', 'sending'));
                if (recoveryError) throw recoveryError;
            } catch (recoveryError) {
                // The saved campaign and expiring claims remain discoverable.
                // A stalled recovery write must not block the whole cron run.
                console.error('Campaign worker could not save retry state:', recoveryError);
            }

            return {
                campaignId: campaign.id,
                success: false,
                retryable: true,
                message: `Campaign remains queued after a temporary worker error: ${message}`
            };
        }
    }));

    return {
        success: true,
        processed: results.length,
        results,
        ...(discoveryFailures.length ? {
            retryable: true,
            discoveryErrors: discoveryFailures.map(error => error instanceof Error
                ? error.message : String(error?.message || 'Campaign discovery is temporarily unavailable.'))
        } : {})
    };
}
