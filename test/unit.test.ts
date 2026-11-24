import { readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { comparePages, snapshotFromHtml } from '../src/analyze.js';
import { compareJobs, detectBoard, parseBoard } from '../src/careers.js';
import { diffSections, diffUnits, units } from '../src/diff.js';
import { pickLink, stripTracking } from '../src/discover.js';
import { extract, linksFrom } from '../src/extract.js';
import { HttpError, nodeTransport } from '../src/http.js';
import { DIGEST_JOBS_RETIRED_WARNING, digestJobsWarning, guessType, parseInput } from '../src/input.js';
import { compileIgnore, normalizeNoise } from '../src/noise.js';
import { comparePlans, extractPlans, findPrices, fmtPrice, parseAmount, periodOf } from '../src/pricing.js';
import { crawlDelayFor, isAllowed, parseRobots } from '../src/robots.js';
import { compareSitemaps, parseSitemap } from '../src/sitemap.js';
import { isPrivateAddress, unsafeUrlReason } from '../src/ssrf.js';
import type { Plan } from '../src/types.js';
import { webhookBody } from '../src/webhook.js';
import { fakeWeb, fx } from './helpers.js';

/** Every string and key in the input schema. Matches digestJobs*, jobs feed, jobs-feed, and company-jobs-feed. */
function schemaCopyMentionsRetiredJobs(node: unknown, key: string | null = null): string[] {
    const hits: string[] = [];
    if (key && mentionsRetiredJobsCopy(key)) hits.push(`key: ${key}`);
    if (typeof node === 'string') {
        if (mentionsRetiredJobsCopy(node)) hits.push(key ? `${key}: ${node}` : node);
        return hits;
    }
    if (Array.isArray(node)) {
        for (const item of node) hits.push(...schemaCopyMentionsRetiredJobs(item, key));
        return hits;
    }
    if (node && typeof node === 'object') {
        for (const [childKey, value] of Object.entries(node)) hits.push(...schemaCopyMentionsRetiredJobs(value, childKey));
    }
    return hits;
}

function mentionsRetiredJobsCopy(text: string): boolean {
    const lower = text.toLowerCase();
    return (
        lower.includes('digestjobs') ||
        lower.includes('jobs feed') ||
        lower.includes('jobs-feed') ||
        lower.includes('company-jobs-feed')
    );
}

const OPTS = { ignore: [], watchKeywords: [] as string[] };
const CMP = {
    ignore: [],
    minChangeChars: 20,
    careersKeywords: [] as string[],
    watchKeywords: [] as string[],
    includeDiff: true,
};
const snap = (
    type: Parameters<typeof snapshotFromHtml>[0]['type'],
    html: string,
    at = '2026-10-18T00:00:00.000Z',
    watch: string[] = [],
) =>
    snapshotFromHtml(
        { url: 'https://acme.test/x', finalUrl: 'https://acme.test/x', type, html, checkedAt: at },
        { ignore: [], watchKeywords: watch },
    );

describe('webhook payloads conform to Slack/Discord rules', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
        url: `https://x.test/${i}`,
        page_type: 'pricing',
        label: `P${i}`,
        severity: 'high',
        change_kind: 'price_changed',
        summary: `change number ${i} with some length to it`,
    }));
    it('json carries the structured changes and a matching count', () => {
        const b = webhookBody('json', 'wl', rows, 'https://run') as {
            count: number;
            changes: unknown[];
            text: string;
            source: string;
        };
        expect(b.source).toBe('fairquery/competitor-change-tracker');
        expect(b.count).toBe(rows.length);
        expect(Array.isArray(b.changes) && b.changes.length).toBe(rows.length);
    });
    it('slack uses only {text} and stays within Slack limits', () => {
        const b = webhookBody('slack', 'wl', rows, 'https://run') as Record<string, unknown>;
        expect(Object.keys(b)).toEqual(['text']);
        expect(typeof b.text).toBe('string');
        expect((b.text as string).length).toBeGreaterThan(0);
        expect((b.text as string).length).toBeLessThanOrEqual(40_000);
    });
    it('discord uses only {content} and respects the 2000-char cap', () => {
        const b = webhookBody('discord', 'wl', rows, 'https://run') as Record<string, unknown>;
        expect(Object.keys(b)).toEqual(['content']);
        expect((b.content as string).length).toBeGreaterThan(0);
        expect((b.content as string).length).toBeLessThanOrEqual(2000);
    });
});

