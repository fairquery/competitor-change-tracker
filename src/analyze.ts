import { createHash } from 'node:crypto';

import { compareJobs, countKeywords, wordRe } from './careers.js';
import { clip, diffSections, type SectionChange } from './diff.js';
import { entriesFrom, extract, loadClean } from './extract.js';
import { isNumberSensitive, normalizeNoise } from './noise.js';
import { comparePlans, extractPlans, fmtPrice, PRICE_RE } from './pricing.js';
import { compareSitemaps } from './sitemap.js';
import {
    type ChangeItem,
    type Entry,
    type Job,
    LIMITS,
    type PageType,
    type Plan,
    type Severity,
    type Snapshot,
} from './types.js';

export const sha = (s: string, n = 40): string => createHash('sha1').update(s).digest('hex').slice(0, n);

export interface CompareOptions {
    ignore: RegExp[];
    minChangeChars: number;
    careersKeywords: string[];
    watchKeywords: string[];
    includeDiff: boolean;
}

export const PAGE_LABEL: Record<PageType, string> = {
    pricing: 'Pricing page',
    product: 'Product pages',
    terms: 'Terms of service',
    privacy: 'Privacy policy',
    careers: 'Careers page',
    changelog: 'Changelog',
    blog: 'Blog',
    generic: 'Page',
};

/** Build a snapshot from a fetched HTML document. */
export function snapshotFromHtml(
    a: {
        url: string;
        finalUrl: string;
        type: PageType;
        html: string;
        etag?: string | null;
        lastModified?: string | null;
        rendered?: boolean;
        checkedAt: string;
        cssSelector?: string | null;
    },
    opts: Pick<CompareOptions, 'ignore' | 'watchKeywords'>,
): Snapshot {
    const $ = loadClean(a.html); // parse once; the extractors below only read from it
    const ex = extract($, a.cssSelector);
    const plans = a.type === 'pricing' ? extractPlans(a.html, $, a.cssSelector) : null;
    const entries = a.type === 'changelog' || a.type === 'blog' ? entriesFrom($, a.finalUrl, a.cssSelector) : null;
    const contentKey = normalizeNoise(ex.text, isNumberSensitive(a.type), opts.ignore);
    return {
        v: 1,
        url: a.url,
        final_url: a.finalUrl,
        type: a.type,
        checked_at: a.checkedAt,
        etag: a.etag ?? null,
        last_modified: a.lastModified ?? null,
        raw_hash: sha(a.html),
        content_hash: sha(contentKey),
        rendered: !!a.rendered,
        title: ex.title,
        sections: ex.sections,
        plans,
        entries,
        jobs: null,
        ats: null,
        sitemap_urls: null,
        sitemap_files: null,
        keyword_counts: countKeywords([ex.text], opts.watchKeywords),
        css_selector: a.cssSelector ?? null,
    };
}

const LEGAL_SENSITIVE =
    /arbitrat|class action|jury|liabilit|indemn|governing law|jurisdiction|terminat|suspend|auto(?:matic(?:ally)?)?[- ]?renew|refund|\bfees?\b|pric(?:e|ing)|charg(?:e|es|ed)\b|payment|\bsell\b|sale of (?:your|personal)|share (?:your|personal)|third[- ]part|advertis|artificial intelligence|\bAI\b|machine learning|train(?:ing)? (?:our|on|its|models?)|model training|retention|retain|biometric|location data|children|minors?\b|subprocessor|data transfer|opt[- ]out|consent/i;

function sectionSummary(changes: SectionChange[]): string {
    return changes
        .slice(0, 6)
        .map((c) =>
            c.change === 'renamed'
                ? `"${clip(c.previous_heading ?? '', 60)}" renamed to "${clip(c.heading, 60)}"`
                : `"${clip(c.heading || '(top of page)', 60)}" (${c.change}${c.change === 'modified' ? `: +${c.added.length}/−${c.removed.length} sentences` : ''})`,
        )
        .join(', ');
}

