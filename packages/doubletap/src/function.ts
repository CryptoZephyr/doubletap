import { Client, TablesDB } from 'node-appwrite';
import { DoubletapTimeoutError, doubletap } from './index.js';

export interface AppwriteRequest {
  headers: Record<string, string>;
  bodyJson?: unknown;
  bodyText?: string;
  [key: string]: unknown;
}

export interface AppwriteResponse {
  text(...args: any[]): unknown;
  json(...args: any[]): unknown;
  empty(...args: any[]): unknown;
  redirect(...args: any[]): unknown;
  binary(...args: any[]): unknown;
}

export interface IdempotentOptions {
  databaseId: string;
  tableId?: string;
  namespace?: string;
  header?: string;
  key?: (req: AppwriteRequest) => string | null;
  ttlMs?: number;
  waitMs?: number;
  tablesDB?: TablesDB;
}

type FunctionContext = {
  req: AppwriteRequest;
  res: AppwriteResponse;
};

type RecordedResponse =
  | {
      kind: 'text' | 'json' | 'redirect';
      body: unknown;
      status?: number;
      headers?: Record<string, string>;
    }
  | {
      kind: 'empty';
      status?: number;
      headers?: Record<string, string>;
    };

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

function eventBody(req: AppwriteRequest): Record<string, unknown> {
  let body = req.bodyJson;
  if (body === undefined && req.bodyText !== undefined) {
    try {
      body = JSON.parse(req.bodyText) as unknown;
    } catch {
      body = undefined;
    }
  }
  return body !== null && typeof body === 'object'
    ? body as Record<string, unknown>
    : {};
}

/**
 * Callers without x-appwrite-user-id share the guest scope. Guest idempotency
 * keys must be unguessable random IDs, and guest responses should not contain
 * private data.
 */
export function requestKey(
  req: AppwriteRequest,
  options: { header?: string } = {},
): string | null {
  const header = options.header ?? 'x-idempotency-key';
  const value = getHeader(req.headers, header);
  if (value !== undefined && value.length > 0) {
    if (value.length > 256) {
      throw new Error('Idempotency header must be 256 characters or fewer');
    }
    const userId = getHeader(req.headers, 'x-appwrite-user-id') || 'guest';
    return `http:${userId}:${value}`;
  }

  if (getHeader(req.headers, 'x-appwrite-trigger') !== 'event') return null;
  const event = getHeader(req.headers, 'x-appwrite-event');
  if (!event) return null;
  const body = eventBody(req);
  if (
    typeof body.$id !== 'string' ||
    body.$id.length === 0 ||
    typeof body.$updatedAt !== 'string' ||
    body.$updatedAt.length === 0
  ) return null;
  return `event:${event}:${body.$id}:${body.$updatedAt}`;
}

function createTablesDB(req: AppwriteRequest): TablesDB {
  const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID;
  const key = getHeader(req.headers, 'x-appwrite-key');
  if (!endpoint || !projectId || !key) {
    throw new Error(
      'idempotent() requires APPWRITE_FUNCTION_API_ENDPOINT, APPWRITE_FUNCTION_PROJECT_ID, and x-appwrite-key',
    );
  }
  const client = new Client().setEndpoint(endpoint).setProject(projectId).setKey(key);
  return new TablesDB(client);
}

function responseHeaders(
  headers: Record<string, string> | undefined,
  marker: 'first' | 'replayed',
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== 'x-doubletap') result[name] = value;
  }
  result['x-doubletap'] = marker;
  return result;
}

function sendResponse(
  res: AppwriteResponse,
  response: RecordedResponse,
  marker: 'first' | 'replayed',
): unknown {
  const headers = responseHeaders(response.headers, marker);
  switch (response.kind) {
    case 'text':
      return res.text(response.body, response.status, headers);
    case 'json':
      return res.json(response.body, response.status, headers);
    case 'empty':
      return res.empty(response.status, headers);
    case 'redirect':
      return res.redirect(response.body, response.status, headers);
  }
}

export function idempotent<C extends FunctionContext>(
  handler: (context: C & { idempotencyKey: string | null }) => Promise<unknown>,
  options: IdempotentOptions,
): (context: C) => Promise<unknown> {
  const {
    databaseId,
    tableId = 'doubletap',
    namespace = 'function',
    header = 'x-idempotency-key',
  } = options;

  return async (context: C): Promise<unknown> => {
    const key = options.key
      ? options.key(context.req)
      : requestKey(context.req, { header });
    if (key === null) {
      return handler({ ...context, idempotencyKey: null });
    }

    const tablesDB = options.tablesDB ?? createTablesDB(context.req);
    const dt = doubletap({ tablesDB, databaseId, tableId, namespace });
    try {
      const result = await dt.once(key, async (onceContext) => {
        let recorded: RecordedResponse | undefined;
        const responseMarker = Symbol('idempotent response');
        const recorder: AppwriteResponse = {
          text(body, status, headers) {
            recorded = { kind: 'text', body, status, headers };
            return responseMarker;
          },
          json(body, status, headers) {
            recorded = { kind: 'json', body, status, headers };
            return responseMarker;
          },
          empty(status, headers) {
            recorded = { kind: 'empty', status, headers };
            return responseMarker;
          },
          redirect(url, status, headers) {
            recorded = { kind: 'redirect', body: url, status, headers };
            return responseMarker;
          },
          binary() {
            throw new Error('idempotent() cannot replay binary responses');
          },
        };
        await handler({
          ...context,
          res: recorder,
          idempotencyKey: onceContext.idempotencyKey,
        });
        if (!recorded) {
          throw new Error(
            'The idempotent handler must return a response using res.text(), res.json(), res.empty(), or res.redirect()',
          );
        }
        return recorded;
      }, {
        ttlMs: options.ttlMs,
        waitMs: options.waitMs,
      });
      return sendResponse(context.res, result.value, result.replayed ? 'replayed' : 'first');
    } catch (error) {
      if (error instanceof DoubletapTimeoutError) {
        return context.res.json(
          { error: 'A request with this idempotency key is still in progress' },
          409,
          { 'x-doubletap': 'in-progress' },
        );
      }
      throw error;
    }
  };
}