describe('discovery link hygiene', () => {
    it('strips tracking parameters and ignores sentences that merely mention the page type', () => {
        expect(stripTracking(new URL('https://a.test/pricing?cta=nav-pricing-1&utm_source=x')).toString()).toBe(
            'https://a.test/pricing',
        );
        expect(stripTracking(new URL('https://a.test/plans?team=1&utm_medium=y')).toString()).toBe(
            'https://a.test/plans?team=1',
        );
        const links = [
            { href: 'https://a.test/pricing?cta=bufferSite-globalNav-pricing-pricing-1', text: 'Pricing' },
            { href: 'https://a.test/subscribe', text: 'Sign up for our monthly changelog' },
        ];
        expect(pickLink(links, 'pricing', 'a.test')).toBe('https://a.test/pricing');
        expect(pickLink(links, 'changelog', 'a.test')).toBe(null);
    });
});

describe('robots.txt', () => {
    const r = parseRobots(
        'User-agent: *\nDisallow: /private\nAllow: /private/ok\nCrawl-delay: 5\n\nUser-agent: FairqueryChangeTracker\nDisallow: /pricing$\nSitemap: https://acme.test/sitemap.xml',
    );
    it('uses the most specific group and longest match', () => {
        expect(isAllowed(r, 'FairqueryChangeTracker', '/pricing')).toBe(false);
        expect(isAllowed(r, 'FairqueryChangeTracker', '/pricing/teams')).toBe(true);
        expect(isAllowed(r, 'OtherBot', '/private/x')).toBe(false);
        expect(isAllowed(r, 'OtherBot', '/private/ok/1')).toBe(true);
    });
    it('reads crawl-delay and sitemaps', () => {
        expect(crawlDelayFor(r, 'OtherBot')).toBe(5);
        expect(crawlDelayFor(r, 'FairqueryChangeTracker')).toBe(null);
        expect(r.sitemaps).toEqual(['https://acme.test/sitemap.xml']);
    });
});

describe('ssrf', () => {
    it('refuses private and odd URLs', () => {
        expect(isPrivateAddress('10.1.2.3')).toBe(true);
        expect(isPrivateAddress('169.254.169.254')).toBe(true);
        expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true);
        expect(isPrivateAddress('93.184.216.34')).toBe(false);
        expect(unsafeUrlReason(new URL('http://localhost/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://user:pw@acme.com/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://acme.com:8443/'))).toBeTruthy();
        expect(unsafeUrlReason(new URL('https://acme.com/pricing'))).toBe(null);
    });
});

describe('noise filter', () => {
    it('masks timestamps, dates, relative times, tokens and copyright years', () => {
        const a = normalizeNoise(
            'Updated 3 minutes ago at 10:42 AM UTC on October 18, 2026. Token 9f8e7d6c5b4a39281706f5e4d3c2b1a0 © 2026',
            true,
        );
        const b = normalizeNoise(
            'Updated 12 minutes ago at 11:07 PM UTC on 19 Oct 2026. Token 0a1b2c3d4e5f60718293a4b5c6d7e8f9 © 2025-2026',
            true,
        );
        expect(a).toBe(b);
    });
    it('keeps numbers on number-sensitive pages and masks them elsewhere', () => {
        expect(normalizeNoise('Up to 10 projects', true)).not.toBe(normalizeNoise('Up to 5 projects', true));
        expect(normalizeNoise('Join 12,431 teams', false)).toBe(normalizeNoise('Join 12,987 teams', false));
    });
    it('applies user patterns and refuses ReDoS-prone ones', () => {
        const ig = compileIgnore(['Promo: [^.]*\\.', '(a+)+$']);
        expect(ig).toHaveLength(1);
        expect(normalizeNoise('Hello. Promo: 20% off today.', true, ig)).toBe(
            normalizeNoise('Hello. Promo: free shipping.', true, ig),
        );
    });
});

