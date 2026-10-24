# Live activation runbook

This runbook turns on live mode on one machine. Live mode runs the kit against a real private store and the real Claude and Codex skill folders. It onboards one real repository, read-only. Follow the steps in order. Every write is a separate owner approval.

Live mode is implemented. The owner ran steps 1 to 15 and 17 on one machine on 2026-10-25 at kit commit `aa8de74`, and they passed: live init, store init, scope add and read-only onboarding of one real client repository with identical before and after-onboarding snapshots; bundled install for Claude and Codex (three skills each, no conflicts); fresh `claude -p` and `codex exec` sessions from a neutral folder that listed the `devctx-*` skills, resolved the project and read the brief with an identical brief hash; and uninstall, `rollback-check` `ok` and reinstall. Step 16 (interactive sessions) is still the owner's to run, and step 14's `DEVCTX_KIT` export is not yet in the shell profile. See the [roadmap](ROADMAP.md).

## What live mode changes

A live config is a pilot file with a `live` block. It names the config ID, the home, one skill folder per agent, the kit path and the kit commit. Everything private lives under `~/.devctx` at mode 0700:

```text
~/.devctx/            0700, created by the owner
  live.json           the live config
  kit/                a separate clone of the kit, detached at a reviewed commit
  store/              the private store (pilotRoot)
    config/ data/ state/ inputs/
```

- Outside the store, live mode writes only `devctx-*` entries directly inside `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) and `~/.agents/skills`. It never creates, removes or changes the mode of a skill folder or its parents.
- Codex skills go to `~/.agents/skills`. Nothing is written to `~/.codex/skills`. `CODEX_HOME` does not change the target; the preview warns with `CODEX_HOME_IGNORED` when it is set.
- Live commands run only from the kit the live config names. That clone must be clean and detached at the live config's commit. Otherwise every live command fails with `GATE_REQUIRED`.
- The home is the process home. A run with a different `$HOME` is refused.
- The live config changes only through `live init`, `live add-repo` and `live set-kit`. Each one records the approved config digest in `store/state/live/approved-config.json`. A live config that differs from the approved one is refused.
- Listed repositories are read-only. Onboarding never writes to them.
- There is no backup. See [No backup](#no-backup).

## Placeholders

Set these in the shell you use for the run. Replace each placeholder and keep the single quotes.

```sh
KIT="$HOME/.devctx/kit"
LIVE_CONFIG="$HOME/.devctx/live.json"
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
mkdir -m 700 ~/.devctx
ls -ld ~/.devctx
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
node "$KIT/bin/devctx.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO"
```

Review `config` (home, skill folders, kit path and commit, repositories), `layout` and `warnings`. `KIT_NOT_SIBLING` means the kit is not at `~/.devctx/kit`. Apply only the fingerprint the owner approved:

```sh
node "$KIT/bin/devctx.mjs" live init --pilot "$LIVE_CONFIG" --agent claude --agent codex --repo "$REPO" --apply --plan-fingerprint '<fingerprint>'
```

Apply creates the store folders, records the approved digest and writes `live.json`. It draws a random config ID once.

## 8. Store init

```sh
node "$KIT/bin/devctx.mjs" init --pilot "$LIVE_CONFIG" --actor '<actor>'
node "$KIT/bin/devctx.mjs" init --pilot "$LIVE_CONFIG" --actor '<actor>' --apply
```

## 9. Keep the before snapshot

Move the snapshot into private state, then remove the empty temporary folder:

```sh
mkdir -m 700 ~/.devctx/store/state/evidence
mv "$SNAP/before.json" ~/.devctx/store/state/evidence/before.json
rmdir "$SNAP"
```

Evidence that names private paths, clients or accounts stays here. The repository records only the date, commit and pass or fail.

## 10. Add the scope

```sh
node "$KIT/bin/devctx.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>'
node "$KIT/bin/devctx.mjs" scope add --pilot "$LIVE_CONFIG" --scope '<scope>' --apply
```

## 11. Onboard the repository

Preview first, before any skill install. If the preview is refused, stop activation for this repository.

```sh
node "$KIT/bin/devctx.mjs" project onboard --pilot "$LIVE_CONFIG" --scope '<scope>' --project '<project>' --repo "$REPO" --request-id '<request-id>' --accept none
```

Check that `repoWrites` is empty. Review the candidates, unknowns and conflicts with the owner, as in [Guided onboarding](ONBOARDING.md). Preview again with the chosen `--accept` value, then apply that fingerprint:

```sh
node "$KIT/bin/devctx.mjs" project onboard --pilot "$LIVE_CONFIG" --scope '<scope>' --project '<project>' --repo "$REPO" --request-id '<request-id>' --accept '<selection>' --apply --plan-fingerprint '<fingerprint>'
```

Onboarding copies some repository text, such as scanned facts and commands, into the store. See [No backup](#no-backup).

## 12. Snapshot after onboarding

```sh
node "$KIT/scripts/repo-snapshot.mjs" --repo "$REPO" --out ~/.devctx/store/state/evidence/after-onboard.json
node "$KIT/scripts/repo-snapshot.mjs" --compare ~/.devctx/store/state/evidence/before.json ~/.devctx/store/state/evidence/after-onboard.json
```

`identical: true` is the expected result. Otherwise the output lists each path that changed. The owner judges each one.

## 13. Install the skills, one agent at a time

Preview, review, then apply after approval. Repeat for `codex`.

```sh
node "$KIT/bin/devctx.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devctx.mjs" agents install --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

