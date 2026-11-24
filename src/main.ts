import { Actor, log } from 'apify';

import { platformActorClient } from './actors.js';
import { baselineSummary } from './analyze.js';
import { Billing } from './billing.js';
import { Renderer } from './browser.js';
import { checkPage, SKIP_CODES } from './check.js';
import { buildDigests, digestDomainList, type DigestPageChange, digestWebhookBody, saveDigestClock } from './digest.js';
import { discover, type Discovered } from './discover.js';
import { Fetcher, HttpError } from './http.js';
import { digestJobsWarning, parseInput } from './input.js';
import {
    type DiscoveryCache,
    discoveryKey,
    loadSnapshot,
    PersistentRobotsCache,
    ROBOTS_KEY,
    snapshotKey,
    type WatchlistIndex,
    watchlistKey,
} from './state.js';
import {
    CHARGE_EVENTS,
    DEFAULTS,
    LIMITS,
    LIST_PRICES_USD,
    type PageTarget,
    SCHEMA_VERSION,
    severityRank,
} from './types.js';
import { type AlertRow, postWebhook, webhookBody } from './webhook.js';

await Actor.init();

const stop = { aborting: false };
Actor.on('aborting', async () => {
    stop.aborting = true;
    log.warning('Run is aborting: finishing the current pages and saving state.');
});

const startedAt = Date.now();
const nowIso = new Date().toISOString();
const raw = ((await Actor.getInput()) ?? {}) as Record<string, unknown>;
const { input, problems } = parseInput(raw);
const jobsWarning = digestJobsWarning(input);
if (jobsWarning) log.warning(jobsWarning);
const env = Actor.getEnv();
const runUrl = env.actorRunId ? `https://console.apify.com/view/runs/${env.actorRunId}` : null;
const base = { schema_version: SCHEMA_VERSION, watchlist: input.watchlistName, checked_at: nowIso };

for (const p of problems) {
    await Actor.pushData({
        ...base,
        type: 'error',
        code: 'INVALID_INPUT',
        message: `${p.field}: ${p.message}`,
        url: null,
        context: { value: p.value },
    });
}

if (!input.pages.length && !input.domains.length) {
    await Actor.setValue('OUTPUT', {
        ...base,
        status: 'no_input',
        message: 'Give at least one URL in "pages"/"urls" or one domain in "domains".',
    });
    await Actor.fail(
        'No pages to check: give at least one URL ("pages" or "urls") or a domain ("domains"). Nothing was charged.',
    );
}

const store = await Actor.openKeyValueStore(input.stateStoreName);
const robotsCache = new PersistentRobotsCache((await store.getValue<Record<string, never>>(ROBOTS_KEY)) ?? {});
const fetcher = new Fetcher({
    hostDelayMs: Math.max(DEFAULTS.minHostDelayMs, input.requestDelaySecs * 1000),
    robotsCache,
});
const billing = new Billing();
billing.init();

let renderer: Renderer | null = null;
if (input.renderJs !== 'never') {
    const mem = Number(process.env.ACTOR_MEMORY_MBYTES ?? 0);
    if (env.isAtHome && mem && mem < 1024) {
        log.warning(
            `renderJs="${input.renderJs}" needs at least 1024 MB of memory (this run has ${mem} MB); browser fallback disabled.`,
        );
        await Actor.pushData({
            ...base,
            type: 'error',
            code: 'BROWSER_NEEDS_MEMORY',
            message: `renderJs needs a run with at least 1024 MB memory (this run: ${mem} MB). Pages were checked with plain HTTP only.`,
            url: null,
        });
    } else renderer = new Renderer();
}

