# Developer Context Kit

This repository is a **local package candidate** for a synthetic devctx pilot. The `devctx` command is **NOT currently installed** globally. Run `node bin/devctx.mjs help` from this checkout.

All root-bound commands require an explicit disposable `--pilot <pilot.json>` fence. This pilot supports synthetic project onboarding, scoped records, deterministic briefs, advisory handoffs, copies of three skills into listed pilot homes, and [private skill draft tooling](docs/SKILL-BUILDER.md). It makes no automatic private-to-public synchronization. It is not a sandbox: the agent host and other tools may have broader access.

No real-home activation, live account connection, client migration, outbound send, or public release is included. The package is private, and rights and license decisions remain with the owner.

The [reviewed source installation bridge](docs/SKILL-BUILDER.md#third-party-source-packages) adds offline `skill-sources package-review`, `content-approve`, `local-plan`, `local-approve`, `local-apply`, and `local-status`. All require a disposable pilot. Explicit mappings name every selected/required file and license/notice; content and action approvals separately bind bytes, declarations, provenance and target effects. Missing dependencies and unreviewed compatibility block installation. Acquired scripts are never executed.

Fixture tests cover installation, update, restoration of an older approved version and removal, with collision/edit protection and interrupted-write holds. Source targets are `.claude/skills` and `.agents/skills` below a pilot home. Personal B retains `.codex/skills` with an added competing-root check. These are sandbox filesystem layouts, not evidence of live discovery, real-source compatibility, twelve-source installation or an automatic updater. Source installation accepts at most 256 KiB total, below acquisition's 1 MiB cap.

`node bin/devctx.mjs skill-sources catalog` lists twelve public recipes with installation status `unverified` and makes no network request. `node bin/devctx.mjs skill-sources check --source <id>` reads public GitHub release and commit metadata without a pilot fence; it writes nothing and does not install skills. The check uses unauthenticated GitHub API requests, which reveal the caller's IP to GitHub and are subject to [60 requests per hour](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). A check can use up to eight requests, so checking all twelve sources can exceed that limit.

Pinned acquisition adds three commands. Copy only `sourceId`, `channel`, `tag` and `commit` from your own fresh check into `PIN_JSON`; choose exact repository-relative file paths in `FILES_JSON`, including any licenses/notices you need. Supply a valid disposable pilot as `PILOT_FILE`. These shell variables contain caller selections, not default package recipes:

```sh
node bin/devctx.mjs skill-sources preview --source humanizer --pin-json "$PIN_JSON" --files-json "$FILES_JSON"
node bin/devctx.mjs skill-sources stage --pilot "$PILOT_FILE" --source humanizer --pin-json "$PIN_JSON" --files-json "$FILES_JSON" --preview-hash "$PREVIEW_HASH"
node bin/devctx.mjs skill-sources inspect --pilot "$PILOT_FILE" --run "$STAGE_ID"
```

Set `PREVIEW_HASH` from preview's `result.fingerprint` and `STAGE_ID` from stage's `result.runId`. For example, an explicit selection is `["SKILL.md","LICENSE"]`; preview refuses a missing file instead of choosing a substitute. A complete offline synthetic example, including a nested skill, is exercised with `node --test test/skill-acquisition.test.mjs test/skill-staging.test.mjs`; these tests make no live GitHub calls.

Preview writes nothing and makes two metadata requests. Stage repeats the preview, verifies every selected blob's Git object hash and SHA-256, and writes only a fresh private directory under pilot `dataRoot/skill-sources/staging`. Inspect is offline and verifies the receipt and exact files. The pin is **caller-supplied-unverified**: acquisition does not recheck tag-to-commit binding or membership in upstream history; GitHub may serve objects from its fork network. The tag is a copied label, not proof of release provenance. Content, dependencies, compatibility, safety and redistribution remain unreviewed; `staged` never means installed.

Limits are 24 selected files, 128 KiB per file, 1 MiB decoded total, 10,000 tree entries, 2 MiB per metadata response, 256 KiB per blob JSON response, 8 MiB response total, 5 seconds per request and 30 seconds per operation. Truncated trees and larger packages return typed failures without fallback. Check + preview + maximum-size stage can use 8 + 2 + 26 = 36 anonymous requests, so a repeated stage can reach the hourly limit. Rate-limit errors retain bounded `retryAfterSeconds`/`resetAt` hints; a failed download creates no directories. Taste currently has no stable-release observation, so the supported check → copy pin → acquire workflow is unavailable for it. Caller-supplied labels remain unverified; there is no automatic branch fallback. See [storage](docs/STORAGE.md) for interrupted stages and [limitations](docs/LIMITATIONS.md) for custom discovery homes.
