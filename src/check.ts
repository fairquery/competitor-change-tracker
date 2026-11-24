import { type CompareOptions, comparePages, jobsSnapshot, sha, snapshotFromHtml } from './analyze.js';
import type { Renderer } from './browser.js';
import { type Ats, detectBoard, fetchBoard } from './careers.js';
import { clip } from './diff.js';
import { extract, SelectorError } from './extract.js';
import { type Fetcher, HttpError } from './http.js';
import { extractPlans } from './pricing.js';
import { canonUrl, compareSitemaps, compileUrlFilters, parseSitemap } from './sitemap.js';
import { type ChangeItem, LIMITS, type PageTarget, type Snapshot } from './types.js';

export interface CheckOptions extends CompareOptions {
    renderJs: 'never' | 'auto' | 'always';
    confirmChanges?: boolean; // re-fetch once before reporting a change on a plain HTML page (default true)
    maxSitemapFiles: number;
    sitemapInclude: string[];
    sitemapExclude: string[];
    nowIso: string;
}

export interface CheckResult {
    snapshot: Snapshot | null; // null = unchanged and nothing new to store (304 / identical bytes)
    changes: ChangeItem[];
    documents: number;
    rendered: number;
    notes: string[];
    confirmFetches?: number; // extra, uncharged requests made to confirm a change
}

/** Codes that mean "skipped on purpose" (reported as a skipped row, never charged). */
export const SKIP_CODES = new Set([
    'ROBOTS_DISALLOWED',
    'ROBOTS_UNAVAILABLE',
    'CRAWL_DELAY_TOO_LONG',
    'HOST_BLOCKED',
    'URL_NOT_ALLOWED',
]);

function isSitemapMode(t: PageTarget): boolean {
    if (t.type !== 'product') return false;
    const u = new URL(t.url);
    return u.pathname === '/' || /\.xml(\.gz)?$/i.test(u.pathname);
}

