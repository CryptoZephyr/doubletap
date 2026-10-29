import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { doubletap } from '../src/index.js';
import {
  client,
  databaseId,
  deleteTableIfPresent,
  testTableId,
} from './helpers.js';

const tableId = testTableId('t_lease');
const lock = doubletap({ tablesDB: client, databaseId, tableId, holderId: 'worker-a' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('lease()', () => {
  beforeAll(async () => {
    await lock.setup();
  });

  afterAll(async () => {
    await deleteTableIfPresent(tableId);
  });

  test('allows one worker to take an expired lease in a 100-way race', async () => {
    const expired = await lock.lease('expired-race', { ttlMs: 1 });
    expect(expired).not.toBeNull();
    await sleep(50);

    const leases = await Promise.all(Array.from({ length: 100 }, () =>
      lock.lease('expired-race'),
    ));
    expect(leases.filter(Boolean)).toHaveLength(1);
    console.log('lease expired race: winners=1 of 100');
  }, 120_000);

  test('refuses a live lease, then allows one after release with token plus two', async () => {
    const held = await lock.lease('live-race', { ttlMs: 30_000 });
    expect(held).not.toBeNull();
    if (!held) throw new Error('Expected initial lease');
    const originalToken = held.token;

    const contenders = await Promise.all(Array.from({ length: 100 }, () =>
      lock.lease('live-race'),
    ));
    expect(contenders.every((lease) => lease === null)).toBe(true);
    expect(await held.release()).toBe(true);

    const afterRelease = await lock.lease('live-race');
    expect(afterRelease).not.toBeNull();
    expect(afterRelease?.token).toBe(originalToken + 2);
    console.log('lease live and release: winners=0 while live, nextToken=original+2');
  }, 120_000);

  test('refuses renewal after another worker takes over', async () => {
    const leaseA = await lock.lease('renew-takeover', { ttlMs: 1000 });
    expect(leaseA).not.toBeNull();
    if (!leaseA) throw new Error('Expected worker A lease');

    await sleep(1500);
    const workerB = doubletap({
      tablesDB: client,
      databaseId,
      tableId,
      holderId: 'worker-b',
    });
    const leaseB = await workerB.lease('renew-takeover', { ttlMs: 30_000 });
    expect(leaseB).not.toBeNull();
    expect(await leaseA.renew()).toBe(false);
    console.log('lease takeover fencing: staleRenew=false');
  }, 120_000);
});