describe('extraction', () => {
    it('drops scripts, nav, footer and consent banners but keeps main content', () => {
        const ex = extract(fx('pricing_v1.html'));
        expect(ex.text).toContain('Simple pricing for every team');
        expect(ex.text).not.toMatch(/We use cookies|CSRF|© 2026|Home/);
        expect(ex.title).toBe('Acme pricing');
    });
    it('splits sections by headings', () => {
        const ex = extract(fx('terms_v1.html'));
        expect(ex.sections.map((s) => s.heading)).toEqual([
            'Terms of Service',
            '1. Accounts',
            '2. Payment',
            '3. Limitation of Liability',
            '4. Governing Law',
        ]);
    });
    it('collects absolute links including nav/footer', () => {
        const l = linksFrom(fx('pricing_v1.html'), 'https://acme.test/pricing');
        expect(l.map((x) => x.href)).toContain('https://acme.test/terms');
    });
    it('limits extraction and plan parsing to a CSS selector', () => {
        const html = `<html><head><title>Acme</title></head><body><main>
            <section id="hero"><h2>Hero</h2><p>Starter $1 per month for a banner that is outside the pin.</p></section>
            <section id="pricing"><h2>Plans</h2><div class="card"><h3>Pro</h3><p>$12 per user / month</p></div></section>
        </main></body></html>`;
        const pinned = extract(html, '#pricing');
        expect(pinned.text).toContain('Pro');
        expect(pinned.text).not.toContain('Hero');
        expect(extractPlans(html, undefined, '#pricing').map((p) => p.name)).toEqual(['Pro']);
        expect(extractPlans(html).map((p) => p.name)).toEqual(expect.arrayContaining(['Pro']));
    });
});

describe('diff', () => {
    it('finds added/removed sentences and ignores moved ones', () => {
        const d = diffUnits(['a', 'b', 'c', 'd'], ['b', 'c', 'x', 'a'], (s) => s);
        expect(d).toEqual({ added: ['x'], removed: ['d'] });
    });
    it('splits long lines into sentences', () => {
        expect(units(`${'Word '.repeat(50)}end. Second sentence here.`)).toHaveLength(2);
    });
    it('detects renamed sections', () => {
        const text = 'This section explains how we handle refunds for annual plans in detail and when.';
        const out = diffSections([{ heading: 'Refunds', text }], [{ heading: 'Refund policy', text }], true);
        expect(out).toHaveLength(1);
        expect(out[0].change).toBe('renamed');
    });
});

