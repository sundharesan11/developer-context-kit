---
title: Errors
description: Every devctx error code, what it means and what to do about it.
---

A failed command prints one JSON line with `ok: false` and an `error` object:

```json
{"ok":false,"command":"record supersede","error":{"code":"DEVCTX_STALE_VERSION","message":"Target changed","details":{}}}
```

- `code` always starts with `DEVCTX_`.
- `message` is a short, fixed description.
- `details` may name the `field`, a `reason`, a `remedy`, or the IDs involved. Read it first.

The process exits with `2` for `DEVCTX_USAGE` and `1` for every other error.

:::tip[General rule]
devctx refuses rather than guesses. When a check fails, it has not written anything you didn't approve. Don't edit the pilot, delete locks or journals, or weaken a gate to get past an error. Preview again, or stop and look.
:::

## Usage and the pilot fence

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_USAGE` | Unknown command, unknown or malformed flag, a positional argument, or a duplicate flag. | Check the [CLI reference](/docs/reference/cli/). Exit code 2. |
| `DEVCTX_GATE_REQUIRED` | A guard refused the call: no `--pilot`, a path outside the fence or on a protected path, a root flag that doesn't match the pilot, a live-config check (`details.field` such as `live.kitRoot`, `live.kitCommit`, `live.approval`, `live.home`), an operation not allowed, or a command not available in live mode. | Read `details.field` and `details.reason`. Fix the cause, never the fence. For live mode see [Live mode troubleshooting](/docs/guides/live-mode/#troubleshooting). |
| `DEVCTX_PATH_UNSAFE` | A path is not canonical, goes through a symlink, has unsafe permissions, or is a repository that Git filters could touch. Also: private roots inside a Git worktree, or `~/.devctx` not private. | Use the real path (`pwd -P`, `realpath`). Check folder modes are 0700. |
| `DEVCTX_PATH_ESCAPE` | A relative path tries to leave its root, or an output path is outside the bound worktree. | Use a plain relative path with no `..`. |
| `DEVCTX_INVALID_ID` | A scope, project, request, record or actor ID is malformed. | See the ID formats in the [CLI reference](/docs/reference/cli/#identifiers). A project ID must start with `<scope>.`. |
| `DEVCTX_INVALID_INPUT` | A value is invalid: unknown kind or status, bad source reference, malformed JSON input, bad profile field, unknown placeholder, reserved skill name. | Read `details.field` and correct that value. |

## Plans, fingerprints and approvals

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_PLAN_REQUIRED` | An apply is missing `--plan-fingerprint`, or a record apply is missing `--request-id`. | Preview first, then pass the fingerprint (or request ID). |
| `DEVCTX_PLAN_MISMATCH` | The fingerprint does not match the plan built now: flags differ, or sources or state changed since preview. For onboarding, the request ID may already have been applied with another plan. | Preview again with the same flags and review the new fingerprint. |
| `DEVCTX_STALE_VERSION` | Something you based the change on moved: a superseded record's hash (`Target changed`), the registry generation, your profile since preview, an approval or validation receipt, or a file during apply. | Re-read the current state, preview again, and approve the new plan. |
| `DEVCTX_APPROVAL_REQUIRED` | An approval is missing or doesn't match: `confirmed` without `--reviewer`, a stack check that differs from the stored approval, a non-canonical approval response, or hub records that aren't confirmed. | Provide the missing approval, or re-approve the current plan. For the stack watch, run `stack plan` and `stack approve` again. |
| `DEVCTX_CONFLICT` | A request ID was reused with different inputs, `init` or `scope add` differs from what exists, a live config already exists, or an onboarding plan has a blocking conflict. | Use a fresh request ID, or review what already exists. For an interrupted onboarding, follow the remedy: "re-run project onboard with a new --request-id". |

