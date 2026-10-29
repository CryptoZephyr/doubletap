# appwrite-doubletap

Exactly-once claims and expiring worker leases for Appwrite TablesDB.

Use `doubletap({ tablesDB, databaseId })`, call `setup()` once, then use
`once()` or `lease()`. Results from `once()` must be JSON-serializable and no
more than 8192 characters after serialization.

Expiry is based on client clocks, so clock skew matters. State rows accumulate
unless finished `once()` keys are pruned. After pruning, a retry of an old
`once()` key runs again. Keep the replay window much longer than any `ttlMs` or
realistic stall.
A stalled `once()` callback can finish its side effect after another worker
takes over, so pass `ctx.idempotencyKey` to external providers.

## Appwrite Function idempotency

Use `idempotent()` to wrap an Appwrite Function entrypoint. It uses
`x-idempotency-key` by default and replays the original response.

```ts
import { idempotent } from 'appwrite-doubletap';

export default idempotent(async ({ req, res, idempotencyKey }) => {
  const order = await createOrder(req.bodyJson, { idempotencyKey });
  return res.json(order);
}, { databaseId: 'main' });
```

Set up the `doubletap` table before invoking the Function. Clients can provide
the key with `functions.createExecution({ ..., headers: { 'x-idempotency-key': orderId } })`.
Callers without `x-appwrite-user-id` share the `guest` scope. Guest idempotency
keys must be unguessable random IDs, and guest responses should not contain private data.

## Pruning old state

`prune()` removes only finished `once()` key chains from the whole table,
across all namespaces. Lease chains are kept on purpose because deleting a
lease's latest row can let two workers hold it. Crashed `pending` keys are kept
too. `olderThanMs` is the replay window, so choose a value far longer than any
claim TTL or realistic worker stall.

```ts
const result = await dt.prune({ olderThanMs: 30 * 24 * 60 * 60 * 1000 });
```
