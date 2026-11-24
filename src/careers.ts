import type { Fetcher } from './http.js';
import { type ChangeItem, type Job, LIMITS } from './types.js';

export type Ats = 'greenhouse' | 'lever' | 'ashby';

const BOARD_PATTERNS: [Ats, RegExp][] = [
    ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([A-Za-z0-9][A-Za-z0-9_-]{0,99})/gi],
    ['greenhouse', /boards-api\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})/gi],
    ['lever', /jobs(?:\.eu)?\.lever\.co\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/gi],
    ['lever', /api(?:\.eu)?\.lever\.co\/v0\/postings\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})/gi],
    ['ashby', /jobs\.ashbyhq\.com\/([A-Za-z0-9][A-Za-z0-9._%-]{0,99})/gi],
    ['ashby', /api\.ashbyhq\.com\/posting-api\/job-board\/([A-Za-z0-9][A-Za-z0-9._%-]{0,99})/gi],
];

const NOT_SLUGS = new Set(['embed', 'js', 'api', 'v0', 'v1', 'jobs', 'job_board', 'static', 'assets', 'favicon.ico', 'robots.txt']);

/** Find a Greenhouse / Lever / Ashby board referenced by a careers page (links, embeds, scripts) or URL. */
export function detectBoard(htmlOrUrl: string): { ats: Ats; slug: string } | null {
    const counts = new Map<string, { ats: Ats; slug: string; n: number }>();
    for (const [ats, re] of BOARD_PATTERNS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(htmlOrUrl))) {
            const slug = decodeURIComponent(m[1]).replace(/\.$/, '');
            if (NOT_SLUGS.has(slug.toLowerCase())) continue;
            const k = `${ats}:${slug.toLowerCase()}`;
            const c = counts.get(k) ?? { ats, slug, n: 0 };
            c.n++;
            counts.set(k, c);
        }
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
    return best ? { ats: best.ats, slug: best.slug } : null;
}

