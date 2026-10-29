# appwrite-doubletap

Exactly-once claims and expiring worker leases for Appwrite TablesDB.

Use `doubletap({ tablesDB, databaseId })`, call `setup()` once, then use
`once()` or `lease()`. Results from `once()` must be JSON-serializable and no
more than 8192 characters after serialization.

Expiry is based on client clocks, so clock skew matters. State rows accumulate
and aren't pruned. A stalled `once()` callback can finish its side effect after
another worker takes over, so pass `ctx.idempotencyKey` to external providers.
