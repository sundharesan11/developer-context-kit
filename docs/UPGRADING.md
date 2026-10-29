# Upgrading and rollback

This guide moves live mode to a new devtwin release, and back to an earlier one. It also moves a Git-clone setup to a package kit. Read [Live activation](LIVE.md) first: this guide uses its placeholders and its owner dialogs.

devtwin is an alpha. Releases go to the `alpha` dist-tag on npm, so always install `devtwin@alpha` or an exact version.

## How an upgrade works

Live mode never runs code from npm's global folder. Hooks, jobs and agent-invoked skills run a pinned copy of the kit under `~/.devtwin/kits/`. A new `npm i -g` changes only the global `devtwin` command. Nothing in live mode changes until you pin the new kit.

An upgrade has four steps:

1. Install the new release with npm.
2. Copy it into a kit folder with `devtwin kit install`.
3. Pin that folder with `devtwin live set-kit`, behind an owner dialog.
4. Move the skills, hooks, jobs and confirmed paths to the new folder with one setup batch.

The old kit folder stays on disk. A rollback pins it again and runs one more batch.

Set the live config path in the shell you use:

```sh
LIVE_CONFIG="$HOME/.devtwin/live.json"
```

## Upgrade to a new release

1. Install the new release:

   ```sh
   npm i -g devtwin@alpha
   devtwin --version
   ```

2. Check the package signatures and provenance. `npm audit signatures` does not check global packages, so install the same version into an empty temporary folder and check it there:

   ```sh
   CHECK="$(mktemp -d)"
   npm install --prefix "$CHECK" devtwin@<version>
   npm audit signatures --prefix "$CHECK"
   ```

   Expect a verified registry signature and a verified attestation for `devtwin`. Remove the temporary folder after the check.

3. Preview the kit install. The plan writes nothing:

   ```sh
   devtwin kit install
   ```

4. Compare the `digest` in the plan with the kit digest in the [GitHub release](https://github.com/sundharesan11/devtwin/releases) for that version. If they differ, stop. The installed package is not the published one.

5. Copy the kit into its folder:

   ```sh
   devtwin kit install --apply
   ```

   The result gives the new `kitRoot` and the next command, `devtwin live set-kit --kit <version>+<digest>`.

6. Preview the kit change. The global command runs it in the new kit folder:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<version>+<digest>'
   ```

7. Apply the previewed fingerprint in your own terminal:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<version>+<digest>' --apply --plan-fingerprint '<fingerprint>'
   ```

   The owner dialog "Change the kit devtwin runs" names the old and new kit IDs and folders. It shows the digest again. Compare it with the release before you approve.

8. Preview the setup batch. It lists the skills, hook entries, job files and paths confirmation that still name the old kit:

   ```sh
   devtwin setup plan --pilot "$LIVE_CONFIG" --all-pending
   ```

9. Apply the batch in your own terminal. One owner dialog covers every line:

   ```sh
   devtwin setup apply --pilot "$LIVE_CONFIG" --all-pending --apply --plan-fingerprint '<fingerprint>'
   ```

10. Check the result:

    ```sh
    devtwin kit list
    devtwin agents status --pilot "$LIVE_CONFIG"
    devtwin schedule status --pilot "$LIVE_CONFIG"
    devtwin paths check --pilot "$LIVE_CONFIG"
    ```

    `kit list` marks the new folder as pinned. Each job shows `current`, each hook entry shows `installed` and `paths check` reports `match`.

11. If you set `DEVTWIN_KIT` in your shell profile, change it to the new `kitRoot`, with the owner's approval.

12. In Codex, run `/hooks` and trust each changed devtwin entry.

The devtwin hook denies `kit install --apply`, `live set-kit --apply` and `setup apply --all-pending` from an agent shell. An agent can show you the previews, but you run each apply.

Until the batch runs, the hook lines and job files still name the old kit. The live config no longer pins that kit, so the kit gate refuses their live commands. `schedule status` shows those jobs as `outdated`.

## Roll back

A rollback pins an earlier kit folder again. `kit install` never deletes a folder, so each earlier release stays in `~/.devtwin/kits/`.

Once the live config names a package kit, a kit from before 0.1.0-alpha.1 cannot load it: those kits do not know the `kitVersion` and `kitDigest` fields. A rollback therefore goes to a kit from 0.1.0-alpha.1 or later.

1. List the kit folders and find the earlier one:

   ```sh
   devtwin kit list
   ```

   Each row gives the `kitId`, `npm:<version>+sha256:<digest>`. Use only a row with the status `ok`.

2. Preview the kit change with that version and digest:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<earlier version>+<earlier digest>'
   ```

3. Apply it in your own terminal, and approve the owner dialog:

   ```sh
   devtwin live set-kit --pilot "$LIVE_CONFIG" --kit '<earlier version>+<earlier digest>' --apply --plan-fingerprint '<fingerprint>'
   ```

4. Run one setup batch, preview then apply, as in steps 8 and 9 of the upgrade.

5. Run the checks in step 10 of the upgrade.

The global command can be newer than the pinned kit. That is safe: it forwards live commands to the pinned kit. To make `devtwin --version` match, install the earlier version with `npm i -g devtwin@<earlier version>`.

A kit folder that shows `bad` in `kit list` failed its digest or mode check. Do not pin it. devtwin never deletes a kit folder. The folders are read-only, so give the owner write bit back with `chmod -R u+w` before you remove one by hand. Remove a folder only when nothing points at it.

## Move from a Git clone to a package kit

A setup made from a clone at `~/.devtwin/kit` moves to a package kit with the same steps as an upgrade:

1. Install the release with `npm i -g devtwin@alpha`.
2. Run steps 2 to 9 of the upgrade.
3. Run the checks in step 10.

The dialog shows the move from `git:<commit>` to `npm:<version>+sha256:<digest>`. The batch rewrites every hook line and job file, because they name the kit folder.

The clone stays on disk. To go back, run `live set-kit` from the clone with its commit, preview then apply:

```sh
node ~/.devtwin/kit/bin/devtwin.mjs live set-kit --pilot "$LIVE_CONFIG" --commit '<commit>'
```

The clone must still be clean and detached at that commit, and the commit must be from 0.1.0-alpha.1 or later. Then run one setup batch.

`live set-kit --commit` and `live migrate` run in the kit you start them from. The global command does not forward them to the pinned kit, so start them with the clone's own `bin/devtwin.mjs`.

## Node versions and nvm

The pinned kit decides which devtwin code runs. The Node interpreter is a separate matter:

- **Hooks** run `node` from the agent's `PATH`. Under nvm, the hook uses the Node version that is active in the shell that started the agent.
- **Jobs** run a fixed Node path, which the setup batch writes into each job file. A Homebrew Node uses its stable link, so `brew upgrade` does not break the jobs.
- **The global `devtwin` command** lives in the global folder of the active Node version. After `nvm use` to another version, `devtwin` can be missing or older. Install it again for that version with `npm i -g devtwin@alpha`.

A Node switch does not change the kit code: hooks, jobs and skills still run the pinned folder. Each Node version must meet the floor, Node 22.13.0 or later.

If you remove the Node version that the job files name, the jobs fail. Run one setup batch from a shell with the Node version you want. `schedule status` shows each job that names another Node path as `outdated`, and the batch rewrites it.

## See also

- [Live activation](LIVE.md): the first activation, the set-kit dialog and how the global command forwards.
- [Release checklist](RELEASING.md): how a release is built, and where the kit digest comes from.
- [Changelog](../CHANGELOG.md): what changed in each release.