- Every action path must be a `devctx-*` entry directly inside that agent's skill folder.
- `create` and `update` write. `installed` is already current.
- `conflict` means a foreign, symlinked or unowned entry with that name. `modified` means an owned entry was edited. Either one turns that agent's writes into `blocked`. Nothing for that agent is written. Resolve it by hand, then preview again.
- Apply records an inventory of the skill folder before the first write. Keep the `runId` from the result. The rollback check needs it.

`agents status --pilot "$LIVE_CONFIG"` shows the current state of both folders.

## 14. Export DEVCTX_KIT

The skills find the kit through `DEVCTX_KIT`. Ask the owner before editing the shell profile. Then add one line, for example to `~/.zshrc`:

```sh
export DEVCTX_KIT="$HOME/.devctx/kit"
```

Open a new terminal and check it with `printenv DEVCTX_KIT`. The kit does not write agent settings files.

Agents started from the Dock, Finder or another GUI launcher may not read the shell profile. Check from inside such a session: ask the agent to run `printenv DEVCTX_KIT`. If it prints nothing, start that agent from a terminal instead. The skills refuse to run without the variable.

## 15. Fresh-session checks

Run these from a neutral folder that is outside every repository, with user-level settings only. The session must not write to the repository.

```sh
NEUTRAL="$(mktemp -d)"
cd "$NEUTRAL"
```

Use one prompt for both agents. Replace the placeholders. It answers the skills' once-per-session confirmation up front:

```text
List the installed skills whose names start with devctx-. Then follow devctx-resume to resolve
the project for the worktree <repo> in scope <scope>. I confirm the kit path <kit real path>
and the pilot path <home>/.devctx/live.json for this session. Run only read-only commands.
Never use --apply and never edit files.
```

Claude, with read tools and only the exact shell commands the checks need. Never widen these to `node` or `git -C` prefixes: those would let the session run any script or Git command, including writes to the repository. A command outside the list is refused, which fails the check safely.

Pipe the prompt on stdin. `--allowedTools` takes several values, so a prompt placed after it is read as another tool rule, and `claude -p` then fails with "Input must be provided either through stdin or as a prompt argument".

A session can run the CLI through the kit's absolute real path instead of the literal `"$DEVCTX_KIT"` form. The list therefore names both forms of exactly the two read-only commands. Replace `<kit real path>` with the output of `realpath "$KIT"`.

```sh
printf '%s\n' '<prompt>' | claude -p --setting-sources user --allowedTools 'Read,Glob,Grep,Bash(printenv DEVCTX_KIT),Bash(realpath:*),Bash(git -C "$DEVCTX_KIT" rev-parse HEAD),Bash(node "$DEVCTX_KIT/bin/devctx.mjs" context resolve:*),Bash(node "$DEVCTX_KIT/bin/devctx.mjs" context brief:*),Bash(node <kit real path>/bin/devctx.mjs context resolve:*),Bash(node <kit real path>/bin/devctx.mjs context brief:*)'
```

