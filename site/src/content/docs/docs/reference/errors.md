---
title: Errors
description: Every devtwin error code, what it means and what to do about it.
---

A failed command prints one JSON line with `ok: false` and an `error` object:

```json
{"ok":false,"command":"record supersede","error":{"code":"DEVTWIN_STALE_VERSION","message":"Target changed","details":{}}}
```

- `code` always starts with `DEVTWIN_`.
- `message` is a short, fixed description.
- `details` may name the `field`, a `reason`, a `remedy`, or the IDs involved. Read it first.

The process exits with `2` for `DEVTWIN_USAGE` and `1` for every other error.

:::tip[General rule]
devtwin refuses rather than guesses. When a check fails, it has not written anything you didn't approve. Don't edit the pilot, delete locks or journals, or weaken a gate to get past an error. Preview again, or stop and look.
:::

## Usage and the pilot fence

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_USAGE` | Unknown command, unknown or malformed flag, a positional argument, or a duplicate flag. | Check the [CLI reference](/docs/reference/cli/). Exit code 2. |
| `DEVTWIN_GATE_REQUIRED` | A guard refused the call: no `--pilot`, a path outside the fence or on a protected path, a root flag that doesn't match the pilot, a live-config check (`details.field` such as `live.kitRoot`, `live.kitCommit`, `live.approval`, `live.home`), an operation not allowed, or a command not available in live mode. The live stack watch adds reasons `no-live-exception` (no `stackWatch` exception), `scope-required` (no `--scope`) and `host-not-in-exception` (an approved host is not in the exception). The [tier table](/docs/security/security-model/#tiers) adds two cases: `lesson accept` to `general` or `hub+general` (`details.via` is `activity review`), and an agent session past its 20 automatic writes. Backups add `field` `writeClasses.backupTargets` (no approved backup folder) and `to` (a folder that is not approved). | Read `details.field` and `details.reason`. Fix the cause, never the fence. For live mode see [Live mode troubleshooting](/docs/guides/live-mode/#troubleshooting). |
| `DEVTWIN_PATH_UNSAFE` | A path is not canonical, goes through a symlink, has unsafe permissions, or is a repository that Git filters could touch. Also: private roots inside a Git worktree, or `~/.devtwin` not private. | Use the real path (`pwd -P`, `realpath`). Check folder modes are 0700. |
| `DEVTWIN_PATH_ESCAPE` | A relative path tries to leave its root, or an output path is outside the bound worktree. | Use a plain relative path with no `..`. |
| `DEVTWIN_INVALID_ID` | A scope, project, request, record or actor ID is malformed. | See the ID formats in the [CLI reference](/docs/reference/cli/#identifiers). A project ID must start with `<scope>.`. |
| `DEVTWIN_INVALID_INPUT` | A value is invalid: unknown kind or status, bad source reference, malformed JSON input, bad profile field, unknown placeholder, reserved skill name. | Read `details.field` and correct that value. |

## Plans, fingerprints and approvals

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_PLAN_REQUIRED` | An apply is missing `--plan-fingerprint`, or a record apply is missing `--request-id`. | Preview first, then pass the fingerprint (or request ID). |
| `DEVTWIN_PLAN_MISMATCH` | The fingerprint does not match the plan built now: flags differ, or sources or state changed since preview. For onboarding, the request ID may already have been applied with another plan. | Preview again with the same flags and review the new fingerprint. |
| `DEVTWIN_STALE_VERSION` | Something you based the change on moved: a superseded record's hash (`Target changed`), the registry generation, your profile since preview, an approval or validation receipt, or a file during apply. | Re-read the current state, preview again, and approve the new plan. |
| `DEVTWIN_APPROVAL_REQUIRED` | An approval is missing or doesn't match: `confirmed` without `--reviewer`, a stack check that differs from the stored approval or an approval made under another pilot config, a non-canonical approval response, or hub records that aren't confirmed. Also "Needs consent": a consented action, such as `lesson accept --target hub`, with no valid consent for its target (`details.consent` names the kind). | Provide the missing approval, or re-approve the current plan. For the stack watch, run `stack plan` and `stack approve` again. For "Needs consent", the owner runs `consent grant` in their own terminal. |
| `DEVTWIN_CONFLICT` | A request ID was reused with different inputs, `init` or `scope add` differs from what exists, a live config already exists, or an onboarding plan has a blocking conflict. | Use a fresh request ID, or review what already exists. For an interrupted onboarding, follow the remedy: `re-run project onboard with a new --request-id`. |

