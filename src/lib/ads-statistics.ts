// Deterministic conjugate Gamma/Poisson screening; all probabilities are model
// estimates, not calibrated guarantees about future auction performance.
export function logGamma(z: number): number {
    const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531,
        -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = 0.9999999999998099;
    coefficients.forEach((coefficient, i) => { x += coefficient / (z + i + 1); });
    const t = z + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function gammaCdf(shape: number, rate: number, value: number): number {
    if (!(shape > 0 && rate > 0) || value <= 0) return 0;
    const x = value * rate;
    if (shape > 5000) {
        // Wilson–Hilferty approximation avoids an under-converged 500-term
        // series for accounts reporting hundreds of thousands of conversions.
        const z = (Math.cbrt(x / shape) - (1 - 1 / (9 * shape))) / Math.sqrt(1 / (9 * shape));
        const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.sqrt(2));
        const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
            - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
        return Math.max(0, Math.min(1, (1 + Math.sign(z) * erf) / 2));
    }
    const factor = Math.exp(shape * Math.log(x) - x - logGamma(shape));
    if (x < shape + 1) {
        let term = 1 / shape;
        let sum = term;
        for (let i = 1; i <= 500; i++) {
            term *= x / (shape + i); sum += term;
            if (Math.abs(term) < Math.abs(sum) * 1e-12) break;
        }
        return Math.max(0, Math.min(1, sum * factor));
    }
    let b = x + 1 - shape;
    let c = 1e30;
    let d = 1 / Math.max(1e-30, b);
    let h = d;
    for (let i = 1; i <= 500; i++) {
        const a = -i * (i - shape);
        b += 2;
        d = a * d + b; if (Math.abs(d) < 1e-30) d = 1e-30;
        c = b + a / c; if (Math.abs(c) < 1e-30) c = 1e-30;
        d = 1 / d;
        const delta = d * c; h *= delta;
        if (Math.abs(delta - 1) < 1e-12) break;
    }
    return Math.max(0, Math.min(1, 1 - factor * h));
}

export function gammaQuantile(shape: number, rate: number, probability: number): number {
    let lower = 0;
    let upper = Math.max(1, shape / rate + 15 * Math.sqrt(shape) / rate);
    while (gammaCdf(shape, rate, upper) < probability) upper *= 2;
    for (let i = 0; i < 65; i++) {
        const middle = (lower + upper) / 2;
        if (gammaCdf(shape, rate, middle) < probability) lower = middle; else upper = middle;
    }
    return (lower + upper) / 2;
}

export type EvidenceDay = { spend: number; results: number };
export interface RatePosterior { shape: number; rate: number; dispersion: number }

export function resultDispersion(days: EvidenceDay[]): number {
    const active = days.filter(day => day.spend > 0);
    const spend = active.reduce((sum, day) => sum + day.spend, 0);
    const results = active.reduce((sum, day) => sum + day.results, 0);
    if (active.length < 3 || results < 5 || spend <= 0) return 1;
    const residual = active.reduce((sum, day) => {
        const expected = results * day.spend / spend;
        return sum + (day.results - expected) ** 2 / Math.max(1, expected);
    }, 0);
    return Math.max(1, Math.min(20, residual / (active.length - 1)));
}

export function estimateRate(days: EvidenceDay[], targetCpa: number, priorRate = 1): RatePosterior {
    const dispersion = resultDispersion(days);
    const spend = days.reduce((sum, day) => sum + day.spend, 0);
    const results = days.reduce((sum, day) => sum + day.results, 0);
    // Weak prior equivalent to one result. Dispersion discounts both observed
    // counts and spend, widening uncertainty when conversions cluster by day.
    return { shape: 1 + results / dispersion, rate: 1 / priorRate + spend / targetCpa / dispersion, dispersion };
}

export function probabilityCostIncrease(current: RatePosterior, baseline: RatePosterior, increasePercent: number): number {
    let total = 0;
    // Integrate over deterministic baseline quantiles; no random output jitter.
    for (let i = 0; i < 40; i++) {
        const baselineRate = gammaQuantile(baseline.shape, baseline.rate, (i + 0.5) / 40);
        total += gammaCdf(current.shape, current.rate, baselineRate / (1 + increasePercent / 100));
    }
    return total / 40;
}

export function adjustFalseDiscoveryRates(values: Array<{ id: string; probability: number }>): Map<string, number> {
    const sorted = [...values].sort((a, b) => a.probability - b.probability);
    const adjusted = new Map<string, number>();
    let previous = 1;
    for (let i = sorted.length - 1; i >= 0; i--) {
        previous = Math.min(previous, sorted[i].probability * sorted.length / (i + 1));
        adjusted.set(sorted[i].id, Math.max(0, Math.min(1, previous)));
    }
    return adjusted;
}
