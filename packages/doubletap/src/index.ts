import { createHash, randomUUID } from 'node:crypto';
import { Query, TablesDB, TablesDBIndexType } from 'node-appwrite';

type State = 'pending' | 'done' | 'held' | 'released';

interface StateRow {
  $id: string;
  k: string;
  gen: number;
  state: State;
  holder: string;
  expiresAt: number;
  result: string;
}

interface OnceContext {
  key: string;
  idempotencyKey: string;
  token: number;
}

interface OnceOptions {
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
}

interface LeaseOptions {
  ttlMs?: number;
}

interface DoubletapOptions {
  tablesDB: TablesDB;
  databaseId: string;
  tableId?: string;
  namespace?: string;
  holderId?: string;
}

export interface Lease {
  name: string;
  token: number;
  holder: string;
  expiresAt: number;
  renew(): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface Doubletap {
  setup(): Promise<void>;
  once<T>(
    key: string,
    fn: (ctx: OnceContext) => Promise<T>,
    options?: OnceOptions,
  ): Promise<{ value: T; replayed: boolean; superseded?: boolean }>;
  lease(name: string, options?: LeaseOptions): Promise<Lease | null>;
}

export class DoubletapTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for another doubletap claim to finish');
    this.name = 'DoubletapTimeoutError';
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const readyTimeoutMs = 120_000;
const doneExpiry = Number.MAX_SAFE_INTEGER;

function isConflict(error: unknown): boolean {
  const value = error as { code?: number; type?: string };
  return value?.code === 409 && value?.type === 'row_already_exists';
}

function isAlreadyExists(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 409;
}

function isNotFound(error: unknown): boolean {
  return (error as { code?: number } | null)?.code === 404;
}

function keyHash(namespace: string, key: string): string {
  return `d${createHash('sha256').update(`${namespace}:${key}`).digest('hex').slice(0, 24)}`;
}

/**
 * Expiries use client clocks, so clock skew matters. State rows aren't pruned.
 * A stalled callback can finish its side effect after takeover, so pass
 * `ctx.idempotencyKey` to external providers. Results must serialize to JSON
 * within 8192 characters, which can only be checked after the callback runs.
 */
export function doubletap(options: DoubletapOptions): Doubletap {
  const {
    tablesDB,
    databaseId,
    tableId = 'doubletap',
    namespace = 'default',
    holderId = randomUUID(),
  } = options;

  if (holderId.length > 64) {
    throw new Error('holderId must be 64 characters or fewer');
  }

  async function createIfMissing(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }

  async function waitUntilAvailable(
    label: string,
    read: () => Promise<unknown>,
  ): Promise<void> {
    const deadline = Date.now() + readyTimeoutMs;
    while (true) {
      const resource = await read() as { status?: string; error?: string | null };
      if (resource.status === undefined || resource.status === 'available') return;
      if (resource.status === 'failed') {
        throw new Error(`${label} failed: ${resource.error ?? 'unknown Appwrite error'}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for ${label} to become available`);
      }
      await sleep(500);
    }
  }

  async function latest(hash: string): Promise<StateRow | undefined> {
    const result = await tablesDB.listRows({
      databaseId,
      tableId,
      queries: [Query.equal('k', hash), Query.orderDesc('gen'), Query.limit(1)],
    });
    return result.rows[0] as unknown as StateRow | undefined;
  }

  async function tryCreate(row: StateRow): Promise<boolean> {
    try {
      await tablesDB.createRow({
        databaseId,
        tableId,
        rowId: row.$id,
        data: {
          k: row.k,
          gen: row.gen,
          state: row.state,
          holder: row.holder,
          expiresAt: row.expiresAt,
          result: row.result,
        },
      });
      return true;
    } catch (error) {
      if (isConflict(error)) return false;
      throw error;
    }
  }

  function stateRow(
    hash: string,
    gen: number,
    state: State,
    holder: string,
    expiresAt: number,
    result = '',
  ): StateRow {
    const id = `${hash}-g${gen}`;
    if (id.length > 36) {
      throw new Error('Generation exceeds Appwrite row ID length limit');
    }
    return { $id: id, k: hash, gen, state, holder, expiresAt, result };
  }

  async function waitForSupersedingResult<T>(
    hash: string,
    deadline: number,
    pollMs: number,
  ): Promise<{ value: T; replayed: true; superseded: true }> {
    while (Date.now() < deadline) {
      const current = await latest(hash);
      if (current?.state === 'done') {
        return {
          value: JSON.parse(current.result) as T,
          replayed: true,
          superseded: true,
        };
      }
      if (current?.state === 'held') {
        throw new Error(`Key "${hash}" is in lease mode, not once mode`);
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    }
    throw new DoubletapTimeoutError();
  }

  async function runClaim<T>(
    key: string,
    hash: string,
    gen: number,
    fn: (ctx: OnceContext) => Promise<T>,
    ttlMs: number,
    waitMs: number,
    pollMs: number,
  ): Promise<{ value: T; replayed: boolean; superseded?: boolean }> {
    let value: T;
    try {
      value = await fn({ key, idempotencyKey: hash, token: gen });
    } catch (error) {
      try {
        await tryCreate(stateRow(hash, gen + 1, 'pending', holderId, 0));
      } catch {
        // Preserve the callback error. The claim still expires after its TTL.
      }
      throw error;
    }

    let result: string | undefined;
    try {
      result = JSON.stringify(value);
    } catch (error) {
      throw new Error('once() result must be JSON-serializable', { cause: error });
    }
    if (result === undefined) {
      throw new Error('once() result must be JSON-serializable');
    }
    if (result.length > 8192) {
      throw new Error('once() result must serialize to 8192 characters or fewer');
    }

    try {
      await tablesDB.createRow({
        databaseId,
        tableId,
        rowId: `${hash}-g${gen + 1}`,
        data: {
          k: hash,
          gen: gen + 1,
          state: 'done',
          holder: holderId,
          expiresAt: doneExpiry,
          result,
        },
      });
      return { value, replayed: false };
    } catch (error) {
      if (!isConflict(error)) throw error;
      return waitForSupersedingResult<T>(hash, Date.now() + waitMs, pollMs);
    }
  }

  return {
    async setup(): Promise<void> {
      async function ensureResource(
        label: string,
        read: () => Promise<unknown>,
        create: () => Promise<unknown>,
      ): Promise<void> {
        try {
          await read();
        } catch (error) {
          if (!isNotFound(error)) throw error;
          await createIfMissing(create);
        }
        await waitUntilAvailable(label, read);
      }

      const columns = [
        {
          key: 'k',
          create: () => tablesDB.createStringColumn({
            databaseId, tableId, key: 'k', size: 32, required: false,
          }),
        },
        {
          key: 'gen',
          create: () => tablesDB.createIntegerColumn({
            databaseId, tableId, key: 'gen', required: false,
          }),
        },
        {
          key: 'state',
          create: () => tablesDB.createStringColumn({
            databaseId, tableId, key: 'state', size: 16, required: false,
          }),
        },
        {
          key: 'holder',
          create: () => tablesDB.createStringColumn({
            databaseId, tableId, key: 'holder', size: 64, required: false,
          }),
        },
        {
          key: 'expiresAt',
          create: () => tablesDB.createIntegerColumn({
            databaseId, tableId, key: 'expiresAt', required: false,
          }),
        },
        {
          key: 'result',
          create: () => tablesDB.createStringColumn({
            databaseId, tableId, key: 'result', size: 8192, required: false,
          }),
        },
      ];
      await ensureResource(
        `table "${tableId}"`,
        () => tablesDB.getTable({ databaseId, tableId }),
        () => tablesDB.createTable({ databaseId, tableId, name: tableId }),
      );

      for (const column of columns) {
        await ensureResource(
          `column "${column.key}"`,
          () => tablesDB.getColumn({ databaseId, tableId, key: column.key }),
          column.create,
        );
      }

      await ensureResource(
        'index "k_gen"',
        () => tablesDB.getIndex({ databaseId, tableId, key: 'k_gen' }),
        () => tablesDB.createIndex({
          databaseId,
          tableId,
          key: 'k_gen',
          type: TablesDBIndexType.Key,
          columns: ['k', 'gen'],
        }),
      );
    },

    async once<T>(
      key: string,
      fn: (ctx: OnceContext) => Promise<T>,
      options: OnceOptions = {},
    ) {
      const ttlMs = options.ttlMs ?? 30_000;
      const waitMs = options.waitMs ?? 20_000;
      const pollMs = options.pollMs ?? 150;
      const hash = keyHash(namespace, key);
      const deadline = Date.now() + waitMs;

      while (true) {
        const current = await latest(hash);
        if (!current) {
          const gen = 1;
          if (!(await tryCreate(stateRow(hash, gen, 'pending', holderId, Date.now() + ttlMs)))) {
            continue;
          }
          return runClaim(key, hash, gen, fn, ttlMs, waitMs, pollMs);
        }
        if (current.state === 'done') {
          return { value: JSON.parse(current.result) as T, replayed: true };
        }
        if (current.state !== 'pending') {
          throw new Error(`Key "${key}" is in ${current.state} mode, not once mode`);
        }
        if (current.expiresAt > Date.now()) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new DoubletapTimeoutError();
          await sleep(Math.min(pollMs, remaining));
          continue;
        }

        const gen = current.gen + 1;
        if (!(await tryCreate(stateRow(hash, gen, 'pending', holderId, Date.now() + ttlMs)))) {
          continue;
        }
        return runClaim(key, hash, gen, fn, ttlMs, waitMs, pollMs);
      }
    },

    async lease(name, options = {}) {
      const ttlMs = options.ttlMs ?? 30_000;
      const hash = keyHash(namespace, name);
      const current = await latest(hash);

      if (current) {
        if (current.state === 'held' && current.expiresAt > Date.now()) return null;
        if (current.state !== 'released' &&
            !(current.state === 'held' && current.expiresAt <= Date.now())) {
          throw new Error(`Key "${name}" is in ${current.state} mode, not lease mode`);
        }
      }

      const token = (current?.gen ?? 0) + 1;
      const expiresAt = Date.now() + ttlMs;
      if (!(await tryCreate(stateRow(hash, token, 'held', holderId, expiresAt)))) return null;

      let active = true;
      let leaseToken = token;
      let leaseExpiresAt = expiresAt;
      return {
        name,
        get token() {
          return leaseToken;
        },
        holder: holderId,
        get expiresAt() {
          return leaseExpiresAt;
        },
        async renew() {
          if (!active) return false;
          const nextToken = leaseToken + 1;
          const nextExpiry = Date.now() + ttlMs;
          const renewed = await tryCreate(
            stateRow(hash, nextToken, 'held', holderId, nextExpiry),
          );
          if (!renewed) {
            active = false;
            return false;
          }
          leaseToken = nextToken;
          leaseExpiresAt = nextExpiry;
          return true;
        },
        async release() {
          if (!active) return false;
          const nextToken = leaseToken + 1;
          const released = await tryCreate(
            stateRow(hash, nextToken, 'released', holderId, Date.now()),
          );
          if (!released) {
            active = false;
            return false;
          }
          active = false;
          leaseToken = nextToken;
          return true;
        },
      };
    },
  };
}