// ---------- targets ----------
const targets: PageTarget[] = [];
const seen = new Set<string>();
const addTarget = (t: PageTarget) => {
    const k = `${t.type}|${t.url}|${t.cssSelector ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    targets.push(t);
};
for (const p of input.pages)
    addTarget({
        url: p.url,
        type: p.type,
        label: p.label,
        source: 'input',
        domain: new URL(p.url).hostname,
        cssSelector: p.cssSelector,
    });

const discoveryNotes: { domain: string; type: string; note: string; code: string; url?: string }[] = [];
for (const domain of input.domains) {
    if (stop.aborting) break;
    const key = discoveryKey(domain);
    const cached = await store.getValue<DiscoveryCache>(key);
    let found: Discovered[];
    const fresh = cached && Date.now() - cached.at < DEFAULTS.discoveryCacheMs;
    const missing = fresh ? input.pageTypes.filter((t) => !cached.found.some((f) => f.type === t)) : input.pageTypes;
    found = fresh ? cached.found.filter((f) => input.pageTypes.includes(f.type)) : [];
    if (missing.length) {
        log.info(`Discovering ${missing.join(', ')} pages for ${domain}`);
        const got = await discover(fetcher, domain, missing);
        found = [...found, ...got];
        const transient = got.some(
            (g) => !g.url && g.note && /ROBOTS_UNAVAILABLE|HOST_BLOCKED|NETWORK|DNS/.test(g.note),
        );
        if (!transient)
            await store.setValue(key, {
                domain,
                at: Date.now(),
                found: [...(fresh ? cached.found : []), ...got],
            } satisfies DiscoveryCache);
    }
    for (const f of found) {
        // one page found for two types (e.g. a combined /legal page for terms and privacy) is tracked once
        const same = f.url ? targets.find((t) => t.url === f.url) : undefined;
        if (f.url && same && same.type !== f.type)
            discoveryNotes.push({
                domain,
                type: f.type,
                url: f.url,
                code: 'DUPLICATE_PAGE',
                note: `the ${f.type} page is the same page as the ${same.type} page (${f.url}); tracked once as ${same.type}`,
            });
        else if (f.url)
            addTarget({
                url: f.url,
                type: f.type,
                label: `${domain} ${f.type}`,
                source: 'discovered',
                domain,
                cssSelector: input.cssSelector,
            });
        else discoveryNotes.push({ domain, type: f.type, code: 'PAGE_NOT_FOUND', note: f.note ?? 'not found' });
    }
}
for (const d of discoveryNotes)
    await Actor.pushData({
        ...base,
        type: 'skipped',
        code: d.code,
        url: d.url ?? null,
        domain: d.domain,
        page_type: d.type,
        message: `${d.domain}: ${d.note}`,
    });

const overflow = targets.splice(input.maxPages);
for (const t of overflow)
    await Actor.pushData({
        ...base,
        type: 'skipped',
        code: 'MAX_PAGES',
        url: t.url,
        page_type: t.type,
        message: `Over the maxPages limit (${input.maxPages}); not checked.`,
    });

// ---------- checks ----------
interface PageStatus {
    url: string;
    type: string;
    cssSelector: string | null;
    status: 'baseline' | 'changed' | 'unchanged' | 'skipped' | 'error' | 'not_checked';
    changes: number;
    note?: string;
}
const statuses: PageStatus[] = [];
const alerts: AlertRow[] = [];
const digestChanges: DigestPageChange[] = [];
const sevCount: Record<string, number> = { low: 0, medium: 0, high: 0 };
let baselines = 0;
let changesEmitted = 0;
let stoppedForBudget = false;

async function processTarget(t: PageTarget): Promise<void> {
    if (stop.aborting || stoppedForBudget) {
        statuses.push({
            url: t.url,
            type: t.type,
            cssSelector: t.cssSelector ?? null,
            status: 'not_checked',
            changes: 0,
            note: stop.aborting ? 'run aborted' : 'max cost per run reached',
        });
        return;
    }
    if (!billing.canAfford({ [CHARGE_EVENTS.pageChecked]: 1 })) {
        stoppedForBudget = true;
        statuses.push({
            url: t.url,
            type: t.type,
            cssSelector: t.cssSelector ?? null,
            status: 'not_checked',
            changes: 0,
            note: 'max cost per run reached',
        });
        return;
    }
    const key = snapshotKey(input.watchlistName, t.type, t.url, t.cssSelector);
    const prev = input.resetBaseline ? null : await loadSnapshot(store, key);
    const rowBase = {
        ...base,
        url: t.url,
        page_type: t.type,
        label: t.label,
        domain: t.domain,
        ...(t.cssSelector ? { css_selector: t.cssSelector } : {}),
    };
    try {
        const res = await checkPage(fetcher, renderer, t, prev, {
            ignore: input.ignorePatterns,
            minChangeChars: input.minChangeChars,
            careersKeywords: input.careersKeywords,
            watchKeywords: input.watchKeywords,
            includeDiff: input.includeDiff,
            renderJs: input.renderJs,
            confirmChanges: input.confirmChanges,
            maxSitemapFiles: input.maxSitemapFiles,
            sitemapInclude: input.sitemapInclude,
            sitemapExclude: input.sitemapExclude,
            nowIso,
        });
        const shown = res.changes.filter((c) => severityRank(c.severity) >= severityRank(input.minSeverity));
        const events = {
            [CHARGE_EVENTS.pageChecked]: res.documents,
            [CHARGE_EVENTS.changeDetected]: prev ? shown.length : 0,
            [CHARGE_EVENTS.pageRendered]: res.rendered,
        };
        if (!billing.canAfford(events)) {
            stoppedForBudget = true;
            statuses.push({
                url: t.url,
                type: t.type,
                cssSelector: t.cssSelector ?? null,
                status: 'not_checked',
                changes: 0,
                note: 'max cost per run reached; will be checked next run',
            });
            return;
        }
        const finalUrl = res.snapshot?.final_url ?? prev?.final_url ?? t.url;
        if (!prev && res.snapshot) {
            baselines += 1;
            const s = res.snapshot;
            await Actor.pushData({
                ...rowBase,
                type: 'baseline',
                final_url: finalUrl,
                severity: null,
                change_kind: 'baseline',
                summary: `${baselineSummary(s)} Future runs will report changes against this snapshot.`,
                details: {
                    title: s.title,
                    sections: s.sections.length,
                    plans: s.plans,
                    jobs_count: s.jobs?.length ?? null,
                    ats: s.ats,
                    entries: s.entries?.slice(0, 10) ?? null,
                    sitemap_urls_count: s.sitemap_urls?.length ?? null,
                    sitemap_files: s.sitemap_files,
                    keyword_counts: s.keyword_counts,
                    rendered: s.rendered,
                    notes: res.notes,
                },
                previous_checked_at: null,
            });
            statuses.push({
                url: t.url,
                type: t.type,
                cssSelector: t.cssSelector ?? null,
                status: 'baseline',
                changes: 0,
            });
        } else {
            for (const c of shown) {
                changesEmitted += 1;
                sevCount[c.severity] += 1;
                await Actor.pushData({
                    ...rowBase,
                    type: 'change',
                    final_url: finalUrl,
                    severity: c.severity,
                    change_kind: c.kind,
                    summary: c.summary,
                    details: c.details,
                    previous_checked_at: prev?.checked_at ?? null,
                });
                if (severityRank(c.severity) >= severityRank(input.webhookMinSeverity))
                    alerts.push({
                        url: t.url,
                        page_type: t.type,
                        label: t.label,
                        severity: c.severity,
                        change_kind: c.kind,
                        summary: c.summary,
                    });
                if (input.mode === 'digest' && t.domain)
                    digestChanges.push({
                        domain: t.domain,
                        url: t.url,
                        page_type: t.type,
                        label: t.label,
                        severity: c.severity,
                        change_kind: c.kind,
                        summary: c.summary,
                    });
            }
            statuses.push({
                url: t.url,
                type: t.type,
                cssSelector: t.cssSelector ?? null,
                status: res.changes.length ? 'changed' : 'unchanged',
                changes: shown.length,
                note: res.notes.join('; ') || undefined,
            });
        }
        await billing.charge(events);
        if (res.snapshot) await store.setValue(key, res.snapshot);
        log.info(
            `${t.type} ${t.url}: ${!prev ? 'baseline saved' : res.changes.length ? `${shown.length} change(s) shown` : 'no meaningful change'}`,
        );
    } catch (e) {
        const he = e instanceof HttpError ? e : null;
        const code = he?.code ?? 'UNEXPECTED_ERROR';
        const message = e instanceof Error ? e.message : String(e);
        const skipped = SKIP_CODES.has(code);
        await Actor.pushData({
            ...rowBase,
            type: skipped ? 'skipped' : 'error',
            code,
            message,
            retryable: he?.retryable ?? false,
        });
        statuses.push({
            url: t.url,
            type: t.type,
            cssSelector: t.cssSelector ?? null,
            status: skipped ? 'skipped' : 'error',
            changes: 0,
            note: `${code}: ${message}`,
        });
        log.warning(`${t.url}: ${code}: ${message}`);
    }
}

// one worker per host (requests to a host are sequential and spaced); up to N hosts in parallel
const byHost = new Map<string, PageTarget[]>();
for (const t of targets) {
    const h = new URL(t.url).hostname;
    byHost.set(h, [...(byHost.get(h) ?? []), t]);
}
const queues = [...byHost.values()];
async function worker(): Promise<void> {
    for (;;) {
        const q = queues.shift();
        if (!q) return;
        for (const t of q) await processTarget(t);
    }
}
await Promise.all(Array.from({ length: Math.min(DEFAULTS.parallelHosts, queues.length) }, worker));
await renderer?.close();

// ---------- weekly digest (one row and one webhook payload per domain) ----------
let webhook: Record<string, unknown> | null = null;
let digestCount = 0;
let digestCalls: { jobs: unknown; tech: unknown } | null = null;
let digestSince: string | null = null;
let digestChangesCount = 0;
let digestChanged = false;
let digestIsBaseline = false;
if (input.mode === 'digest') {
    const domains = digestDomainList(
        input.domains,
        [...targets, ...overflow].map((t) => t.domain),
    );
    const head = domains.slice(0, LIMITS.maxDomains);
    const tail = domains.slice(LIMITS.maxDomains);
    const allowActorCalls = !stop.aborting && !stoppedForBudget;
    const built = await buildDigests({
        domains: head,
        pageChanges: digestChanges,
        techEnabled: input.digestTech,
        allowActorCalls,
        skipCode: stop.aborting ? 'ABORTED' : stoppedForBudget ? 'MAX_COST' : null,
        watchlist: input.watchlistName,
        nowIso,
        store,
        client: platformActorClient(),
        commitSince: false,
    });
    const rest = tail.length
        ? await buildDigests({
              domains: tail,
              pageChanges: digestChanges,
              techEnabled: input.digestTech,
              allowActorCalls: false,
              skipCode: 'DIGEST_DOMAIN_CAP',
              watchlist: input.watchlistName,
              nowIso,
              store,
              client: platformActorClient(),
              commitSince: false,
          })
        : null;
    const digests = [...built.digests, ...(rest?.digests ?? [])];
    for (const d of digests) {
        await Actor.pushData({
            ...base,
            type: 'digest',
            domain: d.domain,
            url: `https://${d.domain}/`,
            page_type: null,
            label: null,
            severity: d.severity,
            change_kind: 'digest',
            summary: d.summary,
            details: { page_changes: d.page_changes, jobs: d.jobs, tech: d.tech },
            previous_checked_at: d.previous_checked_at,
            since: d.since,
            changes_count: d.changes_count,
            changed: d.changed,
            is_baseline: d.is_baseline,
        });
    }
    digestCount = digests.length;
    digestCalls = { jobs: built.jobs, tech: built.tech };
    digestSince = built.since;
    digestIsBaseline = built.is_baseline;
    digestChangesCount = digests.reduce((n, d) => n + d.changes_count, 0);
    digestChanged = digestChangesCount > 0;
    // A finished digest moves the watchlist clock. Abort and max-cost stops leave the previous time in place.
    if (digests.length && !stop.aborting && !stoppedForBudget)
        await saveDigestClock(store, input.watchlistName, nowIso);
    if (input.webhookUrl && digests.length) {
        const deliveries: { domain: string; sent: boolean; http_status: number | null; error: string | null }[] = [];
        for (const d of digests) {
            if (stop.aborting) break;
            const r = await postWebhook(
                fetcher,
                input.webhookUrl,
                digestWebhookBody(input.webhookFormat, input.watchlistName, d, runUrl, input.webhookMinSeverity),
            );
            deliveries.push({ domain: d.domain, sent: r.ok, http_status: r.status, error: r.error ?? null });
            if (!r.ok) log.warning(`Digest webhook for ${d.domain} failed (${r.error ?? r.status}).`);
        }
        webhook = {
            mode: 'digest',
            sent: deliveries.filter((d) => d.sent).length,
            domains: digests.length,
            deliveries,
        };
    } else if (input.webhookUrl) webhook = { mode: 'digest', sent: 0, domains: 0, reason: 'no domains' };
}

