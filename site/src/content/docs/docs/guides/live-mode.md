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

- Outside the store, devtwin writes only `devtwin-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`. It never creates, removes or changes the mode of those folders.
- Codex skills go to `~/.agents/skills`, never `~/.codex/skills`. `CODEX_HOME` does not change this; the preview warns `CODEX_HOME_IGNORED` if it is set.
- Live commands run only from the kit clone the live config names, and that clone must be clean and detached at the configured commit.
- The live config changes only through `live init`, `live add-repo` and `live set-kit`. Each records an approved digest of the config; a `live.json` that differs from the approved one is refused.
- Listed repositories are read-only.

:::caution[No backup yet]
Losing `~/.devtwin` loses your records, decisions and journals, and leaves installed skills unowned. Onboarding copies some repository text into the store, protected only by mode 0700 and your disk encryption. Backup and restore is the top roadmap item; see [Limitations](/docs/security/limitations/).
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

Open a new terminal and check `printenv DEVTWIN_KIT`. devtwin does not edit agent settings files.

## 10. Try it in a fresh session

From a neutral folder outside every repository, start your agent and ask:

```text
List the installed skills whose names start with devtwin-. Then follow devtwin-resume to resolve
the project for the worktree <repo> in scope <scope>. Run only read-only commands.
Never use --apply and never edit files.
```

The session should list `devtwin-onboard`, `devtwin-record` and `devtwin-resume`, run `context resolve` through `DEVTWIN_KIT`, and name your project. A kit-commit warning means the installed skills came from another commit; reinstall from the current kit.

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

3. From now on run every live command from the new clone. Preview `agents install` for each agent; changed skills show `update`.
4. Point `DEVTWIN_KIT` at the new clone.

Installed skills stay owned across a kit change. Don't move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit.

## Troubleshooting

| Error | Likely cause |
| --- | --- |
| `GATE_REQUIRED`, field `live.kitRoot`, reason `running-kit` | You ran the command from another checkout, not the live config's kit. |
| `GATE_REQUIRED`, field `live.kitCommit`, reason `dirty`, `attached` or `commit` | The kit has changes, is on a branch, or is at another commit. A stray file such as `.DS_Store` under `bin`, `src`, `skills`, `scripts`, `schemas` or `catalog` counts; list them with `git -C "$KIT" ls-files --others --ignored --exclude-standard -- bin src skills scripts schemas catalog`. |
| `GATE_REQUIRED`, field `live.approval` | `live.json` differs from the approved config. Don't edit it by hand. |
| `GATE_REQUIRED`, field `live.home` | `$HOME` differs from the live config's home. |
| `GATE_REQUIRED`, `Live skill folder unavailable` | A skill folder is missing or is a link. See step 1. |
| `PATH_UNSAFE`, field `configDir` | `~/.devtwin` is missing, not yours, or not mode 0700. |
| `BUSY` | A lock is held. If no devtwin command is running, [release the stale lock](/docs/guides/coding-agents/#clear-a-stale-lock). |
| `RECOVERY_REQUIRED` | An earlier install stopped part way. [Recover it](/docs/guides/coding-agents/#recover-an-interrupted-install). |

## If the store is lost

Without the store, installed `devtwin-*` entries have no matching journal, become unowned, and devtwin refuses to update or remove them. Remove them by hand: check each entry is a real directory holding only `SKILL.md` and `.devtwin-owned.json`, that the receipt's `kind` is `skill-bundled` and its `configId` is your old one, then move it into a private holding folder. Move the old `live.json` aside too, since `live init` refuses an existing config or a non-empty store, and start again from step 5.

The approved digest catches accidental edits to `live.json`, not deliberate tampering by your own user account. See the [security model](/docs/security/security-model/).