describe('prices', () => {
    it('parses amounts in several formats', () => {
        expect(parseAmount('1,234.56', 'USD')).toBe(1234.56);
        expect(parseAmount('1.234,56', 'EUR')).toBe(1234.56);
        expect(parseAmount('19,99', 'EUR')).toBe(19.99);
        expect(parseAmount('0.125', 'USD')).toBe(0.125);
        expect(parseAmount('1,000', 'USD')).toBe(1000);
        expect(parseAmount('1.000', 'EUR')).toBe(1000);
    });
    it('finds prices with currency before or after', () => {
        expect(findPrices('From $12/mo or 15 € per month, US$9 and CHF 20').map((p) => [p.currency, p.amount])).toEqual(
            [
                ['USD', 12],
                ['EUR', 15],
                ['USD', 9],
                ['CHF', 20],
            ],
        );
        expect(findPrices('Save 20% on 3 projects')).toEqual([]);
    });
    it('detects period, billing and unit', () => {
        expect(periodOf('/mo per user', 'billed annually')).toEqual({
            period: 'month',
            billing: 'annual',
            unit: 'user',
        });
        expect(periodOf(' per year', '')).toEqual({ period: 'year', billing: 'annual', unit: null });
        expect(periodOf(' one-time', '')).toMatchObject({ period: 'one_time' });
    });
    it('extracts plans from a card layout incl. a contact-sales plan', () => {
        const plans = extractPlans(fx('pricing_v1.html'));
        const by = Object.fromEntries(plans.map((p) => [p.name, p.prices.map(fmtPrice)]));
        expect(Object.keys(by)).toEqual(['Free', 'Pro', 'Business', 'Enterprise']);
        expect(by.Free).toEqual(['$0']);
        expect(by.Pro).toContain('$12/month per user (billed annually)');
        expect(by.Pro.some((x) => x.startsWith('$15/month per user'))).toBe(true);
        expect(by.Business).toEqual(['$25/month per user']);
        expect(by.Enterprise[0]).toMatch(/custom|contact sales/i);
    });
    it('extracts plans from a comparison table', () => {
        const html =
            '<main><table><thead><tr><th>Feature</th><th>Starter</th><th>Growth</th></tr></thead><tbody><tr><td>Price</td><td>€9 / month</td><td>€29 / month</td></tr><tr><td>Seats</td><td>1</td><td>5</td></tr></tbody></table><p>All prices exclude VAT and are shown for our standard monthly subscription plans for small teams.</p></main>';
        const plans = extractPlans(html);
        expect(plans.map((p) => [p.name, fmtPrice(p.prices[0])])).toEqual([
            ['Starter', '€9/month'],
            ['Growth', '€29/month'],
        ]);
    });
    it('a plan whose name is still on the page but whose price stopped rendering is low confidence, not high', () => {
        const page = (withEnt: boolean) =>
            `<main><div class="card"><h3>Pro</h3><p>$7 per user / month</p></div>` +
            `<div class="card"><h3>Enterprise+</h3>${withEnt ? '<p>$45 per user / month</p>' : '<p>Contact sales for pricing</p>'}</div></main>`;
        const a = snap('pricing', page(true));
        const b = snap('pricing', page(false));
        const items = comparePages(a, b, CMP);
        const removed = items.find((i) => i.kind === 'plan_removed');
        expect(removed?.severity).toBe('low');
        expect(removed?.details.low_confidence).toBeTruthy();
    });
    it('does not use call-to-action labels as plan names', () => {
        const card = (h: string, price: string) =>
            `<div class="card"><h3>${h}</h3><p>${price} per month</p><a href="/x">Buy now</a></div>`;
        const html = `<main><h2>Plans and pricing for teams of every size, billed monthly or yearly</h2>${card('Team', '$12')}${card('Scale', '$29')}<div class="card"><h3>Let’s talk</h3><p>$12 per month</p></div><div class="card"><h3>Add more seats</h3><p>$1 per month</p></div></main>`;
        const names = extractPlans(html).map((p) => p.name);
        expect(names).toContain('Team');
        expect(names).toContain('Scale');
        expect(names.some((n) => /let.s talk|add more/i.test(n))).toBe(false);
    });
    it('compares plans: price change, plan added, plan removed', () => {
        const a = extractPlans(fx('pricing_v1.html'));
        const b = extractPlans(fx('pricing_v2.html'));
        const items = comparePlans(a, b);
        const kinds = items.map((i) => i.kind).sort();
        expect(kinds).toEqual(['plan_added', 'plan_removed', 'price_changed']);
        const pc = items.find((i) => i.kind === 'price_changed')!;
        expect(pc.summary).toBe(
            '"Pro" price changed from $12/month per user (billed annually) to $14/month per user (billed annually) (up 16.7%).',
        );
        expect(items.every((i) => i.severity === 'high')).toBe(true);
    });
    it('reports a parse failure instead of "all plans removed"', () => {
        const a = extractPlans(fx('pricing_v1.html'));
        const items = comparePlans(a, []);
        expect(items.map((i) => i.kind)).toEqual(['pricing_unparsed']);
    });
    it('ignores label-only differences', () => {
        const p = (unit: string | null): Plan[] => [
            {
                name: 'Pro',
                key: 'pro',
                prices: [{ amount: 10, currency: 'USD', period: 'month', billing: null, unit, raw: '$10' }],
            },
        ];
        expect(comparePlans(p(null), p('user'))).toEqual([]);
    });
});

