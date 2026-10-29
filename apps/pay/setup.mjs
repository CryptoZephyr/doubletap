import { Client, Permission, Role, TablesDB, TablesDBIndexType } from 'node-appwrite';
import { doubletap } from 'doubletap';

const endpoint = process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1';
const projectId = process.env.APPWRITE_PROJECT_ID ?? '6ae32d6f0034eb612a86';
const databaseId = 'doubletap';
const client = new Client()
  .setEndpoint(endpoint)
  .setProject(projectId)
  .setKey(requiredEnv('APPWRITE_API_KEY'));
const tablesDB = new TablesDB(client);

const readAny = [Permission.read(Role.any())];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function isConflict(error) {
  return error?.code === 409;
}

async function ensureResource(create, read, label) {
  try {
    await create();
  } catch (error) {
    if (!isConflict(error)) throw error;
  }

  const deadline = Date.now() + 120_000;
  while (true) {
    const resource = await read();
    if (resource.status === 'available') return;
    if (resource.status === 'failed') {
      throw new Error(`${label} failed: ${resource.error ?? 'unknown Appwrite error'}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(500);
  }
}

async function ensureTable(tableId) {
  try {
    await tablesDB.createTable({
      databaseId,
      tableId,
      name: tableId,
      permissions: readAny,
      rowSecurity: false,
    });
  } catch (error) {
    if (!isConflict(error)) throw error;
    await tablesDB.updateTable({
      databaseId,
      tableId,
      name: tableId,
      permissions: readAny,
      rowSecurity: false,
    });
  }
  await tablesDB.getTable({ databaseId, tableId });
}

async function ensureStringColumn(tableId, key, size) {
  await ensureResource(
    () => tablesDB.createStringColumn({
      databaseId,
      tableId,
      key,
      size,
      required: true,
    }),
    () => tablesDB.getColumn({ databaseId, tableId, key }),
    `${tableId}.${key}`,
  );
}

async function ensureIntegerColumn(tableId, key) {
  await ensureResource(
    () => tablesDB.createIntegerColumn({
      databaseId,
      tableId,
      key,
      required: true,
    }),
    () => tablesDB.getColumn({ databaseId, tableId, key }),
    `${tableId}.${key}`,
  );
}

async function ensureIndex(tableId, key, columns) {
  await ensureResource(
    () => tablesDB.createIndex({
      databaseId,
      tableId,
      key,
      type: TablesDBIndexType.Key,
      columns,
    }),
    () => tablesDB.getIndex({ databaseId, tableId, key }),
    `${tableId}.${key}`,
  );
}

async function setupCharges() {
  await ensureTable('charges');
  await ensureStringColumn('charges', 'orderId', 64);
  await ensureStringColumn('charges', 'requestId', 64);
  await ensureStringColumn('charges', 'via', 16);
  await ensureIntegerColumn('charges', 'at');
  await ensureStringColumn('charges', 'idemKey', 32);
  await ensureIndex('charges', 'orderId', ['orderId']);
}

async function setupTrace() {
  await ensureTable('trace');
  await ensureStringColumn('trace', 'run', 36);
  await ensureStringColumn('trace', 'requestId', 64);
  await ensureStringColumn('trace', 'via', 16);
  await ensureStringColumn('trace', 'phase', 16);
  await ensureIntegerColumn('trace', 'at');
  await ensureIndex('trace', 'run', ['run']);
}

async function setupJobs() {
  await ensureTable('jobs');
  await ensureStringColumn('jobs', 'holder', 64);
  await ensureIntegerColumn('jobs', 'expiresAt');
  await ensureIntegerColumn('jobs', 'version');
}

await setupCharges();
await setupTrace();
await setupJobs();
await doubletap({ tablesDB, databaseId, tableId: 'doubletap', namespace: 'pay' }).setup();
console.log('Pay demo tables are ready: charges, trace, jobs, doubletap');
