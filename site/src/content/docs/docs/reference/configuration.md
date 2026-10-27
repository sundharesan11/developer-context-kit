---
title: Configuration
description: Reference for the pilot file, the live config, init preferences, scope configuration, the personal profile and the environment variables devtwin reads.
---

devtwin has no global configuration file. Everything is driven by one JSON file you pass with `--pilot`: either a **pilot file** for a disposable setup, or the **live config** at `~/.devtwin/live.json`. The JSON schemas live in the kit's `schemas/` folder.

## Pilot file

A pilot file declares the only places devtwin may write and the repositories it may read. It is a write fence for the CLI, not a sandbox for your whole agent.

```json
{
  "schemaVersion": 1,
  "pilotRoot": "/private/tmp/devtwin-demo/pilot",
  "configRoot": "/private/tmp/devtwin-demo/pilot/config",
  "dataRoot": "/private/tmp/devtwin-demo/pilot/data",
  "stateRoot": "/private/tmp/devtwin-demo/pilot/state",
  "inputsRoot": "/private/tmp/devtwin-demo/pilot/inputs",
  "agentHomes": ["/private/tmp/devtwin-demo/pilot/homes/demo"],
  "repos": ["/private/tmp/devtwin-demo/pilot/repos/atlas"],
  "forbidden": ["/Users/<you>/src/devtwin"]
}
```

| Key | Type | Meaning |
| --- | --- | --- |
| `schemaVersion` | `1` | Required. |
| `pilotRoot` | path | Required. The folder that contains everything below. |
| `configRoot` | path | Required. Scopes, project bindings, registry, `user.json`, personal profile. |
| `dataRoot` | path | Required. Records, proposals, drafts, digests, exports, skill workspaces and staging. |
| `stateRoot` | path | Required. Locks, run journals, approvals, stack state. |
| `inputsRoot` | path | Required. Where you put files devtwin reads: `--body-file`, `--candidate`, seeded templates, hubs. |
| `agentHomes` | path[] | Required (may be empty). Fake agent homes that `agents install --home` may target. Must be empty in a live config. |
| `repos` | path[] | Required (may be empty). Repositories that may be onboarded. |
| `forbidden` | path[] | Required (may be empty). Extra paths devtwin must never touch, such as custom agent folders. |
| `live` | object | Only in a live config. See below. |

No other keys are allowed.

### Fence rules

- All paths must be absolute and canonical (no symlinked components). On macOS use `pwd -P` or `realpath`, because `/tmp` is a symlink to `/private/tmp`.
- In a disposable pilot, the five roots, `agentHomes` and `repos` must all be strictly inside `pilotRoot`, and none may overlap another. In a live config, `repos` and the skill folders are instead outside the store.
- Nothing may touch a protected path: `~/.claude`, `~/.codex`, `~/.agents`, `~/.gemini`, `~/.cursor`, `~/.commandcode`, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, `~/.config/devtwin`, `~/.local/share/devtwin`, `~/.local/state/devtwin`, the former defaults `~/.config/devctx`, `~/.local/share/devctx` and `~/.local/state/devctx` (kept protected during the rename transition), `~/.local/state/personal-os`, or the kit checkout itself.
- The private roots must not be inside a Git worktree.
- Changing the pilot file changes its digest. Some stored receipts are bound to that digest and will then refuse with `DEVTWIN_GATE_REQUIRED`.

A violation fails with `DEVTWIN_GATE_REQUIRED` and `details.field` naming the offending key (and `details.protected` naming the protected path, if any).

## Live config

The live config is a pilot file with a `live` block. `live init` writes it; you never edit it by hand. See [Live mode](/docs/guides/live-mode/).

```json
{
  "schemaVersion": 1,
  "pilotRoot": "/Users/<you>/.devtwin/store",
  "configRoot": "/Users/<you>/.devtwin/store/config",
  "dataRoot": "/Users/<you>/.devtwin/store/data",
  "stateRoot": "/Users/<you>/.devtwin/store/state",
  "inputsRoot": "/Users/<you>/.devtwin/store/inputs",
  "agentHomes": [],
  "repos": ["/Users/<you>/src/atlas"],
  "forbidden": [],
  "live": {
    "configId": "cfg_0123456789abcdef",
    "home": "/Users/<you>",
    "skillDirs": {
      "claude": "/Users/<you>/.claude/skills",
      "codex": "/Users/<you>/.agents/skills"
    },
    "kitRoot": "/Users/<you>/.devtwin/kit",
    "kitCommit": "<40-character commit>"
  }
}
```