describe('page comparison (fixtures)', () => {
    it('pricing: noise-only variant gives no change', () => {
        expect(
            comparePages(snap('pricing', fx('pricing_v1.html')), snap('pricing', fx('pricing_v1_noise.html')), CMP),
        ).toEqual([]);
    });
    it('pricing: real change gives price/plan items and a feature-limit text change', () => {
        const items = comparePages(snap('pricing', fx('pricing_v1.html')), snap('pricing', fx('pricing_v2.html')), CMP);
        const kinds = items.map((i) => i.kind);
        expect(kinds).toContain('price_changed');
        expect(kinds).toContain('plan_added');
        expect(kinds).toContain('plan_removed');
        // feature-limit text edits are kept, attached to the plan change rather than sent as a second alert
        expect(kinds).not.toContain('pricing_text_changed');
        expect(items.map((i) => i.summary).join(' ')).toContain('Up to 5 projects');
    });
    it('terms: date-only change is ignored; liability and AI changes are high severity', () => {
        expect(comparePages(snap('terms', fx('terms_v1.html')), snap('terms', fx('terms_v1_noise.html')), CMP)).toEqual(
            [],
        );
        const items = comparePages(snap('terms', fx('terms_v1.html')), snap('terms', fx('terms_v2.html')), CMP);
        expect(items).toHaveLength(1);
        expect(items[0].kind).toBe('legal_text_changed');
        expect(items[0].severity).toBe('high');
        const secs = (items[0].details.sections as { heading: string; change: string }[]).map(
            (s) => `${s.change}:${s.heading}`,
        );
        expect(secs).toContain('modified:3. Limitation of Liability');
        expect(secs).toContain('added:4. Use of AI features');
        expect(secs).toContain('renamed:5. Governing Law');
    });
    it('changelog: new entry with launch keyword is medium', () => {
        const items = comparePages(
            snap('changelog', fx('changelog_v1.html')),
            snap('changelog', fx('changelog_v2.html')),
            CMP,
        );
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({ kind: 'new_entries', severity: 'medium' });
        expect(items[0].summary).toContain('Introducing usage-based pricing');
    });
    it('generic: rotating counters/viewers/session ids are ignored; real copy change is reported', () => {
        expect(
            comparePages(snap('generic', fx('generic_v1.html')), snap('generic', fx('generic_v1_noise.html')), CMP),
        ).toEqual([]);
        const items = comparePages(snap('generic', fx('generic_v1.html')), snap('generic', fx('generic_v2.html')), CMP);
        expect(items.map((i) => i.kind)).toEqual(['content_changed']);
        expect(items[0].summary).toContain('AI assistant');
    });
    it('watch keywords: appearing keyword is reported', () => {
        const items = comparePages(
            snap('generic', fx('generic_v1.html'), undefined, ['AI']),
            snap('generic', fx('generic_v2.html'), undefined, ['AI']),
            CMP,
        );
        expect(items.map((i) => i.kind)).toContain('keyword_changed');
    });
    it('minChangeChars suppresses tiny edits on generic pages', () => {
        const a = snap('generic', '<main><h1>Hi</h1><p>We build tools for teams everywhere on earth today.</p></main>');
        const b = snap('generic', '<main><h1>Hi</h1><p>We build tools for teams everywhere on earth now.</p></main>');
        expect(comparePages(a, b, { ...CMP, minChangeChars: 200 })).toEqual([]);
    });
});

describe('careers', () => {
    it('detects ATS boards in links, embeds and URLs', () => {
        expect(detectBoard(fx('careers.html'))).toEqual({ ats: 'greenhouse', slug: 'acme' });
        expect(detectBoard('https://jobs.lever.co/palantir/abc')).toEqual({ ats: 'lever', slug: 'palantir' });
        expect(detectBoard('<a href="https://jobs.ashbyhq.com/linear">Jobs</a>')).toEqual({
            ats: 'ashby',
            slug: 'linear',
        });
        expect(detectBoard('<a href="https://job-boards.greenhouse.io/stripe/jobs/1">x</a>')).toEqual({
            ats: 'greenhouse',
            slug: 'stripe',
        });
        expect(detectBoard('no board here')).toBe(null);
    });
    it('parses all three ATS formats', () => {
        expect(parseBoard('greenhouse', JSON.parse(fx('gh_v1.json')))[0]).toEqual({
            id: '101',
            title: 'Senior Backend Engineer',
            department: 'Engineering',
            location: 'Remote (US)',
        });
        expect(
            parseBoard('lever', [{ id: 'x', text: 'SRE', categories: { team: 'Infra', location: 'Remote' } }]),
        ).toEqual([{ id: 'x', title: 'SRE', department: 'Infra', location: 'Remote' }]);
        expect(
            parseBoard('ashby', {
                jobs: [
                    { id: 'a', title: 'PM', department: 'Product', location: 'NYC' },
                    { id: 'b', title: 'Hidden', isListed: false },
                ],
            }),
        ).toHaveLength(1);
    });
    it('reports opened/closed roles and keyword trends', () => {
        const a = parseBoard('greenhouse', JSON.parse(fx('gh_v1.json')));
        const b = parseBoard('greenhouse', JSON.parse(fx('gh_v2.json')));
        const items = compareJobs(a, b, ['machine learning', 'AI']);
        expect(items[0].kind).toBe('jobs_changed');
        expect(items[0].severity).toBe('medium');
        expect(items[0].summary).toMatch(
            /^2 new roles \(1 Engineering, 1 Research\); 1 role closed \(1 Design\)\. Open roles: 3 → 4 \(\+33%\)/,
        );
        expect(items[1]).toMatchObject({ kind: 'careers_keywords_changed' });
        expect(compareJobs(a, a, ['AI'])).toEqual([]);
    });
});

