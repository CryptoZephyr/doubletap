import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { doubletap, idempotent, requestKey } from '../src/index.js';
import type { AppwriteRequest, AppwriteResponse } from '../src/index.js';
import {
  client,
  databaseId,
  deleteTableIfPresent,
  testTableId,
} from './helpers.js';

interface ResponseCall {
  kind: 'text' | 'json' | 'empty' | 'redirect' | 'binary';
  args: unknown[];
}

function makeContext(headers: Record<string, string> = {}) {
  const calls: ResponseCall[] = [];
  const res: AppwriteResponse = {
    text(...args) {
      calls.push({ kind: 'text', args });
      return { kind: 'text' };
    },
    json(...args) {
      calls.push({ kind: 'json', args });
      return { kind: 'json' };
    },
    empty(...args) {
      calls.push({ kind: 'empty', args });
      return { kind: 'empty' };
    },
    redirect(...args) {
      calls.push({ kind: 'redirect', args });
      return { kind: 'redirect' };
    },
    binary(...args) {
      calls.push({ kind: 'binary', args });
      return { kind: 'binary' };
    },
  };
  return {
    context: { req: { headers } as AppwriteRequest, res },
    calls,
  };
}

const tableId = testTableId('t_function');
const options = { tablesDB: client, databaseId, tableId, namespace: 'function-test' };

describe('requestKey()', () => {
  test('uses a user-scoped HTTP idempotency header', () => {
    expect(requestKey({
      headers: {
        'X-Idempotency-Key': 'order-1',
        'X-Appwrite-User-Id': 'user-1',
      },
    })).toBe('http:user-1:order-1');
    expect(requestKey({
      headers: { 'X-Idempotency-Key': 'order-1' },
    })).toBe('http:guest:order-1');
  });

  test('supports a custom header', () => {
    expect(requestKey({
      headers: { 'X-Request-Key': 'custom-1' },
    }, { header: 'x-request-key' })).toBe('http:guest:custom-1');
  });

  test('derives event keys from bodyJson and bodyText', () => {
    const headers = {
      'x-appwrite-trigger': 'event',
      'x-appwrite-event': 'tablesdb.doubletap.rows.update',
    };
    expect(requestKey({
      headers,
      bodyJson: { $id: 'row-1', $updatedAt: '2026-10-29T12:00:00.000Z' },
    })).toBe('event:tablesdb.doubletap.rows.update:row-1:2026-10-29T12:00:00.000Z');
    expect(requestKey({
      headers,
      bodyText: JSON.stringify({
        $id: 'row-2',
        $updatedAt: '2026-10-29T12:01:00.000Z',
      }),
    })).toBe('event:tablesdb.doubletap.rows.update:row-2:2026-10-29T12:01:00.000Z');
  });

  test('returns null when an event row is missing its update timestamp', () => {
    expect(requestKey({
      headers: {
        'x-appwrite-trigger': 'event',
        'x-appwrite-event': 'tablesdb.doubletap.rows.update',
      },
      bodyJson: { $id: 'row-1' },
    })).toBeNull();
  });

  test('returns null without a usable request key and rejects long headers', () => {
    expect(requestKey({ headers: {} })).toBeNull();
    expect(() => requestKey({
      headers: { 'x-idempotency-key': 'k'.repeat(257) },
    })).toThrow('Idempotency header must be 256 characters or fewer');
  });
});

