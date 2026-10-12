import { describe, expect, it } from 'vitest';
import { DEFAULT_GUARD_SETTINGS, evaluateAd, poissonLowerTail, validateGuardSettings } from '../ads-guard';
import type { GuardAd } from '../ads-guard';
import { createAdsGuardDemo, DEMO_GUARD_SETTINGS } from '../ads-guard-demo';

const report = createAdsGuardDemo();
const settings = DEMO_GUARD_SETTINGS;
const evaluate = (ad: GuardAd) => evaluateAd(ad, settings, 'messages', report.fetchedAt);

describe('Ads Guard recommendations', () => {
    it('distinguishes stop loss, fatigue, rising cost, efficient winners, early tests, and healthy ads', () => {
        expect(report.ads.map(ad => evaluate(ad).action)).toEqual(['pause', 'refresh', 'reduce', 'scale', 'wait', 'hold']);
    });
    it('requires a business target, and rejects settings that cannot fit the settled window', () => {
        expect(evaluateAd(report.ads[0], DEFAULT_GUARD_SETTINGS, 'messages', report.fetchedAt).action).toBe('configure');
        expect(validateGuardSettings({ ...settings, minDays: 6, attributionLagDays: 2 })).toBe(false);
        expect(validateGuardSettings({ ...settings, targetCpa: NaN })).toBe(false);
        expect(validateGuardSettings({ ...settings, minResults: 5.5 })).toBe(false);
    });
    it('does not pause an ad from fresh spend whose conversions have not settled', () => {
        const ad = { ...report.ads[0], daily: report.ads[0].daily.map((day, i) => ({ ...day, spend: i >= 5 ? 1000 : 1 })) };
        expect(evaluate(ad).action).toBe('wait');
    });
    it('guards ads after edits even when raw weekly CPA is very high', () => {
        expect(evaluate({ ...report.ads[0], updatedTime: '2026-10-12T00:00:00Z' }).action).toBe('wait');
    });
    it('does not label high frequency alone as fatigue', () => {
        const ad = { ...report.ads[5], current: { ...report.ads[5].current, frequency: 9 } };
        expect(evaluate(ad).action).toBe('hold');
    });
    it('withholds scaling without comparable previous-week data', () => {
        const ad = { ...report.ads[3], previous: { ...report.ads[3].previous, results: 0 } };
        expect(evaluate(ad).action).toBe('hold');
    });
    it('withholds purchase scaling without reported revenue or configured ROAS', () => {
        const ad = report.ads[3];
        expect(evaluateAd(ad, { ...settings, targetRoas: 2 }, 'purchases', report.fetchedAt).action).toBe('hold');
        expect(evaluateAd({ ...ad, current: { ...ad.current, revenue: 10000 } }, settings, 'purchases', report.fetchedAt).action).toBe('hold');
        expect(evaluateAd({ ...ad, current: { ...ad.current, revenue: 10000 } }, { ...settings, targetRoas: 2 }, 'purchases', report.fetchedAt).action).toBe('scale');
    });
    it('does not scale an apparent winner that deteriorated in the last 3 days', () => {
        const ad = { ...report.ads[3], daily: report.ads[3].daily.map((day, i) => ({ ...day, results: i >= 4 ? 1 : day.results })) };
        expect(evaluate(ad).action).toBe('hold');
    });
    it('does not recommend scaling or restarting paused and unknown ads', () => {
        expect(evaluate({ ...report.ads[3], status: 'PAUSED' }).action).toBe('inactive');
        expect(evaluate({ ...report.ads[3], status: 'UNKNOWN' }).action).toBe('inactive');
    });
    it('does not divide by zero or show infinite CPA for zero-result ads', () => {
        const decision = evaluate(report.ads[0]);
        expect(decision.cpa).toBeNull();
        expect(decision.cpaChange).toBeNull();
        expect(decision.probabilityAtTarget).toBeLessThan(0.05);
    });
});

describe('Poisson screening model', () => {
    it('matches the exact zero-result probability and handles large spend', () => {
        expect(poissonLowerTail(0, 3)).toBeCloseTo(Math.exp(-3), 10);
        expect(poissonLowerTail(0, 2000)).toBeLessThan(0.001);
        expect(poissonLowerTail(2000, 2000)).toBeGreaterThan(0.49);
        expect(poissonLowerTail(2000, 2000)).toBeLessThan(0.52);
        expect(poissonLowerTail(20, 0)).toBe(1);
    });
});
