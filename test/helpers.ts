import { readFileSync } from 'node:fs';

import { Fetcher, type RawResponse, type Transport } from '../src/http.js';

export const fx = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

export interface Hit {
    url: string;
    headers: Record<string, string>;
}

/** In-memory web: url -> response (or function). Records every request. */
export function fakeWeb(routes: Record<string, RawResponse | string | (() => RawResponse | string)>): { fetcher: Fetcher; hits: Hit[]; set: (url: string, r: RawResponse | string | (() => RawResponse | string)) => void } {
    const hits: Hit[] = [];
    const table = { ...routes };
    const transport: Transport = async (u, headers) => {
        hits.push({ url: u.toString(), headers });
        const r = table[u.toString()];
        const v = typeof r === 'function' ? r() : r;
        if (v === undefined) return { status: 404, body: 'not found', headers: {} };
        if (typeof v === 'string') return { status: 200, body: v, headers: { 'content-type': u.pathname.endsWith('.json') || u.hostname.includes('api') ? 'application/json' : 'text/html; charset=utf-8' } };
        return v;
    };
    const fetcher = new Fetcher({
        hostDelayMs: 0,
        transport,
        resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    return { fetcher, hits, set: (url, r) => (table[url] = r) };
}