## Projects and records

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_PROJECT_UNBOUND` | The worktree or project is not onboarded in that scope. `details.reason` is `not-bound-in-scope` or `worktree-not-confirmed`; `details.remedy` gives the command. | Check you used the right scope. If so, [onboard the worktree](/docs/guides/onboard-a-repository/). |
| `DEVCTX_SCOPE_UNKNOWN` | The scope has not been added. | Run `scope add`. |
| `DEVCTX_BINDING_CONFLICT` | The worktree is bound to another project, or the project belongs to another repository. | Choose the right project ID, or stop and review existing bindings. |
| `DEVCTX_NOT_FOUND` | Something named does not exist: a skill workspace, a lock to release, or `init` data for `--seed-from-init`. | Create it first, or check the name. |
| `DEVCTX_RECORD_NOT_EXPORTABLE` | A record selected for `handoff export` is missing, superseded or proposed. | Select the current, effective record. |
| `DEVCTX_SCHEMA_UNSUPPORTED` | A stored record has an unsupported schema version. | Stop and check which kit version wrote it. |

## Content safety

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_SENSITIVE_CONTENT` | Text looks like a credential (`details.types`, such as `credential-assignment`), or a hub proposal names the scope, project, paths or hosts. | Remove the secret. Never store credentials in records, profiles or drafts. |
| `DEVCTX_HANDOFF_UNSAFE` | Selected record text can't go into a portable packet: URLs, absolute or home paths, control characters, malformed metadata. | Select different records, or supersede the record with portable text. |
| `DEVCTX_POLICY_UNAVAILABLE` | A `required` scope policy could not be read while building a brief. | Restore the policy file in the hub, or make the policy optional. |

