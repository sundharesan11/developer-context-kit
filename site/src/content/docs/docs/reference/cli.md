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
| Preview, then `--apply --plan-fingerprint <fp>` | `project onboard`, `live *`, `agents install/uninstall/recover`, `locks release`, `draft save`, `stack digest`, `lesson edit/reject/accept/copy`, `lesson notices --ack`, `hub join/leave/schedule`, `note revoke/consent`, `published delete` |
| Preview command, then a separate apply command with `--plan-fingerprint` | `profile plan` → `profile apply`, `stack plan` → `stack approve`, `setup plan` → `setup apply` |
| No preview | `lesson index` and `hook verify` write only devtwin's own state. `hub sync` fetches and pushes items you already approved. |

The skill builder and skill-source installers add separate recorded approvals; see their sections.

### Owner actions

Some commands need you at the keyboard. When the [devtwin hook](/docs/guides/lessons-and-hooks/#the-owner-action-block) is installed, it denies them from an agent shell. `lesson accept`, `lesson copy`, `published delete`, `hub join`, `record publish`, `live *`, `agents install`, `agents uninstall`, `hub leave`, `hub schedule`, `lesson notices`, `note revoke`, `note consent`, `pref accept` and `pref retire` are denied with `--apply`; their previews stay open to agents. `instructions apply` is always denied; its preview is `instructions plan`. Most hub and lesson owner actions also show a macOS dialog with the exact content; a denied or dismissed dialog fails with `DEVTWIN_OWNER_DENIED` and writes nothing. This page marks each one **Owner**.

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
| `--clear <class>` | Remove a class: `hubRoot`, `instructionTargets`, `hookTargets` or `launchAgents`. Repeatable. |
| `--apply --plan-fingerprint <fp>` | Write. |

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" \
  --hook-target "$HOME/.claude/settings.json" --hook-target "$HOME/.codex/hooks.json"
```

The preview shows each class `from` and `to` and the config digest before and after. A path with the wrong shape fails with `DEVTWIN_GATE_REQUIRED`; a request that changes nothing fails with `DEVTWIN_INVALID_INPUT`.

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
| `--request-id <id>` | Required with `--apply`. |
| `--apply` | Write. Without it, the command previews and returns the `recordId`. |

### `record add`

Writes a new record. See [Capture decisions](/docs/guides/capture-decisions/).

```sh
devtwin record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind decision --title "Use server-side search" --body "Filter on the server." \
  --request-id req_atlas_decision_01 --apply
```

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

See [Stack watch](/docs/guides/stack-watch/). `stack check` and `stack digest` refuse a live config.

### `stack plan`

Lists watched items, sources and every host that would be contacted. No network, no writes.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--with <group>` | `advisories`, `lifecycle` or `versions`. Repeatable. |
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
| `--scope <id>` | Optional. |
| `--apply --plan-fingerprint <fp>` | Write the digest. |

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

`setup plan --step <id>` shows the preview of one step and its fingerprint. `setup apply --step <id> --plan-fingerprint <fp>` applies it. `setup apply` is **Owner** for the steps `skills-claude`, `skills-codex`, `write-classes-hooks`, `hooks-claude`, `hooks-codex`, `hub-join` and `job-hub-sync`.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--step <id>` | Required. A step ID from `setup status`. |
| `--plan-fingerprint <fp>` | `setup apply` only. Required. |
| Step flags | `--home`, `--run-id`, `--work`, `--preference`, `--stack-current`, `--stack-known`, `--writing`, `--seed-from-init`, `--proposed-by`, `--starter`, `--scope`, `--display-name`, `--project`, `--repo`, `--doc`, `--expect-remote`, `--environment`, `--actor`, `--accept`, `--request-id`, `--keep-previous`, `--recommendation`, `--hub-remote`, `--hub-handle`, `--hub-email`, `--ssh-command`, `--hub-root`. Each step reads only its own. See [Setup flags](/docs/guides/setup-wizard/#setup-flags). |

## Lessons

See [Lessons and hooks](/docs/guides/lessons-and-hooks/).

### `lesson match`

Lists the lessons and preferences that match a path, a package or prompt text. Read-only.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--scope <id>` | Required. |
| `--cwd <path>` | The worktree. Paths are resolved against it. |
| `--path <path>` | Repo-relative, or absolute inside the worktree. Repeatable. |
| `--package <name>` | Repeatable. |
| `--text <text>` | Prompt text to match against package names and topics. |

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
| `--path <glob>`, `--package <name>`, `--topic <word>` | The match rules. Repeatable. Give at least one. |
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

Changes a pending proposal. Takes `--id <prop_id>` and the `lesson propose` flags you want to change: `--title`, `--summary`, `--body`, `--body-file`, and `--path`, `--package` and `--topic`, which replace the whole match block. Apply with `--apply --plan-fingerprint <fp>`.

### `lesson reject`

Drops a pending proposal. Takes `--id <prop_id>`; apply with `--apply --plan-fingerprint <fp>`. The file stays with the state `rejected`.

### `lesson accept`

**Owner** with `--apply`. Accepts a proposal. Every target shows the owner dialog.

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--id <prop_id>` | Required. |
| `--target <target>` | `hub` (default), `hub+general`, `project` or `general`. See [Review proposals](/docs/guides/lessons-and-hooks/#review-proposals). |
| `--scope <id>`, `--project <id>` | The project for a `project` target when the proposal names none. |
| `--apply --plan-fingerprint <fp>` | Write, after the owner dialog. |

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
| `--event <event>` | Required. `session-start`, `user-prompt`, `pre-tool`, `post-tool`, `pre-compact` or `post-compact`. |
| `--agent <claude\|codex>` | Required. |
| `--pilot <file>` | Required. |

```sh
node "$KIT/bin/devtwin.mjs" hook --event pre-tool --agent claude --pilot "$LIVE_CONFIG"
```

You don't run it yourself; `agents install --hooks` writes the entries.

### `hook verify`

Loads and checks the full pilot, then writes the kit receipt that the hook trusts, at `stateRoot/hooks/kit-receipt.json`. The receipt is valid for seven days. Takes only `--pilot`.

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
