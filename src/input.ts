import { detectBoard } from './careers.js';
import { DISCOVERABLE, normalizeDomain } from './discover.js';
import { cssSelectorIssue } from './extract.js';
import { compileIgnore } from './noise.js';
import { unsafeUrlReason } from './ssrf.js';
import { LIMITS, PAGE_TYPES, type PageType, SEVERITIES, type Severity } from './types.js';
import type { WebhookFormat } from './webhook.js';

export type RunMode = 'watch' | 'digest';

export interface PageInput {
    url: string;
    type: PageType;
    label: string | null;
    /** Per-page pin, or the run-level selector when this page did not set its own. */
    cssSelector: string | null;
}

export interface Input {
    watchlistName: string;
    pages: PageInput[];
    domains: string[];
    pageTypes: PageType[];
    maxPages: number;
    careersKeywords: string[];
    watchKeywords: string[];
    minSeverity: Severity;
    ignorePatterns: RegExp[];
    minChangeChars: number;
    includeDiff: boolean;
    renderJs: 'never' | 'auto' | 'always';
    confirmChanges: boolean;
    webhookUrl: string | null;
    webhookFormat: WebhookFormat;
    webhookMinSeverity: Severity;
    sitemapInclude: string[];
    sitemapExclude: string[];
    maxSitemapFiles: number;
    stateStoreName: string;
    resetBaseline: boolean;
    requestDelaySecs: number;
    /** watch = one dataset row per change. digest = one weekly row per competitor domain. */
    mode: RunMode;
    /** True only when the input JSON set digestJobs to true. Any other value, including omitted, is ignored. */
    digestJobsRequested: boolean;
    /** Digest only: call website-tech-seo-ai-readiness for technology add/remove. */
    digestTech: boolean;
    /** Applied to every page and discovered URL that does not set its own cssSelector. */
    cssSelector: string | null;
}

export interface InputProblem {
    field: string;
    value: string;
    message: string;
}

/** One line for the run log and the run summary when digest mode still sets digestJobs to true. */
export const DIGEST_JOBS_RETIRED_WARNING =
    'digestJobs is ignored: jobs opened and closed are not included in digest mode.';

/** Warn only for digest mode with digestJobs set to true. Watch mode, omitted, and false stay quiet. */
export function digestJobsWarning(input: Pick<Input, 'mode' | 'digestJobsRequested'>): string | null {
    return input.mode === 'digest' && input.digestJobsRequested ? DIGEST_JOBS_RETIRED_WARNING : null;
}

/** Guess the page type from the URL path (used when only a URL is given). */
export function guessType(url: string): PageType {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return 'generic';
    }
    const p = u.pathname.toLowerCase();
    if (detectBoard(url)) return 'careers';
    if (/sitemap[^/]*\.xml(\.gz)?$/.test(p)) return 'product';
    if (/(^|\/)(pricing|plans|prices)(\/|$|\.)/.test(p)) return 'pricing';
    if (/privacy|datenschutz|confidentialit/.test(p)) return 'privacy';
    if (/(^|\/)(terms|tos|eula|legal|conditions|agb)([-/._]|$)/.test(p)) return 'terms';
    if (/(^|\/)(careers?|jobs|join-us|work-with-us|hiring)(\/|$)/.test(p)) return 'careers';
    if (/(^|\/)(changelog|release-notes|releases|whats-new|what-s-new|updates|product-updates)(\/|$)/.test(p))
        return 'changelog';
    if (/(^|\/)(blog|news|newsroom|press)(\/|$)/.test(p)) return 'blog';
    return 'generic';
}

const strList = (v: unknown, max: number, maxLen = 300): string[] =>
    Array.isArray(v)
        ? [
              ...new Set(
                  v
                      .filter((x): x is string => typeof x === 'string')
                      .map((x) => x.trim())
                      .filter((x) => x && x.length <= maxLen),
              ),
          ].slice(0, max)
        : [];

const oneOf = <T extends string>(v: unknown, allowed: readonly T[], def: T): T =>
    allowed.includes(v as T) ? (v as T) : def;
const int = (v: unknown, def: number, min: number, max: number) => {
    const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
    return Math.min(max, Math.max(min, n));
};

export function normalizeUrl(raw: string): string | null {
    let s = raw.trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
    try {
        const u = new URL(s);
        u.hash = '';
        if (unsafeUrlReason(u)) return null;
        return u.toString();
    } catch {
        return null;
    }
}

