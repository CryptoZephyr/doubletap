#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, ExecutionMethod, Functions, Query, TablesDB } from 'node-appwrite';

export interface ProveOptions {
  functionId: string;
  count: number;
  body: Record<string, unknown>;
  table: string;
  whereField: string;
  whereValue: string;
  database: string;
  expect: number;
  headers: Record<string, string>;
}

export function parseProveArgs(argv: string[]): ProveOptions {
  if (argv[0] !== 'prove') throw new Error('Expected the prove command');
  const values = new Map<string, string>();
  const headers = new Map<string, string>();

  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option?.startsWith('--')) throw new Error(`Unexpected argument: ${option}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${option}`);
    if (![
      '--function',
      '--count',
      '--body',
      '--table',
      '--where',
      '--database',
      '--expect',
      '--header',
    ].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    if (option === '--header') {
      const separator = value.indexOf('=');
      if (separator < 1) throw new Error('--header must use name=value syntax');
      const name = value.slice(0, separator);
      if (!/^[a-z0-9-]+$/i.test(name)) {
        throw new Error('--header name must contain only letters, numbers, and hyphens');
      }
      if (name.toLowerCase().startsWith('x-appwrite-')) {
        throw new Error('--header cannot set x-appwrite-* headers');
      }
      headers.set(name, value.slice(separator + 1));
    } else {
      values.set(option, value);
    }
    index += 1;
  }

  const functionId = required(values, '--function');
  const table = required(values, '--table');
  const where = required(values, '--where');
  if (!/^[A-Za-z0-9._-]{1,36}$/.test(functionId)) {
    throw new Error('--function must be a safe Appwrite ID');
  }
  if (!/^[A-Za-z0-9._-]{1,36}$/.test(table)) {
    throw new Error('--table must be a safe Appwrite ID');
  }

  const count = parseInteger(values.get('--count') ?? '100', '--count', 1, 500);
  const expect = parseInteger(values.get('--expect') ?? '1', '--expect', 0, Number.MAX_SAFE_INTEGER);
  const whereIndex = where.indexOf('=');
  if (whereIndex < 1) throw new Error('--where must use field=value syntax');
  const whereField = where.slice(0, whereIndex);
  const whereValue = where.slice(whereIndex + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(whereField) || !whereValue) {
    throw new Error('--where must include a valid field and value');
  }

  const bodyValue = required(values, '--body');
  let body: unknown;
  try {
    body = JSON.parse(bodyValue);
  } catch {
    throw new Error('--body must be valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('--body must be a JSON object');
  }

  return {
    functionId,
    count,
    body: body as Record<string, unknown>,
    table,
    whereField,
    whereValue,
    database: values.get('--database') ?? 'doubletap',
    expect,
    headers: Object.fromEntries(headers),
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing required option ${key}`);
  return value;
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return number;
}

export function templateValue(value: unknown, runId: string, requestId: string): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('$RUN', runId).replaceAll('$REQ', requestId);
  }
  if (Array.isArray(value)) return value.map((item) => templateValue(item, runId, requestId));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll('$RUN', runId).replaceAll('$REQ', requestId),
        templateValue(item, runId, requestId),
      ]),
    );
  }
  return value;
}

export function templateWhere(
  field: string,
  value: string,
  runId: string,
): { field: string; value: string } {
  return { field, value: value.replaceAll('$RUN', runId) };
}

export function templateHeaders(
  headers: Record<string, string>,
  runId: string,
  requestId: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      value.replaceAll('$RUN', runId).replaceAll('$REQ', requestId),
    ]),
  );
}

function randomId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function counts(values: string[]): string {
  if (values.length === 0) return 'none';
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
  return [...result].map(([key, count]) => `${key}=${count}`).join(', ');
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown; type?: unknown };
  if (typeof value?.type === 'string' && value.type) return value.type;
  if (value?.code !== undefined) return String(value.code);
  return 'unknown';
}

function executionFailureCode(execution: {
  status: string;
  responseStatusCode: number;
  responseBody: string;
}): string | undefined {
  if (execution.responseStatusCode === 429) return '429';
  if (execution.responseStatusCode >= 400) {
    try {
      const body = JSON.parse(execution.responseBody) as { type?: unknown; code?: unknown };
      if (typeof body.type === 'string') return body.type;
      if (body.code !== undefined) return String(body.code);
    } catch {
      return `http_${execution.responseStatusCode}`;
    }
    return `http_${execution.responseStatusCode}`;
  }
  if (execution.status === 'failed') return 'execution_failed';
  return undefined;
}

async function runProve(options: ProveOptions): Promise<number> {
  const missing = ['APPWRITE_ENDPOINT', 'APPWRITE_PROJECT_ID', 'APPWRITE_API_KEY']
    .filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    return 2;
  }

  const runId = randomId('r');
  const where = templateWhere(options.whereField, options.whereValue, runId);
  const client = new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT!)
    .setProject(process.env.APPWRITE_PROJECT_ID!)
    .setKey(process.env.APPWRITE_API_KEY!);
  const functions = new Functions(client);
  const tablesDB = new TablesDB(client);
  const startedAt = Date.now();

  const executions = await Promise.allSettled(
    Array.from({ length: options.count }, async () => {
      const requestId = randomId('q');
      const body = templateValue(options.body, runId, requestId);
      const headers = templateHeaders(options.headers, runId, requestId);
      return functions.createExecution({
        functionId: options.functionId,
        body: JSON.stringify(body),
        async: false,
        method: ExecutionMethod.POST,
        headers,
      });
    }),
  );

  const completed = executions.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const rejected = executions.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  const rows = await tablesDB.listRows({
    databaseId: options.database,
    tableId: options.table,
    queries: [Query.equal(where.field, where.value), Query.limit(1)],
  });
  const failures = [
    ...rejected.map(errorCode),
    ...completed.flatMap((execution) => {
      const code = executionFailureCode(execution);
      return code ? [code] : [];
    }),
  ];
  const statuses = completed.map((execution) => execution.status);
  const responseCodes = completed.map((execution) => String(execution.responseStatusCode));
  const rateLimits = rejected.filter((error) => (error as { code?: number })?.code === 429).length +
    completed.filter((execution) => execution.responseStatusCode === 429).length;
  const wallMs = Date.now() - startedAt;
  const status = rows.total > options.expect
    ? 'DUPLICATES FOUND'
    : rows.total === options.expect
      ? 'OK'
      : 'BELOW EXPECTED';

  console.log(
    `${options.count} requests -> ${rows.total} rows in ${options.table} where ${where.field}=${where.value} (expected ${options.expect}). ${status}`,
  );
  console.log(`Run ID: ${runId}`);
  console.log(`Execution statuses: ${counts(statuses)}`);
  console.log(`Response status codes: ${counts(responseCodes)}`);
  console.log(`Failures by error code: ${counts(failures)}`);
  console.log(`429s: ${rateLimits}`);
  console.log(`Wall time: ${wallMs} ms`);

  if (rejected.length > 0 || completed.some((execution) =>
    execution.status === 'failed' || execution.responseStatusCode >= 400,
  ) || rows.total < options.expect) return 2;
  return rows.total > options.expect ? 1 : 0;
}

async function main(argv: string[]): Promise<void> {
  try {
    const options = parseProveArgs(argv);
    process.exitCode = await runProve(options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The prove command failed');
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : '';
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  void main(process.argv.slice(2));
}
