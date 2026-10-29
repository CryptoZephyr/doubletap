import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { doubletap } from '../src/index.js';
import {
  client,
  databaseId,
  deleteTableIfPresent,
  testTableId,
} from './helpers.js';

const tableId = testTableId('t_prune');
const lock = doubletap({ tablesDB: client, databaseId, tableId, namespace: 'prune-test' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('prune()', () => {
  beforeAll(async () => {
    await lock.setup();
  });

  afterAll(async () => {
    await deleteTableIfPresent(tableId);
  });

  test('prunes finished chains and keeps live and recent keys', async () => {
    await lock.once('finished-key', async () => ({ value: 'finished' }));
    const released = await lock.lease('released-lease', { ttlMs: 60_000 });
    expect(released).not.toBeNull();
    expect(await released?.release()).toBe(true);
    const live = await lock.lease('live-lease', { ttlMs: 60_000 });
    expect(live).not.toBeNull();

    await sleep(2000);
    await lock.once('recent-key', async () => ({ value: 'recent' }));

    const result = await lock.prune({ olderThanMs: 1500 });
    expect(result).toEqual({ keys: 2, rows: 4 });

    const retried = await lock.once('finished-key', async () => ({ value: 'retried' }));
    expect(retried).toEqual({ value: { value: 'retried' }, replayed: false });
    expect(await lock.once('recent-key', async () => ({ value: 'unexpected' })))
      .toEqual({ value: { value: 'recent' }, replayed: true });
    expect(await lock.lease('live-lease')).toBeNull();

    const reacquired = await lock.lease('released-lease');
    expect(reacquired).not.toBeNull();
    await reacquired?.release();
  }, 120_000);

  test('rejects a non-positive or non-finite olderThanMs', async () => {
    await expect(lock.prune({ olderThanMs: 0 }))
      .rejects.toThrow('olderThanMs must be a positive finite number');
    await expect(lock.prune({ olderThanMs: Number.POSITIVE_INFINITY }))
      .rejects.toThrow('olderThanMs must be a positive finite number');
  });
});
