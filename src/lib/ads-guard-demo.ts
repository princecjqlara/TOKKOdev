import { DEFAULT_GUARD_SETTINGS, type AdsMetrics, type AdsReport, type GuardAd } from './ads-guard';

export const DEMO_GUARD_SETTINGS = { ...DEFAULT_GUARD_SETTINGS, targetCpa: 45 };

export function createAdsGuardDemo(): AdsReport {
    const metrics = (spend: number, results: number, clicks: number, frequency = 1.8): AdsMetrics => ({
        spend, results, impressions: 10000, linkClicks: clicks, frequency,
        reach: Math.round(10000 / frequency), revenue: null, activeDays: 7
    });
    const scenarios = [
        { name: 'Summer offer · no conversations', current: metrics(2100, 0, 190), previous: metrics(1800, 20, 220) },
        { name: 'Customer story · tired creative', current: metrics(3150, 70, 110, 4.5), previous: metrics(2100, 80, 240, 2) },
        { name: 'Product demo · rising costs', current: metrics(3500, 60, 200), previous: metrics(1800, 60, 210) },
        { name: 'Founder video · efficient winner', current: metrics(1400, 110, 350), previous: metrics(1500, 110, 350) },
        { name: 'New hook · early test', current: metrics(160, 3, 22), previous: metrics(0, 0, 0) },
        { name: 'Best seller · steady delivery', current: metrics(2100, 60, 230), previous: metrics(2150, 61, 235) }
    ];
    const ads: GuardAd[] = scenarios.map((scenario, i) => ({
        id: `demo-${i}`, name: scenario.name, campaignId: 'demo-campaign', campaignName: 'Messenger prospecting',
        adsetId: `demo-adset-${i}`, adsetName: 'Broad audience', pageId: 'demo-page', status: 'ACTIVE',
        createdTime: i === 4 ? '2026-10-11T00:00:00Z' : '2026-09-01T00:00:00Z',
        updatedTime: i === 4 ? '2026-10-11T00:00:00Z' : '2026-09-10T00:00:00Z',
        budgetOwner: 'adset', current: scenario.current, previous: scenario.previous,
        history: Array.from({ length: 21 }, (_, day) => ({
            date: new Date(Date.parse('2026-09-15T00:00:00Z') + day * 86400000).toISOString().slice(0, 10),
            spend: scenario.previous.spend / 7,
            results: Math.floor(scenario.previous.results / 7) + (day % 7 < scenario.previous.results % 7 ? 1 : 0),
            impressions: scenario.previous.impressions / 7, linkClicks: scenario.previous.linkClicks / 7
        })),
        daily: Array.from({ length: 7 }, (_, day) => ({
            date: `2026-10-${String(day + 6).padStart(2, '0')}`,
            spend: scenario.current.spend / 7,
            results: Math.floor(scenario.current.results / 7) + (day < scenario.current.results % 7 ? 1 : 0)
        }))
    }));
    return {
        account: { id: 'demo', name: 'Example ad account', currency: 'PHP', timezone_name: 'Asia/Manila', account_status: 1 },
        goal: 'messages', fetchedAt: '2026-10-13T00:00:00Z',
        currentRange: { since: '2026-10-06', until: '2026-10-12' },
        previousRange: { since: '2026-09-29', until: '2026-10-05' },
        ads, warnings: []
    };
}
