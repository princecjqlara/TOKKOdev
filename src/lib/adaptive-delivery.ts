import { categorizeSendError } from './send-errors';
import type { MetaDeliveryFeedback } from './meta-delivery-feedback';

type Job = { start: () => void; reject: (error: Error) => void; allowed?: () => boolean };

/** A Page's learned concurrency plus message-level pacing, including multi-part sends. */
export class AdaptiveDeliveryController {
    concurrency: number;
    intervalMs: number;
    retryAt = 0;
    providerRetryAt = 0;
    limited = false;
    scope: 'page' | 'app' = 'page';
    private active = 0;
    private nextStart = 0;
    private clean = 0;
    private lastGrowth = 0;
    private lastReduction = -Infinity;
    private lastUsage?: { percent: number; at: number };
    private queue: Job[] = [];
    private timer?: ReturnType<typeof setTimeout>;

    constructor(readonly maximum: number, learned: number, intervalMs: number) {
        this.concurrency = Math.max(1, Math.min(maximum, learned));
        this.intervalMs = Math.max(0, Math.min(5000, intervalMs));
        this.lastGrowth = Date.now();
    }

    observeSuccess(feedback?: MetaDeliveryFeedback) {
        if (feedback?.usagePercent !== undefined) this.lastUsage = { percent: feedback.usagePercent, at: Date.now() };
        const usage = feedback?.usagePercent ??
            (this.lastUsage && Date.now() - this.lastUsage.at < 30_000 ? this.lastUsage.percent : 0);
        if (usage >= 100) { this.pause(feedback?.retryAfterMs || 60_000, feedback?.scope, Boolean(feedback?.retryAfterMs)); return; }
        if (usage >= 70) {
            this.clean = 0;
            if (feedback?.usagePercent !== undefined && Date.now() - this.lastReduction >= 2000) {
                this.concurrency = Math.max(1, Math.floor(this.concurrency * (usage >= 90 ? 0.5 : 0.75)));
                this.intervalMs = Math.min(5000, Math.max(50, Math.ceil(this.intervalMs * 1.5)));
                this.lastReduction = Date.now();
            }
        } else if (usage < 50 && !this.limited) {
            this.clean++;
            const growthSamples = feedback?.usagePercent !== undefined ? 5 : 25;
            if (this.clean >= growthSamples && Date.now() - this.lastGrowth >= 1000) {
                this.concurrency = Math.min(this.maximum, this.concurrency + Math.max(1, Math.floor(this.concurrency / 4)));
                this.intervalMs = this.intervalMs <= 5 ? 0 : Math.floor(this.intervalMs * 0.8);
                this.clean = 0; this.lastGrowth = Date.now();
            }
        } else this.clean = 0;
        this.pump();
    }

    private observeError(error: unknown) {
        const category = categorizeSendError(error);
        const details = error as MetaDeliveryFeedback & { code?: number };
        if (category === 'rate_limited') this.pause(details?.retryAfterMs || 60_000,
            [4, 17].includes(details?.code || 0) ? 'app' : details?.scope, Boolean(details?.retryAfterMs));
        else if (category === 'transient' && Date.now() - this.lastReduction >= 2000) {
            this.concurrency = Math.max(1, Math.floor(this.concurrency * 0.8));
            this.intervalMs = Math.min(5000, Math.ceil(this.intervalMs * 1.25));
            this.clean = 0; this.lastReduction = Date.now();
        }
    }

    pause(milliseconds: number, scope: 'page' | 'app' = 'page', providerSpecified = true) {
        if (!this.limited) {
            this.concurrency = Math.max(1, Math.floor(this.concurrency / 2));
            this.intervalMs = Math.min(5000, Math.max(100, this.intervalMs * 2));
        }
        this.limited = true;
        if (scope === 'app') this.scope = 'app';
        this.retryAt = Math.max(this.retryAt, Date.now() + milliseconds);
        if (providerSpecified) this.providerRetryAt = Math.max(this.providerRetryAt, Date.now() + milliseconds);
        this.pump();
    }

    run<T>(operation: () => Promise<T>, allowed?: () => boolean): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.queue.push({ reject, allowed, start: () => {
                this.active++;
                void (async () => {
                    try { resolve(await operation()); }
                    catch (error) { this.observeError(error); reject(error); }
                    finally { this.active--; this.pump(); }
                })();
            } });
            this.pump();
        });
    }

    private pump() {
        clearTimeout(this.timer); this.timer = undefined;
        if (this.limited) {
            const error = Object.assign(new Error('Meta rate limit recovery is in progress. Unsent recipients remain queued.'),
                { status: 429, retryAfterMs: Math.max(0, this.retryAt - Date.now()), scope: this.scope });
            for (const job of this.queue.splice(0)) job.reject(error);
            return;
        }
        while (this.queue.length && this.active < this.concurrency) {
            if (this.nextStart > Date.now()) {
                this.timer = setTimeout(() => this.pump(), this.nextStart - Date.now());
                return;
            }
            const job = this.queue.shift()!;
            if (job.allowed && !job.allowed()) {
                job.reject(new Error('Delivery temporarily unavailable or stopped. Unsent recipients remain queued.'));
                continue;
            }
            this.nextStart = Date.now() + this.intervalMs;
            job.start();
        }
    }
}
