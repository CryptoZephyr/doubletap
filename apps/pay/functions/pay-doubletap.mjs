import { ID } from 'node-appwrite';
import { doubletap, idempotent } from 'appwrite-doubletap';
import { createTablesDB, databaseId, parseBody, trace, validRequest } from './shared.mjs';

const endpointHandler = idempotent(async ({ req, res, idempotencyKey }) => {
  const body = parseBody(req);
  const tablesDB = createTablesDB(req);
  if (!tablesDB) return res.json({ error: 'The function request is missing Appwrite credentials' }, 401);

  const context = { run: body.run, requestId: body.requestId, via: 'doubletap' };
  await trace(tablesDB, { ...context, phase: 'start' });
  const chargeId = ID.unique();
  await tablesDB.createRow({
    databaseId,
    tableId: 'charges',
    rowId: chargeId,
    data: {
      orderId: body.orderId,
      requestId: body.requestId,
      via: 'doubletap',
      at: Date.now(),
      idemKey: idempotencyKey ?? '',
    },
  });
  await trace(tablesDB, { ...context, phase: 'charge' });
  await trace(tablesDB, { ...context, phase: 'end' });
  return res.json({ chargeId });
}, { databaseId });

export default async ({ req, res }) => {
  if (req.headers?.['x-appwrite-trigger'] === 'schedule') {
    const tablesDB = createTablesDB(req);
    if (!tablesDB) return res.json({ error: 'The function request is missing Appwrite credentials' }, 401);
    const result = await doubletap({ tablesDB, databaseId, tableId: 'doubletap' }).prune();
    return res.json(result);
  }

  const body = parseBody(req);
  if (!validRequest(body)) {
    return res.json({ error: 'orderId, run, and requestId must be safe strings from 1 to 36 characters; mode must be pay, job, or endpoint' }, 400);
  }

  const tablesDB = createTablesDB(req);
  if (!tablesDB) return res.json({ error: 'The function request is missing Appwrite credentials' }, 401);
  if (body.mode === 'endpoint') return endpointHandler({ req, res });

  const context = { run: body.run, requestId: body.requestId, via: 'doubletap' };
  await trace(tablesDB, { ...context, phase: 'start' });
  if (body.mode === 'job') {
    const dt = doubletap({ tablesDB, databaseId, tableId: 'doubletap', namespace: 'job' });
    const lease = await dt.lease(body.orderId, { ttlMs: 60_000 });
    const status = lease ? 'won' : 'refused';
    await trace(tablesDB, { ...context, phase: status });
    await trace(tablesDB, { ...context, phase: 'end' });
    return res.json({ status });
  }

  const dt = doubletap({ tablesDB, databaseId, tableId: 'doubletap', namespace: 'pay' });
  const result = await dt.once(body.orderId, async (onceContext) => {
    const chargeId = ID.unique();
    await tablesDB.createRow({
      databaseId,
      tableId: 'charges',
      rowId: chargeId,
      data: {
        orderId: body.orderId,
        requestId: body.requestId,
        via: 'doubletap',
        at: Date.now(),
        idemKey: onceContext.idempotencyKey,
      },
    });
    await trace(tablesDB, { ...context, phase: 'charge' });
    return { chargeId };
  });

  if (result.replayed) await trace(tablesDB, { ...context, phase: 'replay' });
  if (result.superseded) await trace(tablesDB, { ...context, phase: 'superseded' });
  const response = {
    status: result.replayed ? 'already-paid' : 'charged',
    chargeId: result.value.chargeId,
    replayed: result.replayed,
  };
  await trace(tablesDB, { ...context, phase: 'end' });
  return res.json(response);
};