## Projects and records

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_PROJECT_UNBOUND` | The worktree or project is not onboarded in that scope. `details.reason` is `not-bound-in-scope` or `worktree-not-confirmed`; `details.remedy` gives the command. | Check you used the right scope. If so, [onboard the worktree](/docs/guides/onboard-a-repository/). |
| `DEVTWIN_SCOPE_UNKNOWN` | The scope has not been added. | Run `scope add`. |
| `DEVTWIN_BINDING_CONFLICT` | The worktree is bound to another project, or the project belongs to another repository. | Choose the right project ID, or stop and review existing bindings. |
| `DEVTWIN_NOT_FOUND` | Something named does not exist: a skill workspace, a lock to release, `init` data for `--seed-from-init`, a lesson or lesson proposal ID. | Create it first, or check the name and the scope. |
| `DEVTWIN_RECORD_NOT_EXPORTABLE` | A record selected for `handoff export` is missing, superseded or proposed. | Select the current, effective record. |
| `DEVTWIN_SCHEMA_UNSUPPORTED` | A stored record has an unsupported schema version. | Stop and check which kit version wrote it. |

## Content safety

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_SENSITIVE_CONTENT` | Text looks like a credential (`details.types`, such as `credential-assignment`), or a hub proposal names the scope, project, paths or hosts. | Remove the secret. Never store credentials in records, profiles or drafts. |
| `DEVTWIN_ISOLATION` | Text that leaves a scope names another scope: its ID, display name, a project ID, a bound root path or a remote host, as a whole word. A lesson for your personal store is checked against every scope. | Make the lesson general: drop client, repository, account and host names. |
| `DEVTWIN_HANDOFF_UNSAFE` | Selected record text can't go into a portable packet: URLs, absolute or home paths, control characters, malformed metadata. | Select different records, or supersede the record with portable text. |
| `DEVTWIN_POLICY_UNAVAILABLE` | A `required` scope policy could not be read while building a brief. | Restore the policy file in the hub, or make the policy optional. |

