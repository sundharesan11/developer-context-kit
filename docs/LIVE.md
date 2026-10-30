# Live activation runbook

This runbook turns on live mode on one machine. Live mode runs the kit against a real private store and the real Claude and Codex skill folders. It onboards one real repository, read-only. Follow the steps in order. Every write needs an owner approval. From step 13, one setup batch puts many writes behind one owner dialog.

Live mode is implemented. The owner ran steps 1 to 15 and 17 on one machine on 2026-10-25 at kit commit `b95ff72`, and they passed. They covered live init, store init, scope add and read-only onboarding of one real client repository, with identical snapshots before and after onboarding. They covered bundled install for Claude and Codex (three skills each, no conflicts). Fresh `claude -p` and `codex exec` sessions from a neutral folder listed the bundled skills (then named `devctx-*`), resolved the project and read the brief with an identical brief hash. Uninstall, `rollback-check` `ok` and reinstall also passed. Step 16 (interactive sessions) is still the owner's to run, and step 14's kit export is not yet in the shell profile. That activation predates the rename to devtwin; a setup made under the old name moves with [Migrating from devctx](MIGRATING.md). See the [roadmap](ROADMAP.md).

## What live mode changes

A live config is a pilot file with a `live` block. It names the config ID, the home, one skill folder per agent, the kit path and the kit identity. A Git kit has a commit. A package kit has a version and a SHA-256 digest of its files. Everything private lives under `~/.devtwin` at mode 0700:

```text
~/.devtwin/            0700, created by the owner
  live.json           the live config
  kits/               package kits, one locked folder per version and digest
  kit/                or a separate clone of the kit, detached at a reviewed commit
  store/              the private store (pilotRoot)
    config/ data/ state/ inputs/
```

