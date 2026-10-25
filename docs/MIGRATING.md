# Migrating from devctx

The product was called devctx (Developer Context Kit) before it became devtwin. This guide moves a live setup made under the old name to the new one. A disposable pilot is not migrated: create a fresh one.

`live migrate` copies the private store. It never changes or deletes the old folder. Each write is a separate owner approval, as in [Live activation](LIVE.md).

## What changed

| Before | After |
| --- | --- |
| `devctx`, `bin/devctx.mjs` | `devtwin`, `bin/devtwin.mjs` |
| `~/.devctx` (live config, store, kit) | `~/.devtwin` |
| `DEVCTX_KIT` | `DEVTWIN_KIT` |
| `devctx-onboard`, `devctx-resume`, `devctx-record` skills | `devtwin-onboard`, `devtwin-resume`, `devtwin-record` |
| `.devctx-owned.json` receipt | `.devtwin-owned.json` |
| `DEVCTX_*` error codes | `DEVTWIN_*` |
| `github.com/sundharesan11/developer-context-kit` | `github.com/sundharesan11/devtwin` |

## Compatibility for one transition

The new kit still understands the old names in these places. All of them live in `src/config/legacy.mjs`:

- `agents status`, `agents install` and `agents uninstall` recognise `devctx-onboard`, `devctx-resume` and `devctx-record` entries with a `.devctx-owned.json` receipt that matches a completed journal in the store. Install and uninstall remove such an entry when it is unedited. An edited, foreign or unowned `devctx-*` entry is preserved and reported, and never blocks an install.
- `agents recover` and `agents rollback-check` read journals and inventories written by the old kit.
- `agents status` and `live migrate` report a `LEGACY_KIT_ENV` note when `DEVCTX_KIT` is set.
- The bundled skills use `DEVCTX_KIT` when `DEVTWIN_KIT` is not set, and tell the user it is deprecated.
- The old default roots stay protected. The skill builder and skill sources refuse `devctx-*` skill names, and skill sources refuse a `.devctx-owned.json` file.

## What is automatic and what is manual

`live migrate` does:

- Check that the old live config still loads with its approval, that no old store lock is held and that no install is interrupted.
- Copy the old store to `~/.devtwin/store`, file by file, with the same modes (0700 folders, 0600 files). A symlink, hard link, foreign owner or group/other access in the store refuses the migration.
- Write the new live config. Every path that pointed into `~/.devctx` points into `~/.devtwin`, and the kit is the clone you run the command from. The config ID stays the same, so installed skills stay owned.
- Rewrite the hub paths in `config/scopes/*.json`. Record, binding, journal and receipt files are never rewritten; a legacy path in one of them is reported as a `LEGACY_PATH_REFERENCE` warning.
- Record the new approved digest and a migration receipt at `store/state/live/migration.json`.

You do, by hand:

- Create `~/.devtwin` and clone the new kit into it.
- Replace the installed skills with `agents install` (a separate preview and approval per agent).
- Update the shell profile.
- Remove `~/.devctx` once everything checks out.
- Remove leftover `devctx-*` entries in `~/.codex/skills`, if `agents status` lists any under `legacy`.

`live migrate` refuses rather than guesses in three cases. The store is not at `<folder>/store`, the new folder holds anything other than the new kit, or the new kit sits inside the old folder.

## Steps

Run every command in a terminal, with no devctx or devtwin command running and no agent session using the skills.

### 1. Check the old setup

```sh
node ~/.devctx/kit/bin/devctx.mjs agents status --pilot "$HOME/.devctx/live.json"
```

`status` must be `ok`. On `RECOVERY_REQUIRED`, finish the recovery with the old kit first.

### 2. Create the new folder and clone the kit

```sh
mkdir -m 700 ~/.devtwin
git clone https://github.com/sundharesan11/devtwin.git ~/.devtwin/kit
git -C ~/.devtwin/kit checkout --detach '<reviewed commit>'
git -C ~/.devtwin/kit status --porcelain
```

`status` must print nothing. To reuse the objects of the old clone instead, clone it locally and point it at the renamed repository:

```sh
git clone --no-hardlinks ~/.devctx/kit ~/.devtwin/kit
git -C ~/.devtwin/kit remote set-url origin https://github.com/sundharesan11/devtwin.git
git -C ~/.devtwin/kit fetch origin
git -C ~/.devtwin/kit checkout --detach '<reviewed commit>'
```

GitHub redirects the old repository URL after a rename, but set the new URL anyway. Do the same for any other clone you keep: `git -C <clone> remote set-url origin https://github.com/sundharesan11/devtwin.git`.

