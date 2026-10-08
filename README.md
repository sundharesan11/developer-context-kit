# Developer Context Kit

This repository is a **local package candidate** for a synthetic devctx pilot. The `devctx` command is **NOT currently installed** globally. Run `node bin/devctx.mjs help` from this checkout.

All root-bound commands require an explicit disposable `--pilot <pilot.json>` fence. This pilot supports synthetic project onboarding, scoped records, deterministic briefs, advisory handoffs, copies of three skills into listed pilot homes, and [private skill draft tooling](docs/SKILL-BUILDER.md). It makes no automatic private-to-public synchronization. It is not a sandbox: the agent host and other tools may have broader access.

No real-home activation, live account connection, client migration, outbound send, or public release is included. The package is private, and rights and license decisions remain with the owner.

`devctx skill-sources catalog` lists twelve public recipes with installation status `unverified` and makes no network request. `devctx skill-sources check --source <id>` reads public GitHub release and commit metadata without a pilot fence; it writes nothing and does not install skills. The check uses unauthenticated GitHub API requests, which reveal the caller's IP to GitHub and are subject to roughly 60 requests per hour. A check can use up to eight requests, so checking all twelve sources can exceed that limit.
