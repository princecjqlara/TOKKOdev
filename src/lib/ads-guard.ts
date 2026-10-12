import { adjustFalseDiscoveryRates, estimateRate, gammaCdf, gammaQuantile, probabilityCostIncrease } from './ads-statistics';

export type AdsGoal = 'messages' | 'leads' | 'purchases';
export type AdsAction = 'pause' | 'refresh' | 'reduce' | 'scale' | 'wait' | 'hold' | 'inactive' | 'configure';

export const ADS_GOAL_LABELS: Record<AdsGoal, string> = {
    messages: 'Messenger conversations', leads: 'Leads', purchases: 'Purchases'
};
export const ADS_ACTION_LABELS: Record<AdsAction, string> = {
    pause: 'Consider pausing', refresh: 'Refresh creative', reduce: 'Reduce / investigate',
    scale: 'Consider scaling', wait: 'Gather more data', hold: 'Keep running',
    inactive: 'Check delivery', configure: 'Set your target'
};

export interface AdsMetrics {
    spend: number;
    impressions: number;
    linkClicks: number;
    results: number;
    revenue: number | null;
    reach: number;
    frequency: number | null;
    activeDays: number;
}

export interface GuardAd {
    id: string;
    name: string;
    campaignId: string;
    campaignName: string;
    adsetId: string;
    adsetName: string;
    pageId: string | null;
    status: string;
    createdTime: string | null;
    updatedTime: string | null;
    budgetOwner: 'campaign' | 'adset' | 'unknown';
    current: AdsMetrics;
    previous: AdsMetrics;
    daily: AdDailyMetrics[];
    history?: AdDailyMetrics[];
    learningStatus?: string;
    optimizationGoal?: string;
}

export interface AdDailyMetrics {
    date: string; spend: number; results: number;
    impressions?: number; linkClicks?: number; revenue?: number | null;
}

export interface AdsAccount {
    id: string;
    name: string;
    currency: string;
    timezone_name: string;
    account_status: number;
}

export interface AdsReport {
    account: AdsAccount;
    goal: AdsGoal;
    currentRange: { since: string; until: string };
    previousRange: { since: string; until: string };
    fetchedAt: string;
    ads: GuardAd[];
    warnings: string[];
}

export interface GuardSettings {
    targetCpa: number;
    targetRoas: number;
    minResults: number;
    minDays: number;
    attributionLagDays: number;
    stopLossMultiple: number;
    costRisePercent: number;
    fatigueFrequency: number;
    ctrDropPercent: number;
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
    targetCpa: 0, targetRoas: 0, minResults: 20, minDays: 3,
    attributionLagDays: 2, stopLossMultiple: 3, costRisePercent: 30,
    fatigueFrequency: 3, ctrDropPercent: 20
};

export interface AdDecision {
    action: AdsAction;
    priority: number;
    evidence: 'strong' | 'moderate' | 'limited';
    reason: string;
    fixes: string[];
    cautions: string[];
    cpa: number | null;
    previousCpa: number | null;
    cpaChange: number | null;
    ctr: number | null;
    ctrChange: number | null;
    cpm: number | null;
    cpmChange: number | null;
    roas: number | null;
    recentCpa: number | null;
    probabilityAtTarget: number | null;
    probabilityMeetingTarget: number | null;
    cpaRange: { low: number; high: number } | null;
    costIncreaseProbability: number | null;
    adjustedRiskScore: number | null;
    dispersion: number;
    settledSpend: number;
    settledResults: number;
    budgetGroupCpa: number | null;
    budgetGroupAds: number;
    diagnostics: string[];
    recheck: string;
}

type DecisionContext = { adjustedRiskScore?: number; priorRate?: number; budgetAds?: GuardAd[]; accountActive?: boolean };

export function ratio(numerator: number, denominator: number): number | null {
    return denominator > 0 ? numerator / denominator : null;
}

export function percentChange(current: number | null, previous: number | null): number | null {
    return current !== null && previous !== null && previous > 0
        ? (current / previous - 1) * 100 : null;
}

// A Poisson spend-to-result model is a screening heuristic, not a causal test.
// P(N <= observed | expected = spend / target CPA). Ads can violate its assumptions.
export function poissonLowerTail(observed: number, expected: number): number {
    if (!(expected > 0)) return 1;
    const n = Math.max(0, Math.floor(observed));
    if (expected > 200 || n > 200) {
        const z = (n + 0.5 - expected) / Math.sqrt(expected);
        const x = Math.abs(z) / Math.sqrt(2);
        const t = 1 / (1 + 0.3275911 * x);
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
            - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return Math.max(0, Math.min(1, (1 + Math.sign(z) * erf) / 2));
    }
    let term = Math.exp(-expected);
    let total = term;
    for (let k = 1; k <= n; k++) {
        term *= expected / k;
        total += term;
    }
    return Math.min(1, total);
}

