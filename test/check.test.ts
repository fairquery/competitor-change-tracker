import { describe, expect, it } from 'vitest';

import { checkPage, type CheckOptions } from '../src/check.js';
import type { PageTarget, Snapshot } from '../src/types.js';
import { fakeWeb, fx } from './helpers.js';

const O = (now: string): CheckOptions => ({
    ignore: [],
    minChangeChars: 20,
    careersKeywords: ['machine learning'],
    watchKeywords: [],
    includeDiff: true,
    renderJs: 'never',
    maxSitemapFiles: 10,
    sitemapInclude: [],
    sitemapExclude: [],
    nowIso: now,
});
const T1 = '2026-10-18T00:00:00.000Z';
const T2 = '2026-10-18T01:00:00.000Z';
const T3 = '2026-10-18T09:00:00.000Z';
const target = (url: string, type: PageTarget['type']): PageTarget => ({
    url,
    type,
    label: null,
    source: 'input',
    domain: 'acme.test',
});

/** baseline -> noise-only rerun -> real change, through the real fetcher/robots/extraction code */
async function cycle(
    url: string,
    type: PageTarget['type'],
    v1: string,
    noise: string | null,
    v2: string,
    extra: Record<string, string> = {},
) {
    const w = fakeWeb({ 'https://acme.test/robots.txt': 'User-agent: *\nAllow: /', [url]: v1, ...extra });
    const t = target(url, type);
    const base = await checkPage(w.fetcher, null, t, null, O(T1));
    expect(base.changes).toEqual([]);
    expect(base.snapshot).not.toBe(null);
    let prev = base.snapshot as Snapshot;
    if (noise !== null) {
        w.set(url, noise);
        const r = await checkPage(w.fetcher, null, t, prev, O(T2));
        expect(r.changes).toEqual([]);
        if (r.snapshot) prev = r.snapshot;
    }
    w.set(url, v2);
    const r2 = await checkPage(w.fetcher, null, t, prev, O(T3));
    return { base, r2, w };
}

