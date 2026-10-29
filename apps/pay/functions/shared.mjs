import { Client, ID, TablesDB } from 'node-appwrite';

export const databaseId = 'doubletap';
export const endpoint = 'https://fra.cloud.appwrite.io/v1';

function getHeader(headers, name) {
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

export function parseBody(req) {
  if (req.bodyJson && typeof req.bodyJson === 'object') return req.bodyJson;
  try {
    return JSON.parse(req.body ?? '{}');
  } catch {
    return null;
  }
}

export function validRequest(body) {
  return body !== null &&
    typeof body === 'object' &&
    (body.mode === undefined ||
      body.mode === 'pay' ||
      body.mode === 'job' ||
      body.mode === 'endpoint') &&
    ['orderId', 'run', 'requestId'].every((key) =>
      typeof body[key] === 'string' &&
      body[key].length >= 1 &&
      body[key].length <= 36 &&
      /^[A-Za-z0-9._-]+$/.test(body[key]),
    );
}

export function createTablesDB(req) {
  const key = getHeader(req.headers, 'x-appwrite-key');
  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID ??
    getHeader(req.headers, 'x-appwrite-project-id');
  if (!key || !projectId) return null;

  const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT ?? endpoint)
    .setProject(projectId)
    .setKey(key);
  return new TablesDB(client);
}

export async function trace(tablesDB, { run, requestId, via, phase }) {
  await tablesDB.createRow({
    databaseId,
    tableId: 'trace',
    rowId: ID.unique(),
    data: { run, requestId, via, phase, at: Date.now() },
  });
}