describe('sitemaps', () => {
    it('parses index and urlset', () => {
        expect(parseSitemap(fx('sitemap_index.xml'))).toMatchObject({
            kind: 'index',
            locs: ['https://acme.test/sitemap-pages.xml', 'https://acme.test/sitemap-blog.xml.gz'],
        });
        expect(parseSitemap(fx('sitemap_blog.xml')).locs[1]).toBe('https://acme.test/blog/q3-update?utm_source=x&a=1');
    });
    it('diffs URL sets, flags product-like paths, normalises trailing slashes', () => {
        const a = parseSitemap(fx('sitemap_pages_v1.xml')).locs;
        const b = parseSitemap(fx('sitemap_pages_v2.xml')).locs;
        const items = compareSitemaps(a, b, true);
        expect(items.map((i) => [i.kind, i.severity, i.details.count])).toEqual([
            ['pages_added', 'medium', 1],
            ['pages_removed', 'medium', 1],
        ]);
        expect(compareSitemaps(a, [...a.map((u) => (u.endsWith('/') ? u.slice(0, -1) : `${u}/`))], true)).toEqual([]);
        expect(compareSitemaps(a, b, false).map((i) => i.kind)).toEqual(['pages_added']);
    });
    it('marks mass churn as low severity', () => {
        const a = Array.from({ length: 40 }, (_, i) => `https://acme.test/p/${i}`);
        const b = Array.from({ length: 40 }, (_, i) => `https://acme.test/q/${i}`);
        expect(compareSitemaps(a, b, true).every((i) => i.severity === 'low')).toBe(true);
    });
});