export function parseInput(raw: Record<string, unknown>): { input: Input; problems: InputProblem[] } {
    const problems: InputProblem[] = [];
    const takeSelector = (value: unknown, field: string): { selector: string | null; ok: boolean } => {
        if (value == null || value === '') return { selector: null, ok: true };
        if (typeof value !== 'string') {
            problems.push({ field, value: String(value).slice(0, 200), message: 'cssSelector must be a string' });
            return { selector: null, ok: false };
        }
        const issue = cssSelectorIssue(value);
        if (issue) {
            problems.push({ field, value: value.slice(0, 200), message: `invalid CSS selector (${issue})` });
            return { selector: null, ok: false };
        }
        return { selector: value.trim(), ok: true };
    };
    const runSelector = takeSelector(raw.cssSelector, 'cssSelector');
    const pages: PageInput[] = [];
    const addPage = (url: unknown, type: unknown, label: unknown, field: string, pageSelector: unknown) => {
        if (typeof url !== 'string') return;
        const n = normalizeUrl(url);
        if (!n) {
            problems.push({
                field,
                value: String(url).slice(0, 200),
                message: 'not a public http(s) URL (ports 80/443, no credentials, no IP addresses or internal hosts)',
            });
            return;
        }
        const t = typeof type === 'string' && type && type !== 'auto' ? type : guessType(n);
        if (!(PAGE_TYPES as readonly string[]).includes(t)) {
            problems.push({
                field,
                value: String(type),
                message: `unknown page type; use one of ${PAGE_TYPES.join(', ')}`,
            });
            return;
        }
        const own =
            pageSelector == null || pageSelector === ''
                ? { selector: null, ok: true }
                : takeSelector(pageSelector, field);
        if (!own.ok) return;
        pages.push({
            url: n,
            type: t as PageType,
            label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 100) : null,
            cssSelector: own.selector ?? (runSelector.ok ? runSelector.selector : null),
        });
    };
    if (Array.isArray(raw.pages))
        for (const p of raw.pages.slice(0, LIMITS.maxPages * 2)) {
            if (typeof p === 'string') addPage(p, null, null, 'pages', null);
            else if (p && typeof p === 'object') {
                const o = p as Record<string, unknown>;
                addPage(o.url, o.type, o.label, 'pages', o.cssSelector);
            }
        }
    for (const u of strList(raw.urls, LIMITS.maxPages * 2, 2000)) addPage(u, null, null, 'urls', null);
    const domains: string[] = [];
    for (const d of strList(raw.domains, LIMITS.maxDomains)) {
        const n = normalizeDomain(d);
        if (!n || unsafeUrlReason(new URL(`https://${n}/`)))
            problems.push({ field: 'domains', value: d, message: 'not a valid public domain' });
        else if (!domains.includes(n)) domains.push(n);
    }
    const pageTypes = strList(raw.pageTypes, 10).filter((t): t is PageType => (DISCOVERABLE as string[]).includes(t));
    const rawIgnore = strList(raw.ignorePatterns, LIMITS.maxIgnorePatterns, LIMITS.maxPatternLength);
    const ignorePatterns = compileIgnore(rawIgnore);
    if (ignorePatterns.length < rawIgnore.length)
        problems.push({
            field: 'ignorePatterns',
            value: rawIgnore.join(' | ').slice(0, 200),
            message: 'some patterns were invalid or unsafe (nested quantifiers) and were ignored',
        });
    let webhookUrl: string | null = null;
    if (typeof raw.webhookUrl === 'string' && raw.webhookUrl.trim()) {
        const w = raw.webhookUrl.trim();
        try {
            const u = new URL(w);
            if (u.protocol !== 'https:' || unsafeUrlReason(u)) throw new Error('bad');
            webhookUrl = u.toString();
        } catch {
            problems.push({
                field: 'webhookUrl',
                value: '(hidden)',
                message: 'must be a public https URL; webhook disabled',
            });
        }
    }
    const watchlistName =
        typeof raw.watchlistName === 'string' && raw.watchlistName.trim()
            ? raw.watchlistName.trim().slice(0, 100)
            : 'default';
    let stateStoreName =
        typeof raw.stateStoreName === 'string' && raw.stateStoreName.trim()
            ? raw.stateStoreName.trim()
            : 'fairquery-competitor-tracker';
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(stateStoreName)) {
        problems.push({
            field: 'stateStoreName',
            value: stateStoreName,
            message: 'use letters, digits and hyphens (max 63); default used',
        });
        stateStoreName = 'fairquery-competitor-tracker';
    }
    return {
        input: {
            watchlistName,
            pages,
            domains,
            pageTypes: pageTypes.length
                ? pageTypes
                : ['pricing', 'terms', 'privacy', 'careers', 'changelog', 'product'],
            maxPages: int(raw.maxPages, 50, 1, LIMITS.maxPages),
            careersKeywords: strList(raw.careersKeywords, LIMITS.maxKeywords, 60),
            watchKeywords: strList(raw.watchKeywords, LIMITS.maxKeywords, 60),
            minSeverity: oneOf(raw.minSeverity, SEVERITIES, 'low'),
            ignorePatterns,
            minChangeChars: int(raw.minChangeChars, 20, 0, 10_000),
            includeDiff: raw.includeDiff !== false,
            renderJs: oneOf(raw.renderJs, ['never', 'auto', 'always'] as const, 'never'),
            confirmChanges: raw.confirmChanges !== false,
            webhookUrl,
            webhookFormat: oneOf(raw.webhookFormat, ['json', 'slack', 'discord'] as const, 'json'),
            webhookMinSeverity: oneOf(raw.webhookMinSeverity, SEVERITIES, 'medium'),
            sitemapInclude: strList(raw.sitemapInclude, 20, LIMITS.maxPatternLength),
            sitemapExclude: strList(raw.sitemapExclude, 20, LIMITS.maxPatternLength),
            maxSitemapFiles: int(raw.maxSitemapFiles, 10, 1, 50),
            stateStoreName,
            resetBaseline: raw.resetBaseline === true,
            requestDelaySecs: Math.min(
                30,
                Math.max(1, typeof raw.requestDelaySecs === 'number' ? raw.requestDelaySecs : 1.5),
            ),
            mode: oneOf(raw.mode, ['watch', 'digest'] as const, 'watch'),
            digestJobsRequested: raw.digestJobs === true,
            digestTech: raw.digestTech !== false,
            cssSelector: runSelector.ok ? runSelector.selector : null,
        },
        problems,
    };
}