| `live` key | Meaning |
| --- | --- |
| `configId` | Random ID drawn by `live init`. Pattern `^[a-z0-9][a-z0-9_-]{7,63}$`. Install receipts bind to it. |
| `home` | Must equal your process home. |
| `skillDirs` | One or both of `claude` (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`) and `codex` (`~/.agents/skills`). Each must already exist as a real directory. |
| `kitRoot` | The kit clone live commands must run from. |
| `kitCommit` | The commit that clone must be detached at, clean. 40 or 64 hex characters. |

Live mode relaxes the fence for exactly these named skill folders (only `devtwin-*` entries inside them) and the listed repositories (read-only). The approved digest is stored at `store/state/live/approved-config.json`; a `live.json` that differs from it is refused.

### Approval mode

The optional `live.approval` key sets how you answer an always-ask prompt:

| Value | Meaning |
| --- | --- |
| `dialog` | The default. Every always-ask action needs the macOS owner dialog. With no GUI session, such as over SSH, it denies. |
| `dialog-or-tty` | In a GUI session the dialog is still required. With no GUI session, devtwin shows the prompt and a six-letter code on the terminal, and only that code approves. |

Set it only with [`live approval`](/docs/reference/cli/#live-approval), an owner action. The key is part of the approved config digest. See [Owner answers over SSH](/docs/security/security-model/#owner-answers-over-ssh).

### Write classes

A live config can hold an optional top-level `writeClasses` block. It names the only other paths outside the store that devtwin may write. Each class is a list of exact absolute paths, at most 16 per class.

```json
"writeClasses": {
  "hubRoot": ["/Users/<you>/.devtwin/hubs"],
  "hookTargets": ["/Users/<you>/.claude/settings.json", "/Users/<you>/.codex/hooks.json"],
  "launchAgents": ["/Users/<you>/Library/LaunchAgents/devtwin.hub-sync.example.plist"],
  "backupTargets": ["/Users/<you>/devtwin-backups"]
}
```

| Class | Allowed paths | Written by |
| --- | --- | --- |
| `hubRoot` | Folders inside your home for hub clones. Writes are allowed in the folder and below it. | `hub join`, `hub sync`, `hub leave` |
| `instructionTargets` | `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), `~/.codex/AGENTS.md`, and a `devtwin*.md` file directly in one of those folders. | `instructions apply` |
| `hookTargets` | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) and `~/.codex/hooks.json`. | `agents install --hooks`, `agents uninstall --hooks` |
| `launchAgents` | Files named `devtwin.<name>.plist` directly in `~/Library/LaunchAgents`. | `hub schedule`, `schedule apply`, `schedule off` |
| `backupTargets` | Folders inside your home for backup archives and restores. Writes are allowed in the folder and below it, never in a sibling or a parent. | `backup create`, `backup restore`, the `backup-daily` job |

