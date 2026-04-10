import { NextRequest, NextResponse } from 'next/server';
import { resolveCampaignAudienceContactIds } from '@/lib/campaign-audience';
import { sendCampaignById } from '@/lib/campaign-send';
import { getSupabaseAdmin } from '@/lib/supabase';

// GET /api/cron/campaign-scheduled - Called by cronjob.org for due one-time campaigns
export async function GET(request: NextRequest) {
    try {
        const supabase = getSupabaseAdmin();
        const now = new Date().toISOString();

        const { data: dueCampaigns, error } = await supabase
            .from('campaigns')
            .select('id, page_id, audience_mode, audience_start_date, audience_include_tag_ids, audience_exclude_tag_ids')
            .in('status', ['scheduled', 'sending'])
            .eq('is_loop', false)
            .lte('scheduled_at', now);

        if (error) {
            throw error;
        }

        const results = [];

        for (const campaign of dueCampaigns || []) {
            if (campaign.audience_mode === 'dynamic') {
                const contactIds = await resolveCampaignAudienceContactIds({
                    supabase,
                    pageId: campaign.page_id,
                    rules: {
                        startDate: campaign.audience_start_date,
                        includeTagIds: campaign.audience_include_tag_ids,
                        excludeTagIds: campaign.audience_exclude_tag_ids
                    }
                });

                if (contactIds.length > 0) {
                    const { error: upsertError } = await supabase.from('campaign_recipients').upsert(
                        contactIds.map((contactId) => ({
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
                allowScheduled: true
            });

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
