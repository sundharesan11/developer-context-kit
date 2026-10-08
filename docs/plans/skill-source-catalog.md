# Skill Source Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The coordinator owns the independent review and dispatch; this document does not authorize installation or scheduling.

**Goal:** Ship a public, validated twelve-source recipe catalog and a bounded, read-only GitHub checker that resolves stable release tags to commits or reports no release.

**Architecture:** A bundled JSON catalog contains generic source identities, provenance, channel policy, and explicit unverified installation status. A dependency-free validator loads it before any network call. A GitHub resolver takes an injectable HTTP transport, returns a typed observation, and never downloads repository contents or executes upstream code; two new root-free CLI routes expose catalog and check results as the existing JSON envelope.

**Tech Stack:** Node.js `>=22.13.0`, ESM, built-in `fetch`, `node:test`, the existing `DevctxError` and CLI router. No new package dependency.

## Global constraints

- This is the first independently testable slice of the approved [source audit](../research/skill-collections.md). It does not install, update, stage or acquire skill packages, discover agent homes, create receipts, adapt hosts, or schedule automation.
- Keep catalog and tests safe for a public package: no local usernames, accounts, tokens, client paths, real home paths, machine configuration, or private lock state.
- Treat every source and source/host pair as **installation unverified**. Release metadata and a resolved commit make no compatibility, safety, redistribution, or installability claim.
- Make no CLI subprocess or agent binary version probe. The Command Code version probe previously self-updated. Do not execute downloaded source, installers, hooks, or scripts.
- No executable package download, source archive fetch, source tree traversal, real-home access, global edit, private repository edit, or live network request in the normal test suite.
- Keep existing pilot-bound commands gated. Only the new read-only catalog/check routes become root-free.
- Implementation and review happen in later dispatches; no commit, push, install, or automation activation follows from this plan.

## File map and stable interfaces

| Path | Responsibility |
| --- | --- |
| `catalog/skill-sources.json` | Public twelve-source preset and source recipes, with no runtime state. |
| `src/skill-sources/catalog.mjs` | Strict schema validation, bundled loading, lookup, and deterministic public listing. |
| `src/skill-sources/github.mjs` | Bounded public GitHub JSON transport and typed stable-release resolution. |
| `src/skill-sources/commands.mjs` | Read-only CLI route definitions and argument validation. |
| `src/cli.mjs` | Register `skill-sources catalog` and `skill-sources check` as `rootFree: true`; retain all other route gates. |
| `test/skill-sources.test.mjs` | Catalog, validator, local fixture HTTP, and CLI contract tests. |
| `test/pilot.test.mjs` | Update the existing root-free route assertion to admit only the two new read-only routes. |
| `test/required-tests.json` | Required names for the new security and route tests. |
| `scripts/package-allowlist.json` | Include each new public runtime/catalog/test file. |

Avoid modifying the existing private skill-builder workspace or installer to reuse a similarly named concept. The catalog module exports:

```js
validateCatalog(value) // returns a frozen, normalized catalog; throws DevctxError("INVALID_INPUT", ...)
loadBundledCatalog() // reads at most 64 KiB at fileURLToPath(new URL("../../catalog/skill-sources.json", import.meta.url)) and validates it
listSources(catalog) // returns { preset: "requested-twelve", sources: [...] } in catalog order
getSource(catalog, id) // exact ID lookup; unknown ID => DevctxError("INVALID_INPUT", ...)
```

The resolver exports:

```js
checkSource(source, { request = fetch, priorLock, timeoutMs = 5000 } = {})
// Promise<Observation>; request(url, { headers, signal, redirect: "manual" }) returns a Response.
```

`priorLock` is an optional *supplied value*, never loaded from disk by the library: `{ sourceId, channel: "stable-release", tag, commit }`. Its commit must be a lowercase 40-hex Git SHA, its tag must follow the release tag rules below, and its source ID must match the checked recipe. Observations are discriminated by `status`:

```js
{ sourceId, status: "untracked" | "stable" | "release_changed" | "moved_tag", channel: "stable-release", tag, commit, previous?: { tag, commit } }
{ sourceId, status: "no_release", channel: "stable-release", previous?: { tag, commit } }
```

