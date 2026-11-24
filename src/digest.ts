import { sameSite } from './discover.js';
import { digestSinceKey, digestTechKey } from './state.js';
import { SEVERITIES, type Severity, severityRank } from './types.js';
import type { WebhookFormat } from './webhook.js';

export const TECH_ACTOR_ID = 'fairquery/website-tech-seo-ai-readiness';
export const JOBS_RETIRED_CODE = 'JOBS_SIGNAL_RETIRED';
export const JOBS_RETIRED_MESSAGE = 'Jobs opened and closed are not included in digest mode.';

export interface ActorDataset {
    items: Record<string, unknown>[];
    runId: string | null;
    status: string;
}

/** Runs one Actor and returns its dataset items. Unit tests pass a fake; production uses the Apify client. */
export interface ActorRunClient {
    run(actorId: string, input: Record<string, unknown>): Promise<ActorDataset>;
}

export interface DigestStore {
    getValue<T>(key: string): Promise<T | null | undefined>;
    setValue(key: string, value: unknown): Promise<void>;
}

export interface DigestPageChange {
    domain: string;
    url: string;
    page_type: string;
    label: string | null;
    severity: Severity;
    change_kind: string;
    summary: string;
}

export interface DepartmentCount {
    department: string;
    count: number;
    titles: string[];
}

export interface JobsDigest {
    status: 'ok' | 'baseline' | 'error' | 'skipped';
    opened: number;
    closed: number;
    updated: number;
    opened_by_department: DepartmentCount[];
    closed_by_department: DepartmentCount[];
    updated_by_department: DepartmentCount[];
    open_roles_seen: number | null;
    closures_may_be_incomplete: boolean;
    code: string | null;
    message: string | null;
}

export interface TechName {
    name: string;
    category: string | null;
}

export interface TechDigest {
    status: 'ok' | 'baseline' | 'error' | 'skipped';
    added: TechName[];
    removed: TechName[];
    current_count: number | null;
    code: string | null;
    message: string | null;
}

export interface DomainDigest {
    domain: string;
    severity: Severity | null;
    summary: string;
    page_changes: DigestPageChange[];
    jobs: JobsDigest;
    tech: TechDigest;
    previous_checked_at: string | null;
    /** ISO time of the previous successful digest for this watchlist, or null on the first one. */
    since: string | null;
    /** Page changes plus technologies added or removed. A skipped jobs section adds nothing. */
    changes_count: number;
    /** True when changes_count is greater than zero. False on a baseline is not a quiet period. */
    changed: boolean;
    /** True when this watchlist has no previous successful digest. Never a quiet result. */
    is_baseline: boolean;
}

/** Clock stored under `digestSinceKey(watchlistName)` in the caller's state store. */
export interface DigestSinceRecord {
    v: 1;
    at: string;
    watchlist: string;
}

export interface DigestClock {
    since: string | null;
    is_baseline: boolean;
}

export interface ActorCallMeta {
    actor_id: string | null;
    called: boolean;
    run_id: string | null;
    status: string | null;
    error: string | null;
}

interface TechState {
    v: 1;
    at: string;
    technologies: TechName[];
}

const FOCUS_PAGES = new Set(['pricing', 'terms', 'privacy', 'changelog']);
const NAME_CAP = 40;

const emptyJobs = (status: JobsDigest['status'], code: string | null, message: string | null): JobsDigest => ({
    status,
    opened: 0,
    closed: 0,
    updated: 0,
    opened_by_department: [],
    closed_by_department: [],
    updated_by_department: [],
    open_roles_seen: null,
    closures_may_be_incomplete: false,
    code,
    message,
});

/** Jobs are not fetched. The section stays on the row so old readers still see a status. */
export function retiredJobsDigest(): JobsDigest {
    return emptyJobs('skipped', JOBS_RETIRED_CODE, JOBS_RETIRED_MESSAGE);
}

const emptyTech = (status: TechDigest['status'], code: string | null, message: string | null): TechDigest => ({
    status,
    added: [],
    removed: [],
    current_count: null,
    code,
    message,
});

