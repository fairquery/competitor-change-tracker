import { gunzipSync } from 'node:zlib';

import { type ChangeItem, LIMITS } from './types.js';

export interface ParsedSitemap {
    kind: 'urlset' | 'index' | 'unknown';
    locs: string[];
}

const decodeXml = (s: string) =>
    s
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .trim();

export function parseSitemap(xml: string): ParsedSitemap {
    const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : /<urlset[\s>]/i.test(xml) ? 'urlset' : 'unknown';
    const locs: string[] = [];
    const re = /<loc>\s*([\s\S]*?)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) && locs.length < LIMITS.maxSitemapUrls) locs.push(decodeXml(m[1]));
    return { kind, locs };
}

export function maybeGunzip(body: string | Buffer): string {
    const buf = typeof body === 'string' ? Buffer.from(body, 'latin1') : body;
    if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf).toString('utf8');
    return typeof body === 'string' ? body : buf.toString('utf8');
}

/** Canonical form for comparison: no fragment, no trailing slash, lower-case host. */
export function canonUrl(u: string): string {
    try {
        const x = new URL(u);
        x.hash = '';
        x.hostname = x.hostname.toLowerCase();
        let s = x.toString();
        if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
        return s;
    } catch {
        return u.trim();
    }
}

const PRODUCT_PATH = /\/(products?|features?|solutions?|platform|pricing|plans|integrations?|apps?|use-cases?|enterprise|tools?|ai)(\/|$)/i;

export function pathOf(u: string): string {
    try {
        return new URL(u).pathname;
    } catch {
        return u;
    }
}

export function compileUrlFilters(include: string[], exclude: string[]): (u: string) => boolean {
    const toRe = (p: string) => {
        if (p.length > 200 || /(\([^)]*[+*][^)]*\))[+*{]/.test(p)) return null; // ReDoS guard
        try {
            return new RegExp(p, 'i');
        } catch {
            return null;
        }
    };
    const inc = include.map(toRe).filter((x): x is RegExp => !!x);
    const exc = exclude.map(toRe).filter((x): x is RegExp => !!x);
    return (u: string) => (!inc.length || inc.some((r) => r.test(u))) && !exc.some((r) => r.test(u));
}

/** Diff two URL sets from a site's sitemap(s): new and removed pages, product-like paths flagged. */
export function compareSitemaps(prev: string[], next: string[], complete: boolean): ChangeItem[] {
    const a = new Set(prev.map(canonUrl));
    const b = new Set(next.map(canonUrl));
    const added = [...b].filter((u) => !a.has(u)).sort();
    const removed = complete ? [...a].filter((u) => !b.has(u)).sort() : [];
    const items: ChangeItem[] = [];
    const churn = (added.length + removed.length) / Math.max(a.size, 1);
    const mass = a.size >= 20 && churn > 0.5;
    const sample = (xs: string[]) => xs.slice(0, LIMITS.maxListedItems).map(pathOf);
    if (added.length) {
        const product = added.filter((u) => PRODUCT_PATH.test(pathOf(u)));
        items.push({
            kind: 'pages_added',
            severity: mass ? 'low' : product.length ? 'medium' : 'low',
            summary: `${added.length} new page${added.length > 1 ? 's' : ''} in the sitemap${product.length ? ` (${product.length} product/feature-like)` : ''}, e.g. ${sample(product.length ? product : added).slice(0, 5).join(', ')}.${mass ? ' Large share of the sitemap changed at once; possibly a site restructure.' : ''}`,
            details: { count: added.length, product_like: sample(product), urls: added.slice(0, LIMITS.maxListedItems), truncated: added.length > LIMITS.maxListedItems },
        });
    }
    if (removed.length) {
        const product = removed.filter((u) => PRODUCT_PATH.test(pathOf(u)));
        items.push({
            kind: 'pages_removed',
            severity: mass ? 'low' : product.length ? 'medium' : 'low',
            summary: `${removed.length} page${removed.length > 1 ? 's' : ''} removed from the sitemap${product.length ? ` (${product.length} product/feature-like)` : ''}, e.g. ${sample(product.length ? product : removed).slice(0, 5).join(', ')}.`,
            details: { count: removed.length, product_like: sample(product), urls: removed.slice(0, LIMITS.maxListedItems), truncated: removed.length > LIMITS.maxListedItems },
        });
    }
    return items;
}
