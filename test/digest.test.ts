import { describe, expect, it } from 'vitest';

import {
    type ActorRunClient,
    buildDigests,
    type DigestPageChange,
    type DigestStore,
    digestWebhookBody,
    endSentence,
    JOBS_RETIRED_CODE,
    JOBS_RETIRED_MESSAGE,
    TECH_ACTOR_ID,
} from '../src/digest.js';
import { DIGEST_JOBS_RETIRED_WARNING, digestJobsWarning, parseInput } from '../src/input.js';

/** Retired child Actor. Lives only in tests so the string is not shipped in src/ or dist/. */
const RETIRED_JOBS_ACTOR_ID = 'fairquery/company-jobs-feed';

function memoryStore(): DigestStore & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return {
        data,
        async getValue<T>(key: string) {
            return (data.get(key) as T) ?? null;
        },
        async setValue(key: string, value: unknown) {
            data.set(key, value);
        },
    };
}

const pricing: DigestPageChange = {
    domain: 'www.acme.com',
    url: 'https://www.acme.com/pricing',
    page_type: 'pricing',
    label: 'Acme pricing',
    severity: 'high',
    change_kind: 'price_changed',
    summary: '"Pro" price changed from $12/month to $15/month.',
};

function client(byActor: Record<string, Record<string, unknown>[]>): {
    client: ActorRunClient;
    calls: { actorId: string; input: Record<string, unknown> }[];
} {
    const calls: { actorId: string; input: Record<string, unknown> }[] = [];
    return {
        calls,
        client: {
            async run(actorId, input) {
                calls.push({ actorId, input });
                if (actorId === RETIRED_JOBS_ACTOR_ID) throw new Error('jobs actor must not be called');
                return { items: byActor[actorId] ?? [], runId: `run-${actorId}`, status: 'SUCCEEDED' };
            },
        },
    };
}

const baseArgs = {
    techEnabled: true,
    allowActorCalls: true,
    skipCode: null,
    watchlist: 'saas',
    nowIso: '2026-10-24T12:00:00.000Z',
};

const techSite = (names: { name: string; category: string }[]) => ({
    type: 'site',
    domain: 'acme.com',
    technologies: names,
});