/** Homepage technologies only: sitemap and llms.txt reads are off so the nested run stays a single site check. */
export function techActorInput(domains: string[]): Record<string, unknown> {
    return {
        urls: domains,
        checkRobots: true,
        checkSitemap: false,
        checkLlmsTxt: false,
        respectRobotsTxt: true,
        maxSites: Math.max(1, domains.length),
    };
}

export function digestDomainList(domains: string[], pageHosts: (string | null)[]): string[] {
    const out: string[] = [];
    const add = (raw: string | null | undefined) => {
        if (!raw) return;
        const host = raw
            .trim()
            .toLowerCase()
            .replace(/^www\./, '');
        if (!host.includes('.') || out.includes(host)) return;
        out.push(host);
    };
    for (const d of domains) add(d);
    for (const h of pageHosts) add(h);
    return out;
}

function hostOf(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    let s = value.trim().toLowerCase();
    if (!s) return null;
    if (!/^https?:\/\//.test(s)) s = `https://${s}`;
    try {
        const host = new URL(s).hostname.replace(/^www\./, '');
        return host.includes('.') ? host : null;
    } catch {
        return null;
    }
}

function itemHosts(item: Record<string, unknown>): string[] {
    const hosts: string[] = [];
    for (const key of ['company_domain', 'domain', 'input', 'final_url', 'source_url']) {
        const h = hostOf(item[key]);
        if (h && !hosts.includes(h)) hosts.push(h);
    }
    return hosts;
}

function rowsFor(items: Record<string, unknown>[], domain: string, sole: boolean): Record<string, unknown>[] {
    return items.filter((item) => {
        const hosts = itemHosts(item);
        if (hosts.some((h) => h === domain)) return true;
        return sole && hosts.length === 0;
    });
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function readTechnologies(item: Record<string, unknown>): TechName[] {
    if (!Array.isArray(item.technologies)) return [];
    const out: TechName[] = [];
    const seen = new Set<string>();
    for (const raw of item.technologies) {
        if (!raw || typeof raw !== 'object') continue;
        const t = raw as Record<string, unknown>;
        const name = str(t.name);
        if (!name) continue;
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, category: str(t.category) });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Turn a website-tech-seo-ai-readiness site row into additions and removals against the stored list. */
export function techDigestFromItems(
    items: Record<string, unknown>[],
    domain: string,
    sole: boolean,
    previous: TechName[] | null,
): { digest: TechDigest; current: TechName[] | null } {
    const rows = rowsFor(items, domain, sole);
    const site = rows.find((r) => r.type === 'site');
    const error = rows.find((r) => r.type === 'error');
    if (!site) {
        return {
            digest: emptyTech(
                'error',
                error ? str(error.code) : 'NO_DIGEST_ROWS',
                error ? str(error.message) : `tech check returned nothing for ${domain}`,
            ),
            current: null,
        };
    }
    const current = readTechnologies(site);
    if (!previous) {
        return { digest: { ...emptyTech('baseline', null, null), current_count: current.length }, current };
    }
    const prevKeys = new Set(previous.map((t) => t.name.toLowerCase()));
    const curKeys = new Set(current.map((t) => t.name.toLowerCase()));
    return {
        digest: {
            status: 'ok',
            added: current.filter((t) => !prevKeys.has(t.name.toLowerCase())).slice(0, NAME_CAP),
            removed: previous.filter((t) => !curKeys.has(t.name.toLowerCase())).slice(0, NAME_CAP),
            current_count: current.length,
            code: null,
            message: null,
        },
        current,
    };
}

/** Count of differences an agent can treat as "what changed". Baselines, skips and errors add nothing. */
export function digestChangesCount(pages: DigestPageChange[], jobs: JobsDigest, tech: TechDigest): number {
    let n = pages.length;
    if (jobs.status === 'ok') n += jobs.opened + jobs.closed + jobs.updated;
    if (tech.status === 'ok') n += tech.added.length + tech.removed.length;
    return n;
}

/**
 * A skipped signal counts as compared when it was turned off, or when it is the retired jobs section.
 * A tech baseline or error is not a real comparison.
 */
function signalCompared(part: { status: string; code: string | null }): boolean {
    if (part.status === 'ok') return true;
    return part.status === 'skipped' && (part.code === 'DISABLED' || part.code === JOBS_RETIRED_CODE);
}

/**
 * Quiet only after a previous digest, with every enabled signal compared and nothing found.
 * The retired jobs section does not block a quiet result. A tech baseline or error is not quiet.
 */
export function isConfirmedQuiet(pages: DigestPageChange[], jobs: JobsDigest, tech: TechDigest): boolean {
    return digestChangesCount(pages, jobs, tech) === 0 && signalCompared(jobs) && signalCompared(tech);
}

function digestDetail(
    domain: string,
    pages: DigestPageChange[],
    jobs: JobsDigest,
    tech: TechDigest,
    isBaseline: boolean,
): string {
    const focus = pages.filter((p) => FOCUS_PAGES.has(p.page_type));
    const other = pages.length - focus.length;
    const pagePart =
        focus.length > 0
            ? focus
                  .slice(0, 3)
                  .map((p) => endSentence(p.summary))
                  .join(' ')
            : isBaseline
              ? 'pricing, terms and changelog are part of this baseline.'
              : 'no pricing, terms or changelog changes.';
    // Never print opened/closed counts. The jobs Actor is not called, so those numbers would be empty, not real.
    const jobsPart = jobs.status === 'error' ? `jobs unavailable (${jobs.code ?? 'error'})` : 'jobs: not included';
    let techPart: string;
    if (tech.status === 'baseline') techPart = `tech-stack baseline saved (${tech.current_count ?? 0} technologies)`;
    else if (tech.status === 'skipped')
        techPart =
            tech.code && tech.code !== 'DISABLED' ? `tech stack not checked (${tech.code})` : 'tech stack not included';
    else if (tech.status === 'error') techPart = `tech stack unavailable (${tech.code ?? 'error'})`;
    else if (tech.added.length || tech.removed.length) {
        const added = tech.added.map((t) => t.name).join(', ');
        const removed = tech.removed.map((t) => t.name).join(', ');
        techPart = `tech: ${[added ? `added ${added}` : '', removed ? `removed ${removed}` : ''].filter(Boolean).join('; ')}`;
    } else techPart = 'tech stack unchanged';
    const extra = other > 0 ? ` Also ${other} other page change(s).` : '';
    const more = focus.length > 3 ? ` ${focus.length - 3} more pricing, terms or changelog change(s).` : '';
    const pageClause = endSentence(`${pagePart}${more}${extra}`);
    return `${domain} weekly digest: ${pageClause} ${jobsPart}. ${techPart}.`;
}

const SENTENCE_CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '}', '»', '›']);

