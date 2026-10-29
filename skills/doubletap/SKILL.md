---
name: doubletap
description: Use when writing or reviewing Appwrite code (TablesDB, Functions) where something must happen once or by one worker at a time. Triggers include payments, refunds, orders, sign-up bonuses, coupon redemption, sending an email or webhook once, job queues, scheduled workers, "check if it exists then create", "if not paid then charge", retries, double-clicks, and transactions used as a lock. Don't use it for counters and stock limits that Appwrite's bounded increment and decrement already handle.
license: MIT
compatibility: Works in any agent that supports the Agent Skills format. Targets Appwrite projects that use node-appwrite or Appwrite Functions on Node, and installs appwrite-doubletap from npm.
---

# doubletap

Stop Appwrite code from doing a thing twice when 2 or more requests arrive together.

## The bug to look for

Any code shaped like this is unsafe under concurrency:

```js
const existing = await tablesDB.listRows({ ..., queries: [Query.equal('orderId', id)] });
if (existing.total === 0) {
  await chargeCard(id);          // two requests can both get here
  await tablesDB.createRow({ ... });
}
```

The read and the write are separate steps, so many requests can read "nothing yet" before any of them writes. In our tests against Appwrite Cloud, 100 simultaneous taps on this pattern charged 7 to 24 times.

Wrapping the read and write in a TablesDB transaction doesn't fix it today. With 100 workers, 2 to 5 committed the same claim (appwrite/appwrite#14489). Don't use transactions as a lock.

## What to write instead

Use row IDs as the guard. A fixed row ID can only be created once. The second `createRow` gets `409 row_already_exists`. The `doubletap` package wraps this:

```js
import { doubletap } from 'appwrite-doubletap';

const dt = doubletap({ tablesDB, databaseId: 'main' });
await dt.setup(); // once, creates its state table

// Exactly once per key. Retries and double-taps get the first result back.
const { value, replayed } = await dt.once(`pay:${orderId}`, async (ctx) => {
  return chargeCard(orderId, { idempotencyKey: ctx.idempotencyKey });
});

// One worker at a time. The lease expires if the worker dies.
const lease = await dt.lease('nightly-report', { ttlMs: 60_000 });
if (lease) {
  try { await work(lease.token); } finally { await lease.release(); }
}
```

For an Appwrite Function entrypoint, prefer `idempotent()` to replay responses
for repeated requests with the same idempotency key. Use `doubletap()` directly
for non-Function code or when the claim key needs custom handling.
Callers without `x-appwrite-user-id` share the `guest` scope, so guest keys
must be unguessable random IDs and guest responses shouldn't contain private data.

Without the package, the minimal safe version is to create the row first, with a deterministic ID such as `pay_<orderId>`. Treat 409 as "already done or in progress", and only the creator does the work.

## Rules

1. Claim before acting. Create the guard row first, do the side effect second, and record the result third.
2. Always pass `ctx.idempotencyKey` to payment providers and other external APIs. If a worker stalls past its lease, another worker can take over, and the database can't recall a charge that has already gone out.
3. Use `lease.token` as a fencing token when writing results. The higher token wins, and a stale worker's `renew()` returns `false`.
4. Leave stock counts and limits to Appwrite. `decrementRowColumn` with `min` is already atomic. Don't wrap it.
5. Prove it. Run `npx appwrite-doubletap prove --function <id> --count 100 ...` against the Function and check that the row count matches what you expect.

## Review checklist

- [ ] There's no read-then-write on the same logical thing without a fixed-ID claim.
- [ ] There's no transaction used as a mutex.
- [ ] Every external side effect gets an idempotency key.
- [ ] Workers with leases handle `renew() === false` by stopping.