`stable` means the supplied prior lock has the same tag and commit; without a prior lock, a found stable release is `untracked` (a discovery). A changed release tag is `release_changed` with `previous` and makes no claim about version order: an older tag can become latest after release deletion. The **same tag with a different resolved commit is `moved_tag`** and must never be described as an ordinary update. Only the current latest tag is resolved; a previously locked tag that moves while another tag becomes latest is not detected. The caller stores no observation automatically. A no-release observation has no fabricated current tag or commit and retains a supplied previous lock only as `previous`.

The CLI interfaces are exactly:

```text
devctx skill-sources catalog
devctx skill-sources check --source <catalog-id> [--prior-lock-json '<JSON object>']
```

`catalog` has no flags; `check` requires one source ID, accepts at most one inline prior lock, and has no arbitrary URL, host, file path, token, branch, timeout, or transport flag. Both routes require no `--pilot` and never read the default home. Reject all existing root options (`--pilot`, `--config-root`, `--data-root`, `--state-root`, including `--flag=value` forms) with `DEVCTX_USAGE`; they are not silently accepted just because the router knows `ROOT_OPTIONS`. Successful output uses the existing `{ "ok": true, "command": "skill-sources ...", "result": ... }` envelope and exit 0. Unknown flags or missing/duplicate/malformed options return `DEVCTX_USAGE` and exit 2; an unknown source or invalid prior-lock fields return `DEVCTX_INVALID_INPUT` and exit 1. Network/protocol errors are typed `DevctxError`s and exit 1, with no response body or sensitive headers in JSON details. The library accepts an injected request for tests; the CLI uses only the default bounded transport.

## Task 1: Public recipes and strict validation

**Files:** Create `catalog/skill-sources.json`, `src/skill-sources/catalog.mjs`, `test/skill-sources.test.mjs`; modify `test/required-tests.json` and `scripts/package-allowlist.json` in the same implementation change.

**Catalog contract:** Top-level exact keys `version`, `preset`, `sources`, with `version: 1`, `preset: "requested-twelve"`, and exactly twelve unique entries. Each entry has exact keys `id`, `repository`, `license`, `source`, `installation`; `repository` has exact `owner`, `name`. Owner matches `[A-Za-z0-9-]{1,39}` without leading/trailing hyphens; name matches `[A-Za-z0-9._-]{1,100}` excluding `.`, `..`, and a `.git` suffix. Reject slashes and encoded separators. `source` is exactly `{ "channel": "stable-release" }`; `installation` is exactly `{ "status": "unverified", "note": "<short public prose>" }`, with note length 1–200 and no control characters. `license` is `MIT` or `Apache-2.0` per the audit, a provenance hint rather than a redistribution clearance. Reject unknown keys at every level, duplicates (including case-folded IDs and repository paths), prototype-like IDs, empty/overlong notes, wrong types, commit pins, prerelease/branch pseudo-channels and fewer/more than twelve entries. Catalog IDs use lowercase letters, digits and single internal hyphens, 3–64 chars. Return a defensive normalized copy; do not let caller mutation alter later results. Validation errors name the public field path, never echo an entire untrusted value.

The twelve ordered recipes are:

| ID | GitHub repository | Channel | Installation note to record |
| --- | --- | --- | --- |
| `pm-skills` | `phuryn/pm-skills` | stable release | Nested plugin skills and references; selection unverified. |
| `openspec` | `Fission-AI/OpenSpec` | stable release | CLI and project integration are separate; selection unverified. |
| `last30days` | `mvanhorn/last30days-skill` | stable release | Research engine and optional providers; selection unverified. |
| `ui-ux-pro-max` | `nextlevelbuilder/ui-ux-pro-max-skill` | stable release | Host builds and CLI differ; selection unverified. |
| `taste-skill` | `Leonxlnx/taste-skill` | stable release | No branch fallback; check reports `no_release` while no stable release exists. |
| `impeccable` | `pbakaus/impeccable` | stable release | Host builds, engine and hooks need separate review. |
| `superpowers` | `obra/superpowers` | stable release | Native plugin and portable copy can conflict; selection unverified. |
| `mattpocock-skills` | `mattpocock/skills` | stable release | Nested names and references need mapping. |
| `understand-anything` | `Egonex-AI/Understand-Anything` | stable release | Runtime/dashboard and hooks need separate review. |
| `marketing-skills` | `coreyhaines31/marketingskills` | stable release | Skill names can collide; selection unverified. |
| `humanizer` | `blader/humanizer` | stable release | Root-level SKILL.md needs explicit selection. |
| `claude-seo` | `AgriciDaniel/claude-seo` | stable release | Claude plugin and optional dependencies; other hosts unverified. |