- Outside the store, live mode writes only `devtwin-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, plus the exact paths of an approved write class (see [Live-mode exceptions](#live-mode-exceptions)). It never creates, removes or changes the mode of a skill folder or its parents.
- Codex skills go to `~/.agents/skills`. Nothing is written to `~/.codex/skills`. `CODEX_HOME` does not change the target; the preview warns with `CODEX_HOME_IGNORED` when it is set.
- Gemini CLI skills also go to `~/.agents/skills`. Gemini CLI reads this folder as an alias of `~/.gemini/skills`, and the alias wins. One install serves Codex and Gemini CLI. See [Gemini CLI](#gemini-cli).
- Live commands run only from the kit the live config names. A clone must be clean and detached at the live config's commit. A package kit folder must match its manifest, version and digest, and be locked and owned by you. Otherwise every live command fails with `GATE_REQUIRED`.
- Hooks, jobs and agent-invoked skills run the pinned kit's own `bin/devtwin.mjs`. They never run npm's global folder, so a later `npm i -g` changes nothing until you pin a new kit.
- The home is the process home. A run with a different `$HOME` is refused.
- The live config changes only through `live init`, `live add-repo`, `live set-kit` and `live migrate` ([Migrating from devctx](MIGRATING.md)). Each one records the approved config digest in `store/state/live/approved-config.json`. A live config that differs from the approved one is refused.
- Listed repositories are read-only. Onboarding never writes to them.
- A daily job can write an encrypted backup of the store to an approved folder. See [Backup and restore](#backup-and-restore).

## Live-mode exceptions

A live config can hold an optional `writeClasses` block. It names the only other paths outside the store that devtwin may write. Each class is a list of exact absolute paths, at most 16 per class:

| Class | Allowed paths |
| --- | --- |
| `hubRoot` | Folders inside the home for hub clones. Writes are allowed in the folder and below it, never in a sibling or a parent. |
| `instructionTargets` | `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, and a devtwin-owned file named `devtwin*.md` directly in `~/.claude` or `~/.codex`. |
| `hookTargets` | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`), `~/.codex/hooks.json` and `~/.gemini/settings.json`. |
| `launchAgents` | Files named `devtwin.<name>.plist` directly in `~/Library/LaunchAgents`. |
| `backupTargets` | Folders inside the home for backup archives and restores. Writes are allowed in the folder and below it, never in a sibling or a parent. |
| `repoLearnings` | Exact roots of listed repositories that may get learning branches. devtwin writes there only Git objects and one new `devtwin/learning-<id>` branch, never a file. |

- The classes are part of the approved config digest. A live config whose classes differ from the approved ones is refused with `GATE_REQUIRED`, `live.approval`. Set the classes only with `live write-classes` (see [Set the write classes](#set-the-write-classes)). Do not edit them in `live.json` by hand.
- Every path must be canonical and inside the home. A path whose folder is a link, or that is itself a link, is refused. A `hubRoot` or `backupTargets` folder must not overlap the store, the kit, a listed repository, a skill folder, a protected agent home or another approved folder.
- A `repoLearnings` path must be one of the config's `repos`, exactly. It lets a lesson accepted with `--target repo` write a learning branch in that repository ([HUB.md](HUB.md#write-a-lesson-to-the-repository)). Pushing the branch also needs the owner's `repo-push` consent.
- A write outside the store is allowed only when the writing code names one class and the path is exactly in it. Every other file in `~/.claude`, `~/.codex`, `~/.gemini`, `~/.agents` and `~/Library/LaunchAgents` stays refused.
- `hub join`, `hub sync` and `hub leave` write only inside an approved `hubRoot` folder, and `hub schedule` writes only its own `devtwin.hub-sync.<scope>.plist` in `launchAgents` ([HUB.md](HUB.md)).
- Only `agents install --hooks`, `agents uninstall --hooks` and `hub schedule` edit files in a file class, and each edits only its own class. See [Install the hooks](#install-the-hooks). The shared edit step works as follows. In `CLAUDE.md`, `AGENTS.md` and `GEMINI.md`, it changes only the text between `<!-- devtwin:begin -->` and `<!-- devtwin:end -->`. Every byte outside the markers stays the same. Malformed markers stop the edit with `CONFLICT`. In a JSON settings file, it changes only devtwin's own hook entries; the other values stay, but the file can be re-indented.
- Before each edit, it writes the exact prior bytes to `store/state/runs/<run_id>/backups/` at mode 0600, with a record that names the path. For a file that did not exist, only the record is written. If the file changed during the edit, the edit stops with `INTEGRITY` and the file is not replaced. The edited file is replaced atomically and keeps its own mode. A file that devtwin creates gets mode 0600.
- An edited file must be a regular file you own, with one link, that is not group or other writable.

### The import read-only exception

`import run` and the `import-daily` job read files outside the store, for each onboarded repository ([HARNESS.md](HARNESS.md#daily-import)):

- In `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`), only the one folder whose name devtwin computes from the repository's real path. In it, devtwin reads the `*.jsonl` session transcripts for their working directory only, and the `memory/*.md` files. It opens each file with no link following, reads only regular files and stops at a size limit.
- In the repository, only the `docs/solutions` files of the learnings base commit, through Git plumbing with hooks, filters and replace refs off. It never reads the working copy for this. The base is a remote-tracking ref, and the import trusts it as the repository holds it.

This exception is for reading only. The import writes nothing outside the store.

### The stack-watch exception

The stack watch, the radar digests and the radar jobs fetch from the network. In live mode they run only under the `stackWatch` exception, a separate entry in `live.json` next to the write classes:

```json
"exceptions": { "stackWatch": { "hosts": ["api.github.com", "changelog.example.com"], "maxRequests": 30 } }
```

- `hosts` lists each host the watch may reach, at most 32. Every host in the stack approval must be in this list, or the run stops with `GATE_REQUIRED`, reason `host-not-in-exception`, before any request.
- `maxRequests` caps one run, from 1 to 50 (30 by default). Unauthenticated GitHub requests are limited to about 60 an hour, so the cap stays below that. One scheduled radar run fetches each source once for all scopes.
- Live requests send no credential. The routed public-read binding is not used in live mode.
- Every live run is for one scope. `stack check` and `stack digest` without `--scope` stop with `GATE_REQUIRED`, reason `scope-required`, so one scope's digest never names another scope's projects.
- The exception is part of the approved config digest. Set it only with `live stack-watch`. Do not edit it in `live.json` by hand. A disposable pilot cannot hold an exception.

Take the hosts from the `hosts` list of `stack plan`. Preview, review, then apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" live stack-watch --pilot "$LIVE_CONFIG" --host api.github.com --host changelog.example.com
node "$KIT/bin/devtwin.mjs" live stack-watch --pilot "$LIVE_CONFIG" --host api.github.com --host changelog.example.com --apply --plan-fingerprint '<fingerprint>'
```

Each `--host` replaces the whole list. `--max-requests <n>` sets the cap. `--off` removes the exception. The devtwin hook denies `live stack-watch --apply` from an agent shell.

A config change makes the stack approval out of date: `stack check` then stops with `APPROVAL_REQUIRED`. Run `stack plan` and `stack approve` again after `live stack-watch` or `live set-kit`.

### Answer owner prompts over SSH

By default, an always-ask action needs the macOS owner dialog, so it is denied in a session with no GUI, such as an SSH login. The live config key `approval` changes this. It is off by default:

```sh
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty --apply --plan-fingerprint '<fingerprint>'
```

- With `dialog-or-tty`, devtwin reads the launchd session type (`launchctl managername`). In a GUI session (`Aqua`) the dialog is still required. With no GUI session, devtwin writes the prompt and a random six-letter code to the terminal (`/dev/tty`). Type the code and press Return to approve. Anything else, no answer in 300 seconds or no terminal denies.
- The prompt and your answer use the terminal, not the JSON result line on stdout.
- The `SSH_*` variables play no part in this choice.
- The devtwin hook still denies always-ask commands from agent shells.
- This is an owner action. The apply shows the owner dialog, and the devtwin hook denies `live approval --apply` from an agent shell. `--mode dialog` removes the key again.
- The key is part of the approved config digest, so a change ends the path confirmation. Run `paths confirm` again after it.

### Set the write classes

`live write-classes` changes the approved classes. Each class flag replaces the paths of that class: `--hub-root`, `--instruction-target`, `--hook-target`, `--launch-agent`, `--backup-target` and `--repo-learnings`. Give a flag once for each path. `--clear <class>` removes a class. A class that you do not name stays as it is. Preview, review, then apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --hook-target "$HOME/.claude/settings.json" --hook-target "$HOME/.codex/hooks.json"
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --hook-target "$HOME/.claude/settings.json" --hook-target "$HOME/.codex/hooks.json" --apply --plan-fingerprint '<fingerprint>'
```

- The preview shows `writeClasses` with `from` and `to`, and the config digest before and after. Nothing is written.
- Apply records the new approved digest and then replaces `live.json`. The config ID stays.
- A path that does not have the shape of its class is refused with `GATE_REQUIRED`. A request that changes nothing is refused with `INVALID_INPUT`.
- This is an owner action. The devtwin hook denies `live write-classes --apply` from an agent shell.

## Placeholders

Set these in the shell you use for the run. Replace each placeholder and keep the single quotes.

```sh
KIT='<kit path>'
LIVE_CONFIG="$HOME/.devtwin/live.json"
REPO='<absolute real path of the repository>'
```

`<kit path>` is the `kitRoot` that `devtwin kit install` prints in step 5, such as `~/.devtwin/kits/0.1.0-alpha.1-<digest prefix>`. For a Git clone, it is `$HOME/.devtwin/kit`.

`<scope>` is the scope name, `<project>` a project ID that starts with the scope, such as `example.atlas`, and `<actor>` an actor reference such as `email:you@example.com`. Do not write real client names or account identifiers into this repository, issues or public notes.

## 1. Preflight (read-only)

1. Check the installed agent versions with `claude --version` and `codex --version`. Confirm from each agent's current documentation that this version reads user skills from `~/.claude/skills` and `~/.agents/skills`.
2. Inspect both skill folders without following links:

   ```sh
   ls -ld ~/.claude/skills ~/.agents/skills
   ```

   Each must be a real directory, not a symbolic link, and so must `~/.claude` and `~/.agents`. If one is missing or is a link, stop. Creating or fixing a skill folder is the owner's separate decision, done by hand. The kit never creates it.
3. If `CLAUDE_CONFIG_DIR` is set, the Claude folder is `$CLAUDE_CONFIG_DIR/skills` instead.
4. The home itself must not sit inside a Git worktree. `git -C ~ rev-parse --show-toplevel` should fail with "not a git repository".

## 2. Read-only Git check on the repository

Onboarding refuses a repository that Git filters could touch, and stops on a slow `git status`. Check both before any write. These commands mirror the kit's checks and write nothing.

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" config --includes --name-only --get-regexp '^(filter|diff)\.'
time GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -C "$REPO" status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=all | wc -c
```

- Any output from the first command means onboarding will fail with `PATH_UNSAFE`. The kit ignores global and system Git configuration, so only the repository's own configuration counts, such as a repository-local Git LFS filter. Stop. Never change the repository's Git configuration to get past it.
- The status must finish well inside 30 seconds and print less than 16 MiB. Otherwise onboarding fails with `GIT_QUERY_FAILED` or `LIMIT`. Stop.
- Run both in a shell with no `GIT_*` variables set, as the kit does.

## 3. Close editors

Ask the owner to close editors, Git clients and file watchers on the repository for the whole run. They can change the repository and spoil the before-and-after snapshots.

## 4. Create the private folder

```sh
mkdir -m 700 ~/.devtwin
ls -ld ~/.devtwin
```

The folder must be owned by you, mode `drwx------`, and outside any Git worktree. `live init` refuses a folder that is not private. It never creates or changes it.

## 5. Install the kit

Live mode runs from a kit that you pin. Install the package and copy it into a locked kit folder. Contributors can pin a Git clone instead; see [Pin a Git clone](#pin-a-git-clone).

```sh
npm i -g devtwin
devtwin kit install
```

The plan writes nothing. It shows the target folder (`kitRoot`), the `version`, the `digest` and the `kitId`, `npm:<version>+sha256:<digest>`. Compare the digest with the kit digest in the [GitHub release](https://github.com/sundharesan11/devtwin/releases) for that version. A different digest means that the installed package is not the published one. Stop.

When the digests match, copy the kit:

```sh
devtwin kit install --apply
devtwin kit list
```

- `kit install --apply` copies the package into `~/.devtwin/kits/<version>-<digest prefix>/`. Folders are mode 0500 and files 0400, and the copy is checked against its digest. `~/.devtwin` must exist and be private, as in step 4. The command creates only `~/.devtwin/kits`.
- No owner dialog is shown, because nothing runs from the new folder yet. The devtwin hook denies `kit install --apply` from an agent shell.
- `kit list` shows each kit folder, its `kitId`, `ok` or `bad`, and the pinned one.
- The result names the next command, `devtwin live set-kit --kit <version>+<digest>`. On a first activation you do not need it: step 7 pins the kit with `live init --kit`.

Set `KIT` to the printed `kitRoot`.

### Pin a Git clone

Contributors can pin a clone. Clone the kit and check out the reviewed merged commit, detached:

```sh
git clone '<kit repository URL>' "$HOME/.devtwin/kit"
git -C "$HOME/.devtwin/kit" checkout --detach '<merged commit>'
git -C "$HOME/.devtwin/kit" status --porcelain
git -C "$HOME/.devtwin/kit" rev-parse HEAD
```

`status` must print nothing. Do not install packages or create files in the clone: an untracked file makes it dirty, and live commands then refuse. Set `KIT="$HOME/.devtwin/kit"`, and leave out `--kit` in step 7.

## 6. Before snapshot

Take the repository snapshot with the snapshot script, `scripts/repo-snapshot.mjs`. The script is in the Git repository, not in the package. With a Git kit, set `TOOLS="$KIT"`. With a package kit, clone the repository outside `~/.devtwin` at the release tag `v<version>`, and set `TOOLS` to that clone. Write the snapshot to a new private temporary folder:

```sh
SNAP="$(mktemp -d)"
node "$TOOLS/scripts/repo-snapshot.mjs" --repo "$REPO" --out "$SNAP/before.json"
ls -l "$SNAP/before.json"
```

The file is created at mode 0600. The snapshot hashes tracked and untracked files and `.git` outside `objects`, `logs` and `FETCH_HEAD`. Ignored files are recorded by path, size and modification time.

## 7. Live init

Preview the live config. This writes nothing. With a package kit, `--kit` names the kit from step 5, and the global `devtwin` command runs `live init` in that kit folder:

```sh
devtwin live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --kit '<version>+<digest>'
```

With a Git clone, run `node "$KIT/bin/devtwin.mjs" live init` with the same flags and no `--kit`.

Review `config` (home, skill folders, kit path and identity, repositories), `layout` and `warnings`. `KIT_NOT_SIBLING` means the kit is neither in `~/.devtwin/kits` nor at `~/.devtwin/kit`. Apply only the fingerprint the owner approved:

```sh
devtwin live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --kit '<version>+<digest>' --apply --plan-fingerprint '<fingerprint>'
```

The next steps run `node "$KIT/bin/devtwin.mjs"`, which works for both kinds of kit. At the terminal, `devtwin` with the same arguments runs in the pinned kit too; see [How the global command forwards](#how-the-global-command-forwards).

Apply creates the store folders, records the approved digest and writes `live.json`. It draws a random config ID once.

## 8. Store init

```sh
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor '<actor>'
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor '<actor>' --apply
```

## 9. Keep the before snapshot

Move the snapshot into private state, then remove the empty temporary folder:

```sh
mkdir -m 700 ~/.devtwin/store/state/evidence
mv "$SNAP/before.json" ~/.devtwin/store/state/evidence/before.json
rmdir "$SNAP"
```

Evidence that names private paths, clients or accounts stays here. The repository records only the date, commit and pass or fail.

## 10. Add the scope

```sh
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>'
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>' --apply
```

## 11. Onboard the repository

Preview first, before any skill install. If the preview is refused, stop activation for this repository.

```sh
node "$KIT/bin/devtwin.mjs" project onboard --pilot "$LIVE_CONFIG" --scope '<scope>' --project '<project>' --repo "$REPO" --request-id '<request-id>' --accept none
```

Check that `repoWrites` is empty. Review the candidates, unknowns and conflicts with the owner, as in [Guided onboarding](ONBOARDING.md). Preview again with the chosen `--accept` value, then apply that fingerprint:

```sh
node "$KIT/bin/devtwin.mjs" project onboard --pilot "$LIVE_CONFIG" --scope '<scope>' --project '<project>' --repo "$REPO" --request-id '<request-id>' --accept '<selection>' --apply --plan-fingerprint '<fingerprint>'
```

Onboarding copies some repository text, such as scanned facts and commands, into the store. See [Backup and restore](#backup-and-restore).

## 12. Snapshot after onboarding

```sh
node "$TOOLS/scripts/repo-snapshot.mjs" --repo "$REPO" --out ~/.devtwin/store/state/evidence/after-onboard.json
node "$TOOLS/scripts/repo-snapshot.mjs" --compare ~/.devtwin/store/state/evidence/before.json ~/.devtwin/store/state/evidence/after-onboard.json
```

`identical: true` is the expected result. Otherwise the output lists each path that changed. The owner judges each one.

## 13. Install the skills, one agent at a time

### One approval for this step and the next ones

The skills, the hook settings files, the hooks, the paths confirmation, the backup folder and the scheduled jobs can all run behind one owner dialog. Preview the batch, review it, then apply it in your own terminal:

```sh
node "$KIT/bin/devtwin.mjs" setup plan --pilot "$LIVE_CONFIG" --all-pending --backup-target "$HOME/devtwin-backups"
node "$KIT/bin/devtwin.mjs" setup apply --pilot "$LIVE_CONFIG" --all-pending --backup-target "$HOME/devtwin-backups" --apply --plan-fingerprint '<fingerprint>'
```

The dialog lists each change on its own line, in the order the changes run. On a first setup it looks like this:

```text
Approve 12 setup changes
1. Approve hook settings file ~/.claude/settings.json
2. Approve hook settings file ~/.codex/hooks.json
3. Approve backup folder ~/devtwin-backups
4. Approve launch agent ~/Library/LaunchAgents/devtwin.review-monthly.plist
5. Approve launch agent ~/Library/LaunchAgents/devtwin.backup-daily.plist
6. Install skills in ~/.claude/skills: devtwin-onboard, devtwin-resume, devtwin-record, devtwin-capture
7. Install skills in ~/.agents/skills: devtwin-onboard, devtwin-resume, devtwin-record, devtwin-capture
8. Install job review-monthly (monthly) at ~/Library/LaunchAgents/devtwin.review-monthly.plist
9. Install job backup-daily (daily) at ~/Library/LaunchAgents/devtwin.backup-daily.plist
10. Confirm kit ~/.devtwin/kits/<kit folder> at <kit ID> and config ~/.devtwin/live.json
11. Add devtwin hook entries to ~/.claude/settings.json: SessionStart, UserPromptSubmit, PreToolUse, PreCompact, Stop
12. Add devtwin hook entries to ~/.codex/hooks.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop. Then trust them in Codex with /hooks
```

- `--all-pending` selects every owner setup step that is available, not done and not skipped. `--steps <id,id,...>` selects only the steps you name. Leave out `--backup-target` to skip the backup steps.
- The config change runs first and adds to the approved classes. It keeps every path you approved before, so you do not list the earlier plists again. `paths confirm` runs after it, and the hooks run last.
- The radar jobs join the batch only after the stack approval in [Turn on the radar](#turn-on-the-radar). The advisory job needs the radar job on, so it joins a later batch.
- If a step changed after your approval, the batch stops with `DEVTWIN_STALE_VERSION`. The error lists `done` and `notRun`. Preview again for the rest.
- `instructions apply` and `backup key export` keep their own dialog. So does `hub join`.
- The hook denies `setup apply --all-pending` and `setup apply --steps` from an agent shell. From an agent shell it allows `setup apply` only with one `--step` that is not an owner step. A command that names devtwin and `setup` or an owner action is denied too when it holds a shell expansion such as `${`, `$(`, `$'`, `$"` or a backtick.
- A step whose path cannot be approved, such as a symlinked settings file, leaves the batch with a reason. The other steps still run under the one dialog.

The per-step commands below stay as the alternative. Each one asks on its own.

### One agent at a time

Preview, review, then apply after approval. Repeat for `codex`.

```sh
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

- Every action path must be a `devtwin-*` entry directly inside that agent's skill folder.
- `create` and `update` write. `installed` is already current.
- `conflict` means a foreign, symlinked or unowned entry with that name. `modified` means an owned entry was edited. Either one turns that agent's writes into `blocked`. Nothing for that agent is written. Resolve it by hand, then preview again.
- Apply records an inventory of the skill folder before the first write. Keep the `runId` from the result. The rollback check needs it.

`agents status --pilot "$LIVE_CONFIG"` shows the current state of both folders. Its `hooks` field shows each hook entry, as in the next section.

### Install the hooks

The devtwin hook delivers lesson lines and blocks owner-only commands from agent shells. It needs the `hookTargets` file of each agent approved in the live config, as [Set the write classes](#set-the-write-classes) shows. `--hooks` changes only those files. Without it, `agents install` installs only the skills, as before. Preview, review, then apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" agents install --hooks --pilot "$LIVE_CONFIG" --agent claude --agent codex
node "$KIT/bin/devtwin.mjs" agents install --hooks --pilot "$LIVE_CONFIG" --agent claude --agent codex --apply --plan-fingerprint '<fingerprint>'
```

- The preview lists each entry it adds or removes in `changes`, with the exact JSON. `create` makes a file that does not exist, `update` edits one, `installed` is already current and `blocked` means the file is not approved or its folder is missing.
- Claude Code gets entries in `settings.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash`) `PreCompact` and `Stop`. Codex gets entries in `~/.codex/hooks.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `^(apply_patch|Bash)$`), `PostToolUse` (matcher `^Bash$`), `PreCompact` and `Stop`. An install made before the `Stop` entry existed shows it as `missing` until you run the install again.
- Gemini CLI gets entries in `~/.gemini/settings.json`. See [Gemini CLI](#gemini-cli).
- Each entry runs `node "<kit>/bin/devtwin.mjs" hook --event <event> --agent <agent> --pilot "<live config>"` with a 10-second timeout. Gemini CLI counts the timeout in milliseconds, so its entries say `10000`. The line names the kit folder and the live config only. A new kit commit checked out in the same clone keeps every line byte-identical. A package kit has a new folder for each version, so a package upgrade changes the lines, as does a move to another clone. Install shows the changed lines as `update`.
- An entry is devtwin's only when a completed hook install of this live config wrote it. devtwin never changes another entry, also when it looks like a devtwin entry. An exact copy that devtwin did not write is `conflict` with `foreign-entry`. A devtwin entry that you edited is `conflict` with `modified`. A conflict blocks that agent's file. Fix it by hand, then preview again.
- Apply writes a backup of each file, an inventory and a journal under `store/state/runs/<run_id>/`, as a skill install does. `agents recover` and `agents rollback-check --run-id '<run_id>'` read them. Install also refreshes the kit receipt that the hook trusts.
- Codex runs a new or changed hook only after you trust it. Open Codex, run `/hooks`, and trust each devtwin entry. `agents status` repeats this note.
- `agents uninstall --hooks` removes only devtwin's entries. Entries you edited stay.

`agents status` reports each agent's hook entries as `installed`, `missing`, `modified`, `outdated` or `foreign-entry`, per event. It also reports the kit receipt, and it gives an `AMBIGUOUS_ROOT` note for a repository root that is bound in more than one scope. The hook gives such a root no lessons.

### Confirm the kit and config paths

Confirm the paths once, so that skills stop asking for them and the kit receipt stays current. Preview, review, then apply in your own terminal:

```sh
node "$KIT/bin/devtwin.mjs" paths confirm --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" paths confirm --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

- The apply shows the owner dialog with both paths. It writes `store/state/confirmed-paths.json`: the real paths of the kit and the live config, the SHA-256 of the config and the kit's identity. For a Git kit, that is its `.git/HEAD` and the commit of the branch it names. For a package kit, it is the `kitId` from the kit's manifest. The setup step `paths-confirm` runs the same command.
- This is an owner action. The devtwin hook denies `paths confirm --apply` from an agent shell.
- At each session start, the hook compares these values with small file reads, with no Git process and no lock. The line names the pinned kit as ``Kit: `<path>` ``, and the skills run the CLI from that path. While the values match, the line ends with "Kit and config confirmed." and the hook moves the receipt's `verifiedAt` to now. For a package kit, the hook first checks every file of the kit against its digest. If a file changed, the line says `kit not verified` and the receipt is not renewed. You do not need to run `hook verify` each week.
- A kit upgrade or a config change ends the confirmation. The line then says that the kit or the config changed, and skills ask for the paths again. Run `paths confirm` again after you check the new paths.
- `paths check --pilot "$LIVE_CONFIG"` is read-only. It reports `match` or `mismatch` for each value.
- The receipt lasts 30 days. When it is not renewed and expires within three days, the session-start line says so. Run `hook verify`, or confirm the paths.

### Deliver the instruction block

The managed instruction block carries your accepted preferences and devtwin's working rules into every Claude Code and Codex session. It needs these `instructionTargets` paths approved in the live config:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --instruction-target "$HOME/.claude/CLAUDE.md" --instruction-target "$HOME/.claude/devtwin.md" --instruction-target "$HOME/.codex/AGENTS.md"
```

Then preview, review and apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" instructions plan --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" instructions apply --pilot "$LIVE_CONFIG" --plan-fingerprint '<fingerprint>'
```

- **Claude Code.** devtwin writes the block to `~/.claude/devtwin.md`, a file it owns, and adds a marker block to `~/.claude/CLAUDE.md` with one import line, `@<path of devtwin.md>`.
- **Codex.** devtwin writes the block between the markers in `~/.codex/AGENTS.md`.
- **Gemini CLI.** devtwin writes the block between the markers in `~/.gemini/GEMINI.md`. Approve that path with `--instruction-target "$HOME/.gemini/GEMINI.md"`. With no `--agent`, the plan targets Gemini CLI only when the live config names it.
- **Your text.** Every byte outside `<!-- devtwin:begin -->` and `<!-- devtwin:end -->` stays the same. Malformed markers are `conflict` with the reason `markers`, and the apply writes nothing. Each edit writes a backup first, as in [Live-mode exceptions](#live-mode-exceptions).
- **Repository files.** A repository's own `AGENTS.md` or `CLAUDE.md` is never a target. The write class refuses any path that is not one of the shapes above.
- **Cap.** The block has at most 1,200 characters. When the preferences do not fit, the plan leaves out the oldest ones and warns with `PREFERENCES_DROPPED`. Retire some with `pref retire`. Each preference is checked again when the block is built, and one that fails, for example because it names a scope added later, is left out with `PREFERENCES_REFUSED`. Sandbox advice from setup is for one repository and stays out of the block.
- **Owner action.** `instructions apply` shows the owner dialog with the exact block, and the devtwin hook denies it from an agent shell. `--agent claude`, `--agent codex` or `--agent gemini` limits the targets, and `--remove` takes the block out.
- **After a change.** Run `instructions plan` again after you accept or retire a preference. The block does not update by itself.

### Turn on the radar

The radar jobs need the stack-watch exception above, a stack approval and an approved `launchAgents` path for each job:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --launch-agent "$HOME/Library/LaunchAgents/devtwin.radar-weekly.plist" --launch-agent "$HOME/Library/LaunchAgents/devtwin.advisory-hourly.plist" --launch-agent "$HOME/Library/LaunchAgents/devtwin.review-monthly.plist"
node "$KIT/bin/devtwin.mjs" stack plan --pilot "$LIVE_CONFIG" --with radar --with advisories
node "$KIT/bin/devtwin.mjs" stack approve --pilot "$LIVE_CONFIG" --with radar --with advisories --plan-fingerprint '<fingerprint>'
node "$KIT/bin/devtwin.mjs" schedule plan --pilot "$LIVE_CONFIG" --job radar-weekly
node "$KIT/bin/devtwin.mjs" schedule apply --pilot "$LIVE_CONFIG" --job radar-weekly --plan-fingerprint '<fingerprint>'
```

`--launch-agent` replaces the whole `launchAgents` class, so also list the hub sync plist when you use one. Repeat `schedule plan` and `schedule apply` for `advisory-hourly` and `review-monthly`. Each apply shows the owner dialog, and the devtwin hook denies `schedule apply` and `schedule off --apply` from an agent shell. See [Schedules](HARNESS.md#schedules) for what each job does and how to turn it off.

## 14. The kit path for skills

The skills take the kit path from the session-start line of the devtwin hook, ``Kit: `<path>` ``. They run `node '<kit>/bin/devtwin.mjs'` from that path, and never a `devtwin` command found on `PATH`. With the hooks from step 13 installed, you do not need a shell variable.

`DEVTWIN_KIT` is the fallback for a session that has no such line, for example an agent without the hook. To set it, ask the owner before editing the shell profile. Then add one line, for example to `~/.zshrc`, with the kit path from step 5:

```sh
export DEVTWIN_KIT='<kit path>'
```

Open a new terminal and check it with `printenv DEVTWIN_KIT`. The variable names one kit folder, so change it with each `live set-kit`. The kit writes agent settings files only through `agents install --hooks` and `agents uninstall --hooks`.

Agents started from the Dock, Finder or another GUI launcher may not read the shell profile. Without the session-start line and without the variable, the skills stop and ask for the kit path.

## 15. Fresh-session checks

Run these from a neutral folder that is outside every repository, with user-level settings only. The session must not write to the repository.

```sh
NEUTRAL="$(mktemp -d)"
cd "$NEUTRAL"
```

Use one prompt for both agents. Replace the placeholders. It answers the skills' once-per-session confirmation up front:

```text
List the installed skills whose names start with devtwin-. Then follow devtwin-resume to resolve
the project for the worktree <repo> in scope <scope>. I confirm the kit path <kit real path>
and the pilot path <home>/.devtwin/live.json for this session. Run only read-only commands.
Never use --apply and never edit files.
```

Claude, with read tools and only the exact shell commands the checks need. Never widen these to `node` or `git -C` prefixes: those would let the session run any script or Git command, including writes to the repository. A command outside the list is refused, which fails the check safely.

Pipe the prompt on stdin. `--allowedTools` takes several values, so a prompt placed after it is read as another tool rule. Then `claude -p` fails with "Input must be provided either through stdin or as a prompt argument".

The skills run the CLI as `node '<kit>/bin/devtwin.mjs'`, with the kit's real path from the session-start line. They check a Git kit's commit with `git -C '<kit>' rev-parse HEAD`, and a package kit's version and digest with `node '<kit>/bin/devtwin.mjs' version`. A session without that line falls back to the literal `"$DEVTWIN_KIT"` form. The list therefore names both forms of exactly these read-only commands. Replace `<kit real path>` with the output of `realpath "$KIT"`.

```sh
K='<kit real path>'
ALLOWED="Read,Glob,Grep,Bash(printenv DEVTWIN_KIT),Bash(realpath:*),Bash(git -C '$K' rev-parse HEAD),Bash(node '$K/bin/devtwin.mjs' version),Bash(node '$K/bin/devtwin.mjs' context resolve:*),Bash(node '$K/bin/devtwin.mjs' context brief:*),Bash(node $K/bin/devtwin.mjs context resolve:*),Bash(node $K/bin/devtwin.mjs context brief:*)"
ALLOWED="$ALLOWED"',Bash(git -C "$DEVTWIN_KIT" rev-parse HEAD),Bash(node "$DEVTWIN_KIT/bin/devtwin.mjs" version),Bash(node "$DEVTWIN_KIT/bin/devtwin.mjs" context resolve:*),Bash(node "$DEVTWIN_KIT/bin/devtwin.mjs" context brief:*)'
printf '%s\n' '<prompt>' | claude -p --setting-sources user --allowedTools "$ALLOWED"
```

If a listed command is still refused because the skill wrote it differently, record the refusal, compare the command with the list, and rerun with that one exact command added. Do not add a broader rule.

Codex, in its read-only sandbox:

```sh
codex exec --sandbox read-only --skip-git-repo-check '<prompt>'
```

Pass when each session lists `devtwin-onboard`, `devtwin-record` and `devtwin-resume`, runs `context resolve` from the pinned kit path, and names the onboarded project. A session without the hook line uses `DEVTWIN_KIT` instead. A kit warning means the installed skills came from another kit than the one at `<kit>`; stop and find out why. For a package kit, the skills compare the receipt's `kitId` with the version and digest that `version` prints instead. Save the transcripts under `~/.devtwin/store/state/evidence/`.

## 16. Interactive sessions

The owner starts one interactive session per agent from the same neutral folder, with `claude` and `codex`. Ask the same question. Confirm the kit and pilot paths when the skill asks. Pass on the same terms as step 15.

After the last session, take another snapshot and compare it with `before.json`, as in step 12. A tool that creates linked worktrees in the repository during the run, such as a test runner using `git worktree add`, shows up as `.git/worktrees/...` differences. The owner judges those by path, like any other difference.

## 17. Rollback rehearsal

Uninstall, check at once, then reinstall.

```sh
node "$KIT/bin/devtwin.mjs" agents uninstall --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devtwin.mjs" agents uninstall --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
node "$KIT/bin/devtwin.mjs" agents rollback-check --pilot "$LIVE_CONFIG" --run-id '<install run id>'
```

Repeat for `codex`. Uninstall removes only entries whose receipt matches a completed install in this store. Edited or foreign entries are preserved and reported.

The rollback check compares the folder with the inventory taken before that install run. It is read-only. It fails with `DEVTWIN_ROLLBACK_MISMATCH` and exit code 1 on any difference in `devtwin-*` entries. It lists changes to foreign top-level entries with their times; other tools change those folders too, so the owner reviews each one. Run it right after uninstall, so foreign churn stays small.

Then reinstall with a fresh preview and approval (step 13), and repeat a fresh-session check (step 15).

## Upgrading the kit

For a package kit, follow [Upgrading](UPGRADING.md): install the new release, `kit install`, `live set-kit --kit`, then one setup batch. A rollback is `live set-kit` to an earlier kit folder from 0.1.0-alpha.1 or later, then one batch. Older kits cannot load a live config that names a package kit. The same guide moves a Git-clone setup to a package kit.

`live set-kit` takes `--commit <sha>` for a Git kit or `--kit <version>+<digest>` for a package kit, never both. It runs from the new kit. Its apply shows the owner dialog "Change the kit devtwin runs". The dialog names the old and new kit IDs and folders. For a package kit, it also asks you to compare the digest with the one in the GitHub release for that version. The devtwin hook denies `live set-kit --apply` from an agent shell.

### Upgrade a Git clone

Upgrade side by side. The old clone stays usable until the new one is proven.

1. Clone the new reviewed commit next to the old one, for example at `~/.devtwin/kit-next`, detached and clean, as in [Pin a Git clone](#pin-a-git-clone).
2. From the new clone, preview and apply the kit change:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>'
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>' --apply --plan-fingerprint '<fingerprint>'
   ```

   The apply shows the owner dialog. It also rebuilds the lesson index and the session summaries of every scope with the new kit, so the hook finds your bound projects at once.

3. From now on every live command runs from the new clone. Update the skills and the hooks, rewrite the scheduled job files and confirm the new paths behind one owner dialog:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup plan --pilot "$LIVE_CONFIG" --all-pending
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup apply --pilot "$LIVE_CONFIG" --all-pending --apply --plan-fingerprint '<fingerprint>'
   ```

   The dialog lists the changed skills as `Update skills in ...`, the hook files as `Replace devtwin hook entries in ...`, each job that is on as `Rewrite job <job> at ~/Library/LaunchAgents/devtwin.<job>.plist for kit <path>` and the new kit path to confirm. A job file still names the old clone and the Node path of that time. A job that is on keeps running the old kit until this batch writes its file again. Every job that is on is in the list: the radar, advisory, review, backup, activity, import, send and hub sync jobs, and a job whose file is missing. `schedule status` shows each one as `outdated` (or `missing`) before the batch and `current` after it. Or run the steps one at a time: preview `agents install` for each agent (changed skills show `update`), `agents install --hooks`, then `schedule apply --job <job>` (or `hub schedule --scope <scope>`) for each job that is on, then `paths confirm`. Each one asks on its own.
4. If you set `DEVTWIN_KIT`, point it at the new clone, with the owner's approval.
5. If you ran the steps one at a time, run `paths confirm` from the new clone last, preview then apply. The new kit path ends the old confirmation.

Installs stay owned across a kit change, because receipts bind to the config ID, not to the kit. The kit commit in a receipt is provenance. The bundled skills warn when it differs from the commit at `<kit>`, the path from the session-start line.

The live config records each clone's path. Do not move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit. Remove an old clone by hand only when nothing points at it.

To add another repository, use `live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>'`, preview then apply, and run step 2 on it first.

## How the global command forwards

The global `devtwin` command from `npm i -g` is for a person at the terminal. Hooks, jobs and skills never use it: they run the pinned kit's `bin/devtwin.mjs` directly.

When you run a live command, such as `devtwin agents status --pilot "$LIVE_CONFIG"`, the global command runs it in the pinned kit. It forwards when all of these are true:

- The live config exists. It is the file that `--pilot` names, or `~/.devtwin/live.json` without `--pilot`.
- The config matches the approved digest in the store.
- The pinned kit is a Git clone at its commit, or a package kit folder in `~/.devtwin/kits` whose manifest names its version and digest.

Forwarding runs the same Node with the kit's `bin/devtwin.mjs` and the same arguments, with no shell. It writes `devtwin: running kit <kit ID>` on stderr. The kit then runs all its own gates.

When the global command does not forward, it writes `devtwin: not forwarding to <kit> (<reason>); running this kit` on stderr. The reason is one of these:

| Reason | Meaning |
| --- | --- |
| `missing` | The pinned kit folder does not exist. |
| `outside-kits` | A package kit is not directly in `~/.devtwin/kits`. |
| `kit-check` | The kit's manifest or Git commit does not match the live config. |
| `unapproved` | The live config differs from the approved one. |
| `unreadable` | The live config cannot be read. |
| `pilot-twice` | The command gives `--pilot` more than once. |

The command then runs in the global install, where the live gates refuse it with `GATE_REQUIRED`. Without a live config, for example with a disposable pilot, the command runs in the global install with no note.

- `live set-kit --kit` and `live init --kit` forward to the kit that `--kit` names in `~/.devtwin/kits`, because they must run from that kit.
- These commands always run in the global install: `--version`, `version`, `help`, `demo`, `kit install`, `kit list`, `skill-sources catalog`, `skill-sources check`, `skill-sources preview`, `skill template-list` and `hook`.
- A forwarded command does not forward again. If the kit itself would forward, it refuses with `GATE_REQUIRED` and the reason `second-hop`.

## Recovering an interrupted install

`agents status` reports `RECOVERY_REQUIRED` and the run IDs when an install, update or uninstall stopped part way. New applies are blocked until recovery.

```sh
node "$KIT/bin/devtwin.mjs" agents recover --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" agents recover --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

Recovery removes an interrupted create, completes an interrupted update from the run folder's copies, and finishes an interrupted remove. It never rolls an update back. It always matches the journal's hashes. A file that matches neither is reported as `hold` and left alone, and the run stays blocked.

To close a run that is stuck on a hold, or whose journal cannot be read, preview and apply a release. Release finishes every action it safely can, then closes the run and leaves the held files where they are. Those files then count as foreign: the kit never touches them again, so inspect and remove them by hand if they are leftovers. A crash right after a skill folder was created can leave an empty `devtwin-*` folder that blocks later installs for that agent. Check that it is empty, then remove it with `rmdir`.

```sh
node "$KIT/bin/devtwin.mjs" agents recover --pilot "$LIVE_CONFIG" --release
node "$KIT/bin/devtwin.mjs" agents recover --pilot "$LIVE_CONFIG" --release --apply --plan-fingerprint '<fingerprint>'
```

## Stale locks

A command that was killed can leave `state/locks/install.lock` or `state/locks/live.lock` behind, and later commands fail with `BUSY`. Preview the release first. It shows the recorded owner. Apply only removes the lock when it belongs to this machine, its owner process is no longer running, and the file has not changed since the preview.

```sh
node "$KIT/bin/devtwin.mjs" locks release --pilot "$LIVE_CONFIG" --lock install
node "$KIT/bin/devtwin.mjs" locks release --pilot "$LIVE_CONFIG" --lock install --apply --plan-fingerprint '<fingerprint>'
```

An empty or unreadable lock file is refused. Make sure no devtwin command is running, then remove that one file by hand. Never edit or delete journals or receipts by hand.

## Leftover .codex/skills copies

Earlier pilot installs wrote Codex skills to `.codex/skills`. `agents status` lists any `devtwin-*` or legacy `devctx-*` entries there under `legacy`. The kit never touches them. The owner may remove them by hand after checking they are old copies.

## Gemini CLI

Gemini CLI is the third supported agent. Its support level is `full`: skills, the instruction block and the owner-action block all work. Name it at live init with `--agent gemini`. Then the setup steps `skills-gemini` and `hooks-gemini` install it.

A live config made before this release does not name Gemini CLI. Gemini CLI still reads the skills of the Codex install. To add its hooks and its instruction block, approve `~/.gemini/settings.json` and `~/.gemini/GEMINI.md` with `live write-classes`. Then run `agents install --hooks --agent gemini` and `instructions plan --agent gemini`, and apply each after review.

| Part | Where |
| --- | --- |
| Skills | `~/.agents/skills`, shared with Codex |
| Instruction block | A marker block in `~/.gemini/GEMINI.md` |
| Hooks | The top-level `hooks` key of `~/.gemini/settings.json` |

- **Shared skills folder.** Codex and Gemini CLI read the same `~/.agents/skills` folder. `agents install --agent codex --agent gemini` writes each skill once. `agents uninstall --agent gemini` keeps the entries while Codex is in the live config: each one shows `preserve` with the reason `shared-folder`. To remove them, uninstall for both agents.
- **Hook events.** devtwin adds `SessionStart`, `BeforeAgent`, `BeforeTool` (matcher `^run_shell_command$`), `AfterTool` (matcher for the shell, read, edit, glob and search tools), `PreCompress` and `AfterAgent`. Each entry has a `name` such as `devtwin-pre-tool` and a timeout of `10000` milliseconds. Other keys in `settings.json`, such as `mcpServers`, and the hooks of other tools stay. The edit refuses a file with comments, because it reads plain JSON only.
- **Owner-action block.** On `BeforeTool` for `run_shell_command`, the hook denies an owner-only devtwin command with `{"decision":"deny","reason":"..."}`. Gemini CLI sends the reason to the agent as the tool error.
- **Lesson lines.** Gemini CLI does not read added context from a `BeforeTool` hook. The hook adds the lesson lines on `AfterTool`, with the tool result, so the agent reads them right after it opens, edits or runs the matching file or command. This is one step later than for Claude Code and Codex. The capability `preToolContext` is `false` for Gemini CLI.
- **Session start and stop.** The session-start line arrives on `SessionStart`. `AfterAgent` ends each agent turn, as `Stop` does for Claude Code, so it writes the stop stub.
- **Activity label.** Gemini CLI sets `GEMINI_CLI=1` in the shells it starts. A record written from such a shell has the actor `gemini`.

Antigravity CLI is not supported yet. Its hook and skill locations differ from Gemini CLI's, and its public docs do not agree. devtwin writes nothing for it.

## Cursor

Cursor also reads `~/.agents/skills`, so it will see the bundled skills. They behave the same for any caller and keep every confirmation. Cursor support is not tested.

## What the approved digest does not do

The approved digest catches accidental edits to `live.json`. It does not stop deliberate same-user tampering: the same user can rewrite the live config and the digest together. The kit is not a sandbox; see the [security model](SECURITY-MODEL.md). If a live config change was interrupted, the previous live config can stay approved alongside the new one until the next approved live config change. Finish or redo the change to clear it.

## If the store is lost

Without the store, installed `devtwin-*` entries have no matching journal and become unowned. The kit then refuses to update or remove them. Remove them by hand:

1. List the entries: `ls -la ~/.claude/skills ~/.agents/skills | grep devtwin-`.
2. Check each entry. It must be a real directory, not a link, and hold only `SKILL.md` and `.devtwin-owned.json`. The receipt's `kind` must be `skill-bundled` and its `configId` must be your old live config's.
3. Move each checked entry into a private holding folder, such as one made with `mkdir -m 700 ~/.devtwin/removed`. Do not delete it yet. Leave alone any entry that fails a check.
4. Move the old `live.json` aside too. `live init` refuses an existing live config or a non-empty store.
5. Start again from step 6.

## Backup and restore

devtwin can keep encrypted backups of the store in a folder that you approve. There is no sync. The archive format and the files it leaves out are in [Storage](STORAGE.md#backups).

- `backup create` writes one archive into an approved `backupTargets` folder. Agents and the `backup-daily` job may run it. Each folder keeps the newest archive of each day, for the newest 14 days that have archives. A create removes only older archives of its own day and archives older than those days.
- The key is 32 random bytes in your macOS Keychain, made on the first `backup create`. Without the key, an archive cannot be read.
- `backup restore` writes only to a new folder inside an approved `backupTargets` folder. It never writes the live store.
- `backup key export` prints the key once. Only you can run it, after the owner dialog. Until it has run once, the activity digest warns that backups cannot be restored on another machine.

### Turn on daily backups

Pick a folder inside your home that is not in `~/.devtwin`, such as a folder that a cloud drive or an external copy job saves. Preview, review, then apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --backup-target "$HOME/devtwin-backups"
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --backup-target "$HOME/devtwin-backups" --apply --plan-fingerprint '<fingerprint>'
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --launch-agent "$HOME/Library/LaunchAgents/devtwin.backup-daily.plist"
node "$KIT/bin/devtwin.mjs" schedule plan --pilot "$LIVE_CONFIG" --job backup-daily
node "$KIT/bin/devtwin.mjs" schedule apply --pilot "$LIVE_CONFIG" --job backup-daily --plan-fingerprint '<fingerprint>'
```

The `--launch-agent` flag replaces the whole `launchAgents` list, so give every plist that you approved before as well. The setup batch in [step 13](#one-approval-for-this-step-and-the-next-ones) does the same with one dialog: `--backup-target` adds the `backup-folder` and `job-backup` steps, and it keeps the plists you approved before. Then export the key once, in your own terminal and outside any agent session:

```sh
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

Store the key in a password manager, then clear the terminal. The export writes `store/state/backup/key-export.json` with the time only.

### Restore a backup

1. Run `backup status` to list the archives in each approved folder.
2. Preview the restore into a new folder inside the backup folder:

   ```sh
   node "$KIT/bin/devtwin.mjs" backup restore --pilot "$LIVE_CONFIG" --from "$HOME/devtwin-backups/<archive>.dtb" --to "$HOME/devtwin-backups/restored"
   ```

3. Check the file count and the archive time in the preview.
4. Run the same command with `--apply --plan-fingerprint '<fingerprint>'`.
5. Read the result. It gives the number of files written and the number verified.

The restored files are plain text. When the backup folder is copied off the machine, such as by a cloud drive, move the restored folder out of it or delete it after use.

Restore refuses a folder that already exists, a folder outside the approved backup folders and the backup folder itself. It decrypts and checks the whole archive in memory before it writes. A changed archive or a wrong key fails with `INTEGRITY`, and nothing is written.

The restored folder holds `config`, `data` and `state`, the same layout as `~/.devtwin/store`. devtwin does not point the live config at it, and no command does this step. To use it, stop every agent session and move the current store aside. Then move the restored folders into `~/.devtwin/store` by hand, and make an empty `inputs` folder at mode 0700. The restored `state/live/approved-config.json` must match `live.json`. If the live config changed after the backup, live commands fail with `GATE_REQUIRED`, `live.approval`.

### Restore on another machine

1. Add the exported key to the new machine's Keychain with `security add-generic-password -s devtwin-backup -a "$USER" -w`.
2. Paste the key when `security` asks for the password. The key does not go into the shell history or a command line.
3. Copy the archive into an approved backup folder on that machine.
4. Follow [Restore a backup](#restore-a-backup).

Onboarding copies some client repository text into the store. On the machine, that text is protected only by mode 0700 and the disk encryption. The archive protects only the copies that you keep away from the machine.

## Troubleshooting

| Error | Likely cause |
| --- | --- |
| `GATE_REQUIRED`, `live.kitRoot`, `running-kit` | The command ran from another checkout, not the live config's kit. |
| `GATE_REQUIRED`, `live.kitCommit`, `dirty`, `attached` or `commit` | The kit has changes, is on a branch, or is at another commit. A stray file such as a Finder `.DS_Store` under the kit's code folders also counts; list them with `git -C "$KIT" ls-files --others --ignored --exclude-standard -- bin src skills scripts schemas catalog` and remove them by hand. |
| `BUSY` | A lock is held. If no devtwin command is running, see [Stale locks](#stale-locks). |
| `GATE_REQUIRED`, `live.approval` | `live.json` differs from the approved live config. Do not edit it by hand. |
| `GATE_REQUIRED`, `live.home` | `$HOME` differs from the live config's home. |
| `PATH_UNSAFE`, `configDir` | `~/.devtwin` is missing, not yours, or not mode 0700. |
| `GATE_REQUIRED`, `Live skill folder unavailable` | A skill folder is missing or is a link. Stop; see step 1. |
| `RECOVERY_REQUIRED` | An earlier run stopped part way. See [Recovering an interrupted install](#recovering-an-interrupted-install). |