// ---------- webhook (watch mode: one payload for the run; digest mode already posted one per domain) ----------
if (input.mode !== 'digest') {
    if (input.webhookUrl && alerts.length) {
        const r = await postWebhook(
            fetcher,
            input.webhookUrl,
            webhookBody(input.webhookFormat, input.watchlistName, alerts, runUrl),
        );
        webhook = { sent: r.ok, alerts: alerts.length, http_status: r.status, error: r.error ?? null };
        if (!r.ok) log.warning(`Webhook delivery failed (${r.error ?? r.status}).`);
    } else if (input.webhookUrl)
        webhook = { sent: false, alerts: 0, reason: 'no changes at or above webhookMinSeverity' };
}

// ---------- state + summary ----------
await robotsCache.save(store, Date.now());
const wkey = watchlistKey(input.watchlistName);
const idx = (await store.getValue<WatchlistIndex>(wkey)) ?? {
    watchlist: input.watchlistName,
    updated_at: nowIso,
    runs: 0,
    pages: [],
};
idx.runs += 1;
idx.updated_at = nowIso;
for (const s of statuses) {
    const k = snapshotKey(input.watchlistName, s.type as never, s.url, s.cssSelector);
    const existing = idx.pages.find((p) => p.key === k);
    if (existing) Object.assign(existing, { last_checked_at: nowIso, last_status: s.status });
    else idx.pages.push({ url: s.url, type: s.type as never, key: k, last_checked_at: nowIso, last_status: s.status });
}
await store.setValue(wkey, idx);

