import { describe, expect, it } from 'vitest';
import { adjustFalseDiscoveryRates, estimateRate, gammaCdf, gammaQuantile, probabilityCostIncrease, resultDispersion } from '../ads-statistics';
import { evaluateAds } from '../ads-guard';
import { createAdsGuardDemo, DEMO_GUARD_SETTINGS } from '../ads-guard-demo';

describe('advertising uncertainty model', () => {
    it('matches closed-form Gamma distributions and inverts their quantiles', () => {
        expect(gammaCdf(1, 2, 1)).toBeCloseTo(1 - Math.exp(-2), 10);
        expect(gammaCdf(2, 1, 3)).toBeCloseTo(1 - Math.exp(-3) * 4, 10);
        expect(gammaQuantile(1, 2, 0.95)).toBeCloseTo(-Math.log(0.05) / 2, 8);
        expect(gammaCdf(100000, 1, gammaQuantile(100000, 1, 0.95))).toBeCloseTo(0.95, 6);
    });
    it('widens uncertainty when results cluster into one day despite equal spend', () => {
        const steady = Array.from({ length: 5 }, () => ({ spend: 100, results: 10 }));
        const clustered = steady.map((day, i) => ({ ...day, results: i === 0 ? 50 : 0 }));
        expect(resultDispersion(steady)).toBe(1);
        expect(resultDispersion(clustered)).toBeGreaterThan(1);
        const a = estimateRate(steady, 20); const b = estimateRate(clustered, 20);
        expect(gammaQuantile(b.shape, b.rate, 0.95) - gammaQuantile(b.shape, b.rate, 0.05))
            .toBeGreaterThan(gammaQuantile(a.shape, a.rate, 0.95) - gammaQuantile(a.shape, a.rate, 0.05));
    });
    it('separates a meaningful deterioration from equal underlying rates', () => {
        const baseline = estimateRate([{ spend: 1000, results: 100 }], 20);
        const worse = estimateRate([{ spend: 1000, results: 30 }], 20);
        expect(probabilityCostIncrease(worse, baseline, 30)).toBeGreaterThan(0.99);
        expect(probabilityCostIncrease(baseline, baseline, 30)).toBeLessThan(0.1);
    });
    it('corrects account-wide screening for multiple comparisons', () => {
        const scores = adjustFalseDiscoveryRates([{ id: 'a', probability: 0.01 }, { id: 'b', probability: 0.03 }, { id: 'c', probability: 0.8 }]);
        expect(scores.get('a')).toBeCloseTo(0.03);
        expect(scores.get('b')).toBeCloseTo(0.045);
        expect(scores.get('c')).toBeCloseTo(0.8);
    });
    it('holds an efficient ad when the shared campaign budget contains expensive siblings', () => {
        const report = createAdsGuardDemo();
        const costly = { ...report.ads[0], current: { ...report.ads[0].current, spend: 8400 },
            daily: report.ads[0].daily.map(day => ({ ...day, spend: day.spend * 4 })) };
        report.ads = [report.ads[3], costly].map(ad => ({ ...ad, budgetOwner: 'campaign' as const }));
        const winner = evaluateAds(report, DEMO_GUARD_SETTINGS).find(row => row.ad.id === 'demo-3')!;
        expect(winner.decision.action).toBe('hold');
        expect(winner.decision.budgetGroupAds).toBe(2);
    });
    it('withholds scaling during learning and when account delivery is disabled', () => {
        const report = createAdsGuardDemo();
        report.ads = [{ ...report.ads[3], learningStatus: 'LEARNING' }];
        expect(evaluateAds(report, DEMO_GUARD_SETTINGS)[0].decision.action).toBe('wait');
        report.account.account_status = 2;
        expect(evaluateAds(report, DEMO_GUARD_SETTINGS)[0].decision.action).toBe('inactive');
    });
});
