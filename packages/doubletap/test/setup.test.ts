import { afterAll, expect, test } from 'vitest';
import { doubletap } from '../src/index.js';
import {
  client,
  databaseId,
  deleteTableIfPresent,
  testTableId,
} from './helpers.js';

const tableId = testTableId('t_setup');
const lock = doubletap({ tablesDB: client, databaseId, tableId });

afterAll(async () => {
  await deleteTableIfPresent(tableId);
});

test('setup() is idempotent on an existing table', async () => {
  await expect(lock.setup()).resolves.toBeUndefined();
  await expect(lock.setup()).resolves.toBeUndefined();
}, 120_000);
