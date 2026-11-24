import { Actor, log } from 'apify';

/**
 * Pay-per-event charging with the user's max-cost-per-run budget respected up front:
 * a page's events (page check + its changes) are charged together, and only when the whole page fits
 * in the remaining budget. If it doesn't, the run stops before delivering (and before saving the new
 * snapshot, so the change is reported on the next run instead of being lost).
 */
export class Billing {
    private ppe = false;
    private prices: Record<string, number> = {};
    private maxUsd = Infinity;
    readonly counts: Record<string, number> = {};
    limitReached = false;

    init(): void {
        try {
            const info = Actor.getChargingManager().getPricingInfo();
            this.ppe = info.isPayPerEvent;
            this.prices = info.perEventPrices ?? {};
            this.maxUsd = info.maxTotalChargeUsd ?? Infinity;
        } catch {
            this.ppe = false;
        }
    }

    private spentUsd(): number {
        if (!this.ppe) return 0;
        const cm = Actor.getChargingManager();
        let s = 0;
        for (const [e, p] of Object.entries(this.prices)) s += cm.getChargedEventCount(e) * p;
        return s;
    }

    cost(events: Record<string, number>): number {
        return Object.entries(events).reduce((s, [e, n]) => s + (this.prices[e] ?? 0) * n, 0);
    }

    canAfford(events: Record<string, number>): boolean {
        if (!this.ppe || !Number.isFinite(this.maxUsd)) return true;
        return this.cost(events) <= this.maxUsd - this.spentUsd() + 1e-12;
    }

    async charge(events: Record<string, number>): Promise<void> {
        for (const [eventName, count] of Object.entries(events)) {
            if (!count) continue;
            this.counts[eventName] = (this.counts[eventName] ?? 0) + count;
            if (!this.ppe) continue;
            try {
                const res = await Actor.charge({ eventName, count });
                if (res.eventChargeLimitReached) this.limitReached = true;
            } catch (e) {
                log.warning(`Charging ${eventName} failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
}