### 3. Preview the migration

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live migrate --pilot "$HOME/.devtwin/live.json" --from "$HOME/.devctx/live.json"
```

Review:

- `config`: the new live config. Every path is under `~/.devtwin`, except the repositories and skill folders, which do not move.
- `rewrites`: each rewritten file and JSON pointer.
- `store`: the number of folders, files and bytes copied.
- `leftBehind`: what stays in `~/.devctx` and is not copied, normally the old `kit`.
- `warnings`: `KIT_NOT_SIBLING` when the kit is not `~/.devtwin/kit`; `LEGACY_PATH_REFERENCE` for store files that keep an old path.
- `next`: the exact commands for the remaining steps.

### 4. Apply

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live migrate --pilot "$HOME/.devtwin/live.json" --from "$HOME/.devctx/live.json" --apply --plan-fingerprint '<fingerprint>'
```

The command holds the old store's `live` and `install` locks while it copies. It builds the copy in `~/.devtwin/.store-migrating`, checks it against the plan, renames it to `~/.devtwin/store`, then writes `~/.devtwin/live.json`. Running it again reports `status: "migrated"` and writes nothing.

### 5. Replace the installed skills

For each agent, preview and apply:

```sh
node ~/.devtwin/kit/bin/devtwin.mjs agents install --pilot "$HOME/.devtwin/live.json" --agent claude
node ~/.devtwin/kit/bin/devtwin.mjs agents install --pilot "$HOME/.devtwin/live.json" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

Expect `create` for each `devtwin-*` skill and `remove` with reason `legacy-name` for each `devctx-*` skill, in one journaled run. `preserve` marks a `devctx-*` entry the kit will not touch: an edited one (`legacy-edited`) or a foreign one. Check and remove those by hand. Repeat for `codex`.

### 6. Update the shell profile

Replace the old line in `~/.zshrc` (or your shell's profile):

```sh
export DEVCTX_KIT="$HOME/.devctx/kit"
```

with:

```sh
export DEVTWIN_KIT="$HOME/.devtwin/kit"
```

Open a new terminal. `printenv DEVTWIN_KIT` prints the new kit, and `printenv DEVCTX_KIT` prints nothing.

### 7. Verify

```sh
node ~/.devtwin/kit/bin/devtwin.mjs agents status --pilot "$HOME/.devtwin/live.json"
node ~/.devtwin/kit/bin/devtwin.mjs doctor --pilot "$HOME/.devtwin/live.json"
```

`agents status` shows `installed` for each `devtwin-*` skill, no `remove` action and no `notes`. Then run a fresh-session check as in [Live activation](LIVE.md) step 15.

The live config digest changed, as it does on any live config change. Stack-watch approvals and skill-source decisions bound to the old digest refuse with `INTEGRITY` or `GATE_REQUIRED`; preview and approve them again.

### 8. Remove the old folder

Only after step 7 passes:

```sh
rm -rf ~/.devctx
```

Nothing under `~/.devtwin` depends on it, unless the preview listed a `LEGACY_PATH_REFERENCE`; inspect those files first. Removing the folder also removes the old kit clone and any evidence kept outside the store.

## If something goes wrong

- **Preview or apply refused.** Nothing was written. Fix the reported cause (`BUSY`, `RECOVERY_REQUIRED`, `PATH_UNSAFE`, a non-empty `~/.devtwin`) and preview again.
- **Apply failed part way.** If the process caught the error, it removed its own staging folder. If it was killed, the next preview reports `partial`. With `removable: true`, the next apply discards the staging folder and copies again. With `removable: false`, the folder holds something the kit did not write; inspect it and remove it by hand.
- **Stopped after the store moved into place.** The next preview reports `status: "finish"`, and apply writes only the live config.
- **Going back.** Before step 8 the old setup is intact. Uninstall the devtwin skills with the new kit, reinstall with the old kit (`node ~/.devctx/kit/bin/devctx.mjs agents install ...`), restore `DEVCTX_KIT` and remove `~/.devtwin`. Changes made in one store after the migration do not reach the other, so use only one at a time.

## For maintainers

- The GitHub repository is `sundharesan11/devtwin` and the site is at `https://sundharesan11.github.io/devtwin/`. After the rename on GitHub, update each local clone with `git remote set-url origin https://github.com/sundharesan11/devtwin.git` (or the matching SSH URL).
- Every legacy name sits in `src/config/legacy.mjs` and the tests in `test/live-migrate.test.mjs`. To end the transition, remove that module and its imports, the `DEVCTX_KIT` sentence in the bundled skills, and this guide, then check that `git grep -i devctx` is empty.
- The migration code is `src/config/migrate.mjs`, routed as `live migrate`.