Use `Apache-2.0` only for Impeccable and `MIT` for the other eleven, matching the audit snapshot. Do not insert the audit's default-branch SHAs into stable-release recipes as if they were release commits. There is no per-host support matrix yet; the installation status applies to all hosts and does not infer universal compatibility.

- [ ] Write table-driven tests that assert the exact twelve IDs/repositories, their stable-release channel, Taste's absence of a fallback field, and license distribution; mutate one key or type at a time and assert `DEVCTX_INVALID_INPUT`. Include duplicate ID/repository, extra nested key, forbidden commit pin, unsupported channel, prototype-like ID, and frozen-copy behavior. The resolver has no Taste-specific branch.
- [ ] Run `node --test test/skill-sources.test.mjs`; expect the new tests to fail before implementation. Name the gate test `skill source catalog has exactly twelve public unverified recipes` in `test/required-tests.json`.
- [ ] Add the catalog and validator; use `Object.keys` exact sets and `Object.hasOwn` for strict records, bounded text length, and safe normalized objects. Do not use an external schema parser or evaluate catalog strings.
- [ ] Run the focused test again; expect pass. Add the required test names to `test/required-tests.json` and the new files to `scripts/package-allowlist.json` in sorted order.

## Task 2: Bounded GitHub stable-release resolution

**Files:** Create `src/skill-sources/github.mjs`; extend `test/skill-sources.test.mjs`; add the new runtime file to `scripts/package-allowlist.json`.

**Request protocol:** Construct only `https://api.github.com/repos/<encoded owner>/<encoded name>/...` from validated catalog fields; never accept a caller-supplied origin. Use `Accept: application/vnd.github+json`, a fixed non-identifying `User-Agent`, `redirect: "manual"`, no credentials and no GitHub CLI. Request repository metadata first to distinguish an inaccessible/missing repository from an absent latest release. A metadata redirect is `DEVCTX_SOURCE_MOVED` with `{ status }` only, never a followed `Location`; other redirects are `DEVCTX_REDIRECT_REFUSED`. GET `/releases/latest`, then GET `/git/ref/tags/<tag path>` and dereference an annotated tag through `/git/tags/<sha>` until a commit object is reached (maximum four tag objects; reject loops or a non-commit terminal). Encode each `/`-separated tag segment with `encodeURIComponent` and join with literal `/`; do not encode the whole tag as one segment. Ignore release `target_commitish`, which can be a moving branch. Verify the resolved release commit through `/git/commits/<sha>`, including lightweight refs. Do not request archives, assets, contents, trees, raw URLs or package endpoints. Live GitHub behavior for slash-bearing tags remains unverified.

Validate every GitHub JSON shape before use: repository `full_name` must match the recipe case-insensitively (canonical case can differ), release must have `draft === false`, `prerelease === false` and a valid `tag_name` (1–128 chars, no controls). Reject empty tag path segments, segments beginning or ending with `.`, per-segment `.lock` suffixes, `..`, `@{`, characters `~^:?*[\\`, whitespace, and Unicode format or line-separator controls. Apply the same rules to prior-lock tags. Ref response must be one object, not an array, with `ref === "refs/tags/" + tag` and an object of type `commit` or `tag` with lowercase 40-hex SHA; tag object must lead to a valid commit/tag SHA, have its own SHA equal the requested tag-object SHA, and its first `tag` field must match `tag_name`. Track visited SHAs to reject loops. Commit response SHA must equal the requested commit. Compare the terminal commit to the supplied prior lock only after all checks pass. Inconsistent names, refs or SHAs are `DEVCTX_UPSTREAM_INVALID`, not successful observations.

