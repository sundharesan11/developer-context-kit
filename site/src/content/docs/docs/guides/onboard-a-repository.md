---
title: Onboard a repository
description: Preview what devtwin would record about a repository, approve the exact plan, and read the resulting context brief.
---

Onboarding turns a repository into a **project** that devtwin knows about. It scans a small, fixed set of files, proposes context records, and binds the worktree to a project ID inside a scope. You see everything first and approve the exact plan.

Onboarding never writes to the repository. All private context is stored under your pilot's data root.

## Before you start

You need:

- A pilot file whose `repos` list contains the repository's real path. In live mode that is `~/.devtwin/live.json`; see [Live mode](/docs/guides/live-mode/).
- `init` and `scope add` applied for that pilot. See [Quickstart](/docs/getting-started/quickstart/).
- A **scope** (for example `example`) and a **project ID** that starts with it (for example `example.atlas`). See [Scopes and projects](/docs/concepts/scopes-and-projects/).

The examples use two shell variables. Both must be absolute, canonical paths (use `pwd -P` or `realpath`):

```sh
PILOT=/absolute/path/to/pilot.json
REPO=/absolute/path/to/atlas
```

## 1. Preview the onboarding

```sh
devtwin project onboard \
  --pilot "$PILOT" --scope example --project example.atlas \
  --repo "$REPO" --environment staging \
  --request-id req_atlas_onboard_01 --accept all
```

Preview writes nothing. The result is one JSON line; the parts to review are:

```json
{
  "candidates": [
    { "cid": "c01", "kind": "brief", "title": "Atlas", "body": "A fictional task tracker." },
    { "cid": "c02", "kind": "command", "title": "Package declarations",
      "body": "name: atlas-demo\nscripts: {\"test\":\"node --test\"}\ndeclared, not executed or verified" },
    { "cid": "c03", "kind": "environment", "title": "Environment staging", "body": "Name only: staging" }
  ],
  "unknowns": ["deployment/ownership unknown until recorded", "test status unknown"],
  "conflicts": [],
  "repoWrites": [],
  "retire": [],
  "fingerprint": "sha256:586cbb34…"
}
```

- **`candidates`** are the records onboarding proposes. Each has a candidate ID (`c01`, `c02`, …).
- **`unknowns`** are things the scan cannot know, such as deployment or test status.
- **`conflicts`** lists problems. A `REMOTE_MISMATCH` conflict (from `--expect-remote`) is blocking.
- **`repoWrites`** is always an empty array. Onboarding does not touch the repository.
- **`fingerprint`** identifies this exact plan.

### What the scan reads

The scanner reads only these files if present: `README.md` (or `README`), `AGENTS.md`, `CLAUDE.md`, `package.json`, `.nvmrc`, `.node-version`, `go.mod`, `pyproject.toml`, `Cargo.toml` and `Makefile`. Add other files with `--doc <repo-relative path>` (repeatable). Text that looks like a credential is skipped instead of proposed.

Package scripts and Makefile targets become **declared** commands. devtwin never runs them.

### Optional inputs

| Flag | Use |
| --- | --- |
| `--doc <path>` | Extra repo-relative file to read and hash. Repeatable. |
| `--environment <name>` | Record an environment name only. Repeatable. |
| `--expect-remote <url>` | Expected Git remote. If none of the repository's remotes match, the plan has a blocking conflict. Repeatable. |
| `--actor <ref>` | Actor reference such as `email:you@example.com`, stored on the binding. Repeatable. |
| `--keep-previous` | When re-onboarding, retire nothing. |

## 2. Choose which candidates to keep

`--accept` decides which candidates become records:

- `--accept all` keeps every candidate.
- `--accept none` keeps none. This is the default.
- `--accept c01,c03` keeps the listed candidates.

Even `--accept none` stores a generated **client profile** record and the project binding. It does not mean "store nothing".

Changing the selection changes the plan, so preview again with the new `--accept` value and review the new fingerprint.

## 3. Apply the approved fingerprint

Repeat every preview flag unchanged and add `--apply --plan-fingerprint`:

```sh
devtwin project onboard \
  --pilot "$PILOT" --scope example --project example.atlas \
  --repo "$REPO" --environment staging \
  --request-id req_atlas_onboard_01 --accept all \
  --apply --plan-fingerprint 'sha256:586cbb34…'
```

```json
{"ok":true,"command":"project onboard","result":{"operationId":"op_acec42756c3bbc296b7b7c32",
 "requestId":"req_atlas_onboard_01","scope":"example","project":"example.atlas",
 "bundles":[{"id":"rec_328eab1ae2a762878dbeeeef","recordHash":"sha256:cc60…"}, …],
 "committedGeneration":1,"replayed":false}}
```

If anything changed between preview and apply (files, registry state, flags), apply refuses with `DEVTWIN_PLAN_MISMATCH` or `DEVTWIN_STALE_VERSION`. Preview again.

:::tip[Request IDs]
The request ID is the idempotency key. Retrying the exact same approved request returns `replayed: true` and does no new work. Reusing a request ID with different inputs is a `DEVTWIN_CONFLICT`. Use a fresh `--request-id` for every new onboarding or refresh.
:::

## 4. Check the result

Resolve the worktree to its project, then read the brief:

```sh
devtwin context resolve --pilot "$PILOT" --scope example --cwd "$REPO"
devtwin context brief   --pilot "$PILOT" --scope example --cwd "$REPO"
```

`context resolve` returns `"state":"bound"`, the `project`, and the `worktree` (`root`, `branch`, `head`, `dirty`). The brief lists the records you accepted with their freshness. See [Briefs](/docs/concepts/briefs/).

Confirm the repository is untouched:

```sh
git -C "$REPO" status --short
```

## Re-onboarding a worktree

When the repository changes, onboard it again with a **new** request ID. By default the new onboarding retires earlier auto-created records from the same worktree path that it re-creates (same kind and title). The preview lists them under `retire`, each with its record ID and hash. Review that list before you approve.

- Only records auto-created by earlier onboardings of the same worktree are candidates for retirement.
- Records you created yourself, and records already superseded, are never retired.
- Retired records are not deleted. They are superseded, so briefs omit them and history keeps them.
- With `--accept none`, only the earlier client profile is replaced.

To keep everything, add `--keep-previous` to both preview and apply. The preview then shows `"retire": []`.

## Wrong scope or unbound worktree

`context resolve` in a scope where the worktree is not bound fails with `DEVTWIN_PROJECT_UNBOUND` and tells you why:

```json
{"ok":false,"command":"context resolve","error":{"code":"DEVTWIN_PROJECT_UNBOUND",
 "message":"Worktree not bound in selected scope",
 "details":{"reason":"not-bound-in-scope","remedy":"project onboard --scope other --repo <worktree>"}}}
```

A reason of `worktree-not-confirmed` means another worktree of the same repository is bound, but this one is not. Resolution matches the exact Git worktree root, never a folder name or remote.

## Next steps

- [Capture decisions](/docs/guides/capture-decisions/) as you work.
- [Install the skills for your coding agent](/docs/guides/coding-agents/) so it can read the brief.