function example(changes: SectionChange[]): string {
    // the most informative sentences: modified sections first, longest sentence wins
    const pick = (list: (c: SectionChange) => string[]) => {
        for (const group of [changes.filter((c) => c.change === 'modified'), changes]) {
            const all = group.flatMap(list).filter((x) => x.length >= 12);
            if (all.length) return all.reduce((a, b) => (b.length > a.length ? b : a));
        }
        return null;
    };
    const rem = pick((c) => c.removed);
    const add = pick((c) => c.added);
    return `${rem ? ` Removed: “${clip(rem, 140)}”` : ''}${add ? ` Added: “${clip(add, 140)}”` : ''}`;
}

function diffDetails(changes: SectionChange[], include: boolean): Record<string, unknown> {
    const total = changes.reduce((n, c) => n + c.changed_chars, 0);
    return {
        sections_changed: changes.length,
        changed_chars: total,
        sections: include
            ? changes.slice(0, 30).map((c) => ({
                  heading: c.heading,
                  change: c.change,
                  ...(c.previous_heading ? { previous_heading: c.previous_heading } : {}),
                  added: c.added.slice(0, 10).map((x) => clip(x, 400)),
                  removed: c.removed.slice(0, 10).map((x) => clip(x, 400)),
                  more_added: Math.max(0, c.added.length - 10),
                  more_removed: Math.max(0, c.removed.length - 10),
              }))
            : changes.slice(0, 30).map((c) => ({ heading: c.heading, change: c.change })),
    };
}

/** Text diff for a page, with the type's noise rules. Price tokens are masked when plans were parsed. */
function textChange(prev: Snapshot, next: Snapshot, o: CompareOptions, maskPrices: boolean): ChangeItem | null {
    const ignore = maskPrices ? [...o.ignore, new RegExp(PRICE_RE.source, 'g')] : o.ignore;
    const changes = diffSections(prev.sections, next.sections, isNumberSensitive(next.type), ignore);
    if (!changes.length) return null;
    const total = changes.reduce((n, c) => n + c.changed_chars, 0);
    const label = PAGE_LABEL[next.type];
    const legal = next.type === 'terms' || next.type === 'privacy';
    const min = legal ? Math.min(o.minChangeChars, 10) : o.minChangeChars;
    if (total < min) return null;
    let severity: Severity = 'low';
    let kind = 'content_changed';
    if (legal) {
        kind = 'legal_text_changed';
        const sensitive = changes.some((c) =>
            [...c.added, ...c.removed, c.heading].some((t) => LEGAL_SENSITIVE.test(t)),
        );
        severity = sensitive && total >= 40 ? 'high' : total >= 30 ? 'medium' : 'low';
    } else if (next.type === 'pricing') {
        kind = 'pricing_text_changed';
        severity = total >= 40 ? 'medium' : 'low';
    } else if (total >= 1500 || changes.length >= 5) severity = 'medium';
    return {
        kind,
        severity,
        summary: `${label}: ${changes.length} section${changes.length > 1 ? 's' : ''} changed: ${sectionSummary(changes)}.${example(changes)}`,
        details: diffDetails(changes, o.includeDiff),
    };
}

const LAUNCH_RE =
    /\b(pric(?:e|es|ing)|launch(?:es|ed|ing)?|introduc(?:es|ing)|now available|general availability|\bGA\b|deprecat|sunset|end of life|acqui(?:re|res|red|sition)|raises|funding|series [a-e]|partnership|new plan)\b/i;

