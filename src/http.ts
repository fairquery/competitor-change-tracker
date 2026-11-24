import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import zlib, { gunzipSync } from 'node:zlib';

import { crawlDelayFor, isAllowed, parseRobots, type Robots } from './robots.js';
import { isPrivateAddress, unsafeUrlReason } from './ssrf.js';
import { DEFAULTS, LIMITS, ROBOTS_AGENT, USER_AGENT } from './types.js';

export class HttpError extends Error {
    constructor(
        message: string,
        public code: string,
        public retryable: boolean,
        public status?: number,
        public host?: string,
    ) {
        super(message);
    }
}

export interface RawResponse {
    status: number;
    body: string;
    headers: Record<string, string>;
}

export type Transport = (
    u: URL,
    headers: Record<string, string>,
    maxBytes: number,
    pinned: { address: string; family: number },
    timeoutMs: number,
) => Promise<RawResponse>;

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface RobotsRecord {
    status: number;
    text: string;
    fetched_at: number;
}

/** Persistent robots.txt cache (RFC 9309 allows caching for up to 24 hours). */
export interface RobotsCache {
    get(origin: string): RobotsRecord | undefined;
    set(origin: string, rec: RobotsRecord): void;
}

export interface FetchResult {
    url: string;
    finalUrl: string;
    status: number;
    body: string;
    contentType: string | null;
    etag: string | null;
    lastModified: string | null;
    notModified: boolean;
    bytes: number;
}

export interface GetOptions {
    accept?: string;
    maxBytes?: number;
    etag?: string | null;
    lastModified?: string | null;
    maxHops?: number;
}

const sleep = async (ms: number) =>
    new Promise<void>((r) => {
        setTimeout(r, ms);
    });

export function errText(e: unknown): string {
    if (!(e instanceof Error)) return String(e);
    const code = (e as { cause?: { code?: string }; code?: string }).cause?.code ?? (e as { code?: string }).code;
    return code && !e.message.includes(code) ? `${e.message} (${code})` : e.message;
}

const defaultResolver: Resolver = async (host) => dnsLookup(host, { all: true, verbatim: true });