## Limits

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_LIMIT` | A size or count cap was hit: record body (32 KiB), profile (4 KiB), required policies over the brief budget, handoff packet (32 KiB, 12 records), too many sources, Git output over 16 MiB, more than 16 remotes, staged package caps. | Shorten or split the input. Caps are fixed. |

## Interrupted work, locks and integrity

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_BUSY` | Another devctx command holds a lock, or the lock owner is still running. | Wait for it. If nothing is running, preview [`locks release`](/docs/guides/coding-agents/#clear-a-stale-lock). Never delete the lock by hand. |
| `DEVCTX_RECOVERY_REQUIRED` | An earlier operation stopped part way, or stored state is incomplete (binding, manifest, journal). New applies are blocked. | For skill installs, run [`agents recover`](/docs/guides/coding-agents/#recover-an-interrupted-install). Otherwise read `details.remedy`, keep the files, and stop. |
| `DEVCTX_INTEGRITY` | Stored data failed a check: a record bundle doesn't match its hashes or ID, a staged file changed, a seeded template file was edited. `handoff export` names corrupt record IDs in `details.records`. | Don't edit, rename or delete the files. Run `doctor` (its `bundles` check counts corrupt records) and review the files under `dataRoot`. |
| `DEVCTX_SOURCE_CHANGED` | A file changed while devctx was reading it, or between check and write. | Let the file settle and retry. |
| `DEVCTX_ROLLBACK_MISMATCH` | `agents rollback-check` found `devctx-*` entries that differ from the pre-install inventory. | Review the listed changes. Run the check right after uninstalling. |
| `DEVCTX_STORAGE_ERROR` | A filesystem operation devctx needs, such as hard links, failed. | Use a local filesystem that supports hard links. |

## Git

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVCTX_GIT_UNAVAILABLE` | `git` is not installed or not on `PATH`. | Install Git. |
| `DEVCTX_GIT_QUERY_FAILED` | A Git query failed unexpectedly: timeout (30 s), refused repository, other error. `details` names the command. `doctor` reports it under `bound-roots`. | Don't retry around it. Check the repository with the commands in [Live mode](/docs/guides/live-mode/#2-check-the-repository). |

## Network: stack watch

These come from `stack check` and `stack digest`. Per-source failures are reported in the result; run-level ones fail the command.

| Code | Meaning |
| --- | --- |
| `DEVCTX_HOST_NOT_APPROVED` | A request would go to a host not in the stored approval. |
| `DEVCTX_REDIRECT_REFUSED` | The server redirected; redirects are never followed. |
| `DEVCTX_RATE_LIMITED` | The host rate-limited you. `details` may include `retryAfterSeconds` or `resetAt`. |
| `DEVCTX_NETWORK_TIMEOUT`, `DEVCTX_NETWORK_UNAVAILABLE` | The request timed out or could not connect. |
| `DEVCTX_RESPONSE_TOO_LARGE`, `DEVCTX_CALL_LIMIT` | A response or the run exceeded its byte or request cap. |
| `DEVCTX_CONTENT_TYPE_REFUSED`, `DEVCTX_ENCODING_REFUSED` | The response had an unexpected content type or encoding. |
| `DEVCTX_FEED_INVALID`, `DEVCTX_FEED_LIMIT` | A feed could not be parsed, or exceeded a parser limit. |
| `DEVCTX_UPSTREAM_NOT_FOUND`, `DEVCTX_UPSTREAM_FORBIDDEN`, `DEVCTX_UPSTREAM_HTTP`, `DEVCTX_UPSTREAM_UNAVAILABLE`, `DEVCTX_UPSTREAM_INVALID` | The source returned 404/410, 403, another error status, was unavailable, or returned something unexpected. |
| `DEVCTX_PATH_UNSAFE` | The host resolved to a private, loopback, link-local or reserved address and was refused. |

Wait and retry later, or remove the failing source from your plan.

## Network: skill sources

These come from `skill-sources check`, `preview` and `stage`.

| Code | Meaning |
| --- | --- |
| `DEVCTX_SOURCE_NOT_FOUND` | The repository or a pinned object does not exist. |
| `DEVCTX_NO_STABLE_RELEASE` | The latest GitHub release is a draft or prerelease. There is no branch fallback. |
| `DEVCTX_SELECTION_MISSING`, `DEVCTX_SELECTION_CONFLICT`, `DEVCTX_UNSUPPORTED_ENTRY` | A selected path is missing, ambiguous, collides with a directory, or is not a regular file. |
| `DEVCTX_PREVIEW_CHANGED` | Upstream changed between `preview` and `stage`. Preview again. |
| `DEVCTX_STAGE_UNCONFIRMED`, `DEVCTX_STAGE_INCOMPLETE`, `DEVCTX_STAGE_NOT_FOUND` | A stage's outcome is unknown, incomplete or missing. Run `skill-sources inspect` with the run ID. |
| `DEVCTX_RATE_LIMITED`, `DEVCTX_GITHUB_UNAUTHORIZED`, `DEVCTX_GITHUB_FORBIDDEN`, `DEVCTX_UPSTREAM_HTTP`, `DEVCTX_UPSTREAM_UNAVAILABLE`, `DEVCTX_UPSTREAM_INVALID`, `DEVCTX_NETWORK_TIMEOUT`, `DEVCTX_NETWORK_UNAVAILABLE`, `DEVCTX_REDIRECT_REFUSED` | GitHub refused, failed or returned something unexpected. Unauthenticated requests are limited to roughly 60 per hour. |

## Identity checks (not yet exposed)

`DEVCTX_AUTH_UNVERIFIED`, `DEVCTX_AUTH_MISMATCH` and `DEVCTX_APPROVAL_INVALID` exist in the internal auth library, which has no CLI command yet. They will surface with [identity routing](/docs/guides/identity-routing/).

## Internal errors

`DEVCTX_INTERNAL` wraps an unexpected exception; the message is the underlying error, truncated. It is a bug. Report it with a synthetic reproduction; see [Contributing](/docs/project/contributing/).

One known case: `agents status` with a disposable pilot and no `--home` currently fails with `DEVCTX_INTERNAL`. Pass `--home`.