export function validateGuardSettings(settings: GuardSettings): boolean {
    const ranges: Record<keyof GuardSettings, [number, number]> = {
        targetCpa: [0, 1e9], targetRoas: [0, 1000], minResults: [5, 10000],
        minDays: [3, 7], attributionLagDays: [1, 6], stopLossMultiple: [3, 20],
        costRisePercent: [5, 500], fatigueFrequency: [1, 50], ctrDropPercent: [5, 95]
    };
    return settings.minDays + settings.attributionLagDays <= 7 && Object.entries(ranges).every(([key, [min, max]]) => {
        const value = settings[key as keyof GuardSettings];
        return Number.isFinite(value) && value >= min && value <= max &&
            (!['minResults', 'minDays', 'attributionLagDays'].includes(key) || Number.isInteger(value));
    });
}

export function evaluateAd(ad: GuardAd, settings: GuardSettings, goal: AdsGoal, asOf: string, context: DecisionContext = {}): AdDecision {
    const c = ad.current;
    const p = ad.previous;
    const cpa = ratio(c.spend, c.results);
    const previousCpa = ratio(p.spend, p.results);
    const ctr = ratio(c.linkClicks * 100, c.impressions);
    const previousCtr = ratio(p.linkClicks * 100, p.impressions);
    const cpm = ratio(c.spend * 1000, c.impressions);
    const previousCpm = ratio(p.spend * 1000, p.impressions);
    const cpaChange = percentChange(cpa, previousCpa);
    const ctrChange = percentChange(ctr, previousCtr);
    const cpmChange = percentChange(cpm, previousCpm);
    const roas = c.revenue === null ? null : ratio(c.revenue, c.spend);
    // All rows are completed account-local days. Ignore the newest days for decisive rules.
    const matureDays = ad.daily.slice(0, Math.max(0, ad.daily.length - settings.attributionLagDays));
    const matureSpend = matureDays.reduce((sum, day) => sum + day.spend, 0);
    const matureResults = matureDays.reduce((sum, day) => sum + day.results, 0);
    const matureActiveDays = matureDays.filter(day => day.spend > 0 || day.results > 0).length;
    const recentDays = ad.daily.slice(-3);
    const recentSpend = recentDays.reduce((sum, day) => sum + day.spend, 0);
    const recentResults = recentDays.reduce((sum, day) => sum + day.results, 0);
    const recentCpa = ratio(recentSpend, recentResults);
    const probabilityAtTarget = settings.targetCpa > 0 && matureSpend > 0
        ? poissonLowerTail(matureResults, matureSpend / settings.targetCpa) : null;
    const posterior = settings.targetCpa > 0 && matureSpend > 0 ? estimateRate(matureDays, settings.targetCpa, context.priorRate) : null;
    const probabilityMeetingTarget = posterior ? 1 - gammaCdf(posterior.shape, posterior.rate, 1) : null;
    const cpaRange = posterior ? {
        low: settings.targetCpa / gammaQuantile(posterior.shape, posterior.rate, 0.95),
        high: settings.targetCpa / gammaQuantile(posterior.shape, posterior.rate, 0.05)
    } : null;
    const baselineDays = ad.history?.slice(-7, -settings.attributionLagDays) || [];
    const baselineResults = baselineDays.reduce((sum, day) => sum + day.results, 0);
    const baselinePosterior = baselineDays.some(day => day.spend > 0) && settings.targetCpa > 0
        ? estimateRate(baselineDays, settings.targetCpa, context.priorRate) : null;
    const costIncreaseProbability = posterior && baselinePosterior && baselineResults >= settings.minResults
        ? probabilityCostIncrease(posterior, baselinePosterior, settings.costRisePercent) : null;
    const adjustedRiskScore = context.adjustedRiskScore ?? probabilityAtTarget;
    const budgetAds = context.budgetAds || [ad];
    const budgetDays = matureDays.map((day, index) => ({
        spend: budgetAds.reduce((sum, member) => sum + (member.daily[index]?.spend || 0), 0),
        results: budgetAds.reduce((sum, member) => sum + (member.daily[index]?.results || 0), 0)
    }));
    const groupSpend = budgetDays.reduce((sum, day) => sum + day.spend, 0);
    const groupResults = budgetDays.reduce((sum, day) => sum + day.results, 0);
    const budgetGroupCpa = ratio(groupSpend, groupResults);
    const budgetPosterior = groupSpend > 0 && settings.targetCpa > 0 ? estimateRate(budgetDays, settings.targetCpa) : null;
    const budgetHealthy = budgetPosterior !== null && groupResults >= settings.minResults
        && 1 - gammaCdf(budgetPosterior.shape, budgetPosterior.rate, 1) >= 0.9;
    const diagnostics: string[] = [];
    const conversionRateChange = percentChange(ratio(c.results, c.linkClicks), ratio(p.results, p.linkClicks));
    if (cpmChange !== null && cpmChange >= 20) diagnostics.push(`Auction cost: CPM increased ${cpmChange.toFixed(0)}%. Check audience restrictions and placement mix.`);
    if (ctrChange !== null && ctrChange <= -settings.ctrDropPercent) diagnostics.push(`Creative response: link CTR declined ${Math.abs(ctrChange).toFixed(0)}%. Test a new hook and visual.`);
    if (conversionRateChange !== null && conversionRateChange < -20) diagnostics.push(`Conversion path: reported results per link click fell ${Math.abs(conversionRateChange).toFixed(0)}%. Check the offer, form, checkout, or response speed. View-attributed results can affect this ratio.`);
    if (posterior && posterior.dispersion > 1.5) diagnostics.push(`Results are uneven across days (${posterior.dispersion.toFixed(1)}× Poisson variance); uncertainty is widened and scaling is held back.`);
    if (budgetAds.length > 1) diagnostics.push(`This budget is shared by ${budgetAds.length} reported ads. Settled group CPA: ${budgetGroupCpa === null ? 'no reported results' : budgetGroupCpa.toFixed(2)}.`);
    const base = {
        cpa, previousCpa, cpaChange, ctr, ctrChange, cpm, cpmChange, roas, recentCpa, probabilityAtTarget,
        probabilityMeetingTarget, cpaRange, costIncreaseProbability, adjustedRiskScore,
        dispersion: posterior?.dispersion || 1, settledSpend: matureSpend, settledResults: matureResults,
        budgetGroupCpa, budgetGroupAds: budgetAds.length, diagnostics,
        recheck: matureResults < settings.minResults
            ? `Review after ${Math.max(0, settings.minResults - matureResults)} more settled results or if the test budget is reached.`
            : `Review after ${settings.attributionLagDays + 1} more completed day(s), keeping changes limited to one variable.`
    };
    const cautions = [
        `The newest ${settings.attributionLagDays} completed day(s) are excluded from decisive CPA rules because attributed results can arrive late.`
    ];
    const decide = (action: AdsAction, priority: number, evidence: AdDecision['evidence'], reason: string, fixes: string[]): AdDecision => ({
        ...base, action, priority, evidence, reason, fixes, cautions,
        recheck: action === 'pause' ? 'Verify tracking and review this ad now. Evaluate its replacement after enough settled delivery.'
            : action === 'scale' ? 'Recheck the entire budget group after at least 3 settled delivery days following a change.'
            : base.recheck
    });

    if (!validateGuardSettings(settings)) {
        return decide('configure', 0, 'limited', 'Some guard settings are invalid.', ['Use valid positive thresholds and whole numbers for minimum results, days, and attribution delay.']);
    }
    if (ad.status !== 'ACTIVE' || context.accountActive === false) {
        return decide('inactive', 10, 'limited', context.accountActive === false
            ? 'The ad account is not active; resolve its delivery issue before optimizing ads.'
            : `Meta reports ${ad.status.replace(/_/g, ' ').toLowerCase()} delivery.`, ['Check ad, ad set, and campaign delivery in Ads Manager before restarting or changing budget.']);
    }
    if (!(settings.targetCpa > 0)) {
        return decide('configure', 0, 'limited', 'Set the maximum cost per result your business can afford.', ['For messages or leads, estimate target cost from lead-to-sale rate × contribution margin per sale.', 'Choose the result event you actually optimize for.']);
    }
    if (c.spend === 0) {
        return decide('wait', 15, 'limited', 'No spend in the last 7 completed days.', ['Check delivery, schedule, payment, audience size, and approval in Ads Manager.']);
    }

    const elapsedSince = (time: string | null) => time ? (Date.parse(asOf) - Date.parse(time)) / 86400000 : null;
    const age = elapsedSince(ad.createdTime);
    const sinceEdit = elapsedSince(ad.updatedTime);
    const fresh = (age !== null && age < settings.minDays + settings.attributionLagDays)
        || (sinceEdit !== null && sinceEdit < settings.minDays + settings.attributionLagDays);
    if (fresh || matureActiveDays < settings.minDays || ad.learningStatus === 'LEARNING') {
        return decide('wait', 20, 'limited', 'Not enough settled delivery since launch or the latest ad edit.', [
            `Collect at least ${settings.minDays} delivery days outside the attribution delay before making a performance decision.`,
            'Keep a fixed test budget and check tracking while results settle.'
        ]);
    }

    const comparable = c.results >= settings.minResults && p.results >= settings.minResults
        && c.impressions >= 1000 && p.impressions >= 1000;
    const fatigue = comparable && c.frequency !== null && c.frequency >= settings.fatigueFrequency
        && ctrChange !== null && ctrChange <= -settings.ctrDropPercent
        && cpaChange !== null && cpaChange >= settings.costRisePercent;
    if (fatigue) cautions.push('Fatigue is suspected from combined signals; frequency alone does not establish fatigue. Retargeting may tolerate higher frequency.');

    const poor = adjustedRiskScore !== null && adjustedRiskScore < 0.05
        && probabilityMeetingTarget !== null && probabilityMeetingTarget < 0.05;
    const stopLoss = matureSpend >= settings.targetCpa * settings.stopLossMultiple;
    const matureCpa = ratio(matureSpend, matureResults);
    if (stopLoss && poor && (matureResults === 0 || (matureCpa !== null && matureCpa >= settings.targetCpa * 1.5))) {
        if (goal === 'purchases') cautions.push('Verify purchase event tracking and offline sales before pausing; Meta-reported results are not your accounting ledger.');
        return decide('pause', 100, matureResults >= settings.minResults ? 'strong' : 'moderate',
            matureResults === 0
                ? `Settled spend exceeded ${settings.stopLossMultiple}× target CPA without a reported result.`
                : 'Settled cost per result is at least 50% above target, with weak evidence that the ad meets your target.',
            ['Verify the selected conversion event and attribution before acting.',
                fatigue ? 'Test a new opening hook, image/video, and offer before restarting.' : 'Inspect the offer, audience, and conversion path; test one change at a time.',
                'Consider pausing this ad in Ads Manager and keep a controlled budget for its replacement.']);
    }
    if (fatigue) {
        return decide('refresh', 85, 'moderate', 'Frequency is high, link CTR fell, and cost per result rose versus the previous 7 days.', [
            'Launch 2–3 new creative concepts with different hooks, visuals, or customer proof.',
            'Check audience saturation and exclusions; evaluate prospecting and retargeting separately.',
            'Compare the replacement at similar spend before retiring the original.'
        ]);
    }
    if (matureResults < settings.minResults) {
        return decide('wait', 25, 'limited', `Only ${matureResults} settled results; the minimum is ${settings.minResults}.`, [
            `Collect ${settings.minResults - matureResults} more settled results within your test budget.`,
            `Recheck after more delivery; the stop-loss remains ${settings.stopLossMultiple}× target CPA for statistically weak performance.`
        ]);
    }
    const costRising = comparable && cpaChange !== null && cpaChange >= settings.costRisePercent
        && (costIncreaseProbability === null || costIncreaseProbability >= 0.8);
    const roasPoor = goal === 'purchases' && settings.targetRoas > 0 && roas !== null && roas < settings.targetRoas;
    if ((matureCpa !== null && matureCpa > settings.targetCpa) || costRising || roasPoor) {
        const fixes = [cpmChange !== null && cpmChange >= 20
            ? 'CPM rose: check auction competition, audience restrictions, and placement mix.'
            : ctrChange !== null && ctrChange <= -settings.ctrDropPercent
                ? 'Link CTR fell: test a stronger hook, clearer benefit, and new visual.'
                : 'Inspect the conversion path: offer clarity, form friction, checkout, or Messenger response time.',
        'Consider a small budget reduction at the owning ad set or campaign; inspect its other ads first.',
        'Change one variable and compare a full settled window before making another change.'];
        return decide('reduce', 75, 'moderate', roasPoor
            ? 'Reported purchase ROAS is below your minimum.'
            : costRising ? `Cost per result rose at least ${settings.costRisePercent}% versus the previous 7 days.`
                : 'Settled cost per result is above your target.', fixes);
    }
    // Conservative approximate upper CPA from the lower Poisson rate bound.
    const upperCpa = cpaRange?.high ?? null;
    const recentSettled = matureDays.slice(-3);
    const recentSettledSpend = recentSettled.reduce((sum, day) => sum + day.spend, 0);
    const recentSettledResults = recentSettled.reduce((sum, day) => sum + day.results, 0);
    const recentStable = recentSettledResults >= 5 && recentSettledSpend / recentSettledResults <= settings.targetCpa
        && recentCpa !== null && recentCpa <= settings.targetCpa && recentResults >= 5;
    const revenueReady = goal !== 'purchases' || (settings.targetRoas > 0 && roas !== null && roas >= settings.targetRoas * 1.2);
    const historicalStable = comparable && (cpaChange === null || cpaChange <= 10)
        && (ctrChange === null || ctrChange > -settings.ctrDropPercent);
    if (upperCpa !== null && upperCpa <= settings.targetCpa && matureCpa !== null
        && matureCpa <= settings.targetCpa * 0.8 && recentStable && historicalStable && revenueReady
        && budgetHealthy && ad.budgetOwner !== 'unknown' && (posterior?.dispersion || 1) < 1.5
        && probabilityMeetingTarget !== null && probabilityMeetingTarget >= 0.975
        && ad.learningStatus !== 'LEARNING_LIMITED') {
        cautions.push(`Budget belongs to the ${ad.budgetOwner}; review the entire budget group before increasing spend.`);
        return decide('scale', 60, 'strong', 'Settled CPA has room below target, the previous week is comparable, and recent performance is stable.', [
            `Review all ads sharing this ${ad.budgetOwner === 'campaign' ? 'campaign' : 'ad set'} budget.`,
            'If the whole budget group meets your targets, consider a 10% increase in Ads Manager.',
            'Recheck after at least 3 settled delivery days; roll back if group CPA or ROAS breaks your target.'
        ]);
    }
    if (goal === 'purchases' && (roas === null || settings.targetRoas <= 0)) {
        cautions.push('Scaling is withheld until purchase value is available and a minimum ROAS is configured.');
    }
    if (!budgetHealthy || ad.budgetOwner === 'unknown') cautions.push('Scaling is withheld because the shared budget is not reliably within target or its owner is unknown.');
    return decide('hold', 35, 'moderate', 'Settled cost is within target; the evidence does not yet support increasing budget.', [
        'Keep the current budget and monitor the next completed days.',
        'Prepare a replacement creative before performance declines.'
    ]);
}

