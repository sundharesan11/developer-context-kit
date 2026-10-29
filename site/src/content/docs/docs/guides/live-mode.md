---
title: Live mode
description: Turn on devtwin for real on one machine, with a private store under ~/.devtwin, a pinned kit clone and your real Claude Code and Codex skill folders.
---

A disposable pilot is for trying devtwin. **Live mode** is for daily use. It points devtwin at a real private store and your real agent skill folders, and onboards your real repositories read-only.

Every write is still a preview followed by an apply of the exact fingerprint you approved.

## What live mode sets up

```text
~/.devtwin/            0700, created by you
  live.json           the live config
  kit/                a separate clone of the kit, detached at a reviewed commit
  store/              the private store
    config/ data/ state/ inputs/
```

- Outside the store, devtwin writes only `devtwin-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`, plus the exact paths you approve as [write classes](/docs/reference/configuration/#write-classes). It never creates, removes or changes the mode of those folders.
- Codex skills go to `~/.agents/skills`, never `~/.codex/skills`. `CODEX_HOME` does not change this; the preview warns `CODEX_HOME_IGNORED` if it is set.
- Live commands run only from the kit clone the live config names, and that clone must be clean and detached at the configured commit.
- The live config changes only through `live init`, `live add-repo`, `live set-kit`, `live write-classes`, `live stack-watch`, `live approval` and `live migrate`. Each records an approved digest of the config; a `live.json` that differs from the approved one is refused.
- Listed repositories are read-only.
- `import run` and the `import-daily` job also read, never write, two things for each onboarded repository: its own Claude Code folder in `~/.claude/projects`, and the `docs/solutions` files of its remote default branch. See [`import run`](/docs/reference/cli/#import-run). A shell `import run` writes as its caller, under the caller's limits; only the `import-daily` job writes as the job.

:::caution[Turn on backups]
Until you approve a backup folder, there is no backup: losing `~/.devtwin` loses your records, decisions and journals, and leaves installed skills unowned. Onboarding copies some repository text into the store, protected only by mode 0700 and your disk encryption. See [Backup and restore](#backup-and-restore).
:::

The steps below use these variables:

```sh
KIT="$HOME/.devtwin/kit"
LIVE_CONFIG="$HOME/.devtwin/live.json"
REPO='/absolute/real/path/to/your/repository'
```

## 1. Check your agents' skill folders

```sh
ls -ld ~/.claude/skills ~/.agents/skills
```

Each must be a real directory, not a symbolic link, and so must `~/.claude` and `~/.agents`. If one is missing or is a link, create or fix it yourself first; devtwin never creates it. If `CLAUDE_CONFIG_DIR` is set, check `$CLAUDE_CONFIG_DIR/skills` instead.

Your home directory must not be inside a Git worktree: `git -C ~ rev-parse --show-toplevel` should fail with "not a git repository".

## 2. Check the repository

Onboarding refuses a repository that Git filters could touch and stops on a slow `git status`. Check both up front, in a shell with no `GIT_*` variables set:

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C "$REPO" config --includes --name-only --get-regexp '^(filter|diff)\.'
time GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false -C "$REPO" status --porcelain=v1 -z --untracked-files=normal --ignore-submodules=all | wc -c
```

- Any output from the first command (for example a repository-local Git LFS filter) means onboarding will fail with `DEVTWIN_PATH_UNSAFE`. Don't change the repository's Git config to get past it.
- The status must finish well inside 30 seconds and print less than 16 MiB, or onboarding fails with `DEVTWIN_GIT_QUERY_FAILED` or `DEVTWIN_LIMIT`.

## 3. Create the private folder

```sh
mkdir -m 700 ~/.devtwin
ls -ld ~/.devtwin
```

It must be yours, mode `drwx------`, and outside any Git worktree.

## 4. Clone and pin the kit

```sh
git clone https://github.com/sundharesan11/devtwin.git "$KIT"
git -C "$KIT" checkout --detach '<reviewed commit>'
git -C "$KIT" status --porcelain
```

`status` must print nothing. Don't install packages or create files in the clone: an untracked file under its code folders makes it dirty, and live commands then refuse.

## 5. Create the live config

Preview, from the clone:

```sh
node "$KIT/bin/devtwin.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO"
```

Review `config` (home, skill folders, kit path and commit, repositories), `layout` and `warnings`. `KIT_NOT_SIBLING` means the kit is not at `~/.devtwin/kit`. Then apply:

```sh
node "$KIT/bin/devtwin.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" \
  --apply --plan-fingerprint '<fingerprint>'
```

Apply creates the store folders, records the approved digest, writes `live.json` and draws a random config ID.

## 6. Initialize the store and add a scope

```sh
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor 'email:you@example.com'
node "$KIT/bin/devtwin.mjs" init --pilot "$LIVE_CONFIG" --actor 'email:you@example.com' --apply
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>'
node "$KIT/bin/devtwin.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>' --apply
```

## 7. Onboard the repository

Follow [Onboard a repository](/docs/guides/onboard-a-repository/) with `--pilot "$LIVE_CONFIG"`. Check that `repoWrites` is empty before you apply.

### Optional: prove the repository was untouched

The kit includes a snapshot script. Take a snapshot before onboarding and compare after:

```sh
node "$KIT/scripts/repo-snapshot.mjs" --repo "$REPO" --out /private/path/before.json
# … onboard …
node "$KIT/scripts/repo-snapshot.mjs" --repo "$REPO" --out /private/path/after.json
node "$KIT/scripts/repo-snapshot.mjs" --compare /private/path/before.json /private/path/after.json
```

`identical: true` is the expected result. Keep snapshots in private state such as `~/.devtwin/store/state/evidence/`. Close editors and Git clients on the repository while you do this, so they don't change files between snapshots.

## 8. Install the skills

One agent at a time, preview then apply. Omit `--home` in live mode:

```sh
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devtwin.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

Repeat for `codex`. A `conflict` or `modified` entry blocks all of that agent's writes (`blocked`); resolve it by hand and preview again. Keep the `runId` for the rollback check. See [Use with coding agents](/docs/guides/coding-agents/) for statuses, uninstall and recovery.

## 9. Point the skills at the kit

Add one line to your shell profile, for example `~/.zshrc`:

```sh
export DEVTWIN_KIT="$HOME/.devtwin/kit"
```

Open a new terminal and check `printenv DEVTWIN_KIT`. devtwin edits agent settings files only through `agents install --hooks` and `agents uninstall --hooks`, after you approve them as write classes.

To turn on lesson delivery and the owner-action block, follow [Turn on the hooks in live mode](/docs/guides/lessons-and-hooks/#turn-on-the-hooks-in-live-mode). Then run [`paths confirm`](/docs/guides/lessons-and-hooks/#confirm-the-kit-and-config-paths) once, so that the skills stop asking for the kit and config paths and the hook keeps its receipt current. To approve the skills, the hooks, the paths confirmation, the backup folder and the scheduled jobs with one owner dialog, run the [setup batch](/docs/guides/setup-wizard/#approve-the-owner-steps-at-once) (`setup plan --all-pending`, then `setup apply --all-pending --apply`). To run these steps one at a time with a what, why and undo for each, use the [setup wizard](/docs/guides/setup-wizard/). To share lessons with colleagues, see [Organization hub](/docs/guides/organization-hub/).

## 10. Try it in a fresh session

From a neutral folder outside every repository, start your agent and ask:

```text
List the installed skills whose names start with devtwin-. Then follow devtwin-resume to resolve
the project for the worktree <repo> in scope <scope>. Run only read-only commands.
Never use --apply and never edit files.
```

The session should list `devtwin-capture`, `devtwin-onboard`, `devtwin-record` and `devtwin-resume`, run `context resolve` through `DEVTWIN_KIT`, and name your project. A kit-commit warning means the installed skills came from another commit; reinstall from the current kit.

## Learning branches

A lesson accepted with `--target repo` becomes a learning branch in the project's repository. Approve the repository once, and grant the push consent once. Preview each command, review it, then apply it:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --repo-learnings "$REPO"
node "$KIT/bin/devtwin.mjs" consent grant --pilot "$LIVE_CONFIG" --kind repo-push --repo "$REPO"
```

- `--repo-learnings` takes the exact root of a repository in the config's `repos`. It replaces the whole `repoLearnings` list, so also give every repository that you approved before.
- devtwin writes only Git objects and the new branch `devtwin/learning-<id>`. Your working copy, index and current branch never change.
- The push waits in the held queue for the consent's hold time. The hourly `learning-send` job then pushes it over SSH to the URL the consent recorded. It runs from a clean repository of its own, so your repository's Git config cannot redirect it, and it checks that the base is on the remote first. For an HTTPS remote, devtwin prints the `git push` command for you instead.
- `project set` changes the learnings folder or base. A change voids the consent; grant it again. See [Write a lesson to the repository](/docs/guides/organization-hub/#write-a-lesson-to-the-repository).

## Backup and restore

devtwin can keep encrypted backups of the store in a folder that you approve. There is no sync.

- `backup create` writes one archive into an approved `backupTargets` folder. Agents and the `backup-daily` job may run it. Each folder keeps the newest archive of each day, for the newest 14 days that have archives. A create removes only older archives of its own day and archives older than those days.
- The archive holds the config, data and state roots, without caches such as the lesson index and hook session files. It is encrypted with AES-256-GCM.
- The key is 32 random bytes in your macOS Keychain, made on the first `backup create`. Without the key, an archive cannot be read.
- `backup restore` writes only to a new folder inside an approved backup folder. It never writes the live store.
- `backup key export` prints the key once. Only you can run it, after the owner dialog. Until it has run once, the activity digest warns that backups cannot be restored on another machine.

### Turn on daily backups

Pick a folder inside your home that is not in `~/.devtwin`, such as a folder that a cloud drive or an external copy job saves. Preview each command, review it, then apply it:

```sh
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --backup-target "$HOME/devtwin-backups"
node "$KIT/bin/devtwin.mjs" live write-classes --pilot "$LIVE_CONFIG" --launch-agent "$HOME/Library/LaunchAgents/devtwin.backup-daily.plist"
node "$KIT/bin/devtwin.mjs" schedule plan --pilot "$LIVE_CONFIG" --job backup-daily
node "$KIT/bin/devtwin.mjs" schedule apply --pilot "$LIVE_CONFIG" --job backup-daily --plan-fingerprint '<fingerprint>'
```

The `--launch-agent` flag replaces the whole `launchAgents` list, so also give every plist that you approved before. Then export the key once, in your own terminal and outside any agent session:

```sh
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" backup key export --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

Store the key in a password manager, then clear the terminal.

### Restore a backup

1. Run `backup status` to list the archives in each approved folder.
2. Preview the restore into a new folder inside the backup folder:

   ```sh
   node "$KIT/bin/devtwin.mjs" backup restore --pilot "$LIVE_CONFIG" --from "$HOME/devtwin-backups/<archive>.dtb" --to "$HOME/devtwin-backups/restored"
   ```

3. Check the file count and the archive time in the preview.
4. Run the same command with `--apply --plan-fingerprint '<fingerprint>'`, and approve the owner dialog.
5. Read the result. It gives the number of files written and the number verified.

Restore decrypts and checks the whole archive in memory before it writes. A changed archive or a wrong key fails with `DEVTWIN_INTEGRITY`, and nothing is written. The restored files are plain text: when a cloud drive copies the backup folder, move the restored folder out of it or delete it after use.

The restored folder holds `config`, `data` and `state`, the same layout as `~/.devtwin/store`. No command points the live config at it. To use it, stop every agent session and move the current store aside. Then move the restored folders into `~/.devtwin/store` by hand, and make an empty `inputs` folder at mode 0700.

To restore on another machine, add the exported key to that machine's Keychain with `security add-generic-password -s devtwin-backup -a "$USER" -w`, and paste the key when it asks for the password. Then copy the archive into an approved backup folder there and follow the steps above.

## Answer owner prompts over SSH

By default, an always-ask action needs the macOS owner dialog, so it is denied in a session with no GUI, such as an SSH login. To answer on the terminal instead, opt in once:

```sh
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty
node "$KIT/bin/devtwin.mjs" live approval --pilot "$LIVE_CONFIG" --mode dialog-or-tty --apply --plan-fingerprint '<fingerprint>'
```

- In a GUI session the dialog is still required. With no GUI session, devtwin writes the prompt and a random six-letter code to the terminal. Type the code and press Return to approve. Anything else, or no answer in 300 seconds, denies.
- The devtwin hook still denies always-ask commands from agent shells.
- This is an owner action, and the apply shows the owner dialog. `--mode dialog` turns it off again.
- The key is part of the approved config, so a change ends the path confirmation. Run `paths confirm` again after it.

## Add another repository

Run the step 2 checks on it, then:

```sh
node "$KIT/bin/devtwin.mjs" live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>'
node "$KIT/bin/devtwin.mjs" live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>' --apply --plan-fingerprint '<fingerprint>'
```

## Upgrade the kit

Upgrade side by side, so the old clone keeps working until the new one is proven.

1. Clone the new reviewed commit next to the old one, for example `~/.devtwin/kit-next`, detached and clean.
2. From the **new** clone, preview and apply the change:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>'
   node ~/.devtwin/kit-next/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>' --apply --plan-fingerprint '<fingerprint>'
   ```

   The apply also rebuilds the lesson index and session summaries of every scope, so the hook finds your bound projects at once.

3. From now on run every live command from the new clone. Update the skills and the hooks and confirm the new paths with one owner dialog:

   ```sh
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup plan --pilot "$LIVE_CONFIG" --all-pending
   node ~/.devtwin/kit-next/bin/devtwin.mjs setup apply --pilot "$LIVE_CONFIG" --all-pending --apply --plan-fingerprint '<fingerprint>'
   ```

   Or run the steps one at a time: preview `agents install` for each agent (changed skills show `update`), then `agents install --hooks` and `paths confirm`. Each one asks on its own.
4. Point `DEVTWIN_KIT` at the new clone.
5. If you ran the steps one at a time, run `paths confirm` from the new clone last, preview first. The new kit path ends the old confirmation.

Installed skills stay owned across a kit change. Don't move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit.

If you installed the hooks, their entries name the kit clone. After a move to another clone, preview `agents install --hooks` again: it shows the changed entries as `update`. Then run `hook verify` to write a new kit receipt, and trust the changed entries in Codex `/hooks`.

## Coming from devctx

If you set up live mode under the old devctx name, move it with [Migrate from devctx](/docs/guides/migrate-from-devctx/) instead of starting again.

## Troubleshooting

| Error | Likely cause |
| --- | --- |
| `GATE_REQUIRED`, field `live.kitRoot`, reason `running-kit` | You ran the command from another checkout, not the live config's kit. |
| `GATE_REQUIRED`, field `live.kitCommit`, reason `dirty`, `attached` or `commit` | The kit has changes, is on a branch, or is at another commit. A stray file such as `.DS_Store` under `bin`, `src`, `skills`, `scripts`, `schemas` or `catalog` counts; list them with `git -C "$KIT" ls-files --others --ignored --exclude-standard -- bin src skills scripts schemas catalog`. |
| `GATE_REQUIRED`, field `live.approval` | `live.json` differs from the approved config. Don't edit it by hand. |
| `GATE_REQUIRED`, field `live.home` | `$HOME` differs from the live config's home. |
| `GATE_REQUIRED`, field `writeClasses.backupTargets` or `to` | No backup folder is approved, or the folder you named is not one. Approve it with `live write-classes --backup-target`. |
| `GATE_REQUIRED`, `Live skill folder unavailable` | A skill folder is missing or is a link. See step 1. |
| `GATE_REQUIRED`, reason `no-live-exception`, `scope-required` or `host-not-in-exception` | The stack watch needs the `stackWatch` exception, a `--scope`, and every approved host in the exception. See [Stack watch and radar](/docs/guides/stack-watch/#live-mode). |
| `APPROVAL_REQUIRED` from `stack check` | The config changed after the stack approval, for example by `live set-kit` or `live stack-watch`. Run `stack plan` and `stack approve` again. |
| `PATH_UNSAFE`, field `configDir` | `~/.devtwin` is missing, not yours, or not mode 0700. |
| `BUSY` | A lock is held. If no devtwin command is running, [release the stale lock](/docs/guides/coding-agents/#clear-a-stale-lock). |
| `RECOVERY_REQUIRED` | An earlier install stopped part way. [Recover it](/docs/guides/coding-agents/#recover-an-interrupted-install). |

## If the store is lost

If you have a backup, [restore it](#restore-a-backup) into a new folder and move it into place. Without the store, installed `devtwin-*` entries have no matching journal, become unowned, and devtwin refuses to update or remove them. Remove them by hand: check each entry is a real directory holding only `SKILL.md` and `.devtwin-owned.json`, that the receipt's `kind` is `skill-bundled` and its `configId` is your old one, then move it into a private holding folder. Move the old `live.json` aside too, since `live init` refuses an existing config or a non-empty store, and start again from step 5.

The approved digest catches accidental edits to `live.json`, not deliberate tampering by your own user account. See the [security model](/docs/security/security-model/).