const estUsd = Object.entries(billing.counts).reduce((s, [e, n]) => s + (LIST_PRICES_USD[e] ?? 0) * n, 0);
const summary = {
    ...base,
    status: stop.aborting ? 'aborted' : stoppedForBudget ? 'stopped_max_cost' : 'ok',
    first_run_for_watchlist: idx.runs === 1,
    pages_total: targets.length,
    pages_checked: statuses.filter((s) => ['baseline', 'changed', 'unchanged'].includes(s.status)).length,
    baselines,
    changes: changesEmitted,
    changes_by_severity: sevCount,
    unchanged: statuses.filter((s) => s.status === 'unchanged').length,
    skipped: statuses.filter((s) => s.status === 'skipped').length + discoveryNotes.length + overflow.length,
    errors: statuses.filter((s) => s.status === 'error').length + problems.length,
    requests: fetcher.requests,
    bytes_downloaded: fetcher.bytes,
    browser_renders: renderer?.renders ?? 0,
    events: billing.counts,
    event_charges_usd_at_list_price: Math.round(estUsd * 1e6) / 1e6,
    webhook,
    ...(input.mode === 'digest'
        ? {
              mode: 'digest' as const,
              digests: digestCount,
              digest_calls: digestCalls,
              since: digestSince,
              changes_count: digestChangesCount,
              changed: digestChanged,
              is_baseline: digestIsBaseline,
          }
        : {}),
    ...(jobsWarning ? { warnings: [jobsWarning] } : {}),
    state_store: input.stateStoreName,
    duration_secs: Math.round((Date.now() - startedAt) / 100) / 10,
    pages: statuses,
};
await Actor.setValue('OUTPUT', summary);
const msg = `${summary.pages_checked} page(s) checked: ${baselines} baseline(s), ${changesEmitted} change(s) (${sevCount.high} high, ${sevCount.medium} medium, ${sevCount.low} low), ${summary.skipped} skipped, ${summary.errors} error(s)${input.mode === 'digest' ? `, ${digestCount} digest row(s)` : ''}.`;
log.info(msg);
await Actor.setStatusMessage(msg, { isStatusMessageTerminal: true });
await Actor.exit();
