import { getSupabaseAdmin } from './supabase';

type SupabaseAdmin = ReturnType<typeof getSupabaseAdmin>;

export type ClaimedCampaignRecipient = {
    contact_id: string;
    contact_psid: string | null;
    contact_name: string | null;
    contact_best_hour: number | null;
    claim_token: string;
};

export type CampaignDeliveryProgress = {
    sent: number;
    failed: number;
    remaining: number;
};

export type CampaignRecipientResult = {
    contact_id: string;
    success: boolean;
    error_message: string | null;
};

export async function claimCampaignRecipients({
    supabase,
    campaignId,
    batchSize,
    dueAt,
    includeUnscheduledRecipients = false
}: {
    supabase: SupabaseAdmin;
    campaignId: string;
    batchSize: number;
    dueAt?: string;
    includeUnscheduledRecipients?: boolean;
}): Promise<ClaimedCampaignRecipient[]> {
    const { data, error } = await supabase.rpc('claim_campaign_recipients', {
        p_campaign_id: campaignId,
        p_batch_size: batchSize,
        p_due_at: dueAt || null,
        p_include_unscheduled: includeUnscheduledRecipients
    });

    if (error) throw error;
    return (data || []) as ClaimedCampaignRecipient[];
}

export async function finishCampaignRecipient({
    supabase,
    campaignId,
    contactId,
    claimToken,
    success,
    errorMessage
}: {
    supabase: SupabaseAdmin;
    campaignId: string;
    contactId: string;
    claimToken: string;
    success: boolean;
    errorMessage?: string;
}) {
    const { data, error } = await supabase.rpc('finish_campaign_recipient', {
        p_campaign_id: campaignId,
        p_contact_id: contactId,
        p_claim_token: claimToken,
        p_success: success,
        p_error_message: errorMessage || null
    });

    if (error) throw error;
    if (data !== true) throw new Error('Recipient claim expired before completion');
}

export async function finishCampaignRecipientBatch({
    supabase,
    campaignId,
    claimToken,
    results
}: {
    supabase: SupabaseAdmin;
    campaignId: string;
    claimToken: string;
    results: CampaignRecipientResult[];
}) {
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
        const { data, error } = await supabase.rpc('finish_campaign_recipient_batch', {
            p_campaign_id: campaignId,
            p_claim_token: claimToken,
            p_results: results
        });

        if (!error && Number(data) === results.length) return;
        lastError = error || new Error('Not every recipient claim was completed');
    }

    throw lastError;
}

export async function releaseCampaignRecipientBatch({
    supabase,
    campaignId,
    claimToken,
    contactIds
}: {
    supabase: SupabaseAdmin;
    campaignId: string;
    claimToken: string;
    contactIds: string[];
}) {
    if (contactIds.length === 0) return;

    // Keep recoverable page/template/service failures pending. The claim-token
    // guard prevents an expired worker from releasing a newer worker's claim.
    const { error } = await supabase
        .from('campaign_recipients')
        .update({
            status: 'pending',
            claim_token: null,
            claimed_at: null,
            error_message: null
        })
        .eq('campaign_id', campaignId)
        .eq('status', 'processing')
        .eq('claim_token', claimToken)
        .in('contact_id', contactIds);

    if (error) throw error;
}

export async function getCampaignDeliveryProgress(
    supabase: SupabaseAdmin,
    campaignId: string
): Promise<CampaignDeliveryProgress> {
    const { data, error } = await supabase.rpc('get_campaign_delivery_progress', {
        p_campaign_id: campaignId
    });

    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;

    return {
        sent: Number(row?.sent_count || 0),
        failed: Number(row?.failed_count || 0),
        remaining: Number(row?.remaining_count || 0)
    };
}

export async function finishLoopCampaignRecipient({
    supabase,
    campaignId,
    contactId,
    claimToken,
    success,
    nextScheduledAt,
    errorMessage
}: {
    supabase: SupabaseAdmin;
    campaignId: string;
    contactId: string;
    claimToken: string;
    success: boolean;
    nextScheduledAt?: string;
    errorMessage?: string;
}) {
    const { data, error } = await supabase.rpc('finish_loop_campaign_recipient', {
        p_campaign_id: campaignId,
        p_contact_id: contactId,
        p_claim_token: claimToken,
        p_success: success,
        p_next_scheduled_at: nextScheduledAt || null,
        p_error_message: errorMessage || null
    });

    if (error) throw error;
    if (data !== true) throw new Error('Loop recipient claim expired before completion');
}
