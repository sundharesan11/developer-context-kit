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
| Preview, then `--apply` | `init`, `scope add`, `record add`, `record supersede`, `record propose`, `record publish`, `hub propose` |
| Preview, then `--apply --plan-fingerprint <fp>` | `project onboard`, `live *`, `agents install/uninstall/recover`, `locks release`, `draft save`, `stack digest` |
| Preview command, then a separate apply command with `--plan-fingerprint` | `profile plan` → `profile apply`, `stack plan` → `stack approve` |

The skill builder and skill-source installers add separate recorded approvals; see their sections.

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
| `--kind <kind>` | Required. `brief`, `map`, `command`, `environment`, `constraint`, `fact`, `decision`, `experiment`, `unknown` or `handoff`. |
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

```sh
devtwin agents install --pilot "$PILOT" --home "$AGENT_HOME" --agent claude --agent codex
```

### `agents status`

| Flag | |
| --- | --- |
| `--pilot <file>` | Required. |
| `--home <path>` | Required with a disposable pilot. Omit in live mode. |

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
