---
title: Scopes and projects
description: How devctx groups projects into scopes, names them, binds them to exact worktrees, and finds the right project from your working directory.
---

`devctx` organizes context in two levels. A **scope** is a boundary you choose, usually one organization or client. A **project** is one repository inside a scope. Every record belongs to exactly one project, and every project to exactly one scope.

Keeping scopes separate means context from one client never shows up in another client's brief, even when you work on both from the same machine.

## Naming

| Thing | Format | Examples |
| --- | --- | --- |
| Scope ID | 2 to 32 characters: a lowercase letter, then lowercase letters, digits or `-` | `acme`, `personal`, `oss-work` |
| Project ID | The scope ID, a dot, then a name of lowercase letters and digits, optionally split by `.` or `-`. Up to 96 characters in total. | `acme.atlas`, `acme.billing-api`, `personal.dotfiles` |

The project ID must start with its scope. `acme.atlas` can only live in the `acme` scope.

## Create a scope

```sh
devctx scope add --pilot "$PILOT" --scope acme --display-name "Acme Corp"
devctx scope add --pilot "$PILOT" --scope acme --display-name "Acme Corp" --apply
```

```json
{"ok":true,"command":"scope add","result":{"created":true,"scope":"acme"}}
```

A scope's settings are fixed once created. Running `scope add` again with the same settings returns `"created": false`; running it with different settings fails with `DEVCTX_CONFLICT`.

### Optional: knowledge hubs and policies

A scope can point at a local folder of company policy documents, called a hub, and pull named files from it into every brief for that scope:

```sh
devctx scope add --pilot "$PILOT" --scope acme \
  --hub acme-hub=local-dir:$HOME/devctx-inputs/acme-hub \
  --policy pol_security=acme-hub:policies/security.md:required \
  --apply
```

- `--hub <id>=local-dir:<absolute path>` names the folder. It must sit inside your pilot's `inputsRoot`.
- `--policy pol_<name>=<hub id>:<relative path>` names a file in that hub. Add `:required` and a brief fails with `DEVCTX_POLICY_UNAVAILABLE` when the file can't be read, rather than quietly leaving it out.

Most people don't need hubs. Skip them unless you have shared policy text you want in every brief.

## Bind a project to a worktree

You create a project by onboarding a repository into it:

```sh
devctx project onboard --pilot "$PILOT" \
  --scope acme --project acme.atlas --repo $HOME/code/atlas
```

This binds the **exact worktree path** to the project. `--repo` must be the root of a Git worktree, and its path must be listed in your pilot's `repos`. See [Onboard a repository](/docs/guides/onboard-a-repository/) for the full preview-and-apply flow.

A few rules keep the mapping unambiguous:

- **The path identifies the project, not the remote.** The Git remote URL is stored as supporting evidence only.
- **One worktree, one project.** A worktree already bound to one project can't be onboarded into another; that fails with `DEVCTX_BINDING_CONFLICT`.
- **One project, one repository.** Worktrees made with `git worktree add` share a repository, so you can add each of them to the same project by onboarding it. A separate clone is a different repository, even if it has the same remote, and is refused with `DEVCTX_BINDING_CONFLICT`.
- **You choose the scope.** `devctx` never guesses a scope from a folder name. You pass `--scope` every time.

If you want to make sure you're onboarding the repository you think you are, pass `--expect-remote <url>`. When none of the repository's remotes match, the preview reports a blocking `REMOTE_MISMATCH` conflict and the apply is refused.

## How devctx finds your project

`context resolve` and `context brief` take a scope and a working directory:

```sh
devctx context resolve --pilot "$PILOT" --scope acme --cwd "$(pwd -P)"
```

`devctx` finds the Git worktree root that contains `--cwd`, then looks for that exact path among the scope's bindings. Any folder inside the worktree works.

On success, the result names the `project` and the `worktree` (root, branch, commit and whether it has uncommitted changes).

When there's no match, you get `DEVCTX_PROJECT_UNBOUND` with a reason:

| `details.reason` | What it means | What to do |
| --- | --- | --- |
| `not-bound-in-scope` | This worktree isn't onboarded in this scope. Check the scope, or onboard it. | `project onboard --scope <scope> --repo <worktree>` |
| `worktree-not-confirmed` | Another worktree of the same repository is onboarded, but not this one. | Onboard this worktree into the same project. |

Paths must be canonical. A path through a symbolic link, such as `/tmp/...` on macOS (which really lives at `/private/tmp/...`), fails with `DEVCTX_PATH_UNSAFE`. Use `"$(pwd -P)"` or `realpath` to get the real path.

## Onboarding again

Repositories change. To refresh a project, onboard the same worktree again with a new `--request-id`. By default, the new onboarding retires the records that earlier onboardings of that worktree created and that it now re-creates, such as the client profile. Records you wrote yourself are never retired, and retired records are superseded rather than deleted. The preview lists what it will retire under `retire`, and `--keep-previous` retires nothing.

The [Onboard a repository](/docs/guides/onboard-a-repository/) guide covers this in detail.
