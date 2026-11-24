import type { KeyValueStore } from 'apify';

import { sha } from './analyze.js';
import type { Discovered } from './discover.js';
import type { RobotsCache, RobotsRecord } from './http.js';
import type { PageType, Snapshot } from './types.js';

/** Stable across upgrades when no selector is set, so existing baselines stay valid. A selector gets its own key. */
export const snapshotKey = (watchlist: string, type: PageType, url: string, cssSelector?: string | null): string =>
    `snap-${sha(cssSelector ? `${watchlist}\n${type}\n${url}\n${cssSelector}` : `${watchlist}\n${type}\n${url}`, 32)}`;
export const watchlistKey = (watchlist: string): string => `watchlist-${sha(watchlist, 24)}`;
export const discoveryKey = (domain: string): string => `discovery-${sha(domain, 24)}`;
export const digestTechKey = (watchlist: string, domain: string): string =>
    `digest-tech-${sha(`${watchlist}\n${domain}`, 24)}`;
/**
 * Last successful digest for one watchlist. The record lives in the caller's named
 * key-value store (`stateStoreName`), next to page baselines. Only the latest time is kept.
 */
export const digestSinceKey = (watchlist: string): string => `digest-since-${sha(watchlist, 24)}`;
export const ROBOTS_KEY = 'robots-cache';

export interface WatchlistIndex {
    watchlist: string;
    updated_at: string;
    runs: number;
    pages: { url: string; type: PageType; key: string; last_checked_at: string; last_status: string }[];
}

export interface DiscoveryCache {
    domain: string;
    at: number;
    found: Discovered[];
}

/** robots.txt cache persisted in the state store between scheduled runs (entries expire after 24 h). */
export class PersistentRobotsCache implements RobotsCache {
    private dirty = false;
    constructor(private data: Record<string, RobotsRecord>) {}
    get(origin: string): RobotsRecord | undefined {
        return this.data[origin];
    }

    set(origin: string, rec: RobotsRecord): void {
        this.data[origin] = rec;
        this.dirty = true;
    }

    async save(store: KeyValueStore, now: number): Promise<void> {
        if (!this.dirty) return;
        for (const [k, v] of Object.entries(this.data)) if (now - v.fetched_at > 24 * 3600_000) delete this.data[k];
        await store.setValue(ROBOTS_KEY, this.data);
    }
}

export async function loadSnapshot(store: KeyValueStore, key: string): Promise<Snapshot | null> {
    const v = await store.getValue<Snapshot>(key);
    return v && v.v === 1 ? v : null;
}