export function evaluateAds(report: AdsReport, settings: GuardSettings): Array<{ ad: GuardAd; decision: AdDecision }> {
    const mature = (ad: GuardAd) => ad.daily.slice(0, Math.max(0, ad.daily.length - settings.attributionLagDays));
    const candidates = report.ads.filter(ad => ad.status === 'ACTIVE' && mature(ad).filter(day => day.spend > 0).length >= settings.minDays);
    const risks = candidates.map(ad => {
        const days = mature(ad);
        return { id: ad.id, probability: settings.targetCpa > 0
            ? poissonLowerTail(days.reduce((sum, day) => sum + day.results, 0), days.reduce((sum, day) => sum + day.spend, 0) / settings.targetCpa) : 1 };
    });
    const adjusted = adjustFalseDiscoveryRates(risks);
    const groupKey = (ad: GuardAd) => ad.budgetOwner === 'campaign' ? `campaign:${ad.campaignId}` : `adset:${ad.adsetId}`;
    const groups = new Map<string, GuardAd[]>();
    for (const ad of report.ads) {
        const key = groupKey(ad);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(ad);
    }
    return report.ads.map(ad => {
        // Leave-one-out robust portfolio prior. At most one pseudo-result, so
        // strong observations dominate while small samples shrink toward peers.
        const peerRates = candidates.filter(peer => peer.id !== ad.id).flatMap(peer => {
            const days = mature(peer);
            const results = days.reduce((sum, day) => sum + day.results, 0);
            const spend = days.reduce((sum, day) => sum + day.spend, 0);
            return results >= settings.minResults && spend > 0 ? [results * settings.targetCpa / spend] : [];
        }).sort((a, b) => a - b);
        const priorRate = peerRates.length ? Math.max(0.35, Math.min(3, peerRates[Math.floor(peerRates.length / 2)])) : 1;
        return { ad, decision: evaluateAd(ad, settings, report.goal, report.fetchedAt, {
            adjustedRiskScore: adjusted.get(ad.id), priorRate, budgetAds: groups.get(groupKey(ad)),
            accountActive: report.account.account_status === 1
        }) };
    });
}
