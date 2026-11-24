import https from 'node:https';
import type { LookupFunction } from 'node:net';

import type { Fetcher } from './http.js';
import { USER_AGENT } from './types.js';

export type WebhookFormat = 'json' | 'slack' | 'discord';

export interface AlertRow {
    url: string;
    page_type: string;
    label: string | null;
    severity: string;
    change_kind: string;
    summary: string;
}

export function webhookBody(format: WebhookFormat, watchlist: string, rows: AlertRow[], runUrl: string | null): object {
    const lines = rows
        .slice(0, 30)
        .map((r) => `• [${r.severity.toUpperCase()}] ${r.label ?? r.page_type} (${r.url}): ${r.summary}`)
        .join('\n');
    const text = `Competitor Change Tracker: ${rows.length} change${rows.length > 1 ? 's' : ''} on watchlist "${watchlist}"\n${lines}${rows.length > 30 ? `\n…and ${rows.length - 30} more` : ''}${runUrl ? `\nRun: ${runUrl}` : ''}`;
    if (format === 'slack') return { text: text.slice(0, 39_000) };
    if (format === 'discord') return { content: text.slice(0, 1990) };
    return { source: 'fairquery/competitor-change-tracker', watchlist, run_url: runUrl, count: rows.length, text, changes: rows };
}

/** POST alerts to a user-supplied public HTTPS webhook (SSRF-checked, pinned IP, 10 s timeout, one retry). */
export async function postWebhook(fetcher: Fetcher, url: string, body: object): Promise<{ ok: boolean; status: number | null; error?: string }> {
    const u = new URL(url);
    if (u.protocol !== 'https:') return { ok: false, status: null, error: 'webhookUrl must use https' };
    let pinned: { address: string; family: number };
    try {
        pinned = await fetcher.resolvePublic(u);
    } catch (e) {
        return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
    }
    const payload = JSON.stringify(body);
    const once = async () =>
        new Promise<number>((resolve, reject) => {
            const lookup: LookupFunction = (_h, opts, cb) => {
                if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: object[]) => void)(null, [pinned]);
                else cb(null, pinned.address, pinned.family);
            };
            const req = https.request(
                u,
                {
                    method: 'POST',
                    lookup,
                    timeout: 10_000,
                    headers: { 'content-type': 'application/json', 'user-agent': USER_AGENT, 'content-length': Buffer.byteLength(payload) },
                },
                (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode ?? 0));
                },
            );
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
            req.end(payload);
        });
    let status: number | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            status = await once();
            if (status >= 200 && status < 300) return { ok: true, status };
            if (status < 500 && status !== 429) break;
        } catch (e) {
            if (attempt === 1) return { ok: false, status, error: e instanceof Error ? e.message : String(e) };
        }
        await new Promise((r) => {
            setTimeout(r, 2000);
        });
    }
    return { ok: false, status, error: `webhook answered HTTP ${status}` };
}
