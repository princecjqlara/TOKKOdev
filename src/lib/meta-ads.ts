import type { AdDailyMetrics, AdsAccount, AdsGoal, AdsMetrics, AdsReport, GuardAd } from './ads-guard';

const GRAPH_URL = 'https://graph.facebook.com/v21.0';
const INSIGHT_FIELDS = 'ad_id,ad_name,campaign_id,campaign_name,adset_id,adset_name,spend,impressions,inline_link_clicks,reach,frequency,actions,action_values,date_start,date_stop';

type ActionValue = { action_type: string; value: string };
export interface MetaInsight {
    ad_id: string;
    ad_name?: string;
    campaign_id?: string;
    campaign_name?: string;
    adset_id?: string;
    adset_name?: string;
    spend?: string;
    impressions?: string;
    inline_link_clicks?: string;
    reach?: string;
    frequency?: string;
    actions?: ActionValue[];
    action_values?: ActionValue[];
    date_start: string;
    date_stop: string;
}
interface MetaAd {
    id: string;
    name: string;
    effective_status: string;
    created_time?: string;
    updated_time?: string;
    campaign?: { id: string; name: string; daily_budget?: string; lifetime_budget?: string; updated_time?: string };
    adset?: { id: string; name: string; daily_budget?: string; lifetime_budget?: string; updated_time?: string; learning_stage_info?: { status?: string }; optimization_goal?: string };
    creative?: { actor_id?: string; object_story_spec?: { page_id?: string }; effective_object_story_id?: string; object_story_id?: string };
}

export class AdsApiError extends Error {
    constructor(message: string, public status: number, public code: string) {
        super(message);
        this.name = 'AdsApiError';
    }
}

async function graphList<T>(path: string, token: string, params: Record<string, string>, signal: AbortSignal): Promise<T[]> {
    const output: T[] = [];
    const cursors = new Set<string>();
    let after: string | undefined;
    for (let page = 0; page < 40; page++) {
        const url = new URL(`${GRAPH_URL}/${path}`);
        Object.entries({ ...params, limit: '500', ...(after ? { after } : {}) }).forEach(([key, value]) => url.searchParams.set(key, value));
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal
        });
        const body = await response.json().catch(() => null) as {
            data?: T[]; paging?: { next?: string; cursors?: { after?: string } };
            error?: { code?: number }
        } | null;
        if (!response.ok || body?.error) {
            const code = body?.error?.code;
            if (code === 190) throw new AdsApiError('Your Facebook login expired. Reconnect ad access.', 409, 'ADS_REAUTH_REQUIRED');
            if (code === 10 || code === 200 || response.status === 403) {
                throw new AdsApiError('Ad access is missing. Connect with ads_read permission and a Facebook user who can view this ad account. The Meta app also needs Marketing API access.', 409, 'ADS_PERMISSION_REQUIRED');
            }
            if ([4, 17, 32, 613, 80000].includes(code || 0) || response.status === 429) {
                throw new AdsApiError('Meta temporarily limited reporting requests. Wait a few minutes before refreshing.', 429, 'ADS_RATE_LIMIT');
            }
            throw new AdsApiError('Meta could not complete this report. Check the ad account and Marketing API configuration, then retry.', 502, 'ADS_REPORT_FAILED');
        }
        if (!Array.isArray(body?.data)) throw new AdsApiError('Meta returned an incomplete reporting response. Retry before making decisions.', 502, 'ADS_REPORT_INCOMPLETE');
        output.push(...body.data);
        if (!body.paging?.next) return output;
        // Use cursors with our own fixed endpoint; never forward tokens to a paging URL.
        after = body.paging.cursors?.after;
        if (!after || cursors.has(after)) throw new AdsApiError('Meta returned incomplete pagination. Retry before making decisions.', 502, 'ADS_REPORT_INCOMPLETE');
        cursors.add(after);
    }
    throw new AdsApiError('This account is too large for a complete interactive report. A background reporting job is needed; partial data is withheld.', 422, 'ADS_REPORT_TOO_LARGE');
}

async function withDeadline<T>(milliseconds: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), milliseconds);
    try { return await run(controller.signal); }
    catch (error) {
        if (controller.signal.aborted) throw new AdsApiError('Meta reporting timed out. Retry; no decisions were made from a partial report.', 504, 'ADS_REPORT_TIMEOUT');
        throw error;
    } finally { clearTimeout(timeout); controller.abort(); }
}