describe('discovery and input', () => {
    it('picks the right links from a homepage', () => {
        const links = [
            { href: 'https://acme.com/', text: 'Home' },
            { href: 'https://acme.com/pricing', text: 'Pricing' },
            { href: 'https://acme.com/legal/terms', text: 'Terms of Service' },
            { href: 'https://acme.com/privacy-policy', text: 'Privacy' },
            { href: 'https://jobs.lever.co/acme', text: 'Careers' },
            { href: 'https://other.com/pricing', text: 'Pricing' },
        ];
        expect(pickLink(links, 'pricing', 'acme.com')).toBe('https://acme.com/pricing');
        expect(pickLink(links, 'terms', 'acme.com')).toBe('https://acme.com/legal/terms');
        expect(pickLink(links, 'privacy', 'acme.com')).toBe('https://acme.com/privacy-policy');
        expect(pickLink(links, 'careers', 'acme.com')).toBe('https://jobs.lever.co/acme');
        expect(pickLink(links, 'changelog', 'acme.com')).toBe(null);
    });
    it('guesses page types from URLs', () => {
        expect(guessType('https://a.com/pricing')).toBe('pricing');
        expect(guessType('https://a.com/legal/privacy-policy')).toBe('privacy');
        expect(guessType('https://a.com/terms-of-service')).toBe('terms');
        expect(guessType('https://boards.greenhouse.io/acme')).toBe('careers');
        expect(guessType('https://a.com/sitemap.xml')).toBe('product');
        expect(guessType('https://a.com/changelog')).toBe('changelog');
        expect(guessType('https://a.com/about')).toBe('generic');
    });
    it('validates input', () => {
        const { input, problems } = parseInput({
            pages: [
                { url: 'acme.com/pricing' },
                { url: 'http://127.0.0.1/x' },
                'https://acme.com/terms',
                { url: 'https://acme.com/a', type: 'bogus' },
            ],
            domains: ['https://www.acme.com/about', 'localhost'],
            webhookUrl: 'http://hooks.example.com/x',
            stateStoreName: 'bad name!',
            ignorePatterns: ['(a+)+'],
            maxPages: 9999,
        });
        expect(input.pages.map((p) => [p.url, p.type])).toEqual([
            ['https://acme.com/pricing', 'pricing'],
            ['https://acme.com/terms', 'terms'],
        ]);
        expect(input.domains).toEqual(['www.acme.com']);
        expect(input.webhookUrl).toBe(null);
        expect(input.stateStoreName).toBe('fairquery-competitor-tracker');
        expect(input.maxPages).toBe(200);
        expect(input.mode).toBe('watch');
        expect(input.digestJobsRequested).toBe(false);
        expect(digestJobsWarning(input)).toBe(null);
        expect(input.cssSelector).toBe(null);
        expect(input.pages.every((p) => p.cssSelector === null)).toBe(true);
        expect(problems.map((p) => p.field).sort()).toEqual([
            'domains',
            'ignorePatterns',
            'pages',
            'pages',
            'stateStoreName',
            'webhookUrl',
        ]);
        expect(JSON.stringify(problems)).not.toContain('hooks.example.com');
    });
    it('accepts digest mode and a per-page CSS selector, and drops an invalid selector', () => {
        const { input, problems } = parseInput({
            mode: 'digest',
            digestJobs: false,
            cssSelector: '#pricing',
            pages: [
                { url: 'https://acme.com/pricing', cssSelector: '.plans' },
                { url: 'https://acme.com/terms', cssSelector: 'div[' },
                'https://acme.com/changelog',
            ],
        });
        expect(input.mode).toBe('digest');
        expect(input.digestJobsRequested).toBe(false);
        expect(digestJobsWarning(input)).toBe(null);
        expect(input.digestTech).toBe(true);
        expect(input.cssSelector).toBe('#pricing');
        expect(input.pages.map((p) => [p.url, p.cssSelector])).toEqual([
            ['https://acme.com/pricing', '.plans'],
            ['https://acme.com/changelog', '#pricing'],
        ]);
        expect(problems.some((p) => p.field === 'pages' && /invalid CSS selector/.test(p.message))).toBe(true);
    });
    it('warns for digestJobs true only in digest mode, and still accepts the key', () => {
        const omitted = parseInput({ mode: 'digest' });
        expect(omitted.problems).toEqual([]);
        expect(omitted.input.digestJobsRequested).toBe(false);
        expect(digestJobsWarning(omitted.input)).toBe(null);

        const off = parseInput({ mode: 'digest', digestJobs: false });
        expect(off.problems).toEqual([]);
        expect(off.input.digestJobsRequested).toBe(false);
        expect(digestJobsWarning(off.input)).toBe(null);

        const on = parseInput({ mode: 'digest', digestJobs: true });
        expect(on.problems).toEqual([]);
        expect(on.input.digestJobsRequested).toBe(true);
        expect(digestJobsWarning(on.input)).toBe(DIGEST_JOBS_RETIRED_WARNING);
        expect(on.input.digestTech).toBe(true);

        const watch = parseInput({ mode: 'watch', digestJobs: true, pages: ['https://acme.com/pricing'] });
        expect(watch.problems).toEqual([]);
        expect(watch.input.mode).toBe('watch');
        expect(watch.input.digestJobsRequested).toBe(true);
        expect(watch.input.pages.map((p) => [p.url, p.type])).toEqual([['https://acme.com/pricing', 'pricing']]);
        expect(watch.input.digestTech).toBe(true);
        expect(digestJobsWarning(watch.input)).toBe(null);
        const watchOff = parseInput({ mode: 'watch', pages: ['https://acme.com/pricing'] });
        expect(watchOff.input.mode).toBe('watch');
        expect(watchOff.input.pages).toEqual(watch.input.pages);
        expect(watchOff.input.minSeverity).toBe(watch.input.minSeverity);
        expect(watchOff.input.digestTech).toBe(watch.input.digestTech);
        expect(digestJobsWarning(watchOff.input)).toBe(null);

        const yes = parseInput({ mode: 'digest', digestJobs: 'yes' });
        expect(yes.problems).toEqual([]);
        expect(yes.input.mode).toBe('digest');
        expect(yes.input.digestJobsRequested).toBe(false);
        expect(digestJobsWarning(yes.input)).toBe(null);
    });
    it('input schema has no digestJobs property', () => {
        const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../.actor/input_schema.json');
        const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
            properties?: Record<string, unknown>;
            required?: string[];
        };
        expect(schema.properties?.digestJobs).toBeUndefined();
        expect(schema.required ?? []).not.toContain('digestJobs');
        expect(schemaCopyMentionsRetiredJobs(schema)).toEqual([]);
        const planted = {
            properties: {
                digestJobs: { title: 'Still here', description: 'Calls the jobs feed', default: true },
                mode: { sectionCaption: 'company-jobs-feed prices', enumTitles: ['jobs-feed'] },
            },
        };
        const hits = schemaCopyMentionsRetiredJobs(planted);
        expect(hits.some((hit) => hit.includes('digestJobs'))).toBe(true);
        expect(hits.some((hit) => hit.toLowerCase().includes('jobs feed'))).toBe(true);
        expect(hits.some((hit) => hit.toLowerCase().includes('company-jobs-feed'))).toBe(true);
        expect(hits.some((hit) => hit.toLowerCase().includes('jobs-feed'))).toBe(true);
    });
});