describe('checkPage end to end (local fixtures)', () => {
    it('A/B variants that come and go are not reported (confirmation re-read)', async () => {
        const url = 'https://acme.test/pricing';
        const w = fakeWeb({ 'https://acme.test/robots.txt': '', [url]: fx('pricing_v1.html') });
        const t = target(url, 'pricing');
        const base = await checkPage(w.fetcher, null, t, null, O(T1));
        let n = 0;
        w.set(url, (() => (n++ % 2 === 0 ? fx('pricing_v2.html') : fx('pricing_v1.html'))) as never);
        const r = await checkPage(w.fetcher, null, t, base.snapshot, O(T2));
        expect(r.changes).toEqual([]);
        expect(r.snapshot).toBe(null);
        expect(r.notes.join(' ')).toMatch(/not on an immediate re-read/);
        const off = await checkPage(w.fetcher, null, t, base.snapshot, { ...O(T2), confirmChanges: false });
        expect(off.changes.length).toBeGreaterThan(0);
    });
    it('pricing: baseline, no false positive on noise, then price/plan changes', async () => {
        const { base, r2 } = await cycle(
            'https://acme.test/pricing',
            'pricing',
            fx('pricing_v1.html'),
            fx('pricing_v1_noise.html'),
            fx('pricing_v2.html'),
        );
        expect(base.snapshot!.plans!.map((p) => p.name)).toEqual(['Free', 'Pro', 'Business', 'Enterprise']);
        expect(r2.changes.map((c) => c.kind).sort()).toEqual(['plan_added', 'plan_removed', 'price_changed']);
        // the page text diff rides along on a plan change instead of being a second alert
        expect(r2.changes.some((c) => 'related_text_change' in c.details)).toBe(true);
        expect(r2.documents).toBe(1);
        expect(r2.confirmFetches).toBe(1);
        expect(r2.snapshot).not.toBe(null);
    });
    it('a page flipping between two versions across runs alerts once, then reports low-severity flips', async () => {
        const url = 'https://acme.test/terms';
        const w = fakeWeb({ 'https://acme.test/robots.txt': '', [url]: fx('terms_v1.html') });
        const t = target(url, 'terms');
        let prev = (await checkPage(w.fetcher, null, t, null, O(T1))).snapshot!;
        const seq = ['terms_v2.html', 'terms_v1.html', 'terms_v2.html'];
        const out = [];
        for (const [i, f] of seq.entries()) {
            w.set(url, fx(f));
            const r = await checkPage(w.fetcher, null, t, prev, O(`2026-10-1${8 + i}T12:00:00.000Z`));
            out.push(r.changes.map((c) => `${c.kind}:${c.severity}`));
            prev = r.snapshot ?? prev;
        }
        expect(out).toEqual([
            ['legal_text_changed:high'],
            ['reverted_to_seen_version:low'],
            ['reverted_to_seen_version:low'],
        ]);
    });
    it('terms: date-only edits ignored, substantive edits reported', async () => {
        const { r2 } = await cycle(
            'https://acme.test/terms',
            'terms',
            fx('terms_v1.html'),
            fx('terms_v1_noise.html'),
            fx('terms_v2.html'),
        );
        expect(r2.changes).toHaveLength(1);
        expect(r2.changes[0]).toMatchObject({ kind: 'legal_text_changed', severity: 'high' });
    });
    it('careers: Greenhouse board detected from the embed and compared by job id', async () => {
        const api = 'https://boards-api.greenhouse.io/v1/boards/acme/jobs';
        const w = fakeWeb({
            'https://acme.test/robots.txt': '',
            'https://boards-api.greenhouse.io/robots.txt': '',
            'https://acme.test/careers': fx('careers.html'),
            [api]: fx('gh_v1.json'),
        });
        const t = target('https://acme.test/careers', 'careers');
        const b = await checkPage(w.fetcher, null, t, null, O(T1));
        expect(b.documents).toBe(2);
        expect(b.snapshot!.jobs).toHaveLength(3);
        expect(b.snapshot!.ats).toEqual({ ats: 'greenhouse', slug: 'acme' });
        const same = await checkPage(w.fetcher, null, t, b.snapshot, O(T2));
        expect(same.changes).toEqual([]);
        expect(same.snapshot).toBe(null);
        w.set(api, fx('gh_v2.json'));
        const r = await checkPage(w.fetcher, null, t, b.snapshot, O(T3));
        expect(r.changes.map((c) => c.kind)).toEqual(['jobs_changed', 'careers_keywords_changed']);
        expect(r.changes[0].severity).toBe('medium');
    });
    it('careers: direct ATS board URL skips the HTML page', async () => {
        const w = fakeWeb({
            'https://api.lever.co/robots.txt': '',
            'https://api.lever.co/v0/postings/acme?mode=json':
                '[{"id":"1","text":"SRE","categories":{"team":"Infra"}}]',
        });
        const r = await checkPage(w.fetcher, null, target('https://jobs.lever.co/acme', 'careers'), null, O(T1));
        expect(r.snapshot!.jobs).toEqual([{ id: '1', title: 'SRE', department: 'Infra', location: null }]);
        expect(w.hits.some((h) => h.url.startsWith('https://jobs.lever.co'))).toBe(false);
    });
    it('changelog: new entries', async () => {
        const { r2 } = await cycle(
            'https://acme.test/changelog',
            'changelog',
            fx('changelog_v1.html'),
            null,
            fx('changelog_v2.html'),
        );
        expect(r2.changes.map((c) => c.kind)).toEqual(['new_entries']);
    });
    it('generic: counters and viewers ignored; real copy change reported', async () => {
        const { r2 } = await cycle(
            'https://acme.test/',
            'generic',
            fx('generic_v1.html'),
            fx('generic_v1_noise.html'),
            fx('generic_v2.html'),
        );
        expect(r2.changes.map((c) => c.kind)).toEqual(['content_changed']);
    });
    it('product: sitemap index from robots.txt, new and removed product pages', async () => {
        const w = fakeWeb({
            'https://acme.test/robots.txt':
                'User-agent: *\nAllow: /\nSitemap: https://acme.test/sitemap_index.xml\nSitemap: https://other.test/sitemap.xml',
            'https://acme.test/sitemap_index.xml': fx('sitemap_index.xml'),
            'https://acme.test/sitemap-pages.xml': fx('sitemap_pages_v1.xml'),
            'https://acme.test/sitemap-blog.xml.gz': fx('sitemap_blog.xml'),
        });
        const t = target('https://acme.test/', 'product');
        const b = await checkPage(w.fetcher, null, t, null, O(T1));
        expect(b.snapshot!.sitemap_urls).toHaveLength(7);
        expect(b.documents).toBe(3);
        expect(w.hits.some((h) => h.url.includes('other.test'))).toBe(false);
        const same = await checkPage(w.fetcher, null, t, b.snapshot, O(T2));
        expect(same.changes).toEqual([]);
        w.set('https://acme.test/sitemap-pages.xml', fx('sitemap_pages_v2.xml'));
        const r = await checkPage(w.fetcher, null, t, b.snapshot, O(T3));
        expect(r.changes.map((c) => [c.kind, c.severity])).toEqual([
            ['pages_added', 'medium'],
            ['pages_removed', 'medium'],
        ]);
        // a child sitemap failing must not produce "removed" pages
        w.set('https://acme.test/sitemap-blog.xml.gz', { status: 500, body: '', headers: {} });
        const partial = await checkPage(w.fetcher, null, t, r.snapshot, O('2026-10-18T10:00:00.000Z'));
        expect(partial.changes).toEqual([]);
        expect(partial.snapshot!.sitemap_urls).toContain('https://acme.test/blog/hello-world');
    });
    it('robots-disallowed pages are not fetched', async () => {
        const w = fakeWeb({
            'https://acme.test/robots.txt': 'User-agent: FairqueryChangeTracker\nDisallow: /pricing',
            'https://acme.test/pricing': fx('pricing_v1.html'),
        });
        await expect(
            checkPage(w.fetcher, null, target('https://acme.test/pricing', 'pricing'), null, O(T1)),
        ).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
        expect(w.hits.map((h) => h.url)).toEqual(['https://acme.test/robots.txt']);
    });
    it('304 and identical bytes short-circuit without a new snapshot', async () => {
        const w = fakeWeb({
            'https://acme.test/robots.txt': '',
            'https://acme.test/terms': {
                status: 200,
                body: fx('terms_v1.html'),
                headers: { etag: '"v1"', 'content-type': 'text/html' },
            },
        });
        const t = target('https://acme.test/terms', 'terms');
        const b = await checkPage(w.fetcher, null, t, null, O(T1));
        expect(b.snapshot!.etag).toBe('"v1"');
        const same = await checkPage(w.fetcher, null, t, b.snapshot, O(T2));
        expect(same.snapshot).toBe(null);
        expect(same.notes).toEqual(['identical bytes']);
        w.set('https://acme.test/terms', { status: 304, body: '', headers: {} });
        const nm = await checkPage(w.fetcher, null, t, b.snapshot, O(T3));
        expect(nm).toMatchObject({ snapshot: null, changes: [], documents: 1 });
        expect(w.hits.filter((h) => h.headers['if-none-match'] === '"v1"').length).toBeGreaterThan(0);
    });
    it('404 page raises PAGE_NOT_FOUND', async () => {
        const w = fakeWeb({ 'https://acme.test/robots.txt': '' });
        await expect(
            checkPage(w.fetcher, null, target('https://acme.test/gone', 'generic'), null, O(T1)),
        ).rejects.toMatchObject({ code: 'PAGE_NOT_FOUND' });
    });
    it('compares only the pinned CSS region and rebaselines when the selector changes', async () => {
        const page = (banner: string, watched: string) =>
            `<html><head><title>Acme</title></head><body><main><section id="banner"><h2>Banner</h2><p>${banner}</p></section><section id="terms"><h2>Watched</h2><p>${watched}</p></section></main></body></html>`;
        const watched =
            'The watched region says the refund window is fourteen days for every annual plan bought online today.';
        const url = 'https://acme.test/terms';
        const w = fakeWeb({
            'https://acme.test/robots.txt': '',
            [url]: page('Banner copy that is deliberately long enough to count as a real paragraph of text.', watched),
        });
        const pinned = { ...target(url, 'generic'), cssSelector: '#terms' };
        const base = await checkPage(w.fetcher, null, pinned, null, O(T1));
        expect(base.snapshot?.css_selector).toBe('#terms');
        expect(base.snapshot?.sections.map((s) => s.heading)).not.toContain('Banner');
        w.set(
            url,
            page(
                'This banner was replaced with an entirely different promotion that should not raise an alert.',
                watched,
            ),
        );
        const quiet = await checkPage(w.fetcher, null, pinned, base.snapshot, O(T2));
        expect(quiet.changes).toEqual([]);
        const next =
            'The watched region says the refund window is ninety days for every annual plan bought online today.';
        w.set(
            url,
            page('Banner stays irrelevant to the pinned region and is not part of the comparison at all.', next),
        );
        const changed = await checkPage(w.fetcher, null, pinned, quiet.snapshot ?? base.snapshot, O(T3));
        expect(changed.changes.map((c) => c.kind)).toContain('content_changed');
        expect(
            changed.changes.some(
                (c) => /ninety days/.test(c.summary) || JSON.stringify(c.details).includes('ninety days'),
            ),
        ).toBe(true);
        const moved = await checkPage(w.fetcher, null, { ...pinned, cssSelector: '#banner' }, changed.snapshot, O(T3));
        expect(moved.changes).toEqual([]);
        expect(moved.notes.join(' ')).toMatch(/new baseline/i);
        expect(moved.snapshot?.css_selector).toBe('#banner');
    });
    it('reports SELECTOR_NOT_FOUND when the pin matches nothing', async () => {
        const w = fakeWeb({
            'https://acme.test/robots.txt': '',
            'https://acme.test/pricing':
                '<html><body><main><p>Plenty of visible pricing copy lives here but not inside the requested id.</p></main></body></html>',
        });
        const t = { ...target('https://acme.test/pricing', 'pricing'), cssSelector: '#does-not-exist' };
        await expect(checkPage(w.fetcher, null, t, null, O(T1))).rejects.toMatchObject({ code: 'SELECTOR_NOT_FOUND' });
    });
});
