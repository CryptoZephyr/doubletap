import { ID, Query } from 'node-appwrite';
import { createTablesDB, databaseId, parseBody, trace, validRequest } from './shared.mjs';

export default async ({ req, res }) => {
  const body = parseBody(req);
  if (!validRequest(body)) {
    return res.json({ error: 'orderId, run, and requestId must be safe strings from 1 to 36 characters; mode must be pay or job' }, 400);
  }

  const tablesDB = createTablesDB(req);
  if (!tablesDB) return res.json({ error: 'The function request is missing Appwrite credentials' }, 401);

  const context = { run: body.run, requestId: body.requestId, via: 'naive' };
  await trace(tablesDB, { ...context, phase: 'start' });
  if (body.mode === 'job') {
    try {
      await tablesDB.createRow({
        databaseId,
        tableId: 'jobs',
        rowId: body.orderId,
        data: { holder: '', expiresAt: 0, version: 1 },
      });
    } catch (error) {
      if (error?.code !== 409 || error?.type !== 'row_already_exists') throw error;
    }

    let status = 'won';
    try {
      const transaction = await tablesDB.createTransaction({ ttl: 60 });
      const row = await tablesDB.getRow({
        databaseId,
        tableId: 'jobs',
        rowId: body.orderId,
        transactionId: transaction.$id,
      });
      const now = Date.now();
      if (row.expiresAt > now) {
        await tablesDB.updateTransaction({
          transactionId: transaction.$id,
          rollback: true,
        });
        status = 'refused';
      } else {
        await tablesDB.updateRow({
          databaseId,
          tableId: 'jobs',
          rowId: body.orderId,
          data: {
            holder: body.requestId,
            expiresAt: now + 60_000,
            version: row.version + 1,
          },
          transactionId: transaction.$id,
        });
        await tablesDB.updateTransaction({
          transactionId: transaction.$id,
          commit: true,
        });
      }
    } catch (error) {
      if (error?.code !== 409) throw error;
      status = 'refused';
    }

    await trace(tablesDB, { ...context, phase: status });
    await trace(tablesDB, { ...context, phase: 'end' });
    return res.json({ status });
  }

  const existing = await tablesDB.listRows({
    databaseId,
    tableId: 'charges',
    queries: [Query.equal('orderId', body.orderId), Query.limit(1)],
  });

  let response;
  if (existing.rows.length > 0) {
    const chargeId = existing.rows[0].$id;
    await trace(tablesDB, { ...context, phase: 'read-found' });
    response = { status: 'already-paid', chargeId };
  } else {
    await trace(tablesDB, { ...context, phase: 'read-empty' });
    const chargeId = ID.unique();
    await tablesDB.createRow({
      databaseId,
      tableId: 'charges',
      rowId: chargeId,
      data: {
        orderId: body.orderId,
        requestId: body.requestId,
        via: 'naive',
        at: Date.now(),
        idemKey: '',
      },
    });
    await trace(tablesDB, { ...context, phase: 'charge' });
    response = { status: 'charged', chargeId };
  }

  await trace(tablesDB, { ...context, phase: 'end' });
  return res.json(response);
};