- Set the classes only with [`live write-classes`](/docs/reference/cli/#live-write-classes). The classes are part of the approved config digest, so a hand edit is refused with `DEVTWIN_GATE_REQUIRED`.
- Every path must be canonical and inside your home. A link, or a path whose folder is a link, is refused. A hub root or backup folder must not overlap the store, the kit, a listed repository, a skill folder, a protected agent home or another approved folder.
- In a settings or instruction file, devtwin changes only its own JSON entries or the text between `<!-- devtwin:begin -->` and `<!-- devtwin:end -->`. It backs up the exact prior bytes to `store/state/runs/<run_id>/backups/` first, and the file keeps its own mode.
- A disposable pilot can list classes too. Its file targets must have the same shapes inside a listed `agentHomes` folder, and its hub roots must be inside `pilotRoot`.

### Stack-watch exception

The stack watch, the radar digests and the radar jobs fetch from the network. In live mode they run only under the `stackWatch` exception, a separate entry in `live.json` next to the write classes:

```json
"exceptions": { "stackWatch": { "hosts": ["api.github.com", "changelog.example.com"], "maxRequests": 30 } }
```

| Key | Meaning |
| --- | --- |
| `hosts` | Each host the watch may reach, at most 32. Every host in the stack approval must be in this list, or the run stops with `DEVTWIN_GATE_REQUIRED`, reason `host-not-in-exception`, before any request. |
| `maxRequests` | The cap for one run, from 1 to 50. Default 30. One scheduled radar run fetches each source once for all scopes. |

- Live requests send no credential.
- Every live run is for one scope. Without `--scope`, `stack check` and `stack digest` stop with reason `scope-required`.
- The exception is part of the approved config digest. Set it only with [`live stack-watch`](/docs/reference/cli/#live-stack-watch), never by hand. A disposable pilot cannot hold an exception.
- A change to the exception makes the stack approval out of date. Run `stack plan` and `stack approve` again.

## Init preferences

`init --preference` stores working preferences in `configRoot/user.json`, alongside the actor references from `--actor`:

| Key | Values |
| --- | --- |
| `explanationStyle` | `concise` or `detailed` |
| `diagrams` | `prefer`, `avoid` or `neutral` |
| `notes` | up to 10 one-line notes of up to 200 characters |

Capped at 2,048 bytes. The personal profile overrides any field it also sets.

## Scope configuration

`scope add` writes `configRoot/scopes/<scope>.json`:

```json
{"schemaVersion":1,"id":"example","displayName":"example","hubs":[],"policies":[],"accounts":[],"createdAt":"…"}
```

### Hubs

`--hub <id>=local-dir:<absolute path>[:<purposes>]` registers a local folder of company knowledge. The path must be under the pilot's `inputsRoot`. `<purposes>` is an optional comma-separated list of lowercase words.

```sh
--hub 'team-notes=local-dir:/absolute/path/to/pilot/inputs/hub'
```

### Policies

`--policy <pol_id>=<hub id>:<relative path>[:required]` names a policy file inside a hub. Policy text is added to briefs for that scope. A `required` policy that cannot be read fails the brief with `DEVTWIN_POLICY_UNAVAILABLE`.

```sh
--policy 'pol_security=team-notes:policies/security.md:required'
```

The policy ID is `pol_` plus 3–40 lowercase letters, digits or `-`. Every policy must reference a hub given in the same command.

### Accounts

`accounts` is always written as `[]`. It is reserved for [identity routing](/docs/guides/identity-routing/), which is not shipped yet; nothing reads it today.

## Personal profile

The profile lives at `configRoot/profile/` as numbered revisions (`v<generation>.json`) plus a `current.json` pointer. Write it only with `profile apply`. Schema: `schemas/profile.schema.json`.

| Field | Type | Limits |
| --- | --- | --- |
| `workKind` | string | one line, ≤ 200 |
| `workingPreferences.explanationStyle` | enum | `concise`, `detailed` |
| `workingPreferences.diagrams` | enum | `prefer`, `avoid`, `neutral` |
| `workingPreferences.autonomy` | enum | `ask-first`, `balanced`, `autonomous` |
| `workingPreferences.notes` | string[] | ≤ 10 items, ≤ 200 each |
| `stackCurrent`, `stackKnown` | string[] | ≤ 40 items, ≤ 80 each, `name[=version][:care]` |
| `writing.tone` | string | ≤ 120 |
| `writing.formality` | map | ≤ 10 audiences (`^[a-z][a-z0-9-]{0,39}$`) → `formal`, `neutral`, `casual` |
| `writing.greeting`, `writing.signOff` | string | ≤ 80 |
| `writing.length` | enum | `short`, `medium`, `long` |
| `writing.spelling` | string | `xx` or `xx-XX`, such as `en-GB` |
| `writing.avoidPhrases` | string[] | ≤ 20 items, ≤ 80 each |

The canonical JSON is capped at 4,096 bytes. Every field is optional.

## Stack watch catalog and overrides

The bundled catalog `catalog/stack-sources.json` maps item names (and aliases such as `nodejs` or `postgresql`) to GitHub repositories, endoflife.date products and package identifiers. Add your own with `stack plan --feed` and `--map`. Once approved, overrides are stored with the approval in `stateRoot/stack/approval.json` and carry forward to later plans until you pass new ones or `--clear-overrides`. See [Stack watch](/docs/guides/stack-watch/).

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `DEVTWIN_KIT` | Bundled skills | Absolute path of the kit checkout. The skills refuse to run without it. The CLI does not use it to find the kit; `agents status` and `live migrate` only check it to report a leftover legacy variable. |
| `DEVCTX_KIT` | Bundled skills, CLI notes | Legacy name, read for one transition. The skills fall back to it only when `DEVTWIN_KIT` is unset. `agents status` and `live migrate` add a `LEGACY_KIT_ENV` note while it is set. See [Migrate from devctx](/docs/guides/migrate-from-devctx/). |
| `CLAUDE_CONFIG_DIR` | CLI | If set, Claude's skill folder is `$CLAUDE_CONFIG_DIR/skills`, and the directory is protected. |
| `CODEX_HOME` | CLI | Protected. It does not change where Codex skills are installed; live previews warn `CODEX_HOME_IGNORED`. |
| `HOME` | CLI | Used for protected paths. In live mode it must equal the live config's `home`. |

devtwin reads no token or credential from the environment today.
