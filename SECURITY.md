# Security policy

Thanks for helping keep doubletap and the apps that use it safe.

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub instead:

[Report a vulnerability](https://github.com/CryptoZephyr/doubletap/security/advisories/new)

Tell us what you found, how to reproduce it and what someone could do with it. We'll reply as soon as we can and keep you updated until it's fixed. If you'd like credit when the fix ships, say how you'd like to be named.

## What's covered

- The latest release of the [`appwrite-doubletap`](https://www.npmjs.com/package/appwrite-doubletap) package on npm, including the `prove` command and the agent skill
- The code on the `main` branch of this repo
- The live race lab at https://doubletap-lab.appwrite.network and its two demo Functions

Older package versions, older commits and other branches aren't supported.

We especially want to hear about anything that lets someone:

- make work wrapped in `once()` or `idempotent()` run more than once for the same key
- get two workers holding the same `lease()` at the same time
- get back another signed-in user's replayed response, or poison their key with a response of your own
- make `prune()` delete state that's still in use
- read the server API key, database contents or other private data through the lab, the demo Functions or the `prove` command

## Known limits

These are known and aren't treated as vulnerabilities:

- Callers who aren't signed in share one key space, so guest keys must be random and hard to guess.
- Expiry depends on client clocks.
- A stalled callback can still finish an outside side effect after another caller takes over, unless the outside service also gets the same idempotency key.
- After `prune()` removes a key, an old retry of that key can run again.
- `idempotent()` can't replay binary responses.

Appwrite's own transactions letting several workers take one expired lease is an Appwrite issue, tracked at [appwrite/appwrite#14489](https://github.com/appwrite/appwrite/issues/14489). Problems in Appwrite itself should go to Appwrite's [security policy](https://github.com/appwrite/appwrite/security/policy).

## Please don't

- run load or denial-of-service tests against the live lab or its Functions
- try to use up the project's free monthly execution limit
- access or change data that isn't yours

The lab only writes demo rows. No real cards are charged and no real money moves. If anything claiming to be doubletap asks for payment details, please report it.