Each request has a 5-second default deadline and a 256 KiB body cap; cap the entire check at 15 seconds, 8 requests and 1 MiB transferred. The library may accept a shorter positive `timeoutMs` for tests; reject values above 5000 or non-integers. Use one AbortController per request and clear its timer in `finally`; the remaining total deadline can shorten a request. Determine `DEVCTX_NETWORK_TIMEOUT` from that controller's aborted signal, including synchronous throws from injected requests. Refuse a positive `Content-Length` above the cap before reading; stream and abort immediately when the cap is exceeded even if the header is absent or false. Cancel rejected response bodies on non-2xx, redirect and invalid-header paths. Do not follow any 3xx. An injected request must receive the same signal, headers and manual redirect option. Parse `Content-Type` media type as `application/json`, allowing parameters such as `charset=utf-8`. No raw response body appears in errors.

Map HTTP outcomes deliberately: repository metadata 404 is `DEVCTX_SOURCE_NOT_FOUND`; latest-release 404 after confirmed repository is the successful `no_release` observation; tag/ref or commit 404 is `DEVCTX_UPSTREAM_INVALID`; 401 is `DEVCTX_GITHUB_UNAUTHORIZED`; 403 is `DEVCTX_RATE_LIMITED` only when `x-ratelimit-remaining === "0"` or a valid `retry-after` exists, and 429 is always rate limited. Retry details may contain only `retryAfterSeconds` as integer 0–86400 and/or `resetAt` as ISO time from a bounded integer `x-ratelimit-reset` epoch; drop malformed values and never echo raw headers. Other 403 is `DEVCTX_GITHUB_FORBIDDEN`; 5xx is `DEVCTX_UPSTREAM_UNAVAILABLE`; other non-2xx is `DEVCTX_UPSTREAM_HTTP`; transport/DNS failures are `DEVCTX_NETWORK_UNAVAILABLE`; malformed JSON, truncated stream, wrong content type or invalid shape is `DEVCTX_UPSTREAM_INVALID`. A returned draft/prerelease is `DEVCTX_NO_STABLE_RELEASE` (distinct from 404 no release) so no prerelease is accepted as stable. Do not retry implicitly.

- [ ] Add a local `node:http` fixture server on `127.0.0.1` and inject a request function that rewrites only the URL origin to its ephemeral address while preserving path, headers, signal and `redirect`. Test observed requests and output for a lightweight tag, a slash-bearing tag ref with encoded URL path, nested annotated tags through the four-object limit, Taste returning `no_release` after repository metadata succeeds and `/releases/latest` returns 404, same-tag moved commit with prior lock, new tag with prior lock, and stable same lock. The fixture server serves JSON only; the normal suite never contacts GitHub.
- [ ] Add fixture routes for metadata 404 versus releases 404, prerelease/draft, 401, both 403 cases, 429, 500, redirects, bad JSON/content type, missing ref, tag loop, wrong commit SHA, oversized declared/streamed response, timeout and offline failure. Assert the exact codes above and that no body or token enters `details`.
- [ ] Run `node --test test/skill-sources.test.mjs`; expect red for resolver tests. Add `skill source HTTP fixture refuses redirects and oversized bodies` and `skill source moved tag is compared with supplied prior lock` to `test/required-tests.json`.
- [ ] Implement the bounded transport/parser and resolver, then rerun the focused test to green. Keep the request dependency injectable at the single exported entry point; do not add a full HTTP client framework.

## Task 3: Public read-only CLI and regression gate

**Files:** Create `src/skill-sources/commands.mjs`; modify `src/cli.mjs`, `test/skill-sources.test.mjs`, `test/pilot.test.mjs`, `test/required-tests.json`, and `scripts/package-allowlist.json`.

