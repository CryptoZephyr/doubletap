import { randomUUID } from 'node:crypto';
import { Client, TablesDB } from 'node-appwrite';

export const databaseId = 'doubletap';
export const client = new TablesDB(
  new Client()
    .setEndpoint(process.env.APPWRITE_ENDPOINT ?? 'https://fra.cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID ?? '6ae32d6f0034eb612a86')
    .setKey(process.env.APPWRITE_API_KEY ?? ''),
);

export function testTableId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export async function waitForAvailable(
  read: () => Promise<{ status: string; error?: string | null }>,
): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const item = await read();
    if (item.status === 'available') return;
    if (item.status === 'failed') {
      throw new Error(`Appwrite resource failed: ${item.error ?? 'unknown error'}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for an Appwrite resource');
}

export async function createCounterTable(tableId: string): Promise<void> {
  await client.createTable({ databaseId, tableId, name: tableId });
  await client.getTable({ databaseId, tableId });
  await client.createIntegerColumn({
    databaseId,
    tableId,
    key: 'count',
    required: false,
  });
  await waitForAvailable(() => client.getColumn({ databaseId, tableId, key: 'count' }));
}

export async function createCounterRow(tableId: string, rowId: string): Promise<void> {
  await client.createRow({
    databaseId,
    tableId,
    rowId,
    data: { count: 0 },
  });
}

export async function incrementCounter(tableId: string, rowId: string): Promise<void> {
  await client.incrementRowColumn({
    databaseId,
    tableId,
    rowId,
    column: 'count',
    value: 1,
  });
}

export async function counterValue(tableId: string, rowId: string): Promise<number> {
  const row = await client.getRow({ databaseId, tableId, rowId });
  return row.count as number;
}

export async function deleteTableIfPresent(tableId: string): Promise<void> {
  try {
    await client.deleteTable({ databaseId, tableId });
  } catch (error) {
    if ((error as { code?: number }).code !== 404) throw error;
  }
}
