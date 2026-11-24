import { normalizeNoise } from './noise.js';
import type { Section } from './types.js';

/** Split text into comparable units: lines, and long lines into sentences. */
export function units(text: string): string[] {
    const out: string[] = [];
    for (const line of text.split('\n')) {
        const l = line.trim();
        if (!l) continue;
        if (l.length <= 240) {
            out.push(l);
            continue;
        }
        for (const s of l.split(/(?<=[.!?;:])\s+(?=[A-Z0-9("“'])/)) if (s.trim()) out.push(s.trim());
    }
    return out;
}

export interface LineDiff {
    added: string[];
    removed: string[];
}

/** LCS diff on units compared by key (noise-normalised); returns the raw added/removed units. */
export function diffUnits(a: string[], b: string[], key: (s: string) => string): LineDiff {
    const ka = a.map(key);
    const kb = b.map(key);
    // trim common prefix/suffix
    let start = 0;
    while (start < ka.length && start < kb.length && ka[start] === kb[start]) start++;
    let endA = ka.length;
    let endB = kb.length;
    while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) {
        endA--;
        endB--;
    }
    const A = ka.slice(start, endA);
    const B = kb.slice(start, endB);
    const added: string[] = [];
    const removed: string[] = [];
    if (A.length * B.length > 4_000_000) {
        // too large for LCS: multiset difference
        const cnt = new Map<string, number>();
        for (const k of A) cnt.set(k, (cnt.get(k) ?? 0) + 1);
        B.forEach((k, i) => {
            const c = cnt.get(k) ?? 0;
            if (c > 0) cnt.set(k, c - 1);
            else added.push(b[start + i]);
        });
        const cntB = new Map<string, number>();
        for (const k of B) cntB.set(k, (cntB.get(k) ?? 0) + 1);
        A.forEach((k, i) => {
            const c = cntB.get(k) ?? 0;
            if (c > 0) cntB.set(k, c - 1);
            else removed.push(a[start + i]);
        });
        return { added, removed };
    }
    const n = A.length;
    const m = B.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
        for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (A[i] === B[j]) {
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(a[start + i++]);
        else added.push(b[start + j++]);
    }
    while (i < n) removed.push(a[start + i++]);
    while (j < m) added.push(b[start + j++]);
    // a unit that moved (removed in one place, added in another) is not a change
    const addKeys = new Map<string, number>();
    for (const s of added) addKeys.set(key(s), (addKeys.get(key(s)) ?? 0) + 1);
    const keptRemoved: string[] = [];
    for (const s of removed) {
        const k = key(s);
        const c = addKeys.get(k) ?? 0;
        if (c > 0) addKeys.set(k, c - 1);
        else keptRemoved.push(s);
    }
    const remKeys = new Map<string, number>();
    for (const s of removed) remKeys.set(key(s), (remKeys.get(key(s)) ?? 0) + 1);
    const keptAdded: string[] = [];
    for (const s of added) {
        const k = key(s);
        const c = remKeys.get(k) ?? 0;
        if (c > 0) remKeys.set(k, c - 1);
        else keptAdded.push(s);
    }
    return { added: keptAdded, removed: keptRemoved };
}

export interface SectionChange {
    heading: string;
    change: 'added' | 'removed' | 'modified' | 'renamed';
    previous_heading?: string;
    added: string[];
    removed: string[];
    changed_chars: number;
}

function tokens(s: string): Set<string> {
    return new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));
}

export function similarity(a: string, b: string): number {
    const ta = tokens(a);
    const tb = tokens(b);
    if (!ta.size && !tb.size) return 1;
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    return inter / (ta.size + tb.size - inter);
}

/** Section-level semantic diff: added / removed / renamed / modified sections with changed sentences. */
export function diffSections(
    prev: Section[],
    next: Section[],
    numberSensitive: boolean,
    ignore: RegExp[] = [],
): SectionChange[] {
    const key = (s: string) => normalizeNoise(s, numberSensitive, ignore).toLowerCase();
    const hk = (h: string) => key(h);
    const pm = new Map<string, Section>();
    for (const s of prev) if (!pm.has(hk(s.heading))) pm.set(hk(s.heading), s);
    const nm = new Map<string, Section>();
    for (const s of next) if (!nm.has(hk(s.heading))) nm.set(hk(s.heading), s);
    const out: SectionChange[] = [];
    const removedSecs = prev.filter((s) => !nm.has(hk(s.heading)));
    const addedSecs = next.filter((s) => !pm.has(hk(s.heading)));
    const usedRemoved = new Set<Section>();
    for (const s of next) {
        const p = pm.get(hk(s.heading));
        if (p) {
            if (key(p.text) === key(s.text)) continue;
            const d = diffUnits(units(p.text), units(s.text), key);
            if (!d.added.length && !d.removed.length) continue;
            out.push({
                heading: s.heading,
                change: 'modified',
                added: d.added,
                removed: d.removed,
                changed_chars: [...d.added, ...d.removed].reduce((n, x) => n + x.length, 0),
            });
        } else if (addedSecs.includes(s)) {
            // renamed: an unmatched old section with near-identical text
            const twin = removedSecs.find((r) => !usedRemoved.has(r) && r.text.length > 40 && similarity(r.text, s.text) >= 0.8);
            if (twin) {
                usedRemoved.add(twin);
                const d = diffUnits(units(twin.text), units(s.text), key);
                out.push({
                    heading: s.heading,
                    change: 'renamed',
                    previous_heading: twin.heading,
                    added: d.added,
                    removed: d.removed,
                    changed_chars: s.heading.length + [...d.added, ...d.removed].reduce((n, x) => n + x.length, 0),
                });
            } else {
                const u = units(s.text);
                out.push({
                    heading: s.heading,
                    change: 'added',
                    added: u,
                    removed: [],
                    changed_chars: s.heading.length + s.text.length,
                });
            }
        }
    }
    for (const r of removedSecs) {
        if (usedRemoved.has(r)) continue;
        out.push({
            heading: r.heading,
            change: 'removed',
            added: [],
            removed: units(r.text),
            changed_chars: r.heading.length + r.text.length,
        });
    }
    return out;
}

export function clip(s: string, n = 300): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