**Route contract:** Register `skill-sources catalog` and `skill-sources check` with `rootFree: true`, `rootOptions: false` and lazy imports, following existing route style. `catalog` calls only `loadBundledCatalog` and `listSources`. `check` validates the bundled catalog and `--source`, parses `--prior-lock-json` with a 1 KiB UTF-8 byte cap (`Buffer.byteLength`) and the exact four-key lock shape, then calls `checkSource`. Parse malformed JSON and missing/duplicate options as `USAGE`; semantically invalid lock fields as `INVALID_INPUT`. Keep `ROOT_OPTIONS` for existing routes, but omit them for these two routes; strict `parseArgs` then rejects root options in separate-value and equals forms. Do not make `--pilot` optional on an existing route. Help lists the two new routes. Use `parseArgs({ tokens: true })` and count option tokens by name to reject duplicate scalar flags for these routes without changing old route behavior. Add optional `request` to `main(argv, { ..., request } = {})`; pass it through route context only for the check command. Production omits it and uses built-in `fetch`; a test calls `main([...], { stdout, request: fixtureRequest })` to exercise the full CLI without live network.

- [ ] Add CLI tests for root-free catalog/help listing, exact twelve-source output, unknown source, malformed/oversized prior JSON, duplicate flags, unknown flags, and all four root options in both `--flag value` and `--flag=value` forms returning `DEVCTX_USAGE` on **both** new routes. Assert the continued `GATE_REQUIRED` failure for an old pilot-bound route without `--pilot`. Test the successful check CLI via `main`'s injected `request`; do not use live GitHub. Replace the existing required test name `CLI: only version and help are root-free; every other route refuses without --pilot` and its assertion in `test/pilot.test.mjs` with `CLI: only version, help, and skill source reads are root-free; every other route requires --pilot`. Also add `skill source CLI is root-free while existing writes remain pilot-bound` to `test/required-tests.json`.
- [ ] Run `node --test test/skill-sources.test.mjs test/cli.test.mjs test/pilot.test.mjs`; expect CLI tests red before registration.
- [ ] Implement the two route definitions and CLI registration. Preserve the existing JSON output envelope and exit-code rule (`USAGE` 2, other errors 1).
- [ ] Rerun focused tests, then `node scripts/run-tests.mjs .` and `node scripts/check-package.mjs --root . --no-pack`. Expected: JSON `ok: true` from both gates and no new failures. The package audit may use its existing `npm pack --dry-run --ignore-scripts` later in coordinator review; that is a local package manifest check, not acquisition of upstream executable packages.

**Gate and documentation notes:** `scripts/check-package.mjs` scans tracked files for sensitive patterns, so fixture secrets must be assembled at runtime instead of stored as literal fake tokens or authorization headers. `scripts/run-tests.mjs` rejects empty arrow bodies in test files; fixture callbacks must have meaningful bodies. Add README and security-model notes that `skill-sources check` makes unauthenticated GitHub API requests, reveals the caller's IP to GitHub, writes nothing, and is subject to unauthenticated rate limits of roughly 60 requests per hour. At up to eight requests per check, a sweep across twelve sources can exceed that budget. Keep explicit commit verification for both lightweight and annotated tags; do not introduce caching or authentication in this slice.

## Acceptance and handoff

The slice is ready for independent review when all twelve audited sources are listed with explicit unverified installation status; catalog validation rejects unknown fields and unsafe identities; the resolver produces verified stable-release commit observations, a genuine `no_release` result for Taste, or distinct typed failures under local fixture HTTP; a moved tag is visible against a supplied prior lock; the CLI has exact root-free/error behavior; and the normal suite and package allowlist gate pass. Record commands and results in the implementation handoff. The audit's observed release labels are snapshots, not catalog pins: a subsequent coordinator check saw a newer Marketing Skills release and GitHub rate limiting during other tag checks. Live GitHub availability and real host discovery remain unverified and are outside this slice.

Later slices must separately design package acquisition/inspection, explicit per-host adapters and collision handling, guarded install/update with private locks and receipts, and the approved weekly automation. A recipe or release observation alone cannot mark any source installed, safe, or up to date.
