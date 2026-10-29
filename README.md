# doubletap

doubletap makes sure something in your Appwrite app happens once, even when the same request arrives 100 times at the same moment.

It's for developers building on Appwrite who charge cards, send emails, hand out sign-up bonuses or run background jobs. Say a customer taps Pay twice on a slow connection and their phone retries. With ordinary Appwrite code, the order can get charged several times. With doubletap, it's charged once and every retry gets the same receipt back.

Live demo: https://doubletap-lab.appwrite.network · Video: not available yet · Docs: this README · Submission: not linked yet

![The race lab after one live run: 10 charges without doubletap, 1 with it](docs/race-lab.png)

Built with: Appwrite TablesDB · Appwrite Functions · Appwrite Realtime · Appwrite Sites · TypeScript
Status: working on Appwrite Cloud (Frankfurt, Free plan). Published on npm as [appwrite-doubletap](https://www.npmjs.com/package/appwrite-doubletap) 0.1.0.

## The problem

Picture a Pay button. A customer taps it twice, their phone retries on a weak connection, or 100 people hit the same order in one second. Most backend code handles a payment in two steps:

```js
const paid = await tablesDB.listRows({ ..., queries: [Query.equal('orderId', id)] });
if (paid.total === 0) {
  await chargeCard(id);
  await tablesDB.createRow({ ... });
}
```

Under load, many requests read "not paid" before any of them writes, so each one charges. We fired 100 simultaneous taps at a normal Appwrite Function written like this. It charged 7, 17, 18 and 22 times across four runs of the prove command, and between 9 and 24 times in race lab runs.

Appwrite has no built-in idempotency for function calls or row updates. The obvious fix, a TablesDB transaction, doesn't hold either. When 100 workers raced for one expired lock inside a transaction, 2 to 5 of them won every round. That's reported upstream as [appwrite/appwrite#14489](https://github.com/appwrite/appwrite/issues/14489).

## What doubletap does

doubletap gives you four things:

1. A package with two calls. `once(key, fn)` runs a payment or job exactly once per key, and every retry gets the first result back. `lease(name)` gives one worker a job at a time and passes it to exactly one other worker if the first one dies.
2. A `prove` command. Point it at your own Appwrite Function, and it fires 100 identical requests at once and counts what happened, for example "100 requests -> 22 rows in charges (expected 1). DUPLICATES FOUND".
3. A race lab, a web page that runs two races live. In the first, 100 taps hit two Pay functions side by side, and a replay draws every request as a line so you can see the ones that read "unpaid" and charged. In the second, 100 workers grab one job, once through an Appwrite transaction and once through a doubletap lease, so you can watch the transaction hand the same job to several workers.
4. An agent skill that teaches Claude Code, Codex and other coding agents to spot the check-then-write bug in Appwrite code and write the safe version instead.

## How it works

1. You run `doubletap prove` against your Function and see the duplicates.
2. You wrap the side effect in `dt.once(orderId, ...)`.
3. You run `prove` again and get exactly 1.

```mermaid
flowchart LR
    A["100 taps on one order"] --> B["dt.once(orderId)"]
    B -->|first request creates the claim row| C["charge once"]
    B -->|99 requests get 409 row_already_exists| D["wait, then get the same receipt"]
```

## Why Appwrite TablesDB matters

The whole guard is built on one TablesDB rule: a row ID can only be created once. Every state change creates a new row with a fixed ID such as `d3f9...-g2`. When 100 requests try to create the same ID, Appwrite lets one through and returns `409 row_already_exists` to the other 99. No Redis, no extra server and no transactions are involved.

The demo uses the rest of Appwrite too. The two Pay endpoints are Appwrite Functions, the lab's live counters come from Appwrite Realtime, and the lab itself is hosted on Appwrite Sites.

## Try it

1. Open https://doubletap-lab.appwrite.network.
2. Press Tap Pay 100 times.
3. Wait about 10 seconds. The left side shows several charges and the right side shows 1.
4. After the one-minute cooldown, press Start 100 workers. The transaction side usually shows 2 to 5 workers owning the job, and the doubletap side shows 1.

Each press runs 200 real Function executions on a Free plan project, so the lab waits a minute between races.

## Architecture

```mermaid
flowchart TB
    Lab["Race lab on Appwrite Sites"] -->|"100 async executions per side"| Naive["Function: pay-naive"]
    Lab -->|"100 async executions per side"| Safe["Function: pay-doubletap"]
    Safe -->|"dt.once() and dt.lease()"| DB[("TablesDB database: doubletap")]
    Naive -->|"read, then write"| DB
    DB -->|"charge and trace rows over Realtime"| Lab
    CLI["appwrite-doubletap prove"] -->|"N identical executions"| Naive
    CLI -->|"counts rows afterwards"| DB
```

## Integration details

| Appwrite product | How doubletap uses it | Why it matters |
| --- | --- | --- |
| TablesDB | Every claim and lease is a row with a fixed ID. `createRow` on an ID that exists returns `409 row_already_exists`, so exactly one request wins. The demo also keeps `charges`, `jobs` and `trace` tables. | This is the guard itself. No Redis, lock server or transaction is involved. |
| Functions | `pay-naive` and `pay-doubletap` are the two Pay endpoints. Each also has a job mode for the worker race. `prove` fires executions at any Function you name. | The race happens inside real Appwrite Functions, the way an app would run in production. |
| Realtime | The lab subscribes to the `charges` and `trace` tables and updates the counters as requests finish. | You watch the race as it happens instead of reading a log afterwards. |
| Sites | The race lab is hosted at doubletap-lab.appwrite.network. | The whole demo, from page to database, runs on Appwrite. |

## What's running

Checked on 29 Oct 2026:

- Race lab: https://doubletap-lab.appwrite.network, on Appwrite Sites.
- Functions `pay-naive` and `pay-doubletap`, Node 22, Appwrite Cloud Frankfurt.
- TablesDB database `doubletap` with the tables `charges`, `jobs`, `trace` and `doubletap`.
- npm package `appwrite-doubletap` 0.1.0, installed fresh and run with `npx appwrite-doubletap prove`.

The project is on the Free plan, which allows two Functions. Both are used, so the lab waits a minute between races to stay inside the monthly execution limit.

## Using the package

Install from npm:

```bash
npm install appwrite-doubletap node-appwrite
```

```ts
import { Client, TablesDB } from 'node-appwrite';
import { doubletap } from 'appwrite-doubletap';

const tablesDB = new TablesDB(new Client().setEndpoint(endpoint).setProject(projectId).setKey(key));
const dt = doubletap({ tablesDB, databaseId: 'main' });
await dt.setup(); // creates the doubletap table once

const { value, replayed } = await dt.once(`pay:${orderId}`, async (ctx) =>
  chargeCard(orderId, { idempotencyKey: ctx.idempotencyKey }),
);

const lease = await dt.lease('nightly-report', { ttlMs: 60_000 });
if (lease) {
  try { await runReport(lease.token); } finally { await lease.release(); }
}
```

`once()` options are `ttlMs` (how long a claim lives before a retry may take over), `waitMs` and `pollMs`. If waiting runs past `waitMs`, it throws `DoubletapTimeoutError`. Results must be JSON and at most 8192 characters.

## The prove command

```bash
export APPWRITE_ENDPOINT=https://fra.cloud.appwrite.io/v1
export APPWRITE_PROJECT_ID=<your project>
export APPWRITE_API_KEY=<key with functions, execution and rows scopes>

npx appwrite-doubletap prove --function pay-naive --count 100 \
  --body '{"orderId":"$RUN","requestId":"$REQ"}' \
  --table charges --where 'orderId=$RUN' --database doubletap --expect 1
```

`$RUN` becomes one ID for the whole run, and `$REQ` becomes a new ID per request. The command exits with 0 when the row count matches `--expect`, 1 when it finds duplicates, and 2 on setup or execution errors. It caps `--count` at 500.

## Evidence and failure cases

All of these ran against a real Appwrite Cloud project on the Free plan.

| Attempt | Expected | Result |
| --- | --- | --- |
| 100 taps on the plain check-then-charge Function | 1 charge | 7, 17, 18 and 22 charges (prove), 14 (a 100-execution check from a script), 9, 10 and 24 (race lab) |
| 100 taps on the doubletap Function | 1 charge | 1 charge every run |
| 100 workers take over an expired lock with a TablesDB transaction | 1 winner | 2 to 5 winners per round in scripts, 3, 5 and 4 through the deployed Function, 2 in each race lab run |
| 100 workers take over an expired lease with doubletap | 1 winner | 1 winner in 13 of 13 script rounds, 3 of 3 Function rounds and every race lab run |
| A request claims the payment, then crashes, and 100 retries follow | 1 charge, 1 receipt | 1 charge and the same receipt for all retries |
| A request stalls past its lease and wakes up late | refused | its late result is refused, but its card charge already went out (see Limitations) |

The package's own tests (`packages/doubletap/test`) cover the 100-way once race, crash recovery, stalled callbacks, callback errors, lease races, release and renewal fencing.

## Repository structure

```text
packages/doubletap   the package and the prove CLI, with live tests
apps/pay             the two demo Functions: pay-naive and pay-doubletap
apps/lab             the race lab web page, deployed to Appwrite Sites
skills/doubletap     the agent skill (SKILL.md)
```

## Run locally

```bash
npm install
npm run build -w packages/doubletap
# Live tests need APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID and APPWRITE_API_KEY
npm test -w packages/doubletap
# Race lab on http://localhost:5173
npm run dev -w apps/lab
```

The demo Functions need a TablesDB database called `doubletap`. `apps/pay/setup.mjs` creates its tables and `apps/pay/deploy.mjs` deploys both Functions.

## Limitations

- A stalled request can still finish an outside call, like a card charge, after another request has taken over. The database can't undo that. Always pass `ctx.idempotencyKey` to your payment provider too.
- Expiry uses the client's clock, so servers with badly drifting clocks can shorten or stretch a lease.
- Old state rows aren't cleaned up yet.
- In a browser, waiting on each Function call (`async: false`) makes Appwrite run the calls one after another, which hides the race. The lab sends async executions and watches the results through Realtime.
- doubletap doesn't read your source code to find races. `prove` tests a Function from the outside, and the agent skill helps coding agents avoid the pattern while they write.
- If appwrite/appwrite#14489 is fixed, the transaction row in the evidence table will stop failing. The check-then-charge result doesn't depend on that bug.

## Roadmap

- Prune old state rows.
- A `prove` mode for direct TablesDB writes, without a Function.

## License

MIT
