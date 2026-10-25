---
title: Migrate from devctx
description: Move a live setup made under the old devctx name to devtwin, with a reviewed copy of your private store, new skills and an updated shell profile.
---

devtwin used to be called devctx. If you set up [live mode](/docs/guides/live-mode/) under the old name, your private store lives in `~/.devctx`, your agents have `devctx-*` skills, and your shell profile exports `DEVCTX_KIT`. This guide moves all of it to devtwin.

`devtwin live migrate` copies your store to `~/.devtwin`. It never changes or deletes `~/.devctx`, so the old setup stays intact until you remove it yourself. Like every other write, it is a preview followed by an apply of the exact fingerprint you approved.

:::note
A disposable pilot is not migrated. Create a fresh one.
:::

## What changes

| Before | After |
| --- | --- |
| `devctx`, `bin/devctx.mjs` | `devtwin`, `bin/devtwin.mjs` |
| `~/.devctx` | `~/.devtwin` |
| `DEVCTX_KIT` | `DEVTWIN_KIT` |
| `devctx-onboard`, `devctx-resume`, `devctx-record` | `devtwin-onboard`, `devtwin-resume`, `devtwin-record` |
| `.devctx-owned.json` | `.devtwin-owned.json` |
| `DEVCTX_*` error codes | `DEVTWIN_*` |
| `github.com/sundharesan11/developer-context-kit` | `github.com/sundharesan11/devtwin` |

For one transition, devtwin still recognises the old skill folders and receipts, so it can remove them cleanly, and the skills fall back to `DEVCTX_KIT` with a deprecation note.

## What the migration does for you

- Checks that your old live config still loads with its approval, that no lock is held and that no install was interrupted.
- Copies the store with the same file modes, and checks the copy against the plan before moving it into place.
- Writes `~/.devtwin/live.json` with every path moved from `~/.devctx` to `~/.devtwin`. Your repositories and skill folders stay where they are. The config ID stays the same, so your installed skills stay owned.
- Rewrites hub paths in your scope configs. Records, journals and receipts are never rewritten.

You still replace the skills, update your shell profile and remove the old folder yourself.

## 1. Check the old setup

Close any agent sessions that use the skills, then run:

```sh
node ~/.devctx/kit/bin/devctx.mjs agents status --pilot "$HOME/.devctx/live.json"
```

`status` must be `ok`. If it says `RECOVERY_REQUIRED`, finish the recovery with the old kit first.

## 2. Create the new folder and clone devtwin

```sh
mkdir -m 700 ~/.devtwin
git clone https://github.com/sundharesan11/devtwin.git ~/.devtwin/kit
git -C ~/.devtwin/kit checkout --detach '<reviewed commit>'
git -C ~/.devtwin/kit status --porcelain
```

`status` must print nothing. `~/.devtwin` must hold only the kit.

If you'd rather reuse your old clone's objects, clone it locally and re-pin it to the renamed repository:

```sh
git clone --no-hardlinks ~/.devctx/kit ~/.devtwin/kit
git -C ~/.devtwin/kit remote set-url origin https://github.com/sundharesan11/devtwin.git
git -C ~/.devtwin/kit fetch origin
git -C ~/.devtwin/kit checkout --detach '<reviewed commit>'
```

GitHub redirects the old URL after a rename, but set the new one anyway. Do the same for any other clone you keep.

## 3. Preview

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live migrate --pilot "$HOME/.devtwin/live.json" --from "$HOME/.devctx/live.json"
```

Check:

- `config`: the new live config. Every path is under `~/.devtwin`, except your repositories and skill folders.
- `rewrites`: each file and field that changes.
- `store`: how many folders, files and bytes are copied.
- `leftBehind`: what stays in `~/.devctx`, normally just the old `kit`.
- `warnings`: `KIT_NOT_SIBLING` if the kit isn't at `~/.devtwin/kit`, and `LEGACY_PATH_REFERENCE` for stored files that still name an old path.
- `next`: the exact commands for the rest of this guide.

## 4. Apply

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live migrate --pilot "$HOME/.devtwin/live.json" --from "$HOME/.devctx/live.json" --apply --plan-fingerprint '<fingerprint>'
```

Running it again reports `status: "migrated"` and writes nothing.

## 5. Replace the skills

For each agent, preview and apply:

```sh
node ~/.devtwin/kit/bin/devtwin.mjs agents install --pilot "$HOME/.devtwin/live.json" --agent claude
node ~/.devtwin/kit/bin/devtwin.mjs agents install --pilot "$HOME/.devtwin/live.json" --agent claude --apply --plan-fingerprint '<fingerprint>'
```

You should see `create` for each `devtwin-*` skill and `remove` (reason `legacy-name`) for each `devctx-*` skill. Both happen in one journaled run. A `preserve` entry is one devtwin won't touch, such as a skill you edited (`legacy-edited`); check it and remove it by hand. Repeat for `codex`.

## 6. Update your shell profile

In `~/.zshrc` or your shell's profile, replace:

```sh
export DEVCTX_KIT="$HOME/.devctx/kit"
```

with:

```sh
export DEVTWIN_KIT="$HOME/.devtwin/kit"
```

Open a new terminal. `printenv DEVTWIN_KIT` should print the new kit and `printenv DEVCTX_KIT` nothing.

## 7. Verify

```sh
node ~/.devtwin/kit/bin/devtwin.mjs agents status --pilot "$HOME/.devtwin/live.json"
node ~/.devtwin/kit/bin/devtwin.mjs doctor --pilot "$HOME/.devtwin/live.json"
```

Every `devtwin-*` skill shows `installed`, with no `remove` actions and no `notes`. Then start a fresh agent session and ask it to resume a project, as in [live mode](/docs/guides/live-mode/).

Your live config's digest changed, as it does on any live config change. Re-approve stack-watch sources and skill-source decisions if you use them.

## 8. Remove the old folder

Only once everything above checks out:

```sh
rm -rf ~/.devctx
```

If `agents status` lists `devctx-*` entries under `legacy` (in `~/.codex/skills`), remove those by hand too.

## If something goes wrong

- **A refusal.** Nothing was written. Fix the reported cause and preview again.
- **An interrupted apply.** The next preview shows `partial` or `status: "finish"`. Apply that preview to finish. If `partial.removable` is `false`, inspect `~/.devtwin/.store-migrating` and remove it by hand.
- **Going back.** Until step 8, your old setup is intact: uninstall the devtwin skills, reinstall with the old kit, restore `DEVCTX_KIT` and remove `~/.devtwin`. Don't use both stores at once; changes in one don't reach the other.
