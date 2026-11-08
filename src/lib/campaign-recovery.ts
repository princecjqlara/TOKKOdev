export function getCampaignRecoveryUrl(campaignId: string, pageId?: string | null): string {
    const params = new URLSearchParams({ campaignId });
    if (pageId) params.set('pageId', pageId);
    return `/dashboard/campaigns?${params}`;
}

export function getLastBulkCampaignKey(pageId: string): string {
    return `tokko:last-bulk-campaign:${pageId}`;
}
