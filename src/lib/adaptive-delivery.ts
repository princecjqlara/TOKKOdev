import { categorizeSendError } from './send-errors';
import type { MetaDeliveryFeedback } from './meta-delivery-feedback';

type Job = { start: () => void; reject: (error: unknown) => void; allowed?: () => boolean };

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
    private growthAfter = 0;
    private queue: Job[] = [];
    private timer?: ReturnType<typeof setTimeout>;

    constructor(readonly maximum: number, learned: number, intervalMs: number, growthAfter = 0) {
        this.concurrency = Math.max(1, Math.min(maximum, learned));
        this.intervalMs = Math.max(0, Math.min(5000, intervalMs));
        this.lastGrowth = Date.now();
        this.deferGrowth(growthAfter);
    }

    deferGrowth(until: number) {
        if (Number.isFinite(until)) this.growthAfter = Math.max(this.growthAfter, until);
    }

    observeSuccess(feedback?: MetaDeliveryFeedback) {
        if (feedback?.usagePercent !== undefined) this.lastUsage = { percent: feedback.usagePercent, at: Date.now() };
        const usage = feedback?.usagePercent ??
            (this.lastUsage && Date.now() - this.lastUsage.at < 30_000 ? this.lastUsage.percent : 0);
        if (feedback?.retryAfterMs && feedback.retryAfterMs > 0) {
            this.pause(feedback.retryAfterMs, feedback.scope, true); return;
        }
        if (usage >= 100) {
            // An accepted send with a usage header is not a rejected request.
            // Keep a conservative trickle instead of escalating synthetic 429s
            // into long shared cooldowns. Actual throttles still pause below.
            this.clean = 0;
            this.concurrency = 1;
            this.intervalMs = 5000;
            this.nextStart = Math.max(this.nextStart, Date.now() + this.intervalMs);
            this.lastReduction = Date.now();
            this.pump(); return;
        }
        if (usage >= 70) {
            this.clean = 0;
            if (feedback?.usagePercent !== undefined && Date.now() - this.lastReduction >= 2000) {
                this.concurrency = Math.max(1, Math.floor(this.concurrency * (usage >= 90 ? 0.5 : 0.75)));
                this.intervalMs = Math.min(5000, Math.max(50, Math.ceil(this.intervalMs * 1.5)));
                this.lastReduction = Date.now();
            }
        } else if (usage < 50 && !this.limited && Date.now() >= this.growthAfter) {
            this.clean++;
            // Slow workers may restart before collecting 25 responses. Require
            // a bounded period of clean sending so short slices can recover too.
            const growthSamples = feedback?.usagePercent !== undefined ? 5
                : Math.max(3, Math.min(25, Math.ceil(15_000 / Math.max(1, this.intervalMs))));
            // A cooldown ending is not evidence of restored capacity. Probe
            // gradually after recovery, including when quota headers are absent.
            const growthInterval = this.growthAfter > 0 || feedback?.usagePercent === undefined ? 15_000 : 1000;
            if (this.clean >= growthSamples && Date.now() - this.lastGrowth >= growthInterval) {
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
        else if (['recipient_unavailable', 'conversation_unavailable', 'outside_messaging_window',
            'thread_controlled_by_another_app'].includes(category)) {
            // A recipient rejection is still a completed provider request with
            // useful quota feedback. Preserve the rejection, but do not make
            // low-deliverability audiences learn capacity only from successes.
            this.observeSuccess(details);
        }
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
            try {
                if (job.allowed && !job.allowed()) {
                    job.reject(new Error('Delivery temporarily unavailable or stopped. Unsent recipients remain queued.'));
                    continue;
                }
            } catch (error) { job.reject(error); continue; }
            this.nextStart = Date.now() + this.intervalMs;
            job.start();
        }
    }
}