If a listed command is still refused because the skill wrote it differently, record the refusal, compare the command with the list, and rerun with that one exact command added. Do not add a broader rule.

Codex, in its read-only sandbox:

```sh
codex exec --sandbox read-only --skip-git-repo-check '<prompt>'
```

Pass when each session lists `devctx-onboard`, `devctx-record` and `devctx-resume`, runs `context resolve` through `DEVCTX_KIT`, and names the onboarded project. A kit-commit warning means the installed skills came from another commit; stop and find out why. Save the transcripts under `~/.devctx/store/state/evidence/`.

## 16. Interactive sessions

The owner starts one interactive session per agent from the same neutral folder, with `claude` and `codex`. Ask the same question. Confirm the kit and pilot paths when the skill asks. Pass on the same terms as step 15.

After the last session, take another snapshot and compare it with `before.json`, as in step 12. A tool that creates linked worktrees in the repository during the run, such as a test runner using `git worktree add`, shows up as `.git/worktrees/...` differences. The owner judges those by path, like any other difference.

## 17. Rollback rehearsal

Uninstall, check at once, then reinstall.

```sh
node "$KIT/bin/devctx.mjs" agents uninstall --pilot "$LIVE_CONFIG" --agent claude
node "$KIT/bin/devctx.mjs" agents uninstall --pilot "$LIVE_CONFIG" --agent claude --apply --plan-fingerprint '<fingerprint>'
node "$KIT/bin/devctx.mjs" agents rollback-check --pilot "$LIVE_CONFIG" --run-id '<install run id>'
```

Repeat for `codex`. Uninstall removes only entries whose receipt matches a completed install in this store. Edited or foreign entries are preserved and reported.

The rollback check compares the folder with the inventory taken before that install run. It is read-only. It fails with `DEVCTX_ROLLBACK_MISMATCH` and exit code 1 on any difference in `devctx-*` entries. It lists changes to foreign top-level entries with their times; other tools change those folders too, so the owner reviews each one. Run it right after uninstall, so foreign churn stays small.

Then reinstall with a fresh preview and approval (step 13), and repeat a fresh-session check (step 15).

## Upgrading the kit

Upgrade side by side. The old clone stays usable until the new one is proven.

1. Clone the new reviewed commit next to the old one, for example at `~/.devctx/kit-next`, detached and clean, as in step 5.
2. From the new clone, preview and apply the kit change:

   ```sh
   node ~/.devctx/kit-next/bin/devctx.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>'
   node ~/.devctx/kit-next/bin/devctx.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<new commit>' --apply --plan-fingerprint '<fingerprint>'
   ```

3. From now on every live command runs from the new clone. Preview `agents install` for each agent; changed skills show `update`. Apply after approval.
4. Point `DEVCTX_KIT` at the new clone, with the owner's approval.

Installs stay owned across a kit change, because receipts bind to the config ID, not to the kit. The kit commit in a receipt is provenance. The bundled skills warn when it differs from the commit at `DEVCTX_KIT`.

The live config records each clone's path. Do not move or rename a clone after `live set-kit`. To go back, run `live set-kit` from the old clone with its commit. Remove an old clone by hand only when nothing points at it.

To add another repository, use `live add-repo --pilot "$LIVE_CONFIG" --repo '<repo>'`, preview then apply, and run step 2 on it first.

## Recovering an interrupted install

`agents status` reports `RECOVERY_REQUIRED` and the run IDs when an install, update or uninstall stopped part way. New applies are blocked until recovery.

```sh
node "$KIT/bin/devctx.mjs" agents recover --pilot "$LIVE_CONFIG"
node "$KIT/bin/devctx.mjs" agents recover --pilot "$LIVE_CONFIG" --apply --plan-fingerprint '<fingerprint>'
```

Recovery removes an interrupted create, completes an interrupted update from the run folder's copies, and finishes an interrupted remove. It never rolls an update back. It always matches the journal's hashes. A file that matches neither is reported as `hold` and left alone, and the run stays blocked.

To close a run that is stuck on a hold, or whose journal cannot be read, preview and apply a release. Release finishes every action it safely can, then closes the run and leaves the held files where they are. Those files then count as foreign: the kit never touches them again, so inspect and remove them by hand if they are leftovers. A crash right after a skill folder was created can leave an empty `devctx-*` folder that blocks later installs for that agent; check that it is empty, then remove it with `rmdir`.