describe('webhook payloads', () => {
    const rows = [
        {
            url: 'https://acme.com/pricing',
            page_type: 'pricing',
            label: 'Acme',
            severity: 'high',
            change_kind: 'price_changed',
            summary: 'Pro up',
        },
    ];
    it('formats json, slack and discord', () => {
        expect(webhookBody('json', 'w', rows, null)).toMatchObject({ watchlist: 'w', count: 1, changes: rows });
        expect(Object.keys(webhookBody('slack', 'w', rows, null))).toEqual(['text']);
        expect((webhookBody('discord', 'w', rows, null) as { content: string }).content).toContain('[HIGH] Acme');
    });
});

describe('fetcher politeness', () => {
    it('sends an honest UA, no cookies, conditional headers; honours robots on every redirect hop', async () => {
        const w = fakeWeb({
            'https://acme.test/robots.txt': 'User-agent: *\nDisallow: /secret',
            'https://acme.test/pricing': { status: 301, body: '', headers: { location: '/secret/pricing' } },
            'https://acme.test/terms': fx('terms_v1.html'),
        });
        await expect(w.fetcher.get('https://acme.test/pricing')).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
        await w.fetcher.get('https://acme.test/terms', {
            etag: '"abc"',
            lastModified: 'Sat, 17 Oct 2026 10:00:00 GMT',
        });
        const hit = w.hits.find((h) => h.url === 'https://acme.test/terms')!;
        expect(hit.headers['user-agent']).toMatch(/^FairqueryChangeTracker\/1\.0 \(\+https:\/\/getfairquery\.com/);
        expect(hit.headers['if-none-match']).toBe('"abc"');
        expect(hit.headers.cookie).toBeUndefined();
        expect(w.hits.some((h) => h.url === 'https://acme.test/secret/pricing')).toBe(false);
    });
    it('stops a host after 403/429 (kill switch) and skips robots 5xx and huge crawl delays', async () => {
        const w = fakeWeb({
            'https://a.test/robots.txt': '',
            'https://a.test/x': { status: 429, body: '', headers: {} },
            'https://a.test/y': 'ok',
            'https://b.test/robots.txt': { status: 503, body: '', headers: {} },
            'https://c.test/robots.txt': 'User-agent: *\nCrawl-delay: 60',
        });
        await expect(w.fetcher.get('https://a.test/x')).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        await expect(w.fetcher.get('https://a.test/y')).rejects.toMatchObject({ code: 'HOST_BLOCKED' });
        expect(w.hits.filter((h) => h.url === 'https://a.test/y')).toHaveLength(0);
        await expect(w.fetcher.get('https://b.test/p')).rejects.toMatchObject({ code: 'ROBOTS_UNAVAILABLE' });
        await expect(w.fetcher.get('https://c.test/p')).rejects.toMatchObject({ code: 'CRAWL_DELAY_TOO_LONG' });
    });
    it('reports 304 Not Modified', async () => {
        const w = fakeWeb({
            'https://a.test/robots.txt': '',
            'https://a.test/p': { status: 304, body: '', headers: {} },
        });
        const r = await w.fetcher.get('https://a.test/p', { etag: '"1"' });
        expect(r.notModified).toBe(true);
    });
    it('refuses hosts that resolve to private addresses', async () => {
        const { Fetcher } = await import('../src/http.js');
        const f = new Fetcher({ resolver: async () => [{ address: '10.0.0.5', family: 4 }] });
        await expect(f.get('https://evil.test/')).rejects.toBeInstanceOf(HttpError);
    });
    it('node transport decompresses .xml.gz bodies and caps size', async () => {
        const gz = gzipSync(Buffer.from(fx('sitemap_blog.xml')));
        const srv = http.createServer((req, res) => {
            if (req.url === '/big') {
                res.end('x'.repeat(5000));
                return;
            }
            res.setHeader('content-type', 'application/gzip');
            res.end(gz);
        });
        await new Promise<void>((r) => {
            srv.listen(0, '127.0.0.1', () => r());
        });
        const port = (srv.address() as { port: number }).port;
        const pinned = { address: '127.0.0.1', family: 4 };
        const r = await nodeTransport(new URL(`http://acme.test:${port}/s.xml.gz`), {}, 1_000_000, pinned, 5000);
        expect(parseSitemap(r.body).locs).toHaveLength(2);
        await expect(
            nodeTransport(new URL(`http://acme.test:${port}/big`), {}, 1000, pinned, 5000),
        ).rejects.toMatchObject({ code: 'TOO_LARGE' });
        srv.close();
    });
});