describe('digest assembly (offline)', () => {
    it('makes no jobs child call when digestJobs is omitted, true, or false', async () => {
        for (const digestJobs of [undefined, true, false] as const) {
            const raw: Record<string, unknown> = { mode: 'digest', domains: ['acme.com'] };
            if (digestJobs !== undefined) raw.digestJobs = digestJobs;
            const { input, problems } = parseInput(raw);
            expect(problems).toEqual([]);
            expect(input.mode).toBe('digest');
            expect(input.digestTech).toBe(true);
            expect(digestJobsWarning(input)).toBe(digestJobs === true ? DIGEST_JOBS_RETIRED_WARNING : null);

            const store = memoryStore();
            const fake = client({
                [RETIRED_JOBS_ACTOR_ID]: [
                    {
                        type: 'job',
                        company_domain: 'acme.com',
                        title: 'Backend Engineer',
                        department: 'Engineering',
                        change: 'new',
                        status: 'open',
                    },
                ],
                [TECH_ACTOR_ID]: [techSite([{ name: 'Next.js', category: 'JS framework' }])],
            });
            const built = await buildDigests({
                ...baseArgs,
                techEnabled: input.digestTech,
                domains: input.domains,
                pageChanges: [],
                store,
                client: fake.client,
            });
            expect(fake.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
            expect(fake.calls[0].input).toMatchObject({
                urls: ['acme.com'],
                checkRobots: true,
                checkSitemap: false,
                checkLlmsTxt: false,
                respectRobotsTxt: true,
                maxSites: 1,
            });
            expect(built.jobs).toEqual({
                actor_id: null,
                called: false,
                run_id: null,
                status: null,
                error: JOBS_RETIRED_CODE,
            });
            expect(JSON.stringify(built)).not.toContain('fairquery/company-jobs-feed');
            expect(built.tech.called).toBe(true);
            expect(built.digests[0].jobs).toMatchObject({
                status: 'skipped',
                code: JOBS_RETIRED_CODE,
                message: JOBS_RETIRED_MESSAGE,
                opened: 0,
                closed: 0,
                updated: 0,
            });
            expect(built.digests[0].tech.status).toBe('baseline');
            expect(built.digests[0].summary).toContain('part of this baseline. jobs: not included');
            expect(built.digests[0].summary).not.toContain('opened');
            expect(built.digests[0].summary).not.toContain('closed');
            expect(JSON.stringify(built.digests[0])).not.toContain('Backend Engineer');
            const slack = digestWebhookBody('slack', 'saas', built.digests[0], null, 'low') as { text: string };
            expect(slack.text).toContain('jobs: not included');
            expect(slack.text).not.toContain('opened');
            expect(slack.text).not.toContain('closed');
            expect(slack.text).not.toContain('no jobs opened');
        }
    });

    it('reports tech-stack changes and does not count jobs toward changes_count', async () => {
        const store = memoryStore();
        const first = client({
            [TECH_ACTOR_ID]: [
                techSite([
                    { name: 'Next.js', category: 'JS framework' },
                    { name: 'Google Analytics', category: 'Analytics' },
                ]),
            ],
        });
        const baseline = await buildDigests({
            ...baseArgs,
            domains: ['acme.com'],
            pageChanges: [],
            store,
            client: first.client,
        });
        expect(first.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
        expect(baseline.digests).toHaveLength(1);
        expect(baseline.digests[0].jobs.status).toBe('skipped');
        expect(baseline.digests[0].jobs.code).toBe(JOBS_RETIRED_CODE);
        expect(baseline.digests[0].tech.status).toBe('baseline');
        expect(baseline.digests[0].tech.added).toEqual([]);
        expect(baseline.digests[0].severity).toBe(null);
        expect(baseline.digests[0].since).toBe(null);
        expect(baseline.digests[0].is_baseline).toBe(true);
        expect(baseline.digests[0].changed).toBe(false);
        expect(baseline.digests[0].changes_count).toBe(0);
        expect(baseline.digests[0].summary.startsWith('Baseline for acme.com:')).toBe(true);
        expect(baseline.digests[0].summary).toContain('This is not a quiet period.');
        expect(baseline.digests[0].summary).toContain('jobs: not included');
        expect(baseline.digests[0].summary.startsWith('No changes since')).toBe(false);
        expect(baseline.jobs.called).toBe(false);
        expect(baseline.is_baseline).toBe(true);
        expect(baseline.since).toBe(null);

        const second = client({
            [TECH_ACTOR_ID]: [
                {
                    type: 'site',
                    input: 'acme.com',
                    technologies: [
                        { name: 'Next.js', category: 'JS framework' },
                        { name: 'Segment', category: 'Analytics' },
                    ],
                },
            ],
        });
        const weekly = await buildDigests({
            ...baseArgs,
            nowIso: '2026-10-31T12:00:00.000Z',
            domains: ['acme.com', 'beta.com'],
            pageChanges: [pricing],
            store,
            client: second.client,
        });
        expect(second.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
        const acme = weekly.digests.find((d) => d.domain === 'acme.com');
        const beta = weekly.digests.find((d) => d.domain === 'beta.com');
        expect(acme?.page_changes).toHaveLength(1);
        expect(acme?.jobs.status).toBe('skipped');
        expect(acme?.jobs.opened).toBe(0);
        expect(acme?.jobs.closed).toBe(0);
        expect(acme?.tech.added).toEqual([{ name: 'Segment', category: 'Analytics' }]);
        expect(acme?.tech.removed).toEqual([{ name: 'Google Analytics', category: 'Analytics' }]);
        expect(acme?.severity).toBe('high');
        expect(acme?.since).toBe('2026-10-24T12:00:00.000Z');
        expect(acme?.is_baseline).toBe(false);
        expect(acme?.changed).toBe(true);
        expect(acme?.changes_count).toBe(3);
        expect(acme?.summary.startsWith('Since 2026-10-24T12:00:00.000Z:')).toBe(true);
        expect(acme?.summary).toContain('Pro');
        expect(acme?.summary).toContain('jobs: not included');
        expect(acme?.summary).not.toContain('opened');
        expect(acme?.summary).not.toContain('closed');
        expect(acme?.summary).toContain('Segment');
        expect(acme?.summary).toContain('Google Analytics');
        expect(beta?.jobs).toMatchObject({ status: 'skipped', code: JOBS_RETIRED_CODE });
        expect(beta?.page_changes).toEqual([]);
        expect(beta?.since).toBe('2026-10-24T12:00:00.000Z');
        expect(beta?.is_baseline).toBe(false);
        expect(beta?.changed).toBe(false);
        expect(beta?.changes_count).toBe(0);
        expect(beta?.summary.startsWith('No changes since')).toBe(false);
        expect(beta?.summary).toContain('jobs: not included');
        expect(beta?.summary).not.toContain('jobs unavailable');
        expect(beta?.summary).toContain('tech stack unavailable');
        expect(weekly.since).toBe('2026-10-24T12:00:00.000Z');
        expect(weekly.is_baseline).toBe(false);
        expect(weekly.changed).toBe(true);
        expect(weekly.changes_count).toBe(3);
        expect(weekly.jobs.called).toBe(false);

        const slack = digestWebhookBody(
            'slack',
            'saas',
            acme!,
            'https://console.apify.com/view/runs/abc',
            'low',
        ) as Record<string, unknown>;
        expect(Object.keys(slack)).toEqual(['text']);
        expect(slack.text).toContain('acme.com weekly digest');
        expect(slack.text).toContain('jobs: not included');
        expect(slack.text).not.toContain('opened');
        expect(slack.text).not.toContain('closed');
        const discord = digestWebhookBody('discord', 'saas', acme!, null, 'high') as Record<string, unknown>;
        expect(Object.keys(discord)).toEqual(['content']);
        expect((discord.content as string).length).toBeLessThanOrEqual(2000);
        expect(discord.content).not.toContain('opened');
        const json = digestWebhookBody('json', 'saas', acme!, null, 'high') as {
            kind: string;
            domain: string;
            since: string | null;
            changes_count: number;
            changed: boolean;
            is_baseline: boolean;
            page_changes: unknown[];
            text: string;
            jobs: { status: string; code: string | null; opened: number; closed: number };
        };
        expect(json.kind).toBe('digest');
        expect(json.domain).toBe('acme.com');
        expect(json.since).toBe('2026-10-24T12:00:00.000Z');
        expect(json.changes_count).toBe(3);
        expect(json.changed).toBe(true);
        expect(json.is_baseline).toBe(false);
        expect(json.page_changes).toHaveLength(1);
        expect(json.jobs.status).toBe('skipped');
        expect(json.jobs.code).toBe(JOBS_RETIRED_CODE);
        expect(json.jobs.opened).toBe(0);
        expect(json.jobs.closed).toBe(0);
        expect(json.text).toContain('jobs: not included');
        expect(json.text).not.toContain('no jobs opened');
    });

    it('keeps the page change when the tech Actor fails, and still does not call jobs', async () => {
        const store = memoryStore();
        const calls: string[] = [];
        const failing: ActorRunClient = {
            async run(actorId) {
                calls.push(actorId);
                if (actorId === RETIRED_JOBS_ACTOR_ID) throw new Error('jobs actor must not be called');
                return {
                    items: [{ type: 'error', input: 'acme.com', code: 'FETCH_FAILED', message: 'timed out' }],
                    runId: null,
                    status: 'SUCCEEDED',
                };
            },
        };
        const failed = await buildDigests({
            ...baseArgs,
            domains: ['acme.com'],
            pageChanges: [pricing],
            store,
            client: failing,
        });
        expect(calls).toEqual([TECH_ACTOR_ID]);
        expect(failed.digests[0].page_changes).toHaveLength(1);
        expect(failed.digests[0].jobs).toMatchObject({
            status: 'skipped',
            code: JOBS_RETIRED_CODE,
            message: JOBS_RETIRED_MESSAGE,
        });
        expect(failed.digests[0].tech).toMatchObject({ status: 'error', code: 'FETCH_FAILED' });
        expect(failed.digests[0].summary).toContain('jobs: not included');
        expect(failed.digests[0].summary).not.toContain('jobs unavailable');
        expect(failed.digests[0].is_baseline).toBe(true);
        expect(failed.digests[0].since).toBe(null);
        expect(failed.digests[0].changed).toBe(true);
        expect(failed.digests[0].changes_count).toBe(1);
        expect(failed.digests[0].summary.startsWith('Baseline for acme.com:')).toBe(true);
        expect(failed.digests[0].summary.startsWith('No changes since')).toBe(false);
        expect(failed.jobs.called).toBe(false);

        const offCalls: string[] = [];
        const off = await buildDigests({
            ...baseArgs,
            techEnabled: false,
            domains: ['acme.com'],
            pageChanges: [],
            store: memoryStore(),
            client: {
                async run(actorId) {
                    offCalls.push(actorId);
                    throw new Error('no actor should be called');
                },
            },
        });
        expect(offCalls).toEqual([]);
        expect(off.digests[0].jobs).toMatchObject({ status: 'skipped', code: JOBS_RETIRED_CODE });
        expect(off.digests[0].tech.status).toBe('skipped');
        expect(off.digests[0].tech.code).toBe('DISABLED');
        expect(off.jobs.called).toBe(false);
        expect(off.tech.called).toBe(false);
        expect(off.digests[0].is_baseline).toBe(true);
        expect(off.digests[0].changed).toBe(false);
        expect(off.digests[0].changes_count).toBe(0);
        expect(off.digests[0].summary).toContain('This is not a quiet period.');
        expect(off.digests[0].summary).toContain('pricing, terms and changelog are part of this baseline. jobs: not included');
        expect(off.digests[0].summary).toContain('jobs: not included');
        expect(off.digests[0].summary).toContain('tech stack not included');
        expect(off.digests[0].summary.startsWith('No changes since')).toBe(false);
    });

    it('does not call jobs when actor calls are skipped for abort or the domain cap', async () => {
        const calls: string[] = [];
        const built = await buildDigests({
            ...baseArgs,
            allowActorCalls: false,
            skipCode: 'ABORTED',
            domains: ['acme.com'],
            pageChanges: [pricing],
            store: memoryStore(),
            client: {
                async run(actorId) {
                    calls.push(actorId);
                    throw new Error('no actor should be called');
                },
            },
        });
        expect(calls).toEqual([]);
        expect(built.digests[0].jobs).toMatchObject({ status: 'skipped', code: JOBS_RETIRED_CODE });
        expect(built.digests[0].tech).toMatchObject({ status: 'skipped', code: 'ABORTED' });
        expect(built.jobs.called).toBe(false);
        expect(built.tech.called).toBe(false);
        expect(built.digests[0].changes_count).toBe(1);
        expect(built.digests[0].summary).toContain('jobs: not included');
        expect(built.digests[0].summary).toContain('tech stack not checked (ABORTED)');
    });

    it('says no changes only after a real comparison, and keeps each watchlist clock separate', async () => {
        const store = memoryStore();
        const tech = [{ name: 'Next.js', category: 'JS framework' }];
        const rows = {
            [TECH_ACTOR_ID]: [{ type: 'site', domain: 'acme.com', technologies: tech }],
        };
        const first = client(rows);
        const baseline = await buildDigests({
            ...baseArgs,
            domains: ['acme.com'],
            pageChanges: [],
            store,
            client: first.client,
        });
        expect(first.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
        expect(baseline.digests[0].is_baseline).toBe(true);
        expect(baseline.digests[0].summary.startsWith('No changes since')).toBe(false);

        const second = client(rows);
        const quiet = await buildDigests({
            ...baseArgs,
            nowIso: '2026-10-31T12:00:00.000Z',
            domains: ['acme.com'],
            pageChanges: [],
            store,
            client: second.client,
        });
        expect(second.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
        expect(quiet.digests[0].since).toBe('2026-10-24T12:00:00.000Z');
        expect(quiet.digests[0].is_baseline).toBe(false);
        expect(quiet.digests[0].changed).toBe(false);
        expect(quiet.digests[0].changes_count).toBe(0);
        expect(quiet.digests[0].jobs.status).toBe('skipped');
        expect(quiet.digests[0].summary).toBe('No changes since 2026-10-24T12:00:00.000Z.');
        const quietSlack = digestWebhookBody('slack', 'saas', quiet.digests[0], null, 'low') as { text: string };
        expect(quietSlack.text.startsWith('No changes since 2026-10-24T12:00:00.000Z.')).toBe(true);
        expect(quietSlack.text).toContain('acme.com');
        expect(quietSlack.text).not.toContain('opened');
        expect(quietSlack.text).not.toContain('closed');
        expect(quietSlack.text).not.toContain('jobs:');
        const hidden = {
            ...quiet.digests[0],
            changed: true,
            changes_count: 1,
            page_changes: [
                {
                    domain: 'acme.com',
                    url: 'https://acme.com/blog',
                    page_type: 'blog',
                    label: null,
                    severity: 'low' as const,
                    change_kind: 'new_entries',
                    summary: 'New blog post.',
                },
            ],
        };
        const filtered = digestWebhookBody('slack', 'saas', hidden, null, 'high') as { text: string };
        expect(filtered.text.startsWith('Since 2026-10-24T12:00:00.000Z:')).toBe(true);
        expect(filtered.text.startsWith('No changes since')).toBe(false);
        expect(filtered.text).not.toContain('New blog post.');
        expect(filtered.text).toContain('jobs: not included');
        expect(quiet.since).toBe('2026-10-24T12:00:00.000Z');
        expect(quiet.changed).toBe(false);
        expect(quiet.changes_count).toBe(0);
        expect(quiet.is_baseline).toBe(false);

        const other = client(rows);
        const separate = await buildDigests({
            ...baseArgs,
            watchlist: 'other-list',
            domains: ['acme.com'],
            pageChanges: [],
            store,
            client: other.client,
        });
        expect(other.calls.map((c) => c.actorId)).toEqual([TECH_ACTOR_ID]);
        expect(separate.digests[0].is_baseline).toBe(true);
        expect(separate.digests[0].since).toBe(null);
        expect(separate.digests[0].summary.startsWith('Baseline for acme.com:')).toBe(true);

        const held = memoryStore();
        const heldClient = client(rows);
        const uncommitted = await buildDigests({
            ...baseArgs,
            commitSince: false,
            domains: ['acme.com'],
            pageChanges: [],
            store: held,
            client: heldClient.client,
        });
        expect(uncommitted.digests[0].is_baseline).toBe(true);
        const stillBaseline = await buildDigests({
            ...baseArgs,
            nowIso: '2026-10-31T12:00:00.000Z',
            domains: ['acme.com'],
            pageChanges: [],
            store: held,
            client: client(rows).client,
        });
        expect(stillBaseline.digests[0].is_baseline).toBe(true);
        expect(stillBaseline.digests[0].since).toBe(null);

        const broken = await buildDigests({
            ...baseArgs,
            nowIso: '2026-11-07T12:00:00.000Z',
            domains: ['acme.com'],
            pageChanges: [],
            store,
            client: {
                async run(actorId) {
                    if (actorId === RETIRED_JOBS_ACTOR_ID) throw new Error('jobs actor must not be called');
                    throw new Error('down');
                },
            },
        });
        expect(broken.jobs.called).toBe(false);
        expect(broken.digests[0].jobs.status).toBe('skipped');
        expect(broken.digests[0].since).toBe('2026-10-31T12:00:00.000Z');
        expect(broken.digests[0].is_baseline).toBe(false);
        expect(broken.digests[0].changed).toBe(false);
        expect(broken.digests[0].summary.startsWith('No changes since')).toBe(false);
        expect(broken.digests[0].summary).toContain('no pricing, terms or changelog changes. jobs: not included.');
        expect(broken.digests[0].summary).not.toContain('jobs unavailable');
        expect(broken.digests[0].summary).toContain('tech stack unavailable');
    });

    it('closes every page summary, and does not add a second stop', async () => {
        const closed = ['Done.”', 'Ready?"', 'Stop!)', 'Wait…', 'Wait...'];
        for (const summary of closed) {
            expect(endSentence(summary)).toBe(summary);
            const built = await buildDigests({
                ...baseArgs,
                techEnabled: false,
                domains: ['acme.com'],
                pageChanges: [{ ...pricing, summary }],
                store: memoryStore(),
                client: {
                    async run() {
                        throw new Error('no actor should be called');
                    },
                },
            });
            const text = built.digests[0].summary;
            expect(text).toContain(`${summary} jobs: not included.`);
            expect(text).not.toContain(`${summary}.`);
        }
        expect(endSentence('Plan "Business" removed')).toBe('Plan "Business" removed.');

        const two = await buildDigests({
            ...baseArgs,
            techEnabled: false,
            domains: ['acme.com'],
            pageChanges: [
                { ...pricing, summary: '"Up to 5 projects"' },
                {
                    ...pricing,
                    url: 'https://www.acme.com/pricing/business',
                    summary: 'Plan "Business" removed',
                },
            ],
            store: memoryStore(),
            client: {
                async run() {
                    throw new Error('no actor should be called');
                },
            },
        });
        expect(two.digests[0].summary).toContain('"Up to 5 projects". Plan "Business" removed.');
        expect(two.digests[0].summary).not.toContain('"Up to 5 projects" Plan');
    });
});