/** Add a final stop unless the text already ends as a sentence, including stops inside a closing quote or bracket. */
export function endSentence(text: string): string {
    const trimmed = text.trimEnd();
    if (!trimmed || sentenceAlreadyClosed(trimmed)) return trimmed;
    return `${trimmed}.`;
}

function sentenceAlreadyClosed(text: string): boolean {
    let i = text.length - 1;
    while (i >= 0 && SENTENCE_CLOSERS.has(text[i]!)) i -= 1;
    if (i < 0) return false;
    const ch = text[i]!;
    return ch === '.' || ch === '!' || ch === '?' || ch === '…';
}

export function digestSummary(
    domain: string,
    pages: DigestPageChange[],
    jobs: JobsDigest,
    tech: TechDigest,
    clock: DigestClock,
    options?: { allowQuiet?: boolean },
): string {
    const detail = digestDetail(domain, pages, jobs, tech, clock.is_baseline);
    if (clock.is_baseline) {
        return `Baseline for ${domain}: first digest for this watchlist. There is no earlier digest to compare with. This is not a quiet period. ${detail}`;
    }
    if (options?.allowQuiet !== false && isConfirmedQuiet(pages, jobs, tech)) return `No changes since ${clock.since}.`;
    return `Since ${clock.since}: ${detail}`;
}

