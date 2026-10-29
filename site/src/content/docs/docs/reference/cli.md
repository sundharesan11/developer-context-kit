---
title: CLI reference
description: Every devtwin command, grouped by task, with its flags, what it writes and an example.
---

Run devtwin from a checkout of the kit:

```sh
node bin/devtwin.mjs <command> [flags]
```

The examples below use the `devtwin` alias from [Installation](/docs/getting-started/installation/#3-add-a-devtwin-alias). Without it, run `node bin/devtwin.mjs` from the checkout. Live-mode commands run from the pinned kit clone, so their examples spell out `node "$KIT/bin/devtwin.mjs"`.

devtwin is not published to npm yet. It has no third-party runtime dependencies and needs Node.js 22.13 or later. macOS is the reference platform.

## Conventions

### Output

Every command prints exactly one JSON line to standard output.

On success:

```json
{"ok":true,"command":"scope add","result":{"created":true,"scope":"example"}}
```

On failure:

```json
{"ok":false,"command":"context resolve","error":{"code":"DEVTWIN_PROJECT_UNBOUND","message":"Worktree not bound in selected scope","details":{"reason":"not-bound-in-scope","remedy":"project onboard --scope other --repo <worktree>"}}}
```

`error.code` always starts with `DEVTWIN_`. `details` is an object that may be empty. See [Errors](/docs/reference/errors/).

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Success (`ok: true`). |
| `1` | Any error except usage errors. |
| `2` | `DEVTWIN_USAGE`: unknown command, unknown or malformed flag. |

### The pilot fence

Every command except `help`, `version`, `skill-sources catalog`, `skill-sources check`, `skill-sources preview` and `skill template-list` requires `--pilot <file>`: the absolute path of a [pilot file](/docs/reference/configuration/#pilot-file) or of the live config `~/.devtwin/live.json`. Without it, the command fails with `DEVTWIN_GATE_REQUIRED` ("v0 runs only inside a pilot fence").

Most commands also accept `--config-root`, `--data-root` and `--state-root`. They are optional; if given, they must equal the pilot's roots or the command fails with `DEVTWIN_GATE_REQUIRED`. The `live`, `handoff export`, `skill-sources` and `skill template-list` commands do not accept them.

Flags are strict: unknown flags and positional arguments fail with `DEVTWIN_USAGE`.

### Preview and apply

Commands that write follow one of three patterns:

| Pattern | Commands |
| --- | --- |
| Preview, then `--apply` | `init`, `scope add`, `record add`, `record supersede`, `record propose`, `record publish`, `hub propose`, `lesson propose`, `lesson supersede-propose` |
| Preview, then `--apply --plan-fingerprint <fp>` | `project onboard`, `live *`, `agents install/uninstall/recover`, `locks release`, `draft save`, `stack digest`, `radar guide`, `schedule off`, `lesson edit/reject/accept/copy`, `lesson notices --ack`, `hub join/leave/schedule`, `note revoke/consent`, `published delete`, `consent grant/revoke`, `project set`, `learning send`, `undo`, `review apply`, `backup create/restore`, `backup key export`, `paths confirm` |
| Preview command, then a separate apply command with `--plan-fingerprint` | `profile plan` → `profile apply`, `stack plan` → `stack approve`, `setup plan` → `setup apply`, `schedule plan` → `schedule apply` |
| No preview | `lesson index` and `hook verify` write only devtwin's own state. `hub sync` fetches and pushes items you already approved. |

The skill builder and skill-source installers add separate recorded approvals; see their sections.

### Owner actions

Some commands need you at the keyboard: the **always ask** tier of the [tier table](/docs/security/security-model/#tiers). When the [devtwin hook](/docs/guides/lessons-and-hooks/#the-owner-action-block) is installed, it denies them from an agent shell. `lesson copy`, `published delete`, `hub join`, `record publish`, `live *`, `agents install`, `agents uninstall`, `hub leave`, `hub schedule`, `schedule off`, `lesson notices`, `note revoke`, `note consent`, `consent grant`, `consent revoke`, `project set`, `undo`, `review apply`, `backup restore`, `backup key export`, `paths confirm`, `pref accept` and `pref retire` are denied with `--apply`; their previews stay open to agents. `instructions apply` and `schedule apply` are always denied; their previews are `instructions plan` and `schedule plan`. Most owner actions also show a macOS dialog with the exact content; a denied or dismissed dialog fails with `DEVTWIN_OWNER_DENIED` and writes nothing. This page marks each one **Owner**.

`lesson accept` is not an owner action. Agents run it for the `project` and `repo` targets, and for the `hub` target while you hold a `hub-publish` consent. `record add` and `record supersede` of `confirmed` or `disputed` knowledge, or of a write that replaces a `confirmed` or `disputed` record, are not denied by the hook but show the owner dialog whoever runs them.

### Identifiers

| ID | Format | Example |
| --- | --- | --- |
| Scope | `^[a-z][a-z0-9-]{1,31}$` | `example` |
| Project | starts with `<scope>.` | `example.atlas` |
| Request | `req_` + 8–64 of `a-z 0-9 _ -` | `req_atlas_decision_01` |
| Record | `rec_` + 24 hex | `rec_94315938d3e27ab174b5665d` |
| Actor | `email:`, `github:`, `slack:`, `linear:` or `handle:` + up to 128 safe characters | `email:you@example.com` |

---

## Setup and maintenance

### `help`

Lists every command. No pilot needed.

```sh
devtwin help
```

### `version`

Prints the kit name and version. No pilot needed.

```sh
devtwin version
# {"ok":true,"command":"version","result":{"name":"devtwin","version":"0.0.0-local"}}
```

### `doctor`

Read-only health check of the pilot. Reports `node`, `git`, `roots`, `locks`, `orphan-staging`, `registry`, `bundles` (corrupt record count), `install-journals` and `bound-roots`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |

```sh
devtwin doctor --pilot "$PILOT"
```

### `init`

Creates the pilot's private config, data and state roots, `user.json` and an empty registry. Preview without `--apply`. Re-running with the same inputs is a no-op; different inputs are a `DEVTWIN_CONFLICT`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--actor <ref>` | Your actor reference. Repeatable. |
| `--preference <key>=<value>` | `explanationStyle` (`concise`/`detailed`), `diagrams` (`prefer`/`avoid`/`neutral`) or `notes`. Repeatable. |
| `--apply` | Write. |

```sh
devtwin init --pilot "$PILOT" --actor email:you@example.com --apply
```

### `scope add`

Creates a scope. Preview without `--apply`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--display-name <text>` | Optional; defaults to the scope ID. |
| `--hub <id>=local-dir:<abs path>[:<purposes>]` | A local knowledge hub under `inputsRoot`. Repeatable. |
| `--policy <pol_id>=<hub id>:<relative path>[:required]` | A policy file inside a hub. Repeatable. |
| `--apply` | Write. |

```sh
devtwin scope add --pilot "$PILOT" --scope example --apply
```

### `locks release`

Releases a stale lock left by a killed command. Apply removes it only if it belongs to this machine, its owner process is gone, and it has not changed since the preview.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--lock <install\|live>` | Required. |
| `--apply --plan-fingerprint <fp>` | Release. |

```sh
devtwin locks release --pilot "$PILOT" --lock install
```

## Live config

These commands manage `~/.devtwin/live.json`. They must run from the kit clone the live config names (for `live set-kit`, the new clone). `--pilot` must be an absolute path. See [Live mode](/docs/guides/live-mode/).

### `live init`

Creates the live config and the private store next to it.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. Path of the new live config, inside an existing private 0700 folder. |
| `--agent <claude\|codex>` | Required, repeatable. |
| `--repo <path>` | Repository to allow. Repeatable. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" live init --pilot "$HOME/.devtwin/live.json" --agent claude --agent codex --repo "$REPO"
```

### `live add-repo`

Adds one repository to the live config.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--repo <path>` | Required. |
| `--apply --plan-fingerprint <fp>` | Write. |

### `live set-kit`

Moves the live config to a new kit clone and commit. Run it from the new clone.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--commit <sha>` | Required. 40 or 64 hex characters. |
| `--apply --plan-fingerprint <fp>` | Write. |

### `live migrate`

Copies a live setup made under the old devctx name to a new live config folder. Run it from the new kit clone. It never changes or deletes the old folder. See [Migrate from devctx](/docs/guides/migrate-from-devctx/).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. Path of the new live config, inside an existing private 0700 folder that holds only the kit. |
| `--from <file>` | Required. Path of the legacy live config, such as `~/.devctx/live.json`. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$HOME/.devtwin/kit/bin/devtwin.mjs" live migrate --pilot "$HOME/.devtwin/live.json" --from "$HOME/.devctx/live.json"
```

### `live write-classes`

**Owner** with `--apply`. Changes the approved [write classes](/docs/reference/configuration/#write-classes): the only paths outside the store that devtwin may write. Each class flag replaces the paths of that class; a class you do not name stays as it is.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. The live config. |
| `--hub-root <folder>` | A folder inside your home for hub clones. Repeatable. |
| `--instruction-target <file>` | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` or a `devtwin*.md` file in one of those folders. Repeatable. |
| `--hook-target <file>` | `~/.claude/settings.json` or `~/.codex/hooks.json`. Repeatable. |
| `--launch-agent <file>` | A `devtwin.<name>.plist` file in `~/Library/LaunchAgents`. Repeatable. |
| `--backup-target <folder>` | A folder inside your home for backup archives and restores. Repeatable. |
| `--repo-learnings <root>` | A listed repository root that may get learning branches from `lesson accept --target repo`. Repeatable. |
| `--clear <class>` | Remove a class: `hubRoot`, `instructionTargets`, `hookTargets`, `launchAgents`, `backupTargets` or `repoLearnings`. Repeatable. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" \
  --hook-target "$HOME/.claude/settings.json" --hook-target "$HOME/.codex/hooks.json"
```

The preview shows each class `from` and `to` and the config digest before and after. A path with the wrong shape fails with `DEVTWIN_GATE_REQUIRED`; a request that changes nothing fails with `DEVTWIN_INVALID_INPUT`.

### `live stack-watch`

**Owner** with `--apply`. Sets the `stackWatch` [live-mode exception](/docs/reference/configuration/#stack-watch-exception): the hosts the stack watch and the radar may reach in live mode, and a request cap for one run. See [Stack watch and radar](/docs/guides/stack-watch/#live-mode).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. The live config. |
| `--host <host>` | A host the watch may reach. Repeatable, at most 32. The flags replace the whole list. |
| `--max-requests <n>` | The cap for one run, from 1 to 50. Default 30. |
| `--off` | Remove the exception. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" live stack-watch --pilot "$LIVE_CONFIG" --host api.github.com --host changelog.example.com
```

Take the hosts from the `hosts` list of `stack plan`. After a change, run `stack plan` and `stack approve` again.

### `live approval`

**Owner** with `--apply`. Sets how you answer an always-ask prompt: the live config key `approval`. See [Owner answers over SSH](/docs/security/security-model/#owner-answers-over-ssh).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. The live config. |
| `--mode <mode>` | Required. `dialog` (the default) or `dialog-or-tty`. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

```sh
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty
```

With `dialog-or-tty` and no GUI session, such as over SSH, the prompt and a six-letter code go to the terminal. Type the code to approve. In a GUI session the dialog is still required. The key is part of the approved config digest, so a change ends the [path confirmation](#paths-confirm).

## Projects and context

### `project onboard`

Scans a repository, proposes records and binds the worktree to a project. Never writes to the repository. See [Onboard a repository](/docs/guides/onboard-a-repository/).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--project <id>` | Required. |
| `--repo <path>` | Required. Canonical repository root, listed in the pilot's `repos`. |
| `--request-id <id>` | Recommended. Defaults to a value derived from the inputs; use a new one for each refresh. |
| `--accept all\|none\|c01,c02` | Candidates to keep. Default `none`. |
| `--doc <rel path>` | Extra file to read. Repeatable. |
| `--environment <name>` | Repeatable. |
| `--expect-remote <url>` | Repeatable. |
| `--actor <ref>` | Repeatable. |
| `--keep-previous` | Retire no earlier records. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
devtwin project onboard --pilot "$PILOT" --scope example --project example.atlas \
  --repo "$REPO" --request-id req_atlas_onboard_01 --accept all
```

### `project set`

**Owner** with `--apply`. Sets where a project's lessons go in its repository, after the owner dialog. A change voids the repository's `repo-push` consent; the preview lists it.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>`, `--project <id>` | Required. An onboarded project. |
| `--learnings-dir <rel path>` | The repo-relative folder a learning branch adds its file to. Default `docs/solutions/lessons`. |
| `--learnings-base <ref>` | The remote-tracking ref a learning branch starts from, such as `refs/remotes/origin/main`. A local branch is refused. `default` uses the branch that `refs/remotes/origin/HEAD` names. The daily import reads `docs/solutions` from the same base. |
| `--apply --plan-fingerprint <fp>` | Write. |

### `context resolve`

Finds the project bound to a worktree. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--cwd <path>` | Required. Canonical path inside the worktree. |

```sh
devtwin context resolve --pilot "$PILOT" --scope example --cwd "$REPO"
```

Returns `state`, `scope`, `project`, `binding`, `worktree` (`root`, `branch`, `head`, `dirty`), `cwdRelative` and `warnings`.

### `context brief`

Builds the bounded brief for a worktree: at most 12 items and 24,576 body bytes. Read-only. Same flags as `context resolve`. See [Briefs](/docs/concepts/briefs/).

```sh
devtwin context brief --pilot "$PILOT" --scope example --cwd "$REPO"
```

Returns `notice`, `worktree`, `warnings`, `preferences`, `profile`, `policies`, `records`, `review`, `unknownIds`, `disputedIds`, `omittedIds`, `receipt` and `briefHash`.

### `handoff export`

Writes a private Markdown packet of explicitly selected records. See [Handoffs](/docs/concepts/handoffs/).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--cwd <path>` | Required. |
| `--record <id>` | Required, repeatable. Up to 12. |
| `--as-of <timestamp>` | Required. UTC with milliseconds, such as `2026-10-25T00:00:00.000Z`. |
| `--out <file>` | Required. A new `<name>.handoff.md` directly inside `dataRoot/exports/handoffs/<scope>/<project>/`. |

```sh
devtwin handoff export --pilot "$PILOT" --scope example --cwd "$REPO" \
  --record rec_42cda2baa21c74516c2d593c --as-of 2026-10-25T00:00:00.000Z \
  --out "$DATA_ROOT/exports/handoffs/example/example.atlas/atlas.handoff.md"
```

Returns `records`, `packetHash`, `fileHash`, `bytes`, `output` and `"publication":"not-approved"`.

### `handoff write`

Stores a handoff record: where the session stopped, the next step and where the artifacts are. **Automatic**: it needs no approval, and it is audited like `record add`. See [Handoffs](/docs/concepts/handoffs/#write-a-handoff-from-an-agent).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>`, `--project <id>` | Required. |
| `--stopped <text>` | Required. One plain line, at most 300 characters. |
| `--next <text>` | Required. One plain line, at most 300 characters. |
| `--artifact <text>` | Repeatable, up to 10. One plain line each, at most 200 characters. |
| `--session <id>` | The session ID from the hook's session-start line. A handoff from that session hides the stop line at the next start. |
| `--request-id <id>` | Required with `--apply`. |
| `--apply` | Writes the record. Without it, the command shows the body and writes nothing. |

Returns `recordId` and `audit`.

### `import run`

Imports new and changed Claude Code memory and `docs/solutions` files of each onboarded repository as `observed` project records. **Automatic**: it needs no approval, and each record it writes is audited. The `import-daily` job runs it once a day. Takes `--pilot`.

It reads only the Claude Code folder that belongs to the repository, and the `docs/solutions` files of the remote default branch, never the working copy. It writes only in the store. One run writes at most 100 items, preference proposals included.

Only the `import-daily` job writes as the job. A run from a shell writes as its caller, like `record add`, and the caller's session and day limits count its writes. The first write over a limit waits in `activity review`, and the run stops there; the rest wait for a later run.

Returns `runId`, `projects` (with `memory` and `solutions` states such as `read`, `ambiguous` or `no-learnings-base`), `written`, `preferences`, `unchanged`, `skipped`, `refused`, `deferred`, `ambiguous`, `notOnboarded`, `unmapped` and `parked`. After a stop at a limit, `capped` names the limit. A refused item names its source and error code, never its text.

## Records

`record add`, `record supersede` and `record propose` share these flags:

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>`, `--project <id>` | Required. |
| `--kind <kind>` | Required. `brief`, `map`, `command`, `environment`, `constraint`, `fact`, `decision`, `experiment`, `unknown`, `handoff` or `lesson`. The project store refuses `preference`, which never has project reach. For a lesson with match rules, use [`lesson propose`](#lesson-propose). |
| `--title <text>` | Required. One line, up to 200 characters. |
| `--body <text>` or `--body-file <file>` | Optional, not both. Up to 32,768 bytes. The file must be under `inputsRoot`. |
| `--status <status>` | `observed` (default), `confirmed`, `disputed` or `proposed`. |
| `--reviewer <actor>` | Required for `confirmed`. |
| `--source <ref>` | Repeatable, up to 20. `file:`, `commit:`, `record:`, `issue:`, `user:` or `url:`. |
| `--location <kind>:<name>:<where>` | `environment` records only. Repeatable, up to 20. Says where something lives, never its value. See [Locations](#locations). |
| `--request-id <id>` | Required with `--apply`. |
| `--session <id>` | Optional. The session ID from the hook's session-start line. It is kept in the audit entry, which `activity` shows, and counts toward the session cap. |
| `--apply` | Write. Without it, the command previews and returns the `recordId`. |

`record add` and `record supersede` of `observed` or `proposed` knowledge are automatic writes. A `confirmed` or `disputed` record, or a write that replaces a `confirmed` or `disputed` record, shows the owner dialog first. Every write adds an entry to the audit log. An agent session makes at most 20 automatic writes; writes with no `--session` share one count per caller and UTC day, and a caller makes at most 100 a day across all sessions. `--kind retraction` is refused: only `undo` writes one. See [`activity`](#activity) and [`undo`](#undo).

### `record add`

Writes a new record. See [Capture decisions](/docs/guides/capture-decisions/).

```sh
devtwin record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind decision --title "Use server-side search" --body "Filter on the server." \
  --request-id req_atlas_decision_01 --apply
```

### Locations

An `environment` record can say where things live. Each `--location` has three parts:

- `kind` is `file`, `directory`, `host`, `service` or `secret-store`.
- `name` is a short label, up to 80 characters, with no colon.
- `where` is a repository-relative path, a path under `~/`, a host name or a named service. Everything after the second colon belongs to it, so a port is fine.

```sh
devtwin record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind environment --title "Environment staging" \
  --location "file:DB URL:.env" --location "host:Queue:queue.example.com:5672" \
  --request-id req_atlas_env_01 --apply
```

A place that looks like a value is refused with `DEVTWIN_SENSITIVE_CONTENT`: a credential, a URL with a user name or a query, anything with `=`, or a long random-looking string. Absolute paths and `..` segments are refused with `DEVTWIN_INVALID_INPUT`. The brief shows each location on its own line, as `DB URL (file): .env`.

### `record supersede`

Writes a successor that replaces one or more records. Adds:

| Flag | |
| --- | --- |
| `--target <record id>` | Repeatable. |
| `--expect-hash <record hash>` | One per target, in the same order. |

### `record propose`

Writes a private, unreviewed proposal file instead of a record. Returns `proposalId` and `path`.

### `record publish`

Turns a proposal into an `observed` record. Without `--apply`, only echoes the proposal ID.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>`, `--project <id>` | Required. |
| `--proposal <prop_id>` | Required. |
| `--reviewer <actor>` | Optional. |
| `--apply` | Write. |

### `hub propose`

Prepares a company learning proposal from confirmed records. With `--apply`, writes a private proposal file; never writes to the hub.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>`, `--project <id>` | Required. |
| `--record <id>` | Required, repeatable. Each must be confirmed and current. |
| `--hub <id>` | Required. A hub listed in the scope config. |
| `--apply` | Write. |

## Personal profile

See [Personal harness](/docs/guides/personal-harness/).

### `profile show`

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--generation <n>` | Read an earlier revision. |

### `profile plan`

Previews a new profile revision. Writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--work <text>` | Kind of work. |
| `--preference <key>=<value>` | `explanationStyle`, `diagrams`, `autonomy` or `notes`. Repeatable. |
| `--stack-current <entry>` | `name[=version][:care]`. Repeatable. |
| `--stack-known <entry>` | Same format. Repeatable. |
| `--writing <key>=<value>` | `tone`, `greeting`, `signOff`, `length`, `spelling`, `avoidPhrases` or `formality.<audience>`. Repeatable. |
| `--seed-from-init` | Fill unset preferences from `init`. |
| `--proposed-by <agent\|user>` | Who proposed the values. Default `user`. |
| `--interest <term>[:weak\|:strong]` | A [radar](/docs/guides/stack-watch/#interests-and-ranking) interest. Repeatable. |
| `--radar-format <md\|html>` | The default digest format. |

```sh
devtwin profile plan --pilot "$PILOT" --work 'Backend services' --stack-current 'node=>=22:high'
```

### `profile apply`

Same flags as `profile plan`, plus `--plan-fingerprint <fp>` (required). Writes a new revision.

### `profile export`

Renders the profile as Markdown. Writes nothing. Accepts `--generation <n>`.

### `profile suggest-stack`

Suggests stack entries from a scope's onboarded projects, with citations. Writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |

## Stack watch

See [Stack watch and radar](/docs/guides/stack-watch/). With a live config, `stack check` and `stack digest` need the [`stackWatch` exception](#live-stack-watch) and `--scope`.

### `stack plan`

Lists watched items, sources and every host that would be contacted. No network, no writes.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--with <group>` | `advisories`, `lifecycle`, `versions` or `radar`. Repeatable. |
| `--feed <name>=<https URL>` | Add a feed for a declared item. Repeatable. |
| `--map <name>=<kind>:<id>` | Add a GitHub, endoflife.date or package identifier. Repeatable. |
| `--clear-overrides` | Drop carried-forward overrides. |

### `stack approve`

Stores the approval for a plan. Same flags as `stack plan`, plus `--plan-fingerprint <fp>` (required).

```sh
devtwin stack approve --pilot "$PILOT" --plan-fingerprint 'sha256:…'
```

### `stack check`

Fetches from approved hosts and returns findings. Writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Optional. Match against this scope's records. |

### `stack digest`

Preview runs the watch and writes a pending file; apply writes the dated digest and seen state without a request.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Optional. Required in live mode. |
| `--format <md\|html>` | The digest format. Default: the profile's radar format, else `md`. |
| `--apply --plan-fingerprint <fp>` | Write the digest. |

### `radar guide`

Previews a "how to try this" note for one radar item of the scope's latest applied digest. With `--apply`, writes it under `guides/radar/`. Makes no request.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Optional. The scope of the digest. |
| `--item <id>` | Required. The 12-character `item` value in the digest. |
| `--apply --plan-fingerprint <fp>` | Write the guide. |

```sh
devtwin radar guide --pilot "$PILOT" --scope acme --item 0123456789ab
```

## Schedules

These jobs run in the background: `radar-weekly`, `advisory-hourly` and `review-monthly` for the radar, `activity-weekly` for the weekly activity notification, `backup-daily` for the [daily backup](/docs/guides/live-mode/#backup-and-restore), `learning-send` for the hourly send of [held items](/docs/guides/organization-hub/#held-items), and `import-daily` for the daily [`import run`](#import-run). Each is a user LaunchAgent. See [Schedules](/docs/guides/stack-watch/#schedules).

### `schedule plan`

Shows the LaunchAgent path, the command it runs and the off switch for one job. Writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--job <job>` | Required. `radar-weekly`, `advisory-hourly`, `review-monthly`, `activity-weekly`, `backup-daily`, `learning-send` or `import-daily`. |

### `schedule apply`

**Owner**. Shows the owner dialog, writes the plist and loads it. The radar and advisory jobs need a stack approval. The advisory job also needs the radar job on and the `advisories` group. The backup job needs an approved `backupTargets` folder.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--job <job>` | Required. |
| `--plan-fingerprint <fp>` | Required. From `schedule plan`. |

### `schedule off`

Unloads the job and removes its plist. Turning off `radar-weekly` also turns off `advisory-hourly`. **Owner** with `--apply`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--job <job>` | Required. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

### `schedule status`

Reports, for each job, whether it is on, installed and loaded, and its last run. Makes no request. Takes `--pilot`.

### `schedule run`

The command the LaunchAgent runs. Takes `--pilot` and `--job`. It checks the live gate, the job's flag and its last-run receipt before any request. A job that is off writes nothing, and a run inside the job's period is skipped.

## Drafts

### `draft save`

Saves a draft privately. Never sends.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--body-file <file>` | Required. Under `inputsRoot`. |
| `--scope <id>` | Optional. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
devtwin draft save --pilot "$PILOT" --scope example --body-file "$INPUTS/draft.md"
```

## Agent skills

See [Use with coding agents](/docs/guides/coding-agents/).

### `agents install` / `agents uninstall`

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--home <path>` | Required with a disposable pilot (one of its `agentHomes`). Omit in live mode. |
| `--agent <claude\|codex>` | Required, repeatable. |
| `--apply --plan-fingerprint <fp>` | Write. |
| `--run-id <id>` | Optional run ID; a random one is generated by default. |
| `--hooks` | Install or remove devtwin's [hook entries](/docs/guides/lessons-and-hooks/#turn-on-the-hooks-in-live-mode) in the approved `hookTargets` files instead of the skills. |

**Owner** with `--apply`.

```sh
devtwin agents install --pilot "$PILOT" --home "$AGENT_HOME" --agent claude --agent codex
```

`agents install` installs four skills: `devtwin-onboard`, `devtwin-resume`, `devtwin-record` and `devtwin-capture`. With `--hooks`, the preview lists each entry it adds or removes in `changes`.

### `agents status`

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--home <path>` | Required with a disposable pilot. Omit in live mode. |

Its `hooks` field shows each hook entry as `installed`, `missing`, `modified`, `outdated` or `foreign-entry`, and the kit receipt.

### `agents recover`

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--release` | Also close runs stuck on held entries or an unreadable journal. |
| `--apply --plan-fingerprint <fp>` | Apply. |

### `agents rollback-check`

Compares skill folders with the inventory taken before an install run. Read-only. Fails with `DEVTWIN_ROLLBACK_MISMATCH` on any `devtwin-*` difference.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--run-id <id>` | Required. The install run ID. |

## Setup

See [Setup wizard](/docs/guides/setup-wizard/).

### `setup`

The terminal loop over every setup step. For each step it shows the what, why, undo and preview, then asks; only `y` or `yes` applies. It needs a terminal and refuses without one. It takes the same flags as `setup plan` except `--step`. **Owner**: the hook denies it from an agent shell.

### `setup status`

Lists every step with `id`, `title`, `available`, `owner`, `what`, `why`, `undo` and `done`, and the `next` step. Read-only.

### `setup plan` / `setup apply`

`setup plan --step <id>` shows the preview of one step and its fingerprint. `setup apply --step <id> --plan-fingerprint <fp>` applies it. `setup apply` is **Owner** for the steps `skills-claude`, `skills-codex`, `write-classes-hooks`, `hooks-claude`, `hooks-codex`, `paths-confirm`, `hub-join`, `job-hub-sync`, `consent-hub`, `consent-repo`, `job-radar`, `job-advisories`, `job-review-reminder`, `backup-folder` and `job-backup`.

`setup plan --all-pending` or `--steps <id,id,...>` plans a batch of owner steps behind one owner dialog. It returns `items` (each step's `id`, dialog `lines`, `preview` and `fingerprint`), `dialog`, `excluded` with reasons, `skipped`, `separate` and the batch `fingerprint`. `setup apply` with the same flags, `--apply` and `--plan-fingerprint <fp>` shows the dialog once, then runs each step through its own apply. The order is the config change, skills, consents, jobs, `paths-confirm`, then hooks. A step that changed after the preview stops the batch with `DEVTWIN_STALE_VERSION`; its `details` list `done` and `notRun`. The batch apply is **Owner**: the hook denies `setup apply --steps` and `setup apply --all-pending` from an agent shell. See [Approve the owner steps at once](/docs/guides/setup-wizard/#approve-the-owner-steps-at-once).

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--step <id>` | One step ID from `setup status`. |
| `--steps <id,id,...>` | A batch of the named owner steps. Repeatable. |
| `--all-pending` | A batch of every owner step that is available, not done and not skipped. |
| `--apply` | `setup apply` for a batch. Without it, the apply shows the preview. |
| `--plan-fingerprint <fp>` | `setup apply` only. Required. |
| Step flags | `--home`, `--run-id`, `--work`, `--preference`, `--stack-current`, `--stack-known`, `--writing`, `--seed-from-init`, `--proposed-by`, `--starter`, `--scope`, `--display-name`, `--project`, `--repo`, `--doc`, `--expect-remote`, `--environment`, `--actor`, `--accept`, `--request-id`, `--keep-previous`, `--recommendation`, `--hub-remote`, `--hub-handle`, `--hub-email`, `--ssh-command`, `--hub-root`, `--push-repo`, `--hold-hours`, `--backup-target`. Each step reads only its own. See [Setup flags](/docs/guides/setup-wizard/#setup-flags). |

## Lessons

See [Lessons and hooks](/docs/guides/lessons-and-hooks/).

### `lesson match`

Lists the lessons and preferences that match a path, a package, prompt text or a shell command. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--cwd <path>` | The worktree. Paths are resolved against it. |
| `--path <path>` | Repo-relative, or absolute inside the worktree. Repeatable. |
| `--package <name>` | Repeatable. |
| `--text <text>` | Prompt text to match against package names and topics. |
| `--command <text>` | A shell command, split and matched as the hook matches a shell call. |

```sh
devtwin lesson match --pilot "$PILOT" --scope example --cwd "$REPO" --path src/billing/client.js
```

Returns `matches` (each with `id`, `matchedBy` and a `line` of at most 240 bytes), `index` (`current`, `stale`, `missing` or `invalid`) and the resolved `repo`.

### `lesson show`

Returns the full lesson as fenced text, labelled as claimed by its author. The body is capped at about 600 tokens. Takes `--pilot`, `--scope` and `--id <record or lesson ID>`. A superseded or unknown ID fails with `DEVTWIN_NOT_FOUND`.

### `lesson index`

Rebuilds the stored lesson index of a scope at `stateRoot/lessons/<scope>.json`. It is a cache, so it writes with no preview. Takes `--pilot` and `--scope`.

### `lesson propose`

Writes a private lesson proposal. Without `--apply`, runs every check and writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--session <id>` | Required. The session ID from the hook's session-start line. At most three proposals per session. |
| `--title <text>` | Required. |
| `--summary <text>` | Required. One "do" or "don't" line. |
| `--body <text>` or `--body-file <file>` | The reason. `--body-file -` reads stdin. |
| `--path <glob>`, `--package <name>`, `--topic <word>`, `--command <words>` | The match rules. Repeatable. Give at least one. `--command` is one to three lower-case words that start a shell command, such as `git push`. |
| `--project <id>` | The project of a lesson that belongs to one. |
| `--apply` | Write. |

```sh
devtwin lesson propose --pilot "$PILOT" --scope example --session ses_0123456789abcdef \
  --title "Retry budget for the billing client" --summary "Do set a retry budget." \
  --body "Unbounded retries caused duplicate charges." --path 'src/billing/**'
```

Returns the `proposalId`. Fails with `DEVTWIN_LIMIT` on a fourth proposal in one session, `DEVTWIN_SENSITIVE_CONTENT` on credential-like text and `DEVTWIN_ISOLATION` when the text names another scope.

### `lesson proposals`

Lists pending lesson proposals. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Only this scope. |
| `--all` | Also list rejected and accepted proposals. |

### `lesson edit`

Changes a pending proposal. Takes `--id <prop_id>` and the `lesson propose` flags you want to change: `--title`, `--summary`, `--body`, `--body-file`, and `--path`, `--package`, `--topic` and `--command`, which replace the whole match block. Apply with `--apply --plan-fingerprint <fp>`.

### `lesson reject`

Drops a pending proposal. Takes `--id <prop_id>`; apply with `--apply --plan-fingerprint <fp>`. The file stays with the state `rejected`.

### `lesson accept`

Accepts a proposal. It shows no owner dialog; the [tier](/docs/security/security-model/#tiers) of each target decides who may run the apply. `--target` takes one target or a set joined by commas, such as `project,repo`. When any target is refused, the whole accept fails before it writes anything.

| Target | Tier |
| --- | --- |
| `project` | Automatic. Agents run it. Writes an `observed` lesson record and an audit entry. |
| `repo` | Automatic for the branch. Writes a learning branch `devtwin/learning-<id>` in the project's repository, which must be in the `repoLearnings` class. It never touches the working copy. Under a valid `repo-push` consent, the push waits in the held queue; without one, the result says `needs-consent` and the branch stays local. See [Write a lesson to the repository](/docs/guides/organization-hub/#write-a-lesson-to-the-repository). |
| `hub` | Consented. Runs only while a `hub-publish` consent for the scope is valid; otherwise fails with `DEVTWIN_APPROVAL_REQUIRED`, "Needs consent". The lesson waits in the [held queue](/docs/guides/organization-hub/#held-items) for the consent's hold time, then `hub sync` or the `learning-send` job sends it. |
| `general` | Parked, alone or in a set: the other targets are written now, and the general part waits for [`activity review`](#activity-review). The plan lists it in `parked`. `hub+general` is the older spelling of `general,hub`. |

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--id <prop_id>` | Required. |
| `--target <targets>` | Required. `project`, `general`, `hub` or `repo`, or a set such as `project,repo`. See [Review proposals](/docs/guides/lessons-and-hooks/#review-proposals). |
| `--scope <id>`, `--project <id>` | The project for a `project` or `repo` target when the proposal names none. |
| `--session <id>` | Optional. The session ID from the hook, kept in the audit entry. |
| `--apply --plan-fingerprint <fp>` | Write. |

A replacement accepts to `hub` only. `DEVTWIN_STALE_VERSION` means another replacement reached the hub first.

### `lesson copy`

**Owner** with `--apply`. Publishes a lesson from your personal store to the hub of another scope, after the owner dialog.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--id <record id>` | Required. A personal lesson. |
| `--to-scope <id>` | Required. A scope that joined a hub. |
| `--apply --plan-fingerprint <fp>` | Write. |

### `lesson supersede-propose`

Writes a private proposal that replaces a hub lesson. Takes the `lesson propose` flags plus `--predecessor <lsn_id>` (required). With `--apply`, it first tries a `hub sync`. Fails with `DEVTWIN_NOT_FOUND` for an unknown lesson, and with `DEVTWIN_CONFLICT` and the reason `removed` or `superseded` when the lesson was removed or already replaced.

### `lesson notices`

Lists replacements of your own hub lessons. Read-only without `--ack`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--ack` | Preview closing the notices. |
| `--id <lsn_id>` | With `--ack`, close only this replacement. |
| `--apply --plan-fingerprint <fp>` | With `--ack`. **Owner**. |

## Agent hook

See [Lessons and hooks](/docs/guides/lessons-and-hooks/#the-agent-hook).

### `hook`

The command that agent hook entries run. It reads the agent's JSON payload on stdin and prints the agent's own hook JSON, or nothing. It does not print the usual JSON line, and any error gives exit 0 and no output.

| Flag | |
| --- | --- |
| `--event <event>` | Required. `session-start`, `user-prompt`, `pre-tool`, `post-tool`, `pre-compact`, `post-compact` or `stop`. |
| `--agent <claude\|codex>` | Required. |
| `--pilot <file>` | Required. |

```sh
node "$KIT/bin/devtwin.mjs" hook --event pre-tool --agent claude --pilot "$LIVE_CONFIG"
```

You don't run it yourself; `agents install --hooks` writes the entries.

### `hook verify`

Loads and checks the full pilot, then writes the kit receipt that the hook trusts, at `stateRoot/hooks/kit-receipt.json`. The receipt is valid for 30 days. While the [confirmed paths](#paths-confirm) match, each session start renews it. Takes only `--pilot`.

### `paths confirm`

**Owner** with `--apply`. Records the real paths of the kit and the live config, the kit's Git HEAD and the SHA-256 of the config in `stateRoot/confirmed-paths.json`. While they still match, the session-start line ends with "Kit and config confirmed.", the bundled skills stop asking you for the paths, and the hook renews the kit receipt. Takes `--pilot` and `--apply --plan-fingerprint <fp>`. The apply shows the owner dialog with both paths.

A kit upgrade or a config change ends the confirmation. Run `paths confirm` again after you check the new paths.

### `paths check`

Reports `match` or `mismatch` for each confirmed value. Read-only. Takes only `--pilot`.

### `budget report`

Sums the bytes, index lines and overflow lines that the hook injected, per session, per agent and in total. Read-only. Takes only `--pilot`.

## Organization hub

These commands work with a live config. See [Organization hub](/docs/guides/organization-hub/).

### `hub join`

**Owner** with `--apply`. Joins a scope to a hub and clones it into an approved hub root.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--remote <ssh remote>` | Required. `ssh://host/path` or `user@host:path`. |
| `--handle <handle>` | Required. Your handle on the hub. |
| `--email <email>` | Required. The commit email. |
| `--ssh-command <command>` | Optional per-hub SSH command. |
| `--hub-root <folder>` | One of the approved hub roots. Default: the first one. |
| `--apply --plan-fingerprint <fp>` | Join, after the owner dialog. |

### `hub sync`

Fetches the hub, pushes the outbox, deletes your own expired notes and rebuilds the lesson index. It has no preview. `--job` is the form the hub sync job runs: it checks the job's own flag and skips a run within 9 minutes of the last one. Takes `--pilot` and `--scope`.

### `hub status`

Shows the last sync time, the outbox size and the job state, from local files only. Takes `--pilot` and `--scope`.

### `hub schedule`

Installs the hub sync job, a user LaunchAgent that runs every 10 minutes. With `--off`, removes it. **Owner** with `--apply`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--off` | Remove the job. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

### `hub leave`

Revokes the note consent, removes the job, turns delivery off and deletes the clone. Takes `--pilot`, `--scope` and `--apply --plan-fingerprint <fp>`. **Owner** with `--apply`.

### `note list`

Lists colleagues' active notes as fenced data, your own active notes and your queued notes, as of the last sync. Read-only. Takes `--pilot` and `--scope`.

### `note revoke`

Clears the note consent and discards your queued notes. **Owner** with `--apply`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--delete-notes` | Also queue the removal of your active notes from the hub. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

### `note consent`

Shows the current note rules and records your consent again. Takes `--pilot`, `--scope` and `--apply --plan-fingerprint <fp>`. **Owner** with `--apply`.

### `published list`

Lists what devtwin published in your name: your hub lessons with their status, your notes, your tombstones and the outbox. Reads the hub clone. Read-only. Takes `--pilot` and `--scope`.

### `published delete`

**Owner** with `--apply`. Removes one of your lessons (and adds a tombstone) or one of your notes, in one commit.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--id <lsn_id or note_id>` | Required. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

Git history and colleagues' existing clones keep the text. Another author's item fails with `DEVTWIN_HUB_PATH_REFUSED`.

## Consents, activity and undo

See the [tier table](/docs/security/security-model/#tiers).

### `consent grant`

**Owner** with `--apply`. Records a standing consent, after the owner dialog.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--kind <kind>` | Required. `hub-publish` or `repo-push`. |
| `--scope <id>` | For `hub-publish`. A scope that joined a hub. |
| `--repo <path>` | For `repo-push`. A bound repository. The grant records its push URL; learning branches are pushed there only. |
| `--hold-hours <n>` | How long each item waits in the held queue, from 1 to 168. Default 24. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

```sh
node "$KIT/bin/devtwin.mjs" consent grant --pilot "$LIVE_CONFIG" --kind hub-publish --scope example
```

A change to the consent rules in a later kit makes the stored consent void. Grant it again to review the new rules.

A `repo-push` consent also covers the project's learnings folder and base. `project set` voids it.

### `learning send`

Queues the push of a learning branch written before the repository had a `repo-push` consent. Consented: it runs only while the consent is valid, and the push still waits the hold time. A grant does not queue earlier branches; `activity` lists them as waiting. It also queues again a held branch that stays held as `consent-changed` because it was queued under an earlier grant: the branch then waits a new hold under the current grant.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--branch <name>` | Required. `devtwin/learning-<id>`. |
| `--apply --plan-fingerprint <fp>` | Write. |

### `consent revoke`

**Owner** with `--apply`. Ends a consent. Takes `--pilot`, `--kind`, `--scope` or `--repo`, and `--apply --plan-fingerprint <fp>`. Agents then stop at "Needs consent" for that target. It also cancels the target's held items and the outbox items that came from them, then removes the consent; the preview lists the held items. When a send is running, it fails with `DEVTWIN_BUSY` and changes nothing; run it again.

### `consent list`

Lists each consent with its target, hold time, grant time and whether it is valid. It also shows the note consent of each hub, which `note consent` and `note revoke` manage. Read-only. Takes only `--pilot`.

### `activity`

Lists what devtwin learned in the last seven days: each automatic write with its entry ID, time, route, target, record IDs, caller and whether it landed. A hub accept also shows its `state`: `held`, `sent`, `outbox`, `dropped` or `cancelled`. A learning branch shows `local` until it is queued. It also lists the held items, the learning branches that wait for a consent, and warnings, such as no approved backup folder. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--since <time>` | An ISO time, such as `2026-10-01T00:00:00Z`. |
| `--held` | Only the held items, with their full text. |

The items that wait for [`activity review`](#activity-review) are listed by title, and `counts.review` counts them.

### `activity review`

The weekly owner review. It lists every item that waits for you, with its full text. These are global preference candidates from an agent or a `user` memory, and the general part of a `lesson accept`. They also include record writes refused by the session or day cap, and items from a fetched or synced source.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--reject <id>` | Repeatable. Remove this item for good, at most 20 in one review. |
| `--home <dir>` | The agent home whose instruction block gets the saved preferences, as in `instructions plan`. In live mode the live home is the default. |
| `--agent <agent>` | Repeatable. `claude` or `codex`. Both by default. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" activity review --pilot "$LIVE_CONFIG"
```

**Owner** with `--apply`. One dialog holds up to ten items while their full text fits the dialog limit; an item that does not fit with others gets its own dialog. An item too long for any dialog stays waiting, listed in `tooLong`, until you reject it. Approve accepts every item in the dialog; deny leaves them waiting. Rejected items get one dialog of their own. Each accept and reject adds an audit entry with the route `activity review`. A saved preference is written to the instruction block only when the block there has every earlier preference already; otherwise the result says to run `instructions plan`.

### `undo`

Reverses automatic writes from the audit log. A record gets a retraction, so the next session no longer sees it. When the undone entry replaced an earlier record, that record comes back as a new one.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--id <entry>` | One entry. |
| `--session <id>` | The calling session's ID, shown in the plan only. |
| `--since <time>` | Every entry after this time, newest first. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" undo --pilot "$LIVE_CONFIG" --id aud_0123456789abcdef01234567
```

**Owner** with `--apply`: every undo shows the owner dialog. Each undo adds its own audit entry. An undo of an undo fails with `DEVTWIN_CONFLICT`. An undo that stopped between its retraction and its restores resumes on the next run. An undo of a hub accept cancels the lesson while it is held or waits in the outbox. A lesson already on the hub fails with `DEVTWIN_GATE_REQUIRED` and points to `published delete`. An undo of a learning branch adds a revert commit to the branch. A pushed branch gets the revert pushed after the hold. Once the lesson is in the learnings base, or the remote branch is gone, it fails with `DEVTWIN_GATE_REQUIRED` and names the `git revert` to run by hand.

### `review plan`

The monthly [setup review](/docs/guides/preferences-and-templates/#setup-review). Read-only. It lists one line for each suggestion: `id`, `kind`, `target`, `evidence` and `change`. The evidence holds IDs, counts, hashes, dates and paths, never record or preference text. `change.command` is the command an accepted line runs; `change.informational` is true when it runs none. `counts.decided` counts lines you already decided whose evidence did not change, and `notCollected` lists what the review does not check, with the reason. It lists `lesson-unused` until the hook budget log goes back 30 days.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |

```sh
node "$KIT/bin/devtwin.mjs" review plan --pilot "$LIVE_CONFIG"
```

### `review apply`

Decides lines of `review plan`, then runs each accepted change through its own command.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--accept <id>` | Repeatable. Accept this line. |
| `--reject <id>` | Repeatable. Reject this line. It stays hidden until its evidence changes. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" review apply --pilot "$LIVE_CONFIG" --accept sug_0123456789abcdef01234567 --reject sug_76543210fedcba9876543210
```

Decide any number of open lines. A line with no decision stays open, and `open` counts those lines. No decision at all, or a line with both, fails with `DEVTWIN_INVALID_INPUT`. An unknown line fails with `DEVTWIN_NOT_FOUND`.

**Owner** with `--apply`. The owner dialog lists every accepted line and the command it runs, then the number of rejected lines. When the accepted lines do not fit one dialog, it fails with `DEVTWIN_LIMIT`: accept fewer at once. With no accepted line there is no dialog, because a reject only hides the line. The devtwin hook still denies `--apply` from an agent shell. Each accepted change then runs as its own command, plan first and then apply: `pref retire`, `consent revoke`, `undo`, `setup apply --step sandbox` or `profile apply`. That command keeps its own checks and owner dialog. A line with no command records the decision only. Each decision adds an audit entry with the route `review apply`, and is saved as soon as its change is done. A change that fails is listed in `failed`, and its line comes back in the next review.

## Backups

See [Backup and restore](/docs/guides/live-mode/#backup-and-restore).

### `backup create`

Writes one encrypted archive of the store into an approved `backupTargets` folder. Automatic: agents and the `backup-daily` job may run it. Each folder keeps the newest archive of each day, for the newest 14 days that have archives. A create removes only older archives of its own day and archives older than those days. A held store lock stops it with `DEVTWIN_BUSY` before it writes.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--to <folder>` | One of the approved backup folders. Default: the first one. |
| `--apply --plan-fingerprint <fp>` | Write. |

Without an approved folder it fails with `DEVTWIN_GATE_REQUIRED`. The key is made in your macOS Keychain on the first run.

### `backup restore`

**Owner** with `--apply`. Decrypts an archive into a new folder inside an approved backup folder, after the owner dialog. It never writes the live store.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--from <archive>` | Required. A `.dtb` archive. |
| `--to <folder>` | Required. A new folder inside an approved backup folder. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

A changed archive or a wrong key fails with `DEVTWIN_INTEGRITY`, and an existing folder with `DEVTWIN_CONFLICT`. Nothing is written in either case.

### `backup status`

Lists the archives in each approved folder and whether the key was exported. Read-only. Takes only `--pilot`.

### `backup key export`

**Owner** with `--apply`. Prints the backup key once, after the owner dialog. Run it in your own terminal, outside any agent session. Takes `--pilot` and `--apply --plan-fingerprint <fp>`.

## Preferences

See [Preferences and templates](/docs/guides/preferences-and-templates/).

### `pref propose`

Writes a private preference proposal after a correction. Without `--apply`, it runs every check and writes nothing.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--session <id>` | Required. The session ID from the hook's session-start line. |
| `--title <text>` | Required. Up to 80 characters. |
| `--text <text>` | Required. One plain rule, up to 300 characters. |
| `--topic <topic>` | The kind of correction, such as `testing`. One proposal per topic per session. |
| `--apply` | Write. |

Fails with `DEVTWIN_LIMIT` after three proposals in a session, with `DEVTWIN_CONFLICT` and the reason `declined` or `accepted` for a preference you already answered, and with `DEVTWIN_INVALID_INPUT` and a `reason` for text that is not one plain rule.

### `pref proposals`

Lists pending proposals; `--all` lists every state. Read-only.

### `pref accept`

**Owner** with `--apply`. Takes `--pilot`, `--id <pref_id>` and `--apply --plan-fingerprint <fp>`. After the owner dialog, writes a `preference` record to your personal store.

### `pref decline`

Takes `--pilot`, `--id <pref_id>` and `--apply --plan-fingerprint <fp>`. The same preference is refused later.

### `pref list`

Lists the active preferences that the instruction block delivers. Read-only.

### `pref retire`

**Owner** with `--apply`. Takes `--pilot`, `--id <record id>` and `--apply --plan-fingerprint <fp>`. Stops delivering a preference. The record stays.

## Instruction block

### `instructions plan`

Previews the managed instruction block and each file it changes. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--home <path>` | Required with a disposable pilot. Omit in live mode. |
| `--agent <claude\|codex>` | Repeatable. Default: both. |
| `--remove` | Preview taking the block out. |

Each action is `create`, `update`, `remove`, `unchanged`, `blocked` (the path is not an approved `instructionTargets` path) or `conflict` (an unsafe file or malformed markers). The result also holds the `block`, its `chars` and any `PREFERENCES_DROPPED` or `PREFERENCES_REFUSED` warning.

### `instructions apply`

**Owner**. Same flags as `instructions plan`, plus `--plan-fingerprint <fp>` (required) and `--run-id <id>`. Shows the owner dialog with the exact block, then writes each file with a backup. A `blocked` or `conflict` action fails the apply with `DEVTWIN_CONFLICT` before the dialog.

## Output templates

### `template list`

Lists the starter and personal output templates, by kind and format. Read-only.

### `template show`

Takes `--pilot`, `--kind <kind>` (required) and `--format <md|html>` (default `md`). Returns your personal template when you saved one, or the starter. Read-only.

### `template from`

Saves the heading structure of an output you liked as your personal template of that kind.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--file <file>` | Required. A `.md` or `.html` file inside the pilot's `inputsRoot`. |
| `--kind <kind>` | Required. Such as `rca`, `report` or `decision`. |
| `--apply --plan-fingerprint <fp>` | Save. |

Fails with `DEVTWIN_SENSITIVE_CONTENT` and the `line` for a credential, with `DEVTWIN_INVALID_INPUT` and the reason `no-structure` for a file with no headings, and with `DEVTWIN_ISOLATION` for a heading that names a scope.

## Skill builder

All workspace commands take `--pilot` and the selection flags:

| Flag | |
| --- | --- |
| `--audience <personal\|company\|project>` | Required. |
| `--workspace <ws_id>` | Required. `ws_` + 8–64 of `a-z 0-9 _ -`. |
| `--scope <id>` | Required for `company` and `project`. |
| `--project <id>` | Required for `project`. |

IDs use the prefixes `ws_`, `rq_`, `ds_`, `dc_` and `rv_`. Every create is exclusive; nothing is overwritten.

| Command | Extra flags | Does |
| --- | --- | --- |
| `skill discover` | `--fixture <dir under inputsRoot>` | Lists the three installable bundled skills, plus a fixture skill if given. Takes no selection flags. |
| `skill workspace-create` | | Creates a private workspace. |
| `skill workspace-show` | | Lists IDs and statuses. |
| `skill requirements-record` | `--requirements <rq_id> --input <json file>` | Stores requirements. |
| `skill design-record` | `--requirements <rq_id> --design <ds_id> --input <json file>` | Stores a design. |
| `skill design-approve` | `--design <ds_id> --decision <dc_id> --interaction-ref user:<ref> --response 'Approved <design digest>'` | Records your design approval. |
| `skill draft-create` | `--requirements --design --decision --revision <rv_id> --candidate <dir>` | Copies candidate files into an immutable revision. |
| `skill draft-validate` | `--revision <rv_id>` | Validates the revision. |
| `skill content-approve` | `--revision --decision --interaction-ref --response` | Records content approval for installation. |
| `skill local-plan` | `--revision --mode install\|uninstall --home <agent home> --agent <a> [--content-decision <dc_id>]` | Plans an install into a pilot home. |
| `skill local-approve` | local-plan flags + `--decision --plan-fingerprint --interaction-ref --response` | Records the install approval. |
| `skill local-apply` | local-plan flags + `--decision --plan-fingerprint [--run-id]` | Applies the install. |
| `skill local-status` | local-plan flags | Reports observed install state. |

### Templates

| Command | Flags | Does |
| --- | --- | --- |
| `skill template-list` | none (no pilot) | Lists templates and their placeholders. |
| `skill template-seed` | `--pilot --template <name> --audience <personal\|company> [--scope] --workspace --set <key>=<value>…` | Read-only render. Returns files, `layout` and `renderDigest`. |
| `skill template-verify` | template-seed flags + `--dir <dir under inputsRoot> --render-digest <digest>` | Checks written files byte for byte. |

## Skill sources

See [Skill sources](/docs/guides/skill-sources/). These commands accept only the flags listed.

| Command | Flags | Network | Writes |
| --- | --- | --- | --- |
| `skill-sources catalog` | none | no | no |
| `skill-sources check` | `--source <id>` (required), `--prior-lock-json <json>` | GitHub API | no |
| `skill-sources preview` | `--source --pin-json --files-json` (all required) | GitHub API | no |
| `skill-sources stage` | `--pilot --source --pin-json --files-json --preview-hash` (all required) | GitHub API | staging dir |
| `skill-sources inspect` | `--pilot --run <stage id>` | no | no |
| `skill-sources package-review` | `--pilot --run --mapping-json` | no | no |
| `skill-sources content-approve` | `--pilot --run --mapping-json --package-digest --decision --interaction-ref --response` | no | decision |
| `skill-sources local-plan` | `--pilot --content-decision --home --agent-json '["claude","codex"]' --mode install\|uninstall` | no | no |
| `skill-sources local-approve` | local-plan flags + `--decision --plan-fingerprint --interaction-ref --response` | no | decision |
| `skill-sources local-apply` | local-plan flags + `--decision --plan-fingerprint [--run-id]` | no | pilot home |
| `skill-sources local-status` | local-plan flags | no | no |

## Task envelope schema

`schemas/envelope.schema.json` describes the **task envelope**, an auditable contract a parent agent can hand a worker: run and task IDs, scope, project, worktree and source revision, input record refs, allowed output paths, allowed operations (`read`, `edit-files`, `run-tests`, `propose-record`), constraints, deliverable, verification commands, freshness and a fixed notice. It is a library function today with no CLI command, and it is advisory, not an enforced permission. It is not the shape of CLI output; CLI output is the `ok`/`command`/`result` line above.
