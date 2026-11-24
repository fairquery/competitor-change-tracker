import { Actor, log } from 'apify';

import type { ActorDataset, ActorRunClient } from './digest.js';

const WAIT_SECS = 240;
const MEMORY_MB = 256;
const TIMEOUT_SECS = 300;
const PAGE = 1000;
const MAX_ITEMS = 8000;

async function readItems(datasetId: string | undefined): Promise<Record<string, unknown>[]> {
    if (!datasetId) return [];
    const items: Record<string, unknown>[] = [];
    let offset = 0;
    for (;;) {
        const page = await Actor.apifyClient.dataset(datasetId).listItems({ offset, limit: PAGE, clean: true });
        for (const item of page.items) items.push(item as Record<string, unknown>);
        offset += page.items.length;
        if (!page.items.length || offset >= (page.total ?? offset) || items.length >= MAX_ITEMS) break;
    }
    return items;
}

/**
 * Calls another public Actor with this run's Apify token (`APIFY_TOKEN` on the platform) and reads its dataset.
 * Not used by unit tests. A digest run starts at most one child run (the tech Actor). Jobs are not called.
 */
export function platformActorClient(): ActorRunClient {
    return {
        async run(actorId, input): Promise<ActorDataset> {
            log.info(`Digest: starting ${actorId}`);
            const run = await Actor.call(actorId, input, {
                waitSecs: WAIT_SECS,
                memory: MEMORY_MB,
                timeout: TIMEOUT_SECS,
            });
            const status = String(run.status ?? 'UNKNOWN');
            if (status === 'RUNNING' || status === 'READY') {
                throw new Error(`${actorId} was still ${status} after ${WAIT_SECS}s`);
            }
            const items = await readItems(run.defaultDatasetId);
            if (status !== 'SUCCEEDED' && !items.length) throw new Error(`${actorId} finished with status ${status}`);
            if (status !== 'SUCCEEDED')
                log.warning(`Digest: ${actorId} status ${status} with ${items.length} dataset row(s)`);
            else log.info(`Digest: ${actorId} returned ${items.length} row(s)`);
            return { items, runId: run.id ?? null, status };
        },
    };
}