## Limits

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_LIMIT` | A size or count cap was hit: record body (32 KiB), profile (4 KiB), required policies over the brief budget, handoff packet (32 KiB, 12 records), too many sources, Git output over 16 MiB, more than 16 remotes, staged package caps. Also: a fourth lesson proposal in one session, a lesson too long for the owner dialog, or a hub with more than 5000 note files. | Shorten or split the input. Caps are fixed. Don't change the session ID to get past the proposal cap. |

## Lessons, setup and the owner dialog

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_OWNER_DENIED` | The owner dialog was denied or dismissed, or there is no desktop session to show it (also in an SSH session). With `live approval --mode dialog-or-tty`, a wrong code, no answer in 300 seconds or no terminal. Nothing was written. | Run the command yourself in a desktop session, and click **Approve** only for text you reviewed. To answer over SSH, see [Owner answers over SSH](/docs/security/security-model/#owner-answers-over-ssh). |
| `DEVTWIN_UNAVAILABLE` | `setup apply` named a step that is not available yet. | Run `setup status` to see which steps are available. |
| `DEVTWIN_STALE_VERSION` (lessons) | On `lesson accept` of a replacement: another replacement reached the hub first (`already-superseded`). On `published delete`: the file on the hub changed since the preview. | Run `hub sync`, then review what is now on the hub. The proposal stays pending. |
| `DEVTWIN_CONFLICT` (lessons) | On `lesson supersede-propose`: the lesson was `removed` by its author or is already `superseded`. On `hub join`: the scope already has a hub, or another scope joined this hub. | Drop the draft, or leave the other hub first. |
| `DEVTWIN_CONFLICT` (undo and backups) | On `undo`: the entry is already undone, or it is itself an undo. On `backup restore`: the target folder already exists. | Check `activity`, or name a new restore folder. |

## Organization hub

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_HUB_NOT_JOINED` | The scope has not joined a hub. | Run `hub join`, or use a `project` or `general` lesson target. |
| `DEVTWIN_HUB_REMOTE_REFUSED` | The remote is not an SSH remote, or holds a password. | Use `ssh://host/path` or `user@host:path`. |
| `DEVTWIN_HUB_UNREACHABLE` | The remote did not answer, or the clone failed. | Check the SSH key and the remote with `git ls-remote`, then preview again. |
| `DEVTWIN_HUB_INVALID` | The hub has no `hub.json` or no default branch, a hub file is invalid, or the hub ID changed. | Check the hub repository. A changed hub ID needs `hub leave` and a new `hub join`. |
| `DEVTWIN_HUB_READ_ONLY` | The hub uses a newer `schemaVersion` than this kit. `hub sync` and `context brief` show the warning `HUB_SCHEMA_NEWER`. | Upgrade the kit. devtwin reads and writes nothing in that hub until then. |
| `DEVTWIN_HUB_PATH_REFUSED` | A write would touch a file that is not yours: another author's lesson (`other-author`) or another handle's note (`other-handle`). | You can delete only your own items. Ask the author, or the hub admin. |
| `DEVTWIN_HUB_GIT_FAILED` | A Git step on the hub clone failed. | Run `hub status` and `hub sync` again. Items that could not be pushed stay in the outbox. |

## Interrupted work, locks and integrity

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_BUSY` | Another devtwin command holds a lock, or the lock owner is still running. | Wait for it. If nothing is running, preview [`locks release`](/docs/guides/coding-agents/#clear-a-stale-lock). Never delete the lock by hand. |
| `DEVTWIN_RECOVERY_REQUIRED` | An earlier operation stopped part way, or stored state is incomplete (binding, manifest, journal). New applies are blocked. | For skill installs, run [`agents recover`](/docs/guides/coding-agents/#recover-an-interrupted-install). Otherwise read `details.remedy`, keep the files, and stop. |
| `DEVTWIN_INTEGRITY` | Stored data failed a check: a record bundle doesn't match its hashes or ID, a staged file changed, a seeded template file was edited, or a backup archive is changed or was made with another key. `handoff export` names corrupt record IDs in `details.records`. | Don't edit, rename or delete the files. Run `doctor` (its `bundles` check counts corrupt records) and review the files under `dataRoot`. |
| `DEVTWIN_SOURCE_CHANGED` | A file changed while devtwin was reading it, or between check and write. | Let the file settle and retry. |
| `DEVTWIN_ROLLBACK_MISMATCH` | `agents rollback-check` found `devtwin-*` entries that differ from the pre-install inventory. | Review the listed changes. Run the check right after uninstalling. |
| `DEVTWIN_STORAGE_ERROR` | A filesystem operation devtwin needs, such as hard links, failed. | Use a local filesystem that supports hard links. |

## Git

| Code | Meaning | What to do |
| --- | --- | --- |
| `DEVTWIN_GIT_UNAVAILABLE` | `git` is not installed or not on `PATH`. | Install Git. |
| `DEVTWIN_GIT_QUERY_FAILED` | A Git query failed unexpectedly: timeout (30 s), refused repository, other error. `details` names the command. `doctor` reports it under `bound-roots`. | Don't retry around it. Check the repository with the commands in [Live mode](/docs/guides/live-mode/#2-check-the-repository). |

## Network: stack watch

These come from `stack check`, `stack digest` and the radar jobs. Per-source failures are reported in the result; run-level ones fail the command.

| Code | Meaning |
| --- | --- |
| `DEVTWIN_HOST_NOT_APPROVED` | A request would go to a host not in the stored approval. |
| `DEVTWIN_REDIRECT_REFUSED` | The server redirected; redirects are never followed. |
| `DEVTWIN_RATE_LIMITED` | The host rate-limited you. `details` may include `retryAfterSeconds` or `resetAt`. |
| `DEVTWIN_NETWORK_TIMEOUT`, `DEVTWIN_NETWORK_UNAVAILABLE` | The request timed out or could not connect. |
| `DEVTWIN_RESPONSE_TOO_LARGE`, `DEVTWIN_CALL_LIMIT` | A response or the run exceeded its byte or request cap. |
| `DEVTWIN_CONTENT_TYPE_REFUSED`, `DEVTWIN_ENCODING_REFUSED` | The response had an unexpected content type or encoding. |
| `DEVTWIN_FEED_INVALID`, `DEVTWIN_FEED_LIMIT` | A feed could not be parsed, or exceeded a parser limit. |
| `DEVTWIN_UPSTREAM_NOT_FOUND`, `DEVTWIN_UPSTREAM_FORBIDDEN`, `DEVTWIN_UPSTREAM_HTTP`, `DEVTWIN_UPSTREAM_UNAVAILABLE`, `DEVTWIN_UPSTREAM_INVALID` | The source returned 404/410, 403, another error status, was unavailable, or returned something unexpected. |
| `DEVTWIN_PATH_UNSAFE` | The host resolved to a private, loopback, link-local or reserved address and was refused. |

Wait and retry later, or remove the failing source from your plan.

## Network: skill sources

These come from `skill-sources check`, `preview` and `stage`.

| Code | Meaning |
| --- | --- |
| `DEVTWIN_SOURCE_NOT_FOUND` | The repository or a pinned object does not exist. |
| `DEVTWIN_NO_STABLE_RELEASE` | The latest GitHub release is a draft or prerelease. There is no branch fallback. |
| `DEVTWIN_SELECTION_MISSING`, `DEVTWIN_SELECTION_CONFLICT`, `DEVTWIN_UNSUPPORTED_ENTRY` | A selected path is missing, ambiguous, collides with a directory, or is not a regular file. |
| `DEVTWIN_PREVIEW_CHANGED` | Upstream changed between `preview` and `stage`. Preview again. |
| `DEVTWIN_STAGE_UNCONFIRMED`, `DEVTWIN_STAGE_INCOMPLETE`, `DEVTWIN_STAGE_NOT_FOUND` | A stage's outcome is unknown, incomplete or missing. Run `skill-sources inspect` with the run ID. |
| `DEVTWIN_RATE_LIMITED`, `DEVTWIN_GITHUB_UNAUTHORIZED`, `DEVTWIN_GITHUB_FORBIDDEN`, `DEVTWIN_UPSTREAM_HTTP`, `DEVTWIN_UPSTREAM_UNAVAILABLE`, `DEVTWIN_UPSTREAM_INVALID`, `DEVTWIN_NETWORK_TIMEOUT`, `DEVTWIN_NETWORK_UNAVAILABLE`, `DEVTWIN_REDIRECT_REFUSED` | GitHub refused, failed or returned something unexpected. Unauthenticated requests are limited to roughly 60 per hour. |

## Identity checks (not yet exposed)

`DEVTWIN_AUTH_UNVERIFIED`, `DEVTWIN_AUTH_MISMATCH` and `DEVTWIN_APPROVAL_INVALID` exist in the internal auth library, which has no CLI command yet. They will surface with [identity routing](/docs/guides/identity-routing/).

## Internal errors

`DEVTWIN_INTERNAL` wraps an unexpected exception; the message is the underlying error, truncated. It is a bug. Report it with a synthetic reproduction; see [Contributing](/docs/project/contributing/).

One known case: `agents status` with a disposable pilot and no `--home` currently fails with `DEVTWIN_INTERNAL`. Pass `--home`.
