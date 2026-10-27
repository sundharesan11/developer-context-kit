# Live activation runbook

This runbook turns on live mode on one machine. Live mode runs the kit against a real private store and the real Claude and Codex skill folders. It onboards one real repository, read-only. Follow the steps in order. Every write is a separate owner approval.

Live mode is implemented. The owner ran steps 1 to 15 and 17 on one machine on 2026-10-25 at kit commit `b95ff72`, and they passed. They covered live init, store init, scope add and read-only onboarding of one real client repository, with identical snapshots before and after onboarding. They covered bundled install for Claude and Codex (three skills each, no conflicts). Fresh `claude -p` and `codex exec` sessions from a neutral folder listed the bundled skills (then named `devctx-*`), resolved the project and read the brief with an identical brief hash. Uninstall, `rollback-check` `ok` and reinstall also passed. Step 16 (interactive sessions) is still the owner's to run, and step 14's kit export is not yet in the shell profile. That activation predates the rename to devtwin; a setup made under the old name moves with [Migrating from devctx](MIGRATING.md). See the [roadmap](ROADMAP.md).

## What live mode changes

A live config is a pilot file with a `live` block. It names the config ID, the home, one skill folder per agent, the kit path and the kit commit. Everything private lives under `~/.devtwin` at mode 0700:

```text
~/.devtwin/            0700, created by the owner
  live.json           the live config
  kit/                a separate clone of the kit, detached at a reviewed commit
  store/              the private store (pilotRoot)
    config/ data/ state/ inputs/
```

- Outside the store, live mode writes only `devtwin-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, plus the exact paths of an approved write class (see [Live-mode exceptions](#live-mode-exceptions)). It never creates, removes or changes the mode of a skill folder or its parents.
- Codex skills go to `~/.agents/skills`. Nothing is written to `~/.codex/skills`. `CODEX_HOME` does not change the target; the preview warns with `CODEX_HOME_IGNORED` when it is set.
- Live commands run only from the kit the live config names. That clone must be clean and detached at the live config's commit. Otherwise every live command fails with `GATE_REQUIRED`.
- The home is the process home. A run with a different `$HOME` is refused.
- The live config changes only through `live init`, `live add-repo`, `live set-kit` and `live migrate` ([Migrating from devctx](MIGRATING.md)). Each one records the approved config digest in `store/state/live/approved-config.json`. A live config that differs from the approved one is refused.
- Listed repositories are read-only. Onboarding never writes to them.
- A daily job can write an encrypted backup of the store to an approved folder. See [Backup and restore](#backup-and-restore).

## Live-mode exceptions

A live config can hold an optional `writeClasses` block. It names the only other paths outside the store that devtwin may write. Each class is a list of exact absolute paths, at most 16 per class:

| Class | Allowed paths |
| --- | --- |
| `hubRoot` | Folders inside the home for hub clones. Writes are allowed in the folder and below it, never in a sibling or a parent. |
| `instructionTargets` | `~/.claude/CLAUDE.md` (or `$CLAUDE_CONFIG_DIR/CLAUDE.md`), `~/.codex/AGENTS.md`, and a devtwin-owned file named `devtwin*.md` directly in one of those two folders. |
| `hookTargets` | `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`) and `~/.codex/hooks.json`. |
| `launchAgents` | Files named `devtwin.<name>.plist` directly in `~/Library/LaunchAgents`. |
| `backupTargets` | Folders inside the home for backup archives and restores. Writes are allowed in the folder and below it, never in a sibling or a parent. |

- The classes are part of the approved config digest. A live config whose classes differ from the approved ones is refused with `GATE_REQUIRED`, `live.approval`. Set the classes only with `live write-classes` (see [Set the write classes](#set-the-write-classes)). Do not edit them in `live.json` by hand.
- Every path must be canonical and inside the home. A path whose folder is a link, or that is itself a link, is refused. A `hubRoot` or `backupTargets` folder must not overlap the store, the kit, a listed repository, a skill folder, a protected agent home or another approved folder.
- A write outside the store is allowed only when the writing code names one class and the path is exactly in it. Every other file in `~/.claude`, `~/.codex`, `~/.agents` and `~/Library/LaunchAgents` stays refused.
- `hub join`, `hub sync` and `hub leave` write only inside an approved `hubRoot` folder, and `hub schedule` writes only its own `devtwin.hub-sync.<scope>.plist` in `launchAgents` ([HUB.md](HUB.md)).
- Only `agents install --hooks`, `agents uninstall --hooks` and `hub schedule` edit files in a file class, and each edits only its own class. See [Install the hooks](#install-the-hooks). The shared edit step works as follows. In `CLAUDE.md` and `AGENTS.md`, it changes only the text between `<!-- devtwin:begin -->` and `<!-- devtwin:end -->`. Every byte outside the markers stays the same. Malformed markers stop the edit with `CONFLICT`. In a JSON settings file, it changes only devtwin's own hook entries; the other values stay, but the file can be re-indented.
- Before each edit, it writes the exact prior bytes to `store/state/runs/<run_id>/backups/` at mode 0600, with a record that names the path. For a file that did not exist, only the record is written. If the file changed during the edit, the edit stops with `INTEGRITY` and the file is not replaced. The edited file is replaced atomically and keeps its own mode. A file that devtwin creates gets mode 0600.
- An edited file must be a regular file you own, with one link, that is not group or other writable.

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

### Set the write classes

`live write-classes` changes the approved classes. Each class flag replaces the paths of that class: `--hub-root`, `--instruction-target`, `--hook-target`, `--launch-agent` and `--backup-target`. Give a flag once for each path. `--clear <class>` removes a class. A class that you do not name stays as it is. Preview, review, then apply after approval:

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
KIT="$HOME/.devtwin/kit"
LIVE_CONFIG="$HOME/.devtwin/live.json"
REPO='<absolute real path of the repository>'
```

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

