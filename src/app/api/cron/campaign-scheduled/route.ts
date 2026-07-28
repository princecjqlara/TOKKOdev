import { NextRequest, NextResponse } from 'next/server';
import { resolveCampaignAudienceContactIds } from '@/lib/campaign-audience';
import { sendCampaignById } from '@/lib/campaign-send';
import { getSupabaseAdmin } from '@/lib/supabase';
import { chunkArray } from '../../../../lib/chunking';

export const dynamic = 'force-dynamic';

const STALE_SENDING_AFTER_MS = 10 * 60 * 1000;
const MAX_CAMPAIGNS_PER_CRON_RUN = 2;
const MAX_RECIPIENTS_PER_CAMPAIGN_RUN = 10;
const MAX_CRON_SEND_MS = 20000;

type ScheduledCampaign = {
    id: string;
    page_id: string;
    audience_mode: string | null;
    audience_start_date: string | null;
    audience_include_tag_ids: string[] | null;
    audience_exclude_tag_ids: string[] | null;
    recurrence: string | null;
    recurrence_end_at: string | null;
    scheduled_at: string | null;
    status: string;
    updated_at: string | null;
};

const SCHEDULED_CAMPAIGN_SELECT =
    'id, page_id, audience_mode, audience_start_date, audience_include_tag_ids, audience_exclude_tag_ids, recurrence, recurrence_end_at, scheduled_at, status, updated_at';

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
        .lte('scheduled_at', now);

    if (scheduledError) {
        throw scheduledError;
    }

    const { data: staleSendingCampaigns, error: staleSendingError } = await supabase
        .from('campaigns')
        .select(SCHEDULED_CAMPAIGN_SELECT)
        .eq('status', 'sending')
        .eq('is_loop', false)
        .lte('scheduled_at', now)
        .lte('updated_at', staleSendingCutoff);

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
        .eq('status', 'pending')
        .lte('scheduled_at', now)
        .eq('campaigns.is_loop', false)
        .in('campaigns.status', ['scheduled', 'sending']);

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

// GET /api/cron/campaign-scheduled - Called by cron-jobs.org for due one-time campaigns
export async function GET(_request: NextRequest) {
    try {
        const supabase = getSupabaseAdmin();
        const now = new Date().toISOString();
        const staleSendingCutoff = new Date(Date.now() - STALE_SENDING_AFTER_MS).toISOString();

        const campaignLevelCampaigns = await getDueCampaignLevelCampaigns(supabase, now, staleSendingCutoff);
        const recipientLevelCampaigns = await getDueRecipientLevelCampaigns(supabase, now, staleSendingCutoff);
        const dueCampaigns = Array.from(
            new Map(
                [...campaignLevelCampaigns, ...recipientLevelCampaigns]
                    .map((campaign) => [campaign.id, campaign])
            ).values()
        ).slice(0, MAX_CAMPAIGNS_PER_CRON_RUN);

        const results = [];

        for (const campaign of dueCampaigns) {
            const claimed = await claimCampaign(supabase, campaign, now, staleSendingCutoff);
            if (!claimed) {
                results.push({
                    campaignId: campaign.id,
                    skipped: true,
                    reason: 'Campaign is already being processed'
                });
                continue;
            }

            if (campaign.audience_mode === 'dynamic') {
                const contactIds = await resolveCampaignAudienceContactIds({
                    supabase,
                    pageId: campaign.page_id,
                    rules: {
                        startDate: campaign.audience_start_date,
                        includeTagIds: campaign.audience_include_tag_ids || [],
                        excludeTagIds: campaign.audience_exclude_tag_ids || []
                    }
                });

                for (const contactIdBatch of chunkArray(contactIds, 500)) {
                    const { error: upsertError } = await supabase.from('campaign_recipients').upsert(
                        contactIdBatch.map((contactId) => ({
                            campaign_id: campaign.id,
                            contact_id: contactId,
                            status: 'pending'
                        })),
                        { onConflict: 'campaign_id,contact_id', ignoreDuplicates: false }
                    );

                    if (upsertError) {
                        throw upsertError;
                    }
                }

                const { error: updateError } = await supabase
                    .from('campaigns')
                    .update({
                        total_recipients: contactIds.length,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', campaign.id);

                if (updateError) {
                    throw updateError;
                }
            }

            const sendResult = await sendCampaignById({
                campaignId: campaign.id,
                supabase,
                allowScheduled: true,
                dueAt: now,
                sendBatchSize: 5,
                delayBetweenBatchesMs: 0,
                maxRecipientsPerRun: MAX_RECIPIENTS_PER_CAMPAIGN_RUN,
                maxProcessingTimeMs: MAX_CRON_SEND_MS,
                includeUnscheduledRecipients:
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