/** Node http(s) GET pinned to a pre-checked IP. No cookies are stored or sent; redirects are not followed here. */
export const nodeTransport: Transport = async (u, headers, maxBytes, pinned, timeoutMs) =>
    new Promise<RawResponse>((resolve, reject) => {
        const lookup: LookupFunction = (_h, opts, cb) => {
            if ((opts as { all?: boolean }).all) {
                (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [pinned]);
            } else cb(null, pinned.address, pinned.family);
        };
        const mod = u.protocol === 'https:' ? https : http;
        const req = mod.request(u, { method: 'GET', lookup, headers, timeout: timeoutMs }, (res) => {
            const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
            let stream: NodeJS.ReadableStream = res;
            if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
            else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
            else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
            const chunks: Buffer[] = [];
            let total = 0;
            let done = false;
            const hdrs: Record<string, string> = {};
            for (const [k, v] of Object.entries(res.headers)) {
                if (k === 'set-cookie') continue; // never kept
                if (typeof v === 'string') hdrs[k] = v;
                else if (Array.isArray(v)) hdrs[k] = v.join(', ');
            }
            stream.on('data', (c: Buffer) => {
                if (done) return;
                total += c.length;
                if (total > maxBytes) {
                    done = true;
                    req.destroy();
                    reject(new HttpError(`Response from ${u.hostname} larger than ${maxBytes} bytes`, 'TOO_LARGE', false));
                    return;
                }
                chunks.push(c);
            });
            stream.on('end', () => {
                if (done) return;
                done = true;
                let buf = Buffer.concat(chunks);
                // .xml.gz files served without Content-Encoding
                if (buf[0] === 0x1f && buf[1] === 0x8b) {
                    try {
                        buf = gunzipSync(buf, { maxOutputLength: maxBytes });
                    } catch {
                        reject(new HttpError(`Could not decompress response from ${u.hostname}`, 'BAD_RESPONSE', false));
                        return;
                    }
                }
                resolve({ status: res.statusCode ?? 0, body: buf.toString('utf8'), headers: hdrs });
            });
            stream.on('error', (e) => {
                if (!done) {
                    done = true;
                    reject(e);
                }
            });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
        req.end();
    });

/**
 * Polite fetcher for public pages:
 * - robots.txt (RFC 9309) checked before every URL and every redirect hop; 4xx robots = allowed,
 *   5xx/unreachable = treated as disallowed. Crawl-delay honoured (hosts asking for more than 30 s are skipped).
 * - one request at a time per host, at least `hostDelayMs` apart; honest User-Agent; no cookies, no login.
 * - SSRF guard: http(s) on 80/443 only, DNS answers checked against private ranges and pinned.
 * - kill switch: HTTP 403 or 429 stops all further requests to that host for the run (no retries, no proxies).
 */
export class Fetcher {
    private robots = new Map<string, Promise<Robots | HttpError>>();
    private chains = new Map<string, Promise<unknown>>();
    private lastStart = new Map<string, number>();
    readonly killed = new Map<string, string>();
    requests = 0;
    bytes = 0;

    constructor(
        private readonly opts: {
            hostDelayMs?: number;
            timeoutMs?: number;
            resolver?: Resolver;
            transport?: Transport;
            robotsCache?: RobotsCache;
            now?: () => number;
        } = {},
    ) {}

    private get hostDelay(): number {
        return Math.max(this.opts.hostDelayMs ?? DEFAULTS.hostDelayMs, 0);
    }

    async resolvePublic(u: URL): Promise<{ address: string; family: number }> {
        const reason = unsafeUrlReason(u);
        if (reason) throw new HttpError(`${u.hostname}: ${reason}`, 'URL_NOT_ALLOWED', false);
        let addrs: { address: string; family: number }[];
        try {
            addrs = await (this.opts.resolver ?? defaultResolver)(u.hostname);
        } catch (e) {
            throw new HttpError(`DNS lookup failed for ${u.hostname}: ${errText(e)}`, 'DNS_FAILED', false);
        }
        if (!addrs.length) throw new HttpError(`No address for ${u.hostname}`, 'DNS_FAILED', false);
        if (addrs.some((a) => isPrivateAddress(a.address)))
            throw new HttpError(`${u.hostname} resolves to a private or reserved address`, 'URL_NOT_ALLOWED', false);
        return addrs[0];
    }

    /** Serialise requests per host and space their starts. */
    private async onHost<T>(host: string, minGapMs: number, fn: () => Promise<T>): Promise<T> {
        const prev = this.chains.get(host) ?? Promise.resolve();
        const run = prev
            .catch(() => undefined)
            .then(async () => {
                const k = this.killed.get(host);
                if (k) throw new HttpError(`${host} stopped for this run (${k}); not retried.`, 'HOST_BLOCKED', false);
                const wait = (this.lastStart.get(host) ?? 0) + minGapMs - Date.now();
                if (wait > 0) await sleep(wait);
                this.lastStart.set(host, Date.now());
                return fn();
            });
        this.chains.set(host, run);
        return run;
    }

    private async raw(u: URL, headers: Record<string, string>, maxBytes: number, gapMs: number): Promise<RawResponse> {
        const pinned = await this.resolvePublic(u);
        const transport = this.opts.transport ?? nodeTransport;
        const res = await this.onHost(u.hostname, gapMs, async () => {
            this.requests += 1;
            try {
                return await transport(
                    u,
                    {
                        'user-agent': USER_AGENT,
                        'accept-encoding': 'gzip, deflate, br',
                        'accept-language': 'en-US,en;q=0.9',
                        ...headers,
                    },
                    maxBytes,
                    pinned,
                    this.opts.timeoutMs ?? DEFAULTS.requestTimeoutMs,
                );
            } catch (e) {
                if (e instanceof HttpError) throw e;
                throw new HttpError(`GET ${u.origin}${u.pathname} failed: ${errText(e)}`, 'NETWORK_ERROR', true, undefined, u.hostname);
            }
        });
        this.bytes += res.body.length;
        if (res.status === 403 || res.status === 429) {
            if (!this.killed.has(u.hostname)) this.killed.set(u.hostname, `HTTP ${res.status}`);
            throw new HttpError(
                `${u.hostname} answered HTTP ${res.status}; host skipped for the rest of this run (not retried, no proxies).`,
                'HOST_BLOCKED',
                false,
                res.status,
                u.hostname,
            );
        }
        return res;
    }

    private async loadRobots(origin: string): Promise<Robots | HttpError> {
        const now = (this.opts.now ?? Date.now)();
        const cached = this.opts.robotsCache?.get(origin);
        if (cached && now - cached.fetched_at < DEFAULTS.robotsCacheMs) {
            return cached.status >= 200 && cached.status < 300 ? parseRobots(cached.text) : parseRobots('');
        }
        let url = new URL('/robots.txt', origin);
        try {
            let res = await this.raw(url, { accept: 'text/plain,*/*;q=0.5' }, 500_000, this.hostDelay);
            for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.location; hop++) {
                url = new URL(res.headers.location, url);
                if (url.protocol !== 'https:' && url.protocol !== 'http:') break;
                res = await this.raw(url, { accept: 'text/plain,*/*;q=0.5' }, 500_000, this.hostDelay);
            }
            if (res.status >= 200 && res.status < 300) {
                this.opts.robotsCache?.set(origin, { status: res.status, text: res.body.slice(0, 500_000), fetched_at: now });
                return parseRobots(res.body);
            }
            if (res.status >= 400 && res.status < 500) {
                this.opts.robotsCache?.set(origin, { status: res.status, text: '', fetched_at: now });
                return parseRobots('');
            }
            return new HttpError(
                `robots.txt on ${url.hostname} answered HTTP ${res.status}; not fetching (RFC 9309)`,
                'ROBOTS_UNAVAILABLE',
                true,
                res.status,
                url.hostname,
            );
        } catch (e) {
            if (e instanceof HttpError && ['HOST_BLOCKED', 'URL_NOT_ALLOWED', 'DNS_FAILED'].includes(e.code)) return e;
            return new HttpError(
                `robots.txt on ${url.hostname} unreachable (${errText(e)}); not fetching`,
                'ROBOTS_UNAVAILABLE',
                true,
                undefined,
                url.hostname,
            );
        }
    }

    async getRobots(u: URL): Promise<Robots> {
        if (!this.robots.has(u.origin)) this.robots.set(u.origin, this.loadRobots(u.origin));
        const r = await this.robots.get(u.origin)!;
        if (r instanceof HttpError) throw r;
        return r;
    }

    /** Throws ROBOTS_DISALLOWED / ROBOTS_UNAVAILABLE / CRAWL_DELAY_TOO_LONG when the URL may not be fetched. */
    async checkAllowed(u: URL): Promise<number> {
        const robots = await this.getRobots(u);
        if (!isAllowed(robots, ROBOTS_AGENT, u.pathname + u.search))
            throw new HttpError(`robots.txt on ${u.hostname} disallows ${u.pathname}`, 'ROBOTS_DISALLOWED', false, undefined, u.hostname);
        const cd = crawlDelayFor(robots, ROBOTS_AGENT);
        if (cd !== null && cd > DEFAULTS.maxCrawlDelayS)
            throw new HttpError(
                `robots.txt on ${u.hostname} asks for a ${cd}s crawl delay; skipped`,
                'CRAWL_DELAY_TOO_LONG',
                false,
                undefined,
                u.hostname,
            );
        return Math.max(this.hostDelay, (cd ?? 0) * 1000);
    }

    async isAllowed(url: string): Promise<boolean> {
        try {
            await this.checkAllowed(new URL(url));
            return true;
        } catch {
            return false;
        }
    }

    /** GET a public URL with robots checks on every hop; supports conditional requests (ETag / Last-Modified). */
    async get(url: string, o: GetOptions = {}): Promise<FetchResult> {
        let u = new URL(url);
        const maxHops = o.maxHops ?? 5;
        for (let hop = 0; hop <= maxHops; hop++) {
            const gap = await this.checkAllowed(u);
            const headers: Record<string, string> = {
                accept: o.accept ?? 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
            };
            if (hop === 0 && o.etag) headers['if-none-match'] = o.etag;
            if (hop === 0 && o.lastModified) headers['if-modified-since'] = o.lastModified;
            let res: RawResponse;
            try {
                res = await this.raw(u, headers, o.maxBytes ?? LIMITS.maxHtmlBytes, gap);
                if (res.status >= 500) {
                    await sleep(2000);
                    res = await this.raw(u, headers, o.maxBytes ?? LIMITS.maxHtmlBytes, gap);
                }
            } catch (e) {
                if (e instanceof HttpError && e.code === 'NETWORK_ERROR') {
                    await sleep(2000);
                    res = await this.raw(u, headers, o.maxBytes ?? LIMITS.maxHtmlBytes, gap);
                } else throw e;
            }
            if (res.status >= 300 && res.status < 400 && res.status !== 304 && res.headers.location) {
                u = new URL(res.headers.location, u);
                continue;
            }
            return {
                url,
                finalUrl: u.toString(),
                status: res.status,
                body: res.status === 304 ? '' : res.body,
                contentType: res.headers['content-type'] ?? null,
                etag: res.headers.etag ?? null,
                lastModified: res.headers['last-modified'] ?? null,
                notModified: res.status === 304,
                bytes: res.body.length,
            };
        }
        throw new HttpError(`Too many redirects from ${url}`, 'TOO_MANY_REDIRECTS', false);
    }
}