## 5. Clone the kit and pin it

Clone the kit and check out the reviewed merged commit, detached:

```sh
git clone '<kit repository URL>' "$KIT"
git -C "$KIT" checkout --detach '<merged commit>'
git -C "$KIT" status --porcelain
git -C "$KIT" rev-parse HEAD
```

`status` must print nothing. Do not install packages or create files in the clone: an untracked file makes it dirty, and live commands then refuse.

## 6. Before snapshot

Take the repository snapshot with the clone's script. Write it to a new private temporary folder:

```sh
SNAP="$(mktemp -d)"
node "$KIT/scripts/repo-snapshot.mjs" --repo "$REPO" --out "$SNAP/before.json"
ls -l "$SNAP/before.json"
```

The file is created at mode 0600. The snapshot hashes tracked and untracked files and `.git` outside `objects`, `logs` and `FETCH_HEAD`. Ignored files are recorded by path, size and modification time.

## 7. Live init

Preview the live config. This writes nothing.

```sh
node "$KIT/bin/devtwin.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO"
```

Review `config` (home, skill folders, kit path and commit, repositories), `layout` and `warnings`. `KIT_NOT_SIBLING` means the kit is not at `~/.devtwin/kit`. Apply only the fingerprint the owner approved:

```sh
node "$KIT/bin/devtwin.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --apply --plan-fingerprint '<fingerprint>'
```

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
node "$KIT/scripts/repo-snapshot.mjs" --repo "$REPO" --out ~/.devtwin/store/state/evidence/after-onboard.json
node "$KIT/scripts/repo-snapshot.mjs" --compare ~/.devtwin/store/state/evidence/before.json ~/.devtwin/store/state/evidence/after-onboard.json
```

`identical: true` is the expected result. Otherwise the output lists each path that changed. The owner judges each one.

## 13. Install the skills, one agent at a time

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

The devtwin hook delivers lesson lines and blocks owner-only commands from agent shells. It needs the two `hookTargets` files approved in the live config, as [Set the write classes](#set-the-write-classes) shows. `--hooks` changes only those files. Without it, `agents install` installs only the skills, as before. Preview, review, then apply after approval:

```sh
node "$KIT/bin/devtwin.mjs" agents install --hooks --pilot "$LIVE_CONFIG" --agent claude --agent codex
node "$KIT/bin/devtwin.mjs" agents install --hooks --pilot "$LIVE_CONFIG" --agent claude --agent codex --apply --plan-fingerprint '<fingerprint>'
```

- The preview lists each entry it adds or removes in `changes`, with the exact JSON. `create` makes a file that does not exist, `update` edits one, `installed` is already current and `blocked` means the file is not approved or its folder is missing.
- Claude Code gets entries in `settings.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash`) and `PreCompact`. Codex gets entries in `~/.codex/hooks.json` for `SessionStart`, `UserPromptSubmit`, `PreToolUse` (matcher `^(apply_patch|Bash)$`), `PostToolUse` (matcher `^Bash$`) and `PreCompact`.
- Each entry runs `node "<kit>/bin/devtwin.mjs" hook --event <event> --agent <agent> --pilot "<live config>"` with a 10-second timeout. The line names the kit clone and the live config only. A new kit commit in the same clone keeps every line byte-identical. An upgrade to another clone changes the lines, and install shows them as `update`.
- An entry is devtwin's only when a completed hook install of this live config wrote it. devtwin never changes another entry, also when it looks like a devtwin entry. An exact copy that devtwin did not write is `conflict` with `foreign-entry`. A devtwin entry that you edited is `conflict` with `modified`. A conflict blocks that agent's file. Fix it by hand, then preview again.
- Apply writes a backup of each file, an inventory and a journal under `store/state/runs/<run_id>/`, as a skill install does. `agents recover` and `agents rollback-check --run-id '<run_id>'` read them. Install also refreshes the kit receipt that the hook trusts.
- Codex runs a new or changed hook only after you trust it. Open Codex, run `/hooks`, and trust each devtwin entry. `agents status` repeats this note.
- `agents uninstall --hooks` removes only devtwin's entries. Entries you edited stay.

`agents status` reports each agent's hook entries as `installed`, `missing`, `modified`, `outdated` or `foreign-entry`, per event. It also reports the kit receipt, and it gives an `AMBIGUOUS_ROOT` note for a repository root that is bound in more than one scope. The hook gives such a root no lessons.

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
- **Your text.** Every byte outside `<!-- devtwin:begin -->` and `<!-- devtwin:end -->` stays the same. Malformed markers are `conflict` with the reason `markers`, and the apply writes nothing. Each edit writes a backup first, as in [Live-mode exceptions](#live-mode-exceptions).
- **Repository files.** A repository's own `AGENTS.md` or `CLAUDE.md` is never a target. The write class refuses any path that is not one of the shapes above.
- **Cap.** The block has at most 1,200 characters. When the preferences do not fit, the plan leaves out the oldest ones and warns with `PREFERENCES_DROPPED`. Retire some with `pref retire`. Each preference is checked again when the block is built, and one that fails, for example because it names a scope added later, is left out with `PREFERENCES_REFUSED`. Sandbox advice from setup is for one repository and stays out of the block.
- **Owner action.** `instructions apply` shows the owner dialog with the exact block, and the devtwin hook denies it from an agent shell. `--agent claude` or `--agent codex` limits the targets, and `--remove` takes the block out.
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

## 14. Export DEVTWIN_KIT

The skills find the kit through `DEVTWIN_KIT`. Ask the owner before editing the shell profile. Then add one line, for example to `~/.zshrc`:

```sh
export DEVTWIN_KIT="$HOME/.devtwin/kit"
```

Open a new terminal and check it with `printenv DEVTWIN_KIT`. The kit writes agent settings files only through `agents install --hooks` and `agents uninstall --hooks`.

Agents started from the Dock, Finder or another GUI launcher may not read the shell profile. Check from inside such a session: ask the agent to run `printenv DEVTWIN_KIT`. If it prints nothing, start that agent from a terminal instead. The skills refuse to run without the variable.

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

A session can run the CLI through the kit's absolute real path instead of the literal `"$DEVTWIN_KIT"` form. The list therefore names both forms of exactly the two read-only commands. Replace `<kit real path>` with the output of `realpath "$KIT"`.

```sh
printf '%s\n' '<prompt>' | claude -p --setting-sources user --allowedTools 'Read,Glob,Grep,Bash(printenv DEVTWIN_KIT),Bash(realpath:*),Bash(git -C "$DEVTWIN_KIT" rev-parse HEAD),Bash(node "$DEVTWIN_KIT/bin/devtwin.mjs" context resolve:*),Bash(node "$DEVTWIN_KIT/bin/devtwin.mjs" context brief:*),Bash(node <kit real path>/bin/devtwin.mjs context resolve:*),Bash(node <kit real path>/bin/devtwin.mjs context brief:*)'
```

If a listed command is still refused because the skill wrote it differently, record the refusal, compare the command with the list, and rerun with that one exact command added. Do not add a broader rule.

Codex, in its read-only sandbox:

```sh
codex exec --sandbox read-only --skip-git-repo-check '<prompt>'
```

Pass when each session lists `devtwin-onboard`, `devtwin-record` and `devtwin-resume`, runs `context resolve` through `DEVTWIN_KIT`, and names the onboarded project. A kit-commit warning means the installed skills came from another commit; stop and find out why. Save the transcripts under `~/.devtwin/store/state/evidence/`.

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

Upgrade side by side. The old clone stays usable until the new one is proven.

1. Clone the new reviewed commit next to the old one, for example at `~/.devtwin/kit-next`, detached and clean, as in step 5.
2. From the new clone, preview and apply the kit change:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>'
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>' --apply --plan-fingerprint '<fingerprint>'
   ```

3. From now on every live command runs from the new clone. Preview `agents install` for each agent; changed skills show `update`. Apply after approval.
4. Point `DEVTWIN_KIT` at the new clone, with the owner's approval.

Installs stay owned across a kit change, because receipts bind to the config ID, not to the kit. The kit commit in a receipt is provenance. The bundled skills warn when it differs from the commit at `DEVTWIN_KIT`.

The live config records each clone's path. Do not move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit. Remove an old clone by hand only when nothing points at it.

To add another repository, use `live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>'`, preview then apply, and run step 2 on it first.

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

- `backup create` writes one archive into an approved `backupTargets` folder. Agents and the `backup-daily` job may run it. Each folder keeps the newest 14 archives.
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

The `--launch-agent` flag replaces the whole `launchAgents` list, so give every plist that you approved before as well. Then export the key once, in your own terminal and outside any agent session:

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