export async function getMetaAdAccounts(token: string): Promise<AdsAccount[]> {
    return withDeadline(15000, signal => graphList<AdsAccount>('me/adaccounts', token, {
        fields: 'id,name,currency,timezone_name,account_status'
    }, signal));
}

export function getAdsDateRanges(timezone: string, now: Date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
    const part = (type: string) => parts.find(p => p.type === type)!.value;
    const today = new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00Z`);
    const day = (offset: number) => new Date(today.getTime() + offset * 86400000).toISOString().slice(0, 10);
    return { currentRange: { since: day(-7), until: day(-1) }, previousRange: { since: day(-14), until: day(-8) } };
}

const RESULT_TYPES: Record<AdsGoal, string[]> = {
    messages: ['onsite_conversion.messaging_conversation_started_7d'],
    leads: ['lead', 'omni_lead', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped'],
    purchases: ['purchase', 'omni_purchase', 'offsite_conversion.fb_pixel_purchase']
};

function numeric(value: string | undefined): number {
    const result = Number(value || 0);
    if (!Number.isFinite(result) || result < 0) throw new AdsApiError('Meta returned invalid metrics. Retry before making decisions.', 502, 'ADS_REPORT_INCOMPLETE');
    return result;
}

// Meta supplies overlapping action aliases. Take one canonical event, never sum aliases.
function eventValue(actions: ActionValue[] | undefined, types: string[]): number | null {
    for (const type of types) {
        const action = actions?.find(a => a.action_type === type);
        if (action) return numeric(action.value);
    }
    return null;
}

export function normalizeInsight(row: MetaInsight | undefined, goal: AdsGoal): AdsMetrics {
    const results = eventValue(row?.actions, RESULT_TYPES[goal]) ?? 0;
    return {
        spend: numeric(row?.spend), impressions: numeric(row?.impressions),
        linkClicks: numeric(row?.inline_link_clicks), results,
        revenue: goal === 'purchases' ? eventValue(row?.action_values, RESULT_TYPES.purchases) : null,
        reach: numeric(row?.reach), frequency: row?.frequency === undefined ? null : numeric(row.frequency),
        activeDays: 0
    };
}

export function getCreativePageId(creative: MetaAd['creative']): string | null {
    return creative?.object_story_spec?.page_id || creative?.actor_id
        || (creative?.effective_object_story_id || creative?.object_story_id)?.split('_')[0] || null;
}

export async function getMetaAdsReport(token: string, account: AdsAccount, goal: AdsGoal, now: Date = new Date()): Promise<AdsReport> {
    if (!/^act_\d+$/.test(account.id)) throw new AdsApiError('Invalid ad account.', 400, 'ADS_INVALID_ACCOUNT');
    if (!account.timezone_name || !account.currency) throw new AdsApiError('Ad account currency or timezone is unavailable. Retry before using this report.', 502, 'ADS_REPORT_INCOMPLETE');
    const ranges = getAdsDateRanges(account.timezone_name, now);
    const historySince = new Date(Date.parse(`${ranges.currentRange.since}T00:00:00Z`) - 21 * 86400000).toISOString().slice(0, 10);
    const params = (range: { since: string; until: string }) => ({
        fields: INSIGHT_FIELDS, level: 'ad', time_range: JSON.stringify(range),
        use_unified_attribution_setting: 'true', action_report_time: 'impression'
    });
    return withDeadline(40000, async signal => {
        const [metadata, current, previous, daily] = await Promise.all([
            graphList<MetaAd>(`${account.id}/ads`, token, {
                fields: 'id,name,effective_status,created_time,updated_time,campaign{id,name,daily_budget,lifetime_budget,updated_time},adset{id,name,daily_budget,lifetime_budget,updated_time,learning_stage_info,optimization_goal},creative{actor_id,object_story_spec,effective_object_story_id,object_story_id}',
                time_range: JSON.stringify({ since: historySince, until: ranges.currentRange.until })
            }, signal),
            graphList<MetaInsight>(`${account.id}/insights`, token, params(ranges.currentRange), signal),
            graphList<MetaInsight>(`${account.id}/insights`, token, params(ranges.previousRange), signal),
            graphList<MetaInsight>(`${account.id}/insights`, token, { ...params({ since: historySince, until: ranges.currentRange.until }), time_increment: '1' }, signal)
        ]);
        const adsById = new Map(metadata.map(ad => [ad.id, ad]));
        const currentById = new Map(current.map(row => [row.ad_id, row]));
        const previousById = new Map(previous.map(row => [row.ad_id, row]));
        const dailyById = new Map<string, Map<string, MetaInsight>>();
        for (const row of daily) {
            if (!dailyById.has(row.ad_id)) dailyById.set(row.ad_id, new Map());
            dailyById.get(row.ad_id)!.set(row.date_start, row);
        }
        const ids = new Set([...adsById.keys(), ...currentById.keys(), ...previousById.keys(), ...dailyById.keys()]);
        const warnings: string[] = [];
        let unknownPages = 0;
        const ads: GuardAd[] = [...ids].map(id => {
            const ad = adsById.get(id);
            const row = currentById.get(id) || previousById.get(id);
            const pageId = getCreativePageId(ad?.creative);
            if (!pageId) unknownPages++;
            const allDays: AdDailyMetrics[] = Array.from({ length: 28 }, (_, i) => {
                const date = new Date(Date.parse(`${historySince}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
                const metrics = normalizeInsight(dailyById.get(id)?.get(date), goal);
                return { date, spend: metrics.spend, results: metrics.results, impressions: metrics.impressions, linkClicks: metrics.linkClicks, revenue: metrics.revenue };
            });
            const days = allDays.slice(-7);
            const currentMetrics = normalizeInsight(currentById.get(id), goal);
            const dailySpend = days.reduce((sum, day) => sum + day.spend, 0);
            const previousMetrics = normalizeInsight(previousById.get(id), goal);
            const previousDailySpend = allDays.slice(-14, -7).reduce((sum, day) => sum + day.spend, 0);
            const dailyResults = days.reduce((sum, day) => sum + day.results, 0);
            if (Math.abs(dailySpend - currentMetrics.spend) > Math.max(0.1, currentMetrics.spend * 0.005)
                || Math.abs(previousDailySpend - previousMetrics.spend) > Math.max(0.1, previousMetrics.spend * 0.005)
                || Math.abs(dailyResults - currentMetrics.results) > Math.max(1, currentMetrics.results * 0.02)) {
                throw new AdsApiError('Daily spend does not reconcile with the weekly report. Meta may be updating reporting; retry before making decisions.', 502, 'ADS_REPORT_INCOMPLETE');
            }
            currentMetrics.activeDays = days.filter(d => d.spend > 0 || d.results > 0).length;
            const campaignBudget = numeric(ad?.campaign?.daily_budget) > 0 || numeric(ad?.campaign?.lifetime_budget) > 0;
            const adsetBudget = numeric(ad?.adset?.daily_budget) > 0 || numeric(ad?.adset?.lifetime_budget) > 0;
            const updatedTimes = [ad?.updated_time, ad?.adset?.updated_time, ad?.campaign?.updated_time]
                .filter((time): time is string => Boolean(time) && Number.isFinite(Date.parse(time!)))
                .sort((a, b) => Date.parse(b) - Date.parse(a));
            return {
                id, name: ad?.name || row?.ad_name || id,
                campaignId: ad?.campaign?.id || row?.campaign_id || '', campaignName: ad?.campaign?.name || row?.campaign_name || 'Unknown campaign',
                adsetId: ad?.adset?.id || row?.adset_id || '', adsetName: ad?.adset?.name || row?.adset_name || 'Unknown ad set',
                pageId, status: ad?.effective_status || 'UNKNOWN', createdTime: ad?.created_time || null,
                updatedTime: updatedTimes[0] || null, budgetOwner: campaignBudget ? 'campaign' : adsetBudget ? 'adset' : 'unknown',
                current: currentMetrics, previous: previousMetrics, daily: days,
                history: allDays.slice(0, -7), learningStatus: ad?.adset?.learning_stage_info?.status,
                optimizationGoal: ad?.adset?.optimization_goal
            };
        });
        if (unknownPages) warnings.push(`${unknownPages} ad(s) could not be matched to a Facebook Page. They appear under All account ads and are excluded from individual Page filters.`);
        if (ads.length && !ads.some(ad => ad.current.results > 0)) warnings.push(`No ${goal} were reported in this window. Verify that the selected result event matches your ads and that tracking works before pausing anything.`);
        return { account, goal, ...ranges, fetchedAt: now.toISOString(), ads, warnings };
    });
}