async function checkSitemap(f: Fetcher, t: PageTarget, prev: Snapshot | null, o: CheckOptions): Promise<CheckResult> {
    const u = new URL(t.url);
    let roots: string[];
    if (/\.xml(\.gz)?$/i.test(u.pathname)) roots = [u.toString()];
    else {
        const robots = await f.getRobots(u);
        roots = robots.sitemaps.filter((s) => {
            try {
                const h = new URL(s).hostname.replace(/^www\./, '');
                return h === u.hostname.replace(/^www\./, '') || h.endsWith(`.${u.hostname.replace(/^www\./, '')}`);
            } catch {
                return false;
            }
        });
        if (!roots.length) roots = [new URL('/sitemap.xml', u.origin).toString()];
    }
    const keep = compileUrlFilters(o.sitemapInclude, o.sitemapExclude);
    const queue = [...new Set(roots)];
    const files: string[] = [];
    const urls = new Set<string>();
    let complete = true;
    let documents = 0;
    const notes: string[] = [];
    if (t.cssSelector) notes.push('CSS selector ignored: sitemap tracking compares URLs, not page HTML');
    while (queue.length) {
        const next = queue.shift()!;
        if (files.length >= o.maxSitemapFiles) {
            complete = false;
            notes.push(
                `stopped after ${o.maxSitemapFiles} sitemap files (maxSitemapFiles); removed pages are not reported for this run`,
            );
            break;
        }
        try {
            const r = await f.get(next, {
                accept: 'application/xml,text/xml;q=0.9,*/*;q=0.5',
                maxBytes: LIMITS.maxSitemapBytes,
            });
            documents += 1;
            files.push(next);
            if (r.status !== 200) {
                complete = false;
                notes.push(`${next} answered HTTP ${r.status}`);
                continue;
            }
            const sm = parseSitemap(r.body);
            if (sm.kind === 'index') {
                for (const loc of sm.locs) if (!files.includes(loc) && !queue.includes(loc)) queue.push(loc);
            } else
                for (const loc of sm.locs) {
                    if (urls.size >= LIMITS.maxSitemapUrls) {
                        complete = false;
                        break;
                    }
                    if (keep(loc)) urls.add(canonUrl(loc));
                }
        } catch (e) {
            complete = false;
            if (e instanceof HttpError && SKIP_CODES.has(e.code) && !files.length && !urls.size) throw e;
            notes.push(`${next}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    if (!documents) throw new HttpError(`No sitemap could be read for ${u.hostname}`, 'NO_SITEMAP', false);
    if (!urls.size && !prev) throw new HttpError(`Sitemap for ${u.hostname} listed no URLs`, 'NO_SITEMAP', false);
    const list = [...urls].sort();
    const snapshot: Snapshot = {
        v: 1,
        url: t.url,
        final_url: t.url,
        type: 'product',
        checked_at: o.nowIso,
        etag: null,
        last_modified: null,
        raw_hash: null,
        content_hash: '',
        rendered: false,
        title: null,
        sections: [],
        plans: null,
        entries: null,
        jobs: null,
        ats: null,
        sitemap_urls: list,
        sitemap_files: files,
        keyword_counts: {},
    };
    snapshot.content_hash = sha(list.join('\n'));
    let changes: ChangeItem[] = [];
    if (prev?.sitemap_urls) {
        if (!complete) {
            // keep previously known URLs we could not re-read, so they are not reported as removed later
            const merged = new Set([...list, ...prev.sitemap_urls]);
            snapshot.sitemap_urls = [...merged].sort().slice(0, LIMITS.maxSitemapUrls);
        }
        changes = compareSitemaps(prev.sitemap_urls, list, complete);
    }
    return { snapshot, changes, documents, rendered: 0, notes };
}

/** Fetch, extract and compare one target. Throws HttpError for skip/error conditions. */
export async function checkPage(
    f: Fetcher,
    r: Renderer | null,
    t: PageTarget,
    prev: Snapshot | null,
    o: CheckOptions,
): Promise<CheckResult> {
    if (isSitemapMode(t)) return checkSitemap(f, t, prev, o);
    const notes: string[] = [];
    let documents = 0;
    let rendered = 0;
    const directBoard = t.type === 'careers' ? detectBoard(t.url) : null;
    let snap: Snapshot;
    if (directBoard) {
        if (t.cssSelector)
            notes.push('CSS selector ignored: this careers URL is read from the job-board API, not from page HTML');
        const { jobs } = await fetchBoard(f, directBoard as { ats: Ats; slug: string });
        documents += 1;
        const base: Snapshot = {
            v: 1,
            url: t.url,
            final_url: t.url,
            type: 'careers',
            checked_at: o.nowIso,
            etag: null,
            last_modified: null,
            raw_hash: null,
            content_hash: '',
            rendered: false,
            css_selector: t.cssSelector ?? null,
            title: null,
            sections: [],
            plans: null,
            entries: null,
            jobs: null,
            ats: null,
            sitemap_urls: null,
            sitemap_files: null,
            keyword_counts: {},
        };
        snap = jobsSnapshot(base, jobs, directBoard, o.watchKeywords);
    } else {
        const wantRender = r && (o.renderJs === 'always' || prev?.rendered);
        let html: string;
        let finalUrl: string;
        let etag: string | null = null;
        let lastModified: string | null = null;
        let usedRender = false;
        if (wantRender) {
            await f.checkAllowed(new URL(t.url));
            const out = await r.render(t.url);
            await f.checkAllowed(new URL(out.finalUrl));
            if (out.status >= 400)
                throw new HttpError(
                    `${t.url} answered HTTP ${out.status}`,
                    'HTTP_ERROR',
                    out.status >= 500,
                    out.status,
                );
            html = out.html;
            finalUrl = out.finalUrl;
            documents += 1;
            rendered += 1;
            usedRender = true;
        } else {
            // careers pages backed by a job board must re-read the board even if the page itself is unchanged
            const pageOnly = !prev?.jobs;
            // A new or changed selector must see the body again; a 304 against the old region would hide the pin.
            const sameSelector = (prev?.css_selector ?? null) === (t.cssSelector ?? null);
            const res = await f.get(
                t.url,
                pageOnly && sameSelector ? { etag: prev?.etag, lastModified: prev?.last_modified } : {},
            );
            documents += 1;
            if (res.notModified && prev && pageOnly && sameSelector)
                return { snapshot: null, changes: [], documents, rendered, notes: ['304 Not Modified'] };
            if (res.status === 404 || res.status === 410)
                throw new HttpError(
                    `${t.url} answered HTTP ${res.status} (page gone?)`,
                    'PAGE_NOT_FOUND',
                    false,
                    res.status,
                );
            if (res.status >= 400)
                throw new HttpError(
                    `${t.url} answered HTTP ${res.status}`,
                    'HTTP_ERROR',
                    res.status >= 500,
                    res.status,
                );
            if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType))
                throw new HttpError(`${t.url} is not an HTML page (${res.contentType})`, 'NOT_HTML', false);
            html = res.body;
            finalUrl = res.finalUrl;
            etag = res.etag;
            lastModified = res.lastModified;
            if (
                pageOnly &&
                sameSelector &&
                prev?.raw_hash &&
                prev.raw_hash === sha(html) &&
                prev.final_url === finalUrl
            ) {
                return { snapshot: null, changes: [], documents, rendered, notes: ['identical bytes'] };
            }
            if (r && o.renderJs === 'auto') {
                const ex = extract(html);
                const thin = ex.text.length < 400;
                const noPlans = t.type === 'pricing' && !extractPlans(html).length;
                if (thin || noPlans) {
                    try {
                        const out = await r.render(finalUrl);
                        await f.checkAllowed(new URL(out.finalUrl));
                        rendered += 1;
                        const better =
                            t.type === 'pricing'
                                ? extractPlans(out.html).length > 0
                                : extract(out.html).text.length > ex.text.length * 1.5 + 200;
                        if (better && out.status < 400) {
                            html = out.html;
                            finalUrl = out.finalUrl;
                            usedRender = true;
                            etag = null;
                            lastModified = null;
                            notes.push('rendered with headless browser (JavaScript page)');
                        }
                    } catch (e) {
                        notes.push(`browser fallback failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            }
        }
        try {
            snap = snapshotFromHtml(
                {
                    url: t.url,
                    finalUrl,
                    type: t.type,
                    html,
                    etag,
                    lastModified,
                    rendered: usedRender,
                    checkedAt: o.nowIso,
                    cssSelector: t.cssSelector,
                },
                o,
            );
        } catch (e) {
            if (e instanceof SelectorError) throw new HttpError(e.message, e.code, false);
            throw e;
        }
        if (t.type === 'careers') {
            const board = detectBoard(html);
            if (board) {
                try {
                    const { jobs } = await fetchBoard(f, board as { ats: Ats; slug: string });
                    documents += 1;
                    snap = jobsSnapshot(snap, jobs, board, o.watchKeywords);
                } catch (e) {
                    notes.push(
                        `job board ${board.ats}:${board.slug} not readable (${e instanceof Error ? e.message : String(e)}); compared careers page text instead`,
                    );
                    if (prev?.jobs) return { snapshot: null, changes: [], documents, rendered, notes };
                }
            }
        }
    }
    if (!prev) return { snapshot: snap, changes: [], documents, rendered, notes };
    if ((prev.css_selector ?? null) !== (snap.css_selector ?? null)) {
        notes.push(
            `CSS selector changed to ${snap.css_selector ?? '(full page)'}; saved a new baseline for this region and did not compare it with the previous one`,
        );
        return { snapshot: snap, changes: [], documents, rendered, notes };
    }
    let changes = comparePages(prev, snap, o);
    if (changes.length && o.confirmChanges !== false && !snap.jobs && !snap.rendered) {
        // A/B tests and rotating page variants can differ between two requests. Re-read the page once and
        // report only the changes seen on both reads, so a variant that comes and goes is not reported.
        const res2 = await f.get(t.url, {});
        if (res2.status < 400 && !res2.notModified) {
            let snap2: Snapshot;
            try {
                snap2 = snapshotFromHtml(
                    {
                        url: t.url,
                        finalUrl: res2.finalUrl,
                        type: t.type,
                        html: res2.body,
                        etag: res2.etag,
                        lastModified: res2.lastModified,
                        rendered: false,
                        checkedAt: o.nowIso,
                        cssSelector: t.cssSelector,
                    },
                    o,
                );
            } catch (e) {
                if (e instanceof SelectorError) {
                    notes.push(`re-read: ${e.message}`);
                    return {
                        ...withHistory(prev, snap, changes, o.nowIso),
                        documents,
                        rendered,
                        notes,
                        confirmFetches: 1,
                    };
                }
                throw e;
            }
            const changes2 = comparePages(prev, snap2, o);
            const seen = new Set(changes.map((c) => `${c.kind}\n${c.summary}`));
            const confirmed = changes2.filter((c) => seen.has(`${c.kind}\n${c.summary}`));
            if (!confirmed.length) {
                notes.push(
                    'change seen on one read but not on an immediate re-read (A/B test or rotating content); not reported',
                );
                return { snapshot: null, changes: [], documents, rendered, notes, confirmFetches: 1 };
            }
            if (confirmed.length < changes.length)
                notes.push(`${changes.length - confirmed.length} change(s) not confirmed on re-read; not reported`);
            changes = confirmed;
            snap = snap2;
        }
        return { ...withHistory(prev, snap, changes, o.nowIso), documents, rendered, notes, confirmFetches: 1 };
    }
    if (!changes.length) {
        // Nothing meaningful: keep the old baseline so small edits accumulate until they cross the threshold.
        // Only refresh it when the meaningful content is identical (e.g. new ETag or a new timestamp).
        const ageMs = Date.parse(o.nowIso) - Date.parse(prev.checked_at);
        const refresh =
            snap.content_hash === prev.content_hash &&
            (snap.etag !== prev.etag || snap.last_modified !== prev.last_modified || snap.raw_hash !== prev.raw_hash) &&
            !(ageMs < 6 * 3600_000);
        return {
            snapshot: refresh ? { ...snap, recent_hashes: prev.recent_hashes ?? [] } : null,
            changes,
            documents,
            rendered,
            notes,
        };
    }
    return { ...withHistory(prev, snap, changes, o.nowIso), documents, rendered, notes };
}