```sh
node "$KIT/bin/devctx.mjs" agents recover --pilot "$LIVE_CONFIG" --release
node "$KIT/bin/devctx.mjs" agents recover --pilot "$LIVE_CONFIG" --release --apply --plan-fingerprint '<fingerprint>'
```

## Stale locks

A command that was killed can leave `state/locks/install.lock` or `state/locks/live.lock` behind, and later commands fail with `BUSY`. Preview the release first. It shows the recorded owner. Apply only removes the lock when it belongs to this machine, its owner process is no longer running, and the file has not changed since the preview.

```sh
node "$KIT/bin/devctx.mjs" locks release --pilot "$LIVE_CONFIG" --lock install
node "$KIT/bin/devctx.mjs" locks release --pilot "$LIVE_CONFIG" --lock install --apply --plan-fingerprint '<fingerprint>'
```

An empty or unreadable lock file is refused. Make sure no devctx command is running, then remove that one file by hand. Never edit or delete journals or receipts by hand.

## Leftover .codex/skills copies

Earlier pilot installs wrote Codex skills to `.codex/skills`. `agents status` lists any `devctx-*` entries there under `legacy`. The kit never touches them. The owner may remove them by hand after checking they are old copies.

## Cursor

Cursor also reads `~/.agents/skills`, so it will see the bundled skills. They behave the same for any caller and keep every confirmation. Cursor support is not tested.

## What the approved digest does not do

The approved digest catches accidental edits to `live.json`. It does not stop deliberate same-user tampering: the same user can rewrite the live config and the digest together. The kit is not a sandbox; see the [security model](SECURITY-MODEL.md). If a live config change was interrupted, the previous live config can stay approved alongside the new one until the next approved live config change; finish or redo the change to clear it.

## If the store is lost

Without the store, installed `devctx-*` entries have no matching journal and become unowned. The kit then refuses to update or remove them. Remove them by hand:

1. List the entries: `ls -la ~/.claude/skills ~/.agents/skills | grep devctx-`.
2. For each entry, check that it is a real directory, not a link, that it holds only `SKILL.md` and `.devctx-owned.json`, and that the receipt's `kind` is `skill-bundled` and its `configId` is your old live config's.
3. Move each checked entry into a private holding folder, such as one made with `mkdir -m 700 ~/.devctx/removed`. Do not delete it yet. Leave alone any entry that fails a check.
4. Move the old `live.json` aside too. `live init` refuses an existing live config or a non-empty store.
5. Start again from step 6.

## No backup

There is no backup or sync in this stage. Losing `~/.devctx` loses the store: records, decisions, journals and evidence. Onboarding copies some client repository text into the store. That text is protected only by mode 0700 and the machine's disk encryption. A lost laptop can expose it and can lose the only copy. Backup and restore is roadmap priority 1.

## Troubleshooting

| Error | Likely cause |
| --- | --- |
| `GATE_REQUIRED`, `live.kitRoot`, `running-kit` | The command ran from another checkout, not the live config's kit. |
| `GATE_REQUIRED`, `live.kitCommit`, `dirty`, `attached` or `commit` | The kit has changes, is on a branch, or is at another commit. A stray file such as a Finder `.DS_Store` under the kit's code folders also counts; list them with `git -C "$KIT" ls-files --others --ignored --exclude-standard -- bin src skills scripts schemas catalog` and remove them by hand. |
| `BUSY` | A lock is held. If no devctx command is running, see [Stale locks](#stale-locks). |
| `GATE_REQUIRED`, `live.approval` | `live.json` differs from the approved live config. Do not edit it by hand. |
| `GATE_REQUIRED`, `live.home` | `$HOME` differs from the live config's home. |
| `PATH_UNSAFE`, `configDir` | `~/.devctx` is missing, not yours, or not mode 0700. |
| `GATE_REQUIRED`, `Live skill folder unavailable` | A skill folder is missing or is a link. Stop; see step 1. |
| `RECOVERY_REQUIRED` | An earlier run stopped part way. See [Recovering an interrupted install](#recovering-an-interrupted-install). |
