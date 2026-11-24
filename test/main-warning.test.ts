import { describe, expect, it, vi } from 'vitest';

import { DIGEST_JOBS_RETIRED_WARNING } from '../src/input.js';

const saved = vi.hoisted(() => ({
    mode: 'digest' as 'digest' | 'watch',
    output: null as Record<string, unknown> | null,
}));
const warn = vi.hoisted(() => vi.fn());

vi.mock('apify', () => ({
    Actor: {
        init: async () => undefined,
        on: () => undefined,
        getInput: async () => ({
            mode: saved.mode,
            digestJobs: true,
            digestTech: false,
            pages: ['https://example.com/pricing'],
        }),
        getEnv: () => ({ isAtHome: false }),
        pushData: async () => undefined,
        setValue: async (key: string, value: unknown) => {
            if (key === 'OUTPUT') saved.output = value as Record<string, unknown>;
        },
        openKeyValueStore: async () => ({
            getValue: async () => null,
            setValue: async () => undefined,
        }),
        exit: async () => undefined,
        fail: async (message: string) => {
            throw new Error(message);
        },
        setStatusMessage: async () => undefined,
    },
    log: {
        info: () => undefined,
        warning: warn,
        error: () => undefined,
        debug: () => undefined,
    },
}));

vi.mock('../src/http.js', async () => {
    const actual = await vi.importActual<typeof import('../src/http.js')>('../src/http.js');
    return {
        ...actual,
        Fetcher: class {
            requests = 0;
            bytes = 0;
            async get(): Promise<never> {
                this.requests += 1;
                throw new actual.HttpError('blocked in test', 'DNS_FAILED', false);
            }
        },
    };
});

async function runMain(): Promise<void> {
    vi.resetModules();
    await import('../src/main.js');
}

describe('main warnings path', () => {
    it('logs the digestJobs warning only in digest mode', async () => {
        saved.mode = 'digest';
        saved.output = null;
        warn.mockClear();
        await runMain();
        expect(warn).toHaveBeenCalledWith(DIGEST_JOBS_RETIRED_WARNING);
        expect(saved.output?.mode).toBe('digest');
        expect(saved.output?.warnings).toEqual([DIGEST_JOBS_RETIRED_WARNING]);
        expect(JSON.stringify(saved.output)).not.toContain('fairquery/company-jobs-feed');

        saved.mode = 'watch';
        saved.output = null;
        warn.mockClear();
        await runMain();
        expect(warn).not.toHaveBeenCalledWith(DIGEST_JOBS_RETIRED_WARNING);
        expect(saved.output?.warnings).toBeUndefined();
        expect(saved.output?.mode).toBeUndefined();
    });
});