/** Previous successful digest time for this watchlist, or a baseline when the record is missing or unreadable. */
export async function loadDigestClock(store: DigestStore, watchlist: string): Promise<DigestClock> {
    const raw = await store.getValue<Partial<DigestSinceRecord>>(digestSinceKey(watchlist));
    const at = raw && raw.v === 1 && typeof raw.at === 'string' ? raw.at.trim() : '';
    const since = at || null;
    return { since, is_baseline: since === null };
}

/** Overwrites the single stored time. Older digest windows are not kept. */
export async function saveDigestClock(store: DigestStore, watchlist: string, at: string): Promise<void> {
    const record: DigestSinceRecord = { v: 1, at, watchlist };
    await store.setValue(digestSinceKey(watchlist), record);
}

function rollupSeverity(pages: DigestPageChange[], jobs: JobsDigest, tech: TechDigest): Severity | null {
    let rank = -1;
    const bump = (s: Severity) => {
        rank = Math.max(rank, severityRank(s));
    };
    for (const p of pages) bump(p.severity);
    if (jobs.status === 'ok' && (jobs.opened || jobs.closed)) bump('medium');
    else if (jobs.status === 'ok' && jobs.updated) bump('low');
    else if (jobs.status === 'error') bump('low');
    if (tech.status === 'ok' && (tech.added.length || tech.removed.length)) bump('medium');
    else if (tech.status === 'error') bump('low');
    return rank < 0 ? null : SEVERITIES[rank];
}

function pageHost(domain: string): string {
    return domain.replace(/^www\./, '').toLowerCase();
}

function pagesFor(domain: string, changes: DigestPageChange[]): DigestPageChange[] {
    return changes.filter((c) => pageHost(c.domain) === domain || sameSite(c.domain, domain));
}

function errText(e: unknown): string {
    return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}

export interface BuildDigestArgs {
    domains: string[];
    pageChanges: DigestPageChange[];
    techEnabled: boolean;
    /** When false, page changes are still summarized and the tech Actor is not started. Jobs are never started. */
    allowActorCalls: boolean;
    skipCode: string | null;
    watchlist: string;
    nowIso: string;
    store: DigestStore;
    client: ActorRunClient;
    /**
     * When true (default), save `nowIso` as this watchlist's last successful digest.
     * The Actor entry commits once for the whole run, including a domain-cap tail, and skips the save on abort or max cost.
     */
    commitSince?: boolean;
}

export interface BuildDigestResult {
    digests: DomainDigest[];
    jobs: ActorCallMeta;
    tech: ActorCallMeta;
    since: string | null;
    changes_count: number;
    changed: boolean;
    is_baseline: boolean;
}

/**
 * One digest per domain: this Actor's page changes, plus tech-stack add/remove.
 * The tech Actor is called once for the whole domain list. The jobs Actor is never called.
 * Tests pass `client` and never touch the network.
 */