describe('idempotent()', () => {
  beforeAll(async () => {
    await doubletap({ tablesDB: client, databaseId, tableId, namespace: 'function-test' }).setup();
  });

  afterAll(async () => {
    await deleteTableIfPresent(tableId);
  });

  test('runs one handler for 50 concurrent calls and replays its JSON response', async () => {
    let handlers = 0;
    const wrapped = idempotent(async ({ res, idempotencyKey }) => {
      handlers += 1;
      expect(idempotencyKey).toBeTruthy();
      return res.json({ chargeId: 'charge-stable' }, 201, { 'x-original': 'kept' });
    }, options);

    const calls = await Promise.all(Array.from({ length: 50 }, async () => {
      const ctx = makeContext({
        'x-idempotency-key': 'shared-order',
        'x-appwrite-user-id': 'same-user',
      });
      await wrapped(ctx.context);
      return ctx.calls[0];
    }));

    expect(handlers).toBe(1);
    expect(calls).toHaveLength(50);
    expect(calls.every((call) => call.kind === 'json')).toBe(true);
    expect(new Set(calls.map((call) => JSON.stringify(call.args.slice(0, 2)))).size).toBe(1);
    expect(calls.filter((call) =>
      (call.args[2] as Record<string, string>)['x-doubletap'] === 'first',
    )).toHaveLength(1);
    expect(calls.filter((call) =>
      (call.args[2] as Record<string, string>)['x-doubletap'] === 'replayed',
    )).toHaveLength(49);
    expect((calls[0]?.args[2] as Record<string, string>)['x-original']).toBe('kept');
  }, 120_000);

  test('scopes the same header value to different user IDs', async () => {
    let handlers = 0;
    const wrapped = idempotent(async ({ res }) => {
      handlers += 1;
      return res.json({ call: handlers });
    }, options);

    await Promise.all(['user-a', 'user-a', 'user-b', 'user-b'].map(async (userId) => {
      const ctx = makeContext({
        'x-idempotency-key': 'same-value',
        'x-appwrite-user-id': userId,
      });
      await wrapped(ctx.context);
    }));

    expect(handlers).toBe(2);
  }, 120_000);

  test('passes through and runs every time when there is no key', async () => {
    let handlers = 0;
    const wrapped = idempotent(async ({ res, idempotencyKey }) => {
      handlers += 1;
      expect(idempotencyKey).toBeNull();
      return res.json({ call: handlers });
    }, options);

    for (let index = 0; index < 3; index += 1) {
      const ctx = makeContext();
      await wrapped(ctx.context);
      expect(ctx.calls[0]?.kind).toBe('json');
    }
    expect(handlers).toBe(3);
  });

  test('replays text, empty, and redirect responses', async () => {
    const cases: Array<{
      key: string;
      kind: ResponseCall['kind'];
      respond: (res: AppwriteResponse) => unknown;
    }> = [
      {
        key: 'text-response',
        kind: 'text',
        respond: (res) => res.text('done', 202, { 'x-original': 'text' }),
      },
      {
        key: 'empty-response',
        kind: 'empty',
        respond: (res) => res.empty(),
      },
      {
        key: 'redirect-response',
        kind: 'redirect',
        respond: (res) => res.redirect('https://example.test/finished', 303),
      },
    ];

    for (const response of cases) {
      let handlers = 0;
      const wrapped = idempotent(async ({ res }) => {
        handlers += 1;
        return response.respond(res);
      }, options);
      const first = makeContext({ 'x-idempotency-key': response.key });
      const replay = makeContext({ 'x-idempotency-key': response.key });
      await wrapped(first.context);
      await wrapped(replay.context);

      expect(handlers).toBe(1);
      expect(first.calls[0]?.kind).toBe(response.kind);
      expect(replay.calls[0]?.kind).toBe(response.kind);
      expect((first.calls[0]?.args.at(-1) as Record<string, string>)['x-doubletap'])
        .toBe('first');
      expect((replay.calls[0]?.args.at(-1) as Record<string, string>)['x-doubletap'])
        .toBe('replayed');
    }
  }, 120_000);

  test('rejects binary responses and releases the claim for retry', async () => {
    let handlers = 0;
    const wrapped = idempotent(async ({ res }) => {
      handlers += 1;
      if (handlers === 1) return res.binary(new Uint8Array([1, 2, 3]));
      return res.json({ retried: true });
    }, options);
    const request = { 'x-idempotency-key': 'binary-response' };

    await expect(wrapped(makeContext(request).context))
      .rejects.toThrow('idempotent() cannot replay binary responses');
    const retry = makeContext(request);
    await wrapped(retry.context);

    expect(handlers).toBe(2);
    expect(retry.calls[0]?.kind).toBe('json');
    expect((retry.calls[0]?.args[2] as Record<string, string>)['x-doubletap']).toBe('first');
  }, 120_000);
});
