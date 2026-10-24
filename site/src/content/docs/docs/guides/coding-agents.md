---
title: Use with coding agents
description: Install the bundled devctx skills for Claude Code and Codex, check their state, remove them cleanly and recover from an interrupted install.
sidebar:
  label: Coding agents
---

devctx ships skills that teach a coding agent how to call the CLI: resume a project, propose a record, onboard a repository. `agents install` copies them into your agents' skill folders. Every install is previewed, approved by fingerprint, journaled and reversible.

## What gets installed

| Agent | Skill folder | Skills |
| --- | --- | --- |
| Claude Code | `.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) | `devctx-onboard`, `devctx-resume`, `devctx-record` |
| Codex | `.agents/skills` | the same three |

Each installed entry is a folder holding `SKILL.md` and a `.devctx-owned.json` ownership receipt. devctx only ever writes, updates or removes `devctx-*` entries it owns. Codex skills go to `.agents/skills`, never `.codex/skills`.

See [Bundled skills](/docs/reference/bundled-skills/) for what each skill does.

## Where it installs

- **Disposable pilot:** into a home listed in the pilot's `agentHomes`, named with `--home`. Use this to try installs safely.
- **Live mode:** into your real skill folders named in `~/.devctx/live.json`. Omit `--home`. See [Live mode](/docs/guides/live-mode/) for setup.

Any other target is refused with `DEVCTX_GATE_REQUIRED`.

## Install

Preview for one or both agents:

```sh
node bin/devctx.mjs agents install --pilot "$PILOT" --home "$AGENT_HOME" --agent claude --agent codex
```

The preview lists one action per agent and skill:

```json
{"kind":"skill-install","mode":"install","agents":["claude","codex"],
 "actions":[{"agent":"claude","skill":"devctx-onboard","path":"…/.claude/skills/devctx-onboard","status":"create","prior":null,"hash":"sha256:d7b6…"}, …],
 "fingerprint":"sha256:e310…"}
```

| Status | Meaning |
| --- | --- |
| `create` | New entry will be written. |
| `update` | An owned entry will be replaced with the current kit's version. |
| `installed` | Already current. Nothing to do. |
| `conflict` | A foreign, symlinked or unowned entry already has that name. |
| `modified` | An owned entry was edited by hand. |
| `blocked` | Live mode only: another entry for this agent is in conflict, so none of this agent's writes run. |

Apply only the fingerprint you reviewed:

```sh
node bin/devctx.mjs agents install --pilot "$PILOT" --home "$AGENT_HOME" --agent claude --agent codex \
  --apply --plan-fingerprint 'sha256:e310…'
```

```json
{"ok":true,"command":"agents install","result":{"applied":true,"runId":"run_714a64446eccd535dd38b17b","actions":[…]}}
```

:::tip[Keep the run ID]
Write down `runId`. The rollback check needs it.
:::

A `conflict` or `modified` entry is never overwritten. Resolve it by hand (move the foreign entry aside, or undo your edit), then preview again.

## Check state

```sh
node bin/devctx.mjs agents status --pilot "$PILOT" --home "$AGENT_HOME"
```

With a disposable pilot, `--home` is required. In live mode, omit it. Status shows each skill's current action status, any interrupted runs under `incomplete`, and `legacy`: old `devctx-*` copies under `.codex/skills` from earlier pilot installs. devctx never touches legacy copies; remove them by hand once you have checked they are old.

## Uninstall

Uninstall works the same way: preview, then apply the fingerprint.

```sh
node bin/devctx.mjs agents uninstall --pilot "$PILOT" --home "$AGENT_HOME" --agent claude
node bin/devctx.mjs agents uninstall --pilot "$PILOT" --home "$AGENT_HOME" --agent claude \
  --apply --plan-fingerprint '<fingerprint>'
```

Only entries whose receipt matches a completed install in this store are removed (`remove`). Foreign entries are reported as `preserve`, edited ones as `modified`, and both are left alone.

## Verify a clean rollback

After uninstalling, compare the skill folders with the inventory taken just before the install run:

```sh
node bin/devctx.mjs agents rollback-check --pilot "$PILOT" --run-id run_714a64446eccd535dd38b17b
```

A clean result:

```json
{"ok":true,"command":"agents rollback-check","result":{"status":"ok","runId":"run_714a64446eccd535dd38b17b",
 "folders":[{"agent":"claude","dir":"…/.claude/skills","existedBefore":false,"existsNow":true,"devctx":[],"foreign":[]}, …]}}
```

The check is read-only. Any difference in `devctx-*` entries fails with `DEVCTX_ROLLBACK_MISMATCH` (exit code 1) and lists each change. Changes to other tools' entries are listed under `foreign` for you to review; other tools write to these folders too, so run the check right after uninstalling.

## Recover an interrupted install

If an install, update or uninstall stopped part way, `agents status` reports `RECOVERY_REQUIRED` with the run IDs, and new applies are blocked. Preview and apply a recovery:

```sh
node bin/devctx.mjs agents recover --pilot "$PILOT"
node bin/devctx.mjs agents recover --pilot "$PILOT" --apply --plan-fingerprint '<fingerprint>'
```

Recovery removes an interrupted create, completes an interrupted update from saved copies, and finishes an interrupted remove. A file that matches neither the old nor the new hash is reported as `hold` and left alone.

To close a run that is stuck on a hold or has an unreadable journal, add `--release` to both commands. Release finishes what it safely can and leaves held files in place as foreign entries. Inspect and remove those by hand.

## Clear a stale lock

A killed command can leave `state/locks/install.lock` (or `live.lock`) behind, and later commands fail with `DEVCTX_BUSY`. Preview the release first; it shows the recorded owner:

```sh
node bin/devctx.mjs locks release --pilot "$PILOT" --lock install
node bin/devctx.mjs locks release --pilot "$PILOT" --lock install --apply --plan-fingerprint '<fingerprint>'
```

Apply removes the lock only if it belongs to this machine, its owner process is gone, and the file has not changed since the preview. Never delete journals or receipts by hand.

## Make the skills find the kit

The skills call the CLI as `node "$DEVCTX_KIT/bin/devctx.mjs"`. Set `DEVCTX_KIT` to the absolute path of your kit checkout, for example in `~/.zshrc`:

```sh
export DEVCTX_KIT="$HOME/.devctx/kit"
```

Open a new terminal and check it with `printenv DEVCTX_KIT`. Agents started from the Dock or Finder may not read your shell profile; ask the agent to run `printenv DEVCTX_KIT`, and if it prints nothing, start the agent from a terminal.

Before the first CLI call in a session, each skill asks you to confirm the kit path and the pilot path. It also warns if the installed skill came from a different kit commit than the one at `DEVCTX_KIT`.

## Using the brief in a session

Ask the agent to resume the project; the `devctx-resume` skill resolves the worktree and reads the brief. A useful prompt:

> Use devctx-resume for this worktree in scope `example`. Lead with stale records, disputed records and unknowns, then give me the current decisions. Don't use `--apply`.

There is no automatic session injection yet; you or the skill pull the brief when you need it. Records are evidence, not instructions: repository instructions and you still govern.

:::note[Cursor]
Cursor also reads `~/.agents/skills`, so it sees the installed skills. They behave the same for any caller, but Cursor is not tested.
:::