export function boardApiUrl(b: { ats: Ats; slug: string }): string {
    const s = encodeURIComponent(b.slug);
    switch (b.ats) {
        case 'greenhouse':
            return `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`;
        case 'lever':
            return `https://api.lever.co/v0/postings/${s}?mode=json`;
        case 'ashby':
            return `https://api.ashbyhq.com/posting-api/job-board/${s}`;
        default:
            throw new Error('unknown ATS');
    }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** Normalise the public job-board JSON of each ATS to {id, title, department, location}. */
export function parseBoard(ats: Ats, json: unknown): Job[] {
    const jobs: Job[] = [];
    if (ats === 'greenhouse') {
        const arr = (json as { jobs?: unknown[] })?.jobs ?? [];
        for (const j of arr as Record<string, unknown>[]) {
            const id = str(j.id);
            const title = str(j.title);
            if (!id || !title) continue;
            const depts = (j.departments as { name?: string }[] | undefined)?.map((d) => d.name).filter(Boolean);
            jobs.push({ id, title, department: depts?.[0] ?? null, location: str((j.location as { name?: string })?.name) });
        }
    } else if (ats === 'lever') {
        for (const j of (Array.isArray(json) ? json : []) as Record<string, unknown>[]) {
            const id = str(j.id);
            const title = str(j.text);
            if (!id || !title) continue;
            const cat = (j.categories ?? {}) as Record<string, unknown>;
            jobs.push({ id, title, department: str(cat.department) ?? str(cat.team), location: str(cat.location) });
        }
    } else {
        const arr = (json as { jobs?: unknown[] })?.jobs ?? [];
        for (const j of arr as Record<string, unknown>[]) {
            if (j.isListed === false) continue;
            const id = str(j.id);
            const title = str(j.title);
            if (!id || !title) continue;
            jobs.push({ id, title, department: str(j.department) ?? str(j.team), location: str(j.location) });
        }
    }
    return jobs.slice(0, LIMITS.maxJobs);
}

export async function fetchBoard(fetcher: Fetcher, b: { ats: Ats; slug: string }): Promise<{ jobs: Job[]; url: string }> {
    const url = boardApiUrl(b);
    const res = await fetcher.get(url, { accept: 'application/json', maxBytes: LIMITS.maxJsonBytes, maxHops: 0 });
    if (res.status !== 200) throw new Error(`${b.ats} board ${b.slug} answered HTTP ${res.status}`);
    let json: unknown;
    try {
        json = JSON.parse(res.body);
    } catch {
        throw new Error(`${b.ats} board ${b.slug}: response was not JSON`);
    }
    return { jobs: parseBoard(b.ats, json), url };
}

export function wordRe(k: string): RegExp {
    return new RegExp(`(?<![\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
}

export function countKeywords(texts: string[], keywords: string[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const k of keywords) {
        const re = wordRe(k);
        let n = 0;
        for (const t of texts) n += (t.match(re) ?? []).length;
        out[k] = n;
    }
    return out;
}

function groupCount(jobs: Job[]): string {
    const m = new Map<string, number>();
    for (const j of jobs) m.set(j.department ?? 'Other', (m.get(j.department ?? 'Other') ?? 0) + 1);
    return [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([d, n]) => `${n} ${d}`)
        .join(', ');
}

/** Compare job lists: roles opened / closed, hiring-volume shift, keyword trends in titles. */
export function compareJobs(prev: Job[], next: Job[], keywords: string[]): ChangeItem[] {
    const pm = new Map(prev.map((j) => [j.id, j]));
    const nm = new Map(next.map((j) => [j.id, j]));
    const opened = next.filter((j) => !pm.has(j.id));
    const closed = prev.filter((j) => !nm.has(j.id));
    const items: ChangeItem[] = [];
    const shift = prev.length ? (next.length - prev.length) / prev.length : 0;
    const big = (Math.abs(shift) >= 0.2 && Math.abs(next.length - prev.length) >= 5) || opened.length >= 10 || closed.length >= 10;
    const kwHit = (j: Job) => keywords.some((k) => wordRe(k).test(j.title));
    if (opened.length || closed.length) {
        const parts: string[] = [];
        if (opened.length) parts.push(`${opened.length} new role${opened.length > 1 ? 's' : ''} (${groupCount(opened)})`);
        if (closed.length) parts.push(`${closed.length} role${closed.length > 1 ? 's' : ''} closed (${groupCount(closed)})`);
        const kwOpened = opened.filter(kwHit);
        items.push({
            kind: 'jobs_changed',
            severity: big || kwOpened.length ? 'medium' : 'low',
            summary: `${parts.join('; ')}. Open roles: ${prev.length} → ${next.length}${prev.length ? ` (${shift >= 0 ? '+' : ''}${Math.round(shift * 100)}%)` : ''}.${kwOpened.length ? ` Keyword match: ${kwOpened.slice(0, 5).map((j) => `"${j.title}"`).join(', ')}.` : ''} Examples: ${opened
                .slice(0, 5)
                .map((j) => j.title)
                .join(', ') || closed.slice(0, 5).map((j) => j.title).join(', ')}.`,
            details: {
                open_before: prev.length,
                open_after: next.length,
                opened: opened.slice(0, LIMITS.maxListedItems),
                closed: closed.slice(0, LIMITS.maxListedItems),
                keyword_matches: kwOpened.slice(0, LIMITS.maxListedItems).map((j) => j.title),
            },
        });
    }
    if (keywords.length) {
        const a = countKeywords(prev.map((j) => j.title), keywords);
        const b = countKeywords(next.map((j) => j.title), keywords);
        const moved = keywords.filter((k) => a[k] !== b[k]);
        if (moved.length)
            items.push({
                kind: 'careers_keywords_changed',
                severity: 'medium',
                summary: `Job-title keyword counts changed: ${moved.map((k) => `"${k}" ${a[k]} → ${b[k]}`).join(', ')}.`,
                details: { before: a, after: b },
            });
    }
    return items;
}
