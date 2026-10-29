import { createHash, randomUUID } from 'node:crypto';
import { Query } from 'node-appwrite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { doubletap } from '../src/index.js';
import {
  client,
  counterValue,
  createCounterRow,
  createCounterTable,
  databaseId,
  deleteTableIfPresent,
  incrementCounter,
  testTableId,
} from './helpers.js';

const tableId = testTableId('t_once');
const counterTableId = testTableId('c_once');
const lock = doubletap({ tablesDB: client, databaseId, tableId });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function counterRow(rowId: string): Promise<void> {
  await createCounterRow(counterTableId, rowId);
}

describe('once()', () => {
  beforeAll(async () => {
    await lock.setup();
    await createCounterTable(counterTableId);
  });

  afterAll(async () => {
    await Promise.all([
      deleteTableIfPresent(tableId),
      deleteTableIfPresent(counterTableId),
    ]);
  });

  test('runs one callback for 100 concurrent calls and replays the result', async () => {
    const rowId = 'once_100';
    await counterRow(rowId);
    let callbacks = 0;
    const calls = await Promise.all(Array.from({ length: 100 }, () =>
      lock.once('concurrent', async () => {
        callbacks += 1;
        await incrementCounter(counterTableId, rowId);
        return { receipt: 'receipt-stable' };
      }),
    ));

    expect(await counterValue(counterTableId, rowId)).toBe(1);
    expect(new Set(calls.map((call) => JSON.stringify(call.value))).size).toBe(1);
    expect(calls.filter((call) => call.replayed)).toHaveLength(99);
    expect(callbacks).toBe(1);

    const late = await lock.once('concurrent', async () => {
      callbacks += 1;
      await incrementCounter(counterTableId, rowId);
      return { receipt: 'unexpected' };
    });
    expect(late).toEqual({ value: { receipt: 'receipt-stable' }, replayed: true });
    expect(await counterValue(counterTableId, rowId)).toBe(1);
    console.log('once 100-way: counter=1 values=1 replayed=99 late=stable');
  }, 120_000);

  test('takes over a crashed callback and runs one replacement', async () => {
    const rowId = 'once_crash';
    await counterRow(rowId);
    let started!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    void lock.once('crashed', async () => {
      started();
      return new Promise<string>(() => {});
    }, { ttlMs: 3000 });
    await claimStarted;

    const calls = await Promise.all(Array.from({ length: 100 }, () =>
      lock.once('crashed', async () => {
        await incrementCounter(counterTableId, rowId);
        return 'recovered-receipt';
      }, { ttlMs: 3000 }),
    ));

    expect(await counterValue(counterTableId, rowId)).toBe(1);
    expect(new Set(calls.map((call) => call.value)).size).toBe(1);
    console.log('once crash recovery: counter=1 values=1');
  }, 120_000);

  test('returns the takeover result when a stalled callback finishes late', async () => {
    const rowId = 'once_stall';
    await counterRow(rowId);
    let started!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = lock.once('stalled', async () => {
      started();
      await sleep(5000);
      await incrementCounter(counterTableId, rowId);
      return 'late-receipt';
    }, { ttlMs: 3000, waitMs: 20_000 });
    await claimStarted;

    const replacements = await Promise.all(Array.from({ length: 100 }, () =>
      lock.once('stalled', async () => {
        await incrementCounter(counterTableId, rowId);
        return 'canonical-receipt';
      }, { ttlMs: 3000, waitMs: 20_000 }),
    ));
    const late = await slow;

    expect(await counterValue(counterTableId, rowId)).toBe(2);
    expect(new Set([...replacements, late].map((call) => call.value)).size).toBe(1);
    expect(late.superseded).toBe(true);
    console.log('once stall: counter=2 values=1 lateSuperseded=true');
  }, 120_000);

  test('releases a failed callback for immediate retry', async () => {
    const rowId = 'once_throw';
    await counterRow(rowId);
    const start = Date.now();
    await expect(lock.once('throws-once', async () => {
      throw new Error('planned callback failure');
    }, { ttlMs: 30_000 })).rejects.toThrow('planned callback failure');

    const recovered = await lock.once('throws-once', async () => {
      await incrementCounter(counterTableId, rowId);
      return 'recovered';
    }, { ttlMs: 30_000 });

    expect(recovered).toEqual({ value: 'recovered', replayed: false });
    expect(await counterValue(counterTableId, rowId)).toBe(1);
    expect(Date.now() - start).toBeLessThan(3000);
    console.log('once throw retry: counter=1 retriedImmediately=true');
  }, 120_000);

  test('shows why check-then-create with random row IDs is unsafe', async () => {
    const rowId = 'once_naive';
    await counterRow(rowId);
    const key = 'naive-contrast';
    const hash = `d${createHash('sha256').update(`default:${key}`).digest('hex').slice(0, 24)}`;
    let reads = 0;
    let releaseReads!: () => void;
    const allRead = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });

    await Promise.all(Array.from({ length: 100 }, async () => {
      const rows = await client.listRows({
        databaseId,
        tableId,
        queries: [Query.equal('k', hash), Query.limit(1)],
      });
      expect(rows.rows).toHaveLength(0);
      reads += 1;
      if (reads === 100) releaseReads();
      await allRead;

      await incrementCounter(counterTableId, rowId);
      await client.createRow({
        databaseId,
        tableId,
        rowId: randomUUID().replaceAll('-', ''),
        data: {
          k: hash,
          gen: 1,
          state: 'done',
          holder: 'naive-worker',
          expiresAt: Date.now(),
          result: '"naive"',
        },
      });
    }));

    const count = await counterValue(counterTableId, rowId);
    expect(count).toBeGreaterThanOrEqual(1);
    console.log(`naive contrast: counter=${count} (one or more is expected)`);
  }, 120_000);
});
