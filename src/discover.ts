import { detectBoard } from './careers.js';
import { extract, type Link, linksFrom } from './extract.js';
import { type Fetcher, HttpError } from './http.js';
import type { PageType } from './types.js';

export const DISCOVERABLE: PageType[] = ['pricing', 'product', 'terms', 'privacy', 'careers', 'changelog', 'blog'];

const PATH_RULES: Record<string, RegExp> = {
    pricing: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:pricing|plans|plans-pricing|prices|pricing-plans)(?:\/)?$/i,
    terms: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:legal\/)?(?:terms|tos|terms-of-service|terms-of-use|terms-and-conditions|terms-conditions|eula|legal\/terms[a-z-]*)(?:\.html)?\/?$/i,
    privacy: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:legal\/)?(?:privacy|privacy-policy|privacy-notice|privacy-statement|legal\/privacy[a-z-]*)(?:\.html)?\/?$/i,
    careers: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:careers|jobs|join-us|join|work-with-us|company\/careers|about\/careers)\/?$/i,
    changelog: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:changelog|release-notes|releases|whats-new|what-s-new|updates|product-updates|news\/product)\/?$/i,
    blog: /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(?:blog|news|newsroom|articles|insights)\/?$/i,
};

const TEXT_RULES: Record<string, RegExp> = {
    pricing: /^(pricing|plans|plans (?:&|and) pricing|prices)$/i,
    terms: /^(terms|terms of (?:service|use)|terms (?:&|and) conditions|legal)$/i,
    privacy: /^(privacy|privacy policy|privacy notice|privacy statement)$/i,
    careers: /^(careers|jobs|we'?re hiring|join (?:us|the team|our team)|work with us)$/i,
    changelog: /^(changelog|release notes|what'?s new|product updates|updates)$/i,
    blog: /^(blog|news|newsroom)$/i,
};

const GUESSES: Record<string, string[]> = {
    pricing: ['/pricing', '/plans'],
    terms: ['/terms', '/legal/terms'],
    privacy: ['/privacy', '/privacy-policy'],
    careers: ['/careers', '/jobs'],
    changelog: ['/changelog', '/release-notes'],
    blog: ['/blog'],
};

export function normalizeDomain(input: string): string | null {
    let s = input.trim().toLowerCase();
    if (!s) return null;
    if (!/^https?:\/\//.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        if (!u.hostname.includes('.')) return null;
        return u.hostname;
    } catch {
        return null;
    }
}

const baseDomain = (host: string) => host.replace(/^www\./, '');
export const sameSite = (host: string, domain: string): boolean => {
    const b = baseDomain(domain);
    return host === b || host.endsWith(`.${b}`);
};

/** Pick the best link for a page type from a homepage's links. */
const TRACKING = /^(utm_\w+|cta|ref|ref_src|source|src|via|from|gclid|fbclid|msclkid|mc_cid|mc_eid|_gl|hsctatracking|trk|campaign|referrer)$/i;

/** Drop analytics/tracking query parameters from a discovered link (they change between visits and are not part of the page). */
export function stripTracking(input: URL): URL {
    const u = new URL(input.toString());
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    if (![...u.searchParams.keys()].length) u.search = '';
    return u;
}

export function pickLink(links: Link[], type: string, domain: string): string | null {
    let best: { url: string; score: number } | null = null;
    for (const l of links) {
        let u: URL;
        try {
            u = new URL(l.href);
        } catch {
            continue;
        }
        const site = sameSite(u.hostname, domain);
        let score = 0;
        if (type === 'careers' && detectBoard(l.href)) score = 9;
        if (!site && score === 0) continue;
        if (PATH_RULES[type]?.test(u.pathname)) score = Math.max(score, 10);
        // link text counts fully only for short labels ("Pricing", "Terms of service"), not sentences that mention the word
        if (TEXT_RULES[type]?.test(l.text)) score += l.text.split(/\s+/).length <= 4 ? 5 : 2;
        if (!score) continue;
        u = stripTracking(u);
        if (u.search) score -= 2;
        if (u.hostname !== domain && site) score -= 1;
        score -= u.pathname.length / 100;
        if (!best || score > best.score) best = { url: u.toString(), score };
    }
    return best && best.score >= 4.5 ? best.url : null;
}

export interface Discovered {
    type: PageType;
    url: string | null;
    via: 'homepage_link' | 'guess' | 'sitemap' | 'none';
    note?: string;
}

/** Find the URL of each requested page type for a domain: homepage links first, then up to 2 common paths. */
export async function discover(fetcher: Fetcher, domain: string, types: PageType[]): Promise<Discovered[]> {
    const out: Discovered[] = [];
    const home = `https://${domain}/`;
    let links: Link[] = [];
    let homeNote: string | undefined;
    try {
        const r = await fetcher.get(home);
        if (r.status === 200) links = linksFrom(r.body, r.finalUrl);
        else homeNote = `homepage answered HTTP ${r.status}`;
    } catch (e) {
        homeNote = e instanceof HttpError ? `${e.code}: ${e.message}` : String(e);
        if (e instanceof HttpError && (e.code === 'HOST_BLOCKED' || e.code === 'DNS_FAILED' || e.code === 'URL_NOT_ALLOWED' || e.code === 'ROBOTS_UNAVAILABLE')) {
            return types.map((type) => ({ type, url: null, via: 'none', note: homeNote }));
        }
    }
    for (const type of types) {
        if (type === 'product') {
            out.push({ type, url: home, via: 'sitemap' });
            continue;
        }
        const found = pickLink(links, type, domain);
        if (found) {
            out.push({ type, url: found, via: 'homepage_link' });
            continue;
        }
        let hit: string | null = null;
        for (const path of GUESSES[type] ?? []) {
            const url = `https://${domain}${path}`;
            try {
                const r = await fetcher.get(url);
                if (r.status === 200 && /html/i.test(r.contentType ?? 'html') && extract(r.body).text.length > 200) {
                    hit = r.finalUrl;
                    break;
                }
            } catch {
                /* try next guess */
            }
        }
        out.push(hit ? { type, url: hit, via: 'guess' } : { type, url: null, via: 'none', note: homeNote ?? `no ${type} page found on the homepage or common paths` });
    }
    return out;
}