function compareEntries(prev: Entry[], next: Entry[], type: PageType, watch: string[]): ChangeItem[] {
    const pk = new Set(prev.map((e) => e.title.toLowerCase()));
    const nk = new Set(next.map((e) => e.title.toLowerCase()));
    const fresh = next.filter((e) => !pk.has(e.title.toLowerCase()));
    const gone = prev.filter((e) => !nk.has(e.title.toLowerCase()));
    if (!fresh.length) return [];
    const hot = fresh.filter((e) => LAUNCH_RE.test(e.title) || watch.some((k) => wordRe(k).test(e.title)));
    const what = type === 'changelog' ? 'changelog entr' : 'post';
    const plural = type === 'changelog' ? (fresh.length > 1 ? 'ies' : 'y') : fresh.length > 1 ? 's' : '';
    return [
        {
            kind: 'new_entries',
            severity: hot.length ? 'medium' : 'low',
            summary: `${fresh.length} new ${what}${plural}: ${fresh
                .slice(0, 5)
                .map((e) => `“${clip(e.title, 100)}”`)
                .join(', ')}${fresh.length > 5 ? ', …' : ''}.`,
            details: {
                new_entries: fresh.slice(0, LIMITS.maxListedItems),
                launch_or_keyword_matches: hot.map((e) => e.title).slice(0, LIMITS.maxListedItems),
                no_longer_listed: gone.length,
            },
        },
    ];
}

function compareKeywords(prev: Record<string, number>, next: Record<string, number>): ChangeItem[] {
    const appeared = Object.keys(next).filter((k) => (next[k] ?? 0) > 0 && !(prev[k] ?? 0) && k in prev);
    const vanished = Object.keys(prev).filter((k) => (prev[k] ?? 0) > 0 && !(next[k] ?? 0) && k in next);
    if (!appeared.length && !vanished.length) return [];
    const parts: string[] = [];
    if (appeared.length) parts.push(`now mentions ${appeared.map((k) => `“${k}”`).join(', ')}`);
    if (vanished.length) parts.push(`no longer mentions ${vanished.map((k) => `“${k}”`).join(', ')}`);
    return [
        {
            kind: 'keyword_changed',
            severity: 'medium',
            summary: `Page ${parts.join(' and ')}.`,
            details: { appeared, disappeared: vanished, before: prev, after: next },
        },
    ];
}

const textBlob = (s: Snapshot): string =>
    `${s.title ?? ''}\n${s.sections.map((x) => `${x.heading}\n${x.text}`).join('\n')}`.toLowerCase();
/** Does this plan name appear as a distinct phrase in the page text (not just as a substring of another word)? */
function hasPlanName(name: string, text: string): boolean {
    const n = name.trim().toLowerCase();
    if (n.length < 3) return false;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(text);
}