export async function buildDigests(args: BuildDigestArgs): Promise<BuildDigestResult> {
    const {
        domains,
        pageChanges,
        techEnabled,
        allowActorCalls,
        skipCode,
        watchlist,
        nowIso,
        store,
        client,
        commitSince = true,
    } = args;
    const clock = await loadDigestClock(store, watchlist);
    const skipped = (actorId: string, code: string): ActorCallMeta => ({
        actor_id: actorId,
        called: false,
        run_id: null,
        status: null,
        error: code,
    });
    const jobsMeta: ActorCallMeta = {
        actor_id: null,
        called: false,
        run_id: null,
        status: null,
        error: JOBS_RETIRED_CODE,
    };
    let techMeta: ActorCallMeta = skipped(TECH_ACTOR_ID, techEnabled ? (skipCode ?? 'SKIPPED') : 'DISABLED');
    let techItems: Record<string, unknown>[] | null = null;
    let techFail: string | null = null;

    if (domains.length && allowActorCalls && techEnabled) {
        try {
            const r = await client.run(TECH_ACTOR_ID, techActorInput(domains));
            techMeta = {
                actor_id: TECH_ACTOR_ID,
                called: true,
                run_id: r.runId,
                status: r.status,
                error: null,
            };
            techItems = r.items;
        } catch (e: unknown) {
            techFail = errText(e);
            techMeta = {
                actor_id: TECH_ACTOR_ID,
                called: true,
                run_id: null,
                status: 'FAILED',
                error: techFail,
            };
        }
    }

    const sole = domains.length === 1;
    const digests: DomainDigest[] = [];
    for (const domain of domains) {
        const pages = pagesFor(domain, pageChanges);
        const jobs = retiredJobsDigest();
        let tech: TechDigest;
        let previousAt: string | null = null;
        if (!techEnabled) tech = emptyTech('skipped', 'DISABLED', null);
        else if (!allowActorCalls) tech = emptyTech('skipped', skipCode, null);
        else if (techFail) tech = emptyTech('error', 'ACTOR_CALL_FAILED', techFail);
        else {
            const prev = await store.getValue<TechState>(digestTechKey(watchlist, domain));
            const previous = prev && prev.v === 1 && Array.isArray(prev.technologies) ? prev.technologies : null;
            previousAt = prev?.at ?? null;
            const interpreted = techDigestFromItems(techItems ?? [], domain, sole, previous);
            tech = interpreted.digest;
            if (interpreted.current) {
                await store.setValue(digestTechKey(watchlist, domain), {
                    v: 1,
                    at: nowIso,
                    technologies: interpreted.current,
                } satisfies TechState);
            }
        }
        const changesCount = digestChangesCount(pages, jobs, tech);
        digests.push({
            domain,
            severity: rollupSeverity(pages, jobs, tech),
            summary: digestSummary(domain, pages, jobs, tech, clock),
            page_changes: pages,
            jobs,
            tech,
            previous_checked_at: previousAt,
            since: clock.since,
            changes_count: changesCount,
            changed: changesCount > 0,
            is_baseline: clock.is_baseline,
        });
    }
    if (commitSince && domains.length) await saveDigestClock(store, watchlist, nowIso);
    const totalChanges = digests.reduce((n, d) => n + d.changes_count, 0);
    return {
        digests,
        jobs: jobsMeta,
        tech: techMeta,
        since: clock.since,
        changes_count: totalChanges,
        changed: totalChanges > 0,
        is_baseline: clock.is_baseline,
    };
}

/** One Slack/Discord/JSON body for a single domain. Slack stays `{text}` and Discord stays `{content}`. */
export function digestWebhookBody(
    format: WebhookFormat,
    watchlist: string,
    digest: DomainDigest,
    runUrl: string | null,
    minSeverity: Severity,
): object {
    const pages = digest.page_changes.filter((p) => severityRank(p.severity) >= severityRank(minSeverity));
    const summary = digestSummary(
        digest.domain,
        pages,
        digest.jobs,
        digest.tech,
        { since: digest.since, is_baseline: digest.is_baseline },
        // Page lines below webhookMinSeverity are omitted. That filter must not turn a real change into the quiet sentence.
        { allowQuiet: !digest.changed },
    );
    const withDomain = summary.includes(digest.domain) ? summary : `${summary}\n${digest.domain}`;
    const text = `${withDomain}${runUrl ? `\nRun: ${runUrl}` : ''}`;
    if (format === 'slack') return { text: text.slice(0, 39_000) };
    if (format === 'discord') return { content: text.slice(0, 1990) };
    return {
        source: 'fairquery/competitor-change-tracker',
        kind: 'digest',
        watchlist,
        domain: digest.domain,
        run_url: runUrl,
        since: digest.since,
        changes_count: digest.changes_count,
        changed: digest.changed,
        is_baseline: digest.is_baseline,
        severity: rollupSeverity(pages, digest.jobs, digest.tech),
        text,
        page_changes: pages,
        jobs: digest.jobs,
        tech: digest.tech,
    };
}