const HISTORY_DAYS = 30;
const HISTORY_MAX = 6;

/**
 * Remember the last few content versions. When a page switches back to a version seen recently (A/B tests and
 * regional variants that alternate between runs, or a rolled-back edit), report one low-severity item instead of
 * fresh alerts, so a page that flips between two versions does not alert on every run.
 */
export function withHistory(
    prev: Snapshot,
    snap: Snapshot,
    changes: ChangeItem[],
    nowIso: string,
): { snapshot: Snapshot; changes: ChangeItem[] } {
    const cutoff = Date.parse(nowIso) - HISTORY_DAYS * 86400_000;
    const history = [{ h: prev.content_hash, at: prev.checked_at }, ...(prev.recent_hashes ?? [])]
        .filter(
            (x, i, a) =>
                x.h && x.h !== snap.content_hash && Date.parse(x.at) >= cutoff && a.findIndex((y) => y.h === x.h) === i,
        )
        .slice(0, HISTORY_MAX);
    const seenBefore =
        changes.length && snap.content_hash !== prev.content_hash
            ? (prev.recent_hashes ?? []).find((x) => x.h === snap.content_hash)
            : undefined;
    const out = { ...snap, recent_hashes: history };
    if (!seenBefore || Date.parse(seenBefore.at) < cutoff) return { snapshot: out, changes };
    const first = changes.find((c) => c.severity === 'high') ?? changes[0];
    return {
        snapshot: out,
        changes: [
            {
                kind: 'reverted_to_seen_version',
                severity: 'low',
                summary: `Page switched back to a version already seen on ${seenBefore.at.slice(0, 10)} (common with A/B tests or regional variants, or a rolled-back edit). Difference from the last check: ${clip(first.summary, 240)}`,
                details: {
                    seen_at: seenBefore.at,
                    changes: changes.map((c) => ({
                        kind: c.kind,
                        severity: c.severity,
                        summary: c.summary,
                        details: c.details,
                    })),
                },
            },
        ],
    };
}
