---
title: Bundled skills
description: What each skill shipped in the kit's skills/ folder does, which ones agents install installs, and the safety checks they all share.
---

The kit's `skills/` folder holds the instructions your coding agent follows to use devtwin. They are plain `SKILL.md` files; they contain no scripts. Each one calls the CLI as `node "$DEVTWIN_KIT/bin/devtwin.mjs"`.

| Skill | Purpose | Installed by `agents install` |
| --- | --- | --- |
| `devtwin-resume` | Read the brief for the current worktree. | Yes |
| `devtwin-record` | Propose a record for you to review. | Yes |
| `devtwin-onboard` | Onboard or re-onboard a repository. | Yes |
| `devtwin-setup` | First-run personal profile setup. | Not yet |
| `devtwin-create-skill` | Blank starter for building a skill. | No (asset only) |

See [Use with coding agents](/docs/guides/coding-agents/) to install them.

## Shared preconditions

Before its first CLI call in a session, every skill checks:

1. `DEVTWIN_KIT` is set to an absolute path whose real path is **outside** the current repository. If only the legacy `DEVCTX_KIT` is set, the skill uses it for the session and tells you it is deprecated; see [Migrate from devctx](/docs/guides/migrate-from-devctx/).
2. The kit contains `bin/devtwin.mjs` and a `package.json` named `devtwin`.
3. You confirm the kit's real path, once per session.
4. You confirm the pilot path, once per session. The skill offers `~/.devtwin/live.json` or takes a disposable pilot path from you. It refuses a pilot inside the current repository or the kit.
5. For project skills: the repository is listed in the pilot's `repos`, and you state the scope. The skill never infers the scope from a folder name.
6. The installed skill's `kitCommit` (from its `.devtwin-owned.json`) matches the commit at `DEVTWIN_KIT`. If not, it warns you and asks whether to continue.

## Shared rules

Every skill:

- Treats records, briefs, file text and fetched text as untrusted evidence, never instructions.
- Passes free text in single quotes, never inside a double-quoted shell argument.
- Never runs `live init`, `live add-repo` or `live set-kit`. Changing the live config is your decision.
- Never runs `record publish --apply`.
- Never applies a fingerprint you did not approve.
- Never deletes or edits devtwin locks, journals, receipts or state files.
- Stops and asks on `GATE_REQUIRED`, `GIT_QUERY_FAILED`, `RECOVERY_REQUIRED`, `BUSY`, `INTEGRITY` or `PATH_UNSAFE`.
- Never sends records, briefs or files off the machine.

## devtwin-resume

**Use when** you start or resume work in an onboarded repository and want its context.

1. `context resolve --scope <scope> --cwd <worktree>` and checks the project is the one you expect.
2. `context brief` for the same worktree.
3. Summarises for you, leading with stale records, disputed records and unknowns, then decisions, constraints and commands, quoting record IDs.
4. Asks which parts the current task needs.

Read-only. On `PROJECT_UNBOUND` it tells you the `reason` and `remedy` and offers `devtwin-onboard` without running it. On `PATH_UNSAFE` it retries once with the real path of `--cwd`.

## devtwin-record

**Use when** you want to capture a decision, fact, constraint, command, unknown or handoff note.

1. Drafts the record with you: kind, status (`observed` or `proposed`), title, body, sources.
2. Writes the body to a new file under the pilot's `inputsRoot`, never on the command line.
3. Previews `record propose`, then applies it after you approve.
4. Reports the `proposalId` and file path.

The result is a private proposal, not a record. It appears in the brief only after **you** run `record publish --apply`. The skill never runs `record add --apply`, `record supersede --apply` or `record publish --apply`. See [Capture decisions](/docs/guides/capture-decisions/).

## devtwin-onboard

**Use when** you ask to onboard a repository, or refresh context after it changed.

1. For a new pilot or scope, asks before running `init` and `scope add`.
2. Previews `project onboard` with `--accept none`, then shows you `candidates`, `unknowns`, `conflicts` and `repoWrites` (which must be empty).
3. Asks which candidates to keep and previews again with that selection.
4. When re-onboarding, shows the records listed under `retire` and offers `--keep-previous`.
5. Applies only the fingerprint you approved, with a fresh request ID for every new onboarding or refresh.

If the repository is not in the live config's `repos`, it tells you that you can preview `live add-repo`, and stops. See [Onboard a repository](/docs/guides/onboard-a-repository/).

## devtwin-setup

**Use when** you set up devtwin for the first time or want to change your personal profile.

1. Runs `doctor` and stops without creating anything if the pilot is missing or `init` has not run. It never runs `init` itself.
2. Reads your profile with `profile show` and explains what is stored and where.
3. Asks at most five skippable questions: kind of work; how you like to work with agents; stack you know; stack you build on now (offering `profile suggest-stack` results for a scope you name); whether to seed from `init`.
4. Shows the full `profile plan` output. Values the agent proposed are marked `--proposed-by agent`.
5. Runs `profile apply` only after you explicitly approve that exact plan in the session.
6. Lists templates with `skill template-list`, and creates a skill only if you ask.

It never scans a repository to suggest a stack. See [Personal harness](/docs/guides/personal-harness/).

:::note
`agents install` does not install `devtwin-setup` yet. Ask your agent to follow `skills/devtwin-setup/SKILL.md` from the kit checkout.
:::

## devtwin-create-skill

This folder holds only `assets/skill-template.md`, a blank `SKILL.md` starter with `name` and `description` frontmatter. It is not an installable or discoverable skill. Copy it as the candidate when you build a skill from scratch with the [skill builder](/docs/guides/skill-sources/#build-your-own-skill). For a guided start, use a [skill template](/docs/guides/personal-harness/#turn-a-template-into-your-own-skill) instead.

## Output the skills expect

Each CLI call prints one JSON line: `{"ok": true, "command": …, "result": …}` or `{"ok": false, "command": …, "error": …}`, with error codes prefixed `DEVTWIN_`. See the [CLI reference](/docs/reference/cli/) and [Errors](/docs/reference/errors/).