/** Compare a page's previous and new snapshot and return only meaningful changes. */
export function comparePages(prev: Snapshot, next: Snapshot, o: CompareOptions): ChangeItem[] {
    const items: ChangeItem[] = [];
    if (next.sitemap_urls && prev.sitemap_urls) {
        items.push(...compareSitemaps(prev.sitemap_urls, next.sitemap_urls, true));
        return items;
    }
    if (next.jobs && prev.jobs) {
        items.push(...compareJobs(prev.jobs, next.jobs, o.careersKeywords));
        items.push(...compareKeywords(prev.keyword_counts, next.keyword_counts));
        return items;
    }
    let maskPrices = false;
    if (next.type === 'pricing' && prev.plans && next.plans && (prev.plans.length || next.plans.length)) {
        const pi = comparePlans(prev.plans, next.plans);
        // Guard against intermittent rendering: a plan "added"/"removed" whose name is still present in the other
        // snapshot's text existed on both sides and was only parsed on one (e.g. a price that renders only sometimes).
        // Report it low instead of high, so a flaky pricing page does not raise a false alarm.
        const prevText = textBlob(prev);
        const nextText = textBlob(next);
        for (const it of pi) {
            const name = typeof it.details.plan === 'string' ? (it.details.plan as string) : '';
            const planWord = name && hasPlanName(name, it.kind === 'plan_added' ? prevText : nextText);
            if ((it.kind === 'plan_added' || it.kind === 'plan_removed') && planWord) {
                it.severity = 'low';
                it.summary = `${it.summary} (the plan name was already on the other version of the page, so its price may just render intermittently; treated as low confidence)`;
                it.details = { ...it.details, low_confidence: 'plan name present in both versions' };
            }
        }
        items.push(...pi);
        maskPrices = next.plans.length > 0 && prev.plans.length > 0;
    }
    if ((next.type === 'changelog' || next.type === 'blog') && prev.entries?.length && next.entries?.length) {
        items.push(...compareEntries(prev.entries, next.entries, next.type, o.watchKeywords));
    } else if (prev.content_hash !== next.content_hash) {
        const t = textChange(prev, next, o, maskPrices);
        const planItem = items.find((i) => /^(plan_|price|pricing_restructured)/.test(i.kind));
        // a structured plan change already covers this page: attach the text diff instead of a second alert
        if (t && planItem) {
            planItem.details = { ...planItem.details, related_text_change: { summary: t.summary, ...t.details } };
            planItem.summary = `${planItem.summary} Also on the page: ${t.summary}`;
        } else if (t) items.push(t);
    }
    if (next.type === 'careers' && !next.jobs && o.careersKeywords.length) {
        const a = countKeywords(
            prev.sections.map((s) => `${s.heading}\n${s.text}`),
            o.careersKeywords,
        );
        const b = countKeywords(
            next.sections.map((s) => `${s.heading}\n${s.text}`),
            o.careersKeywords,
        );
        const moved = o.careersKeywords.filter((k) => a[k] !== b[k]);
        if (moved.length)
            items.push({
                kind: 'careers_keywords_changed',
                severity: 'medium',
                summary: `Careers page keyword counts changed: ${moved.map((k) => `“${k}” ${a[k]} → ${b[k]}`).join(', ')}.`,
                details: { before: a, after: b },
            });
    }
    items.push(...compareKeywords(prev.keyword_counts, next.keyword_counts));
    return items;
}

const fmtPlans = (plans: Plan[]) =>
    plans
        .slice(0, 8)
        .map((p) => `${p.name} ${p.prices.slice(0, 2).map(fmtPrice).join(' / ')}`)
        .join('; ');

/** One-line description of what the baseline captured. */
export function baselineSummary(s: Snapshot): string {
    const label = PAGE_LABEL[s.type];
    if (s.sitemap_urls)
        return `${label}: baseline of ${s.sitemap_urls.length} URLs from ${s.sitemap_files?.length ?? 0} sitemap file(s).`;
    if (s.jobs)
        return `${label}: baseline of ${s.jobs.length} open roles${s.ats ? ` from the ${s.ats.ats} board "${s.ats.slug}"` : ''}.`;
    if (s.plans?.length) return `${label}: baseline of ${s.plans.length} plan(s): ${fmtPlans(s.plans)}.`;
    if (s.entries?.length)
        return `${label}: baseline of ${s.entries.length} entries, latest “${clip(s.entries[0].title, 80)}”.`;
    const chars = s.sections.reduce((n, x) => n + x.text.length, 0);
    return `${label}: baseline of ${s.sections.length} section(s), ${chars} characters of text${s.type === 'pricing' ? '; no plan prices recognised, text changes will be tracked' : ''}.`;
}

export function jobsSnapshot(
    base: Snapshot,
    jobs: Job[],
    ats: { ats: string; slug: string },
    watch: string[],
): Snapshot {
    const text = jobs.map((j) => `${j.title} ${j.department ?? ''} ${j.location ?? ''}`).join('\n');
    return {
        ...base,
        jobs: [...jobs].sort((a, b) => a.id.localeCompare(b.id)),
        ats,
        content_hash: sha(
            jobs
                .map((j) => `${j.id}|${j.title}`)
                .sort()
                .join('\n'),
        ),
        keyword_counts: { ...base.keyword_counts, ...countKeywords([text], watch) },
    };
}
