---
title: "feat: Install devtwin from npm - Plan"
type: feat
date: 2026-10-29
topic: npm-release
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Install devtwin from npm - Plan

## Goal Capsule

- **Objective:** A developer installs devtwin with `npm i -g devtwin@alpha` and gets the same live mode as a reviewed Git clone. Hooks, jobs and agent-invoked skills run from a pinned, content-checked copy of the kit. They never run from npm's global folder. Upgrades and rollbacks are `live set-kit` plus one setup batch.
- **Product authority:** This plan, then `docs/plans/2026-10-27-001-feat-devtwin-promotion-phase-plan.md`, then repository instructions (`AGENTS.md`, `CONTRIBUTING.md`, `docs/SECURITY-MODEL.md`, `docs/RELEASING.md`).
- **Execution profile:** Seven units in one phase, U42 to U48, built in this order. U43 to U46 depend on U42's runtime set. U47 uses U42's pack smoke test. U48 is docs and the site.
- **Stop conditions:**
  - Stop and ask the owner before any `npm publish`, tag push, GitHub release, npm package setting change or dist-tag change.
  - Stop and ask before any change that lets hooks, jobs or agent-invoked skills run code that no owner approval names.
- **Tail ownership:** The owner approves every push, tag, release and publish. The owner also does the one-time npm and GitHub settings in U47.
- **Open blockers:** None.

---

## Product Contract

### Summary

- `npm i -g devtwin@alpha` installs the `devtwin` command.
- `devtwin kit install` copies the installed package into `~/.devtwin/kits/<version>-<digest12>/` and checks the copy against a content digest. The release publishes the same digest.
- `devtwin live set-kit --kit <version>+<digest>` pins that folder behind an owner dialog. Hooks, jobs, receipts, `paths confirm` and the agent-invoked skills then name the pinned folder.
- For a human at the terminal, the global `devtwin` command forwards live commands to the pinned kit. Agents never use the global command.
- A GitHub Actions workflow publishes releases with npm trusted publishing and provenance. It is started by a tag the owner pushes. It never moves `latest`.

### Requirements

- **R1.** An npm install supports `devtwin demo` (the offline demo), `live init`, setup, hooks and jobs on macOS. A Git clone stays a supported install for contributors.
- **R2.** Live mode never runs kit code from npm's global folder in hooks, jobs or agent-invoked skills. A later `npm i -g` or a Node switch does not change which kit code runs until the owner pins a new kit. The interpreter is a separate matter: hooks use `node` from PATH and jobs use a fixed node path, as today. U48 documents this for nvm users.
- **R3.** A pinned package kit has an identity: its version plus a SHA-256 digest of its files. The kit gate (`GATE_REQUIRED`) fails if any of these is true:
  - A runtime file changed, was added or was removed.
  - The kit folder holds a file the manifest does not list.
  - A file is owned by another user.
  - A folder is writable by someone else.
- **R4.** An upgrade has four steps: install the new version, `kit install`, `live set-kit`, then one `setup apply --all-pending` batch. A rollback is `live set-kit` to an earlier kit folder, which stays on disk, then one batch.
- **R5.** The published package contains only runtime files. It does not contain tests, the site, docs, scripts or private state. The package audit enforces this.
- **R6.** Only the release workflow publishes. It runs with provenance, after the full gates pass on the tagged commit. A local `npm publish` fails unless the owner overrides it on purpose. npm token publishing is disabled.
- **R7.** The first release is `0.1.0-alpha.1` under the `alpha` dist-tag. The placeholder `0.0.1` is deprecated with a message that points to `devtwin@alpha`. `latest` moves only through a separate owner `npm dist-tag add`, after the real-agent scenarios pass.
- **R8.** The README, Getting Started, the live runbook, the site and the landing page show the npm install. `docs/RELEASING.md` describes the package release, and `docs/UPGRADING.md` describes upgrade and rollback.

### Scope Boundaries

- Out of scope:
  - Linux and Windows support claims.
  - New features other than `devtwin demo`.
  - A Homebrew formula.
  - Automatic upgrades.
- Out of scope: the actual publish, tags and GitHub release. Each one is a separate owner approval.
- Deferred: `kit prune` for old kit folders. U44 lists the folders but does not delete any.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. The pinned copy, not the global install.**
  - npm's global folder changes with every `npm i -g` and with every nvm or Homebrew Node switch. Hooks and plists that pointed there would run unreviewed code after an upgrade.
  - A copy under `~/.devtwin/kits/` changes only through `live set-kit`. This matches today's model, a clean detached clone at a reviewed commit.
- **KTD2. One kit identity, two kinds.**
  - `src/kit/identity.mjs` returns `{ kind: "git", commit }` or `{ kind: "package", version, digest }`.
  - Its `kitId` string is `git:<sha>` or `npm:<version>+sha256:<digest>`.
  - Configs, receipts and `--kit` always hold the full 64-hex digest. The 12-hex prefix is only for folder names and display.
  - The live config keeps `kitCommit` for Git kits. Package kits use `kitVersion` and `kitDigest`. `pilot.mjs` accepts exactly one of the two forms, so existing configs need no migration.
- **KTD3. Digest and manifest.**
  - The runtime set is defined once, in `src/kit/runtime-files.mjs`. It is the `files` allowlist plus `package.json`.
  - The digest is SHA-256 over a sorted list of `path NUL mode NUL sha256(file)` lines for every file in that set.
  - `kit install` writes `KIT-MANIFEST.json` inside the kit folder: version, digest, file list and the source commit if known. The manifest is not part of the digest.
  - `assertKit` recomputes the digest. It also requires the folder's full recursive listing to equal the manifest list plus the manifest itself, which catches a stray `node_modules/`.
  - The hook fast path reads only the manifest digest and compares it with the receipt, as it reads `.git/HEAD` today.
- **KTD4. Owned, read-only folders.**
  - Kit folders are mode 0500. Files are 0400, except `bin/devtwin.mjs`, which is 0500. A link anywhere is refused.
  - Every entry must be owned by the current uid. `~/.devtwin` and `~/.devtwin/kits` must be owned and have no group or other bits. `assertKit` reuses the private-path check in `src/storage/fsx.mjs`.
  - devtwin never creates `~/.devtwin`; the owner creates it at 0700, as today. `kit install` creates only `~/.devtwin/kits` at 0700.
  - Same-user code can still chmod and rewrite the folders. The modes stop accidents, not a compromised account. `docs/SECURITY-MODEL.md` says this.
- **KTD5. The gate is on `set-kit`, and it gets a real dialog.**
  - `kit install` needs no dialog, because nothing runs a new folder yet.
  - `live set-kit` has no owner dialog today. Its only guard is the agent-shell block. U45 adds `requireOwnerApproval` to `applyLiveSetKit`, following `applyLiveApproval` in `src/config/live.mjs`.
  - The dialog names the from and to `kitId` and kit paths. For a package kit, it also tells the owner to compare the digest with the one published in the GitHub release for that version (KTD8).
  - `kit install --apply` joins the hook's owner-route list, so an agent shell cannot stage kits on its own.
- **KTD6. Agents never use the global command. Humans may.**
  - The session-start hook already runs from the pinned kit. It now puts the pinned kit's real path in its context line.
  - Skills run `node "<that path>/bin/devtwin.mjs"`, with `DEVTWIN_KIT` as the fallback. They never resolve `devtwin` through PATH.
  - For a human at the terminal, the global `bin/devtwin.mjs` forwards live commands to the pinned kit when all of these are true:
    - The config exists. It is the config named by `--pilot`, or `~/.devtwin/live.json` when no `--pilot` is given.
    - Its digest matches the approved digest in the store.
    - The named kit is a Git kit or a package kit under `~/.devtwin/kits/`, and it passes the fast identity check.
  - `live set-kit --kit X` and `live init --kit X` forward to the named kit under `~/.devtwin/kits/` after its manifest check. They must run from that kit, because the running-kit gate compares `runningKit(ctx)`.
  - These commands run locally: `--version`, `kit install`, `kit list` and `demo`.
  - Forwarding runs `process.execPath` with the kit's bin and the same arguments. It never uses a shell. It prints the `kitId` on stderr. `DEVTWIN_FORWARDED=1` stops a second hop.
- **KTD7. A `files` allowlist plus the audit.**
  - `package.json` `files` lists `bin/`, `src/`, `skills/`, `templates/`, `schemas/`, `catalog/`, `LICENSE`, `NOTICE` and `README.md`. npm always adds `package.json`, and the runtime set includes it.
  - `scripts/check-package.mjs` fails when the pack differs from the runtime set. A packed file that points at an unpacked `docs/` path also fails it.
  - Tests, the site, docs and scripts stay in Git. The offline demo moves into `src/` as `devtwin demo` (U42).
- **KTD8. Trusted publishing, never `latest`.**
  - `.github/workflows/release.yml` triggers only on `push: tags: v*`, with no `workflow_dispatch` and no `pull_request`.
  - **Gate job.** It runs on `macos-15` with Node 22.13.0 and 26.4.0, in this order:
    1. Check that the tag equals `v` + the `package.json` version.
    2. Run `check:package`, `check:writing`, the full suite and the pack smoke test.
    3. Compute the KTD3 digest from the packed tarball.
  - **Publish job.** It needs the gate job and runs in the `npm-release` environment. That environment has the owner as required reviewer and allows only `v*` tags. Only this job has the `id-token` write permission. In this order:
    1. Install an exact npm version (11.5.1 or the version checked at implementation time).
    2. Run `npm publish --provenance --access public --tag alpha`. A version without a prerelease part gets `--tag next`. The workflow never writes `latest`.
    3. Create a draft GitHub release that lists the version, the source commit and the kit digest.
  - `package.json` gets `repository` (`git+https://github.com/sundharesan11/devtwin.git`), which provenance requires. It loses `private: true`.
  - A `prepublishOnly` guard refuses when `GITHUB_ACTIONS` is not `true`, unless `DEVTWIN_ALLOW_LOCAL_PUBLISH=1` is set. It only stops accidents. npm's "disallow tokens" setting is the real control.
- **KTD9. The version comes from `package.json`.** `devtwin --version` reads it, not the hard-coded `0.0.0-local`. A Git kit adds its commit, and a package kit adds its digest prefix.

### Patterns to follow

- Owner dialog on a config change: `applyLiveApproval` in `src/config/live.mjs`.
- Owner-gated config change: `setKit`, `planChange` and `applyChange` in `src/config/live.mjs`.
- Kit gate: `assertKit` and `KIT_CODE` in `src/config/pilot.mjs`.
- Receipt fast path: `receiptProblem` in `src/hooks/receipt.mjs`.
- Paths confirm fields and batch line: `src/paths/confirm.mjs`, and the `paths-confirm` line in `src/setup/batch.mjs`.
- Private-path checks and owned writes: `src/storage/fsx.mjs`, and `installJob` in `src/schedule/launchd.mjs`.
- Agent-shell owner routes: `src/hooks/owner-block.mjs`.
- Package audit: `scripts/check-package.mjs` and `scripts/package-allowlist.json`.
- Actions pinned by SHA: `.github/workflows/ci.yml`.

### System-Wide Impact

- Every reader of `live.kitCommit` moves to the identity helper:
  - `src/config/migrate.mjs`
  - `src/agents/install.mjs` (skill receipts get `kitId` in schema 3; schema 2 is still read)
  - `src/hooks/receipt.mjs` (the hook receipt gets `kitId` in schema 2; schema 1 from a Git kit is still read)
  - `src/paths/confirm.mjs` (`confirmed-paths.json` gets a new schema version with per-kind fields)
  - `src/setup/batch.mjs`
  - `src/setup/steps.mjs`
- Hook lines and job plists name `kitRoot`, so they change on every kit move: clone to package, upgrade and rollback. The existing outdated-hook and outdated-job checks (`0545ded`) make them pending batch items, so no new mechanism is needed.

---

## Implementation Units

### U42. Package contents, version, demo and pack smoke test

- **Goal:** The pack holds exactly the runtime files. `--version` is real. The demo runs from a package. The pack has a smoke test.
- **Files:**
  - `package.json`
  - `src/kit/runtime-files.mjs` (new)
  - `src/demo/` (new: the acceptance checks moved from `scripts/acceptance.mjs`)
  - `scripts/acceptance.mjs` (now calls the shared module)
  - `src/cli.mjs`
  - `scripts/check-package.mjs`
  - `scripts/package-allowlist.json`
  - `scripts/pack-smoke.mjs` (new)
  - `test/package.test.mjs`
  - `test/demo.test.mjs` (new)
- **Approach:**
  - Add `files` (KTD7) and set `version` to `0.1.0-alpha.1`. Keep `private: true` until U47.
  - `devtwin demo` runs the acceptance checks. When the kit is not a Git clone, it reports the clone-only check `package-allowlist` as `skipped`, not failed.
  - `pack-smoke.mjs` runs `npm pack` into a temp folder, installs the tarball with `npm install -g --prefix <tmp> <tarball> --offline`, then runs `devtwin --version` and `devtwin demo`.
- **Test scenarios:**
  - The pack lists no `test/`, `site/`, `docs/` or `scripts/` entry.
  - A runtime file missing from the pack fails with `pack-missing`. An extra file fails with `pack-extra`. A packed file that names an unpacked `docs/` path fails.
  - `--version` prints the `package.json` version.
  - `devtwin demo` passes from a clone and from a packed install, with `package-allowlist` skipped in the packed install.
  - `node scripts/acceptance.mjs` gives the same results as before.
- **Verification:** `npm run check:package` and the pack smoke test pass. The focused tests pass both normally and under `env -i`.

### U43. Kit identity and digest

- **Goal:** One helper that names, digests and checks a kit of either kind.
- **Files:**
  - `src/kit/identity.mjs` (new)
  - `src/kit/manifest.mjs` (new)
  - `src/config/pilot.mjs`
  - `src/hooks/receipt.mjs`
  - `src/paths/confirm.mjs`
  - `schemas/` (live config schema)
  - `docs/SECURITY-MODEL.md`
  - `test/kit-identity.test.mjs` (new)
  - `test/live-config.test.mjs`
- **Approach:** Implement KTD2 to KTD4. `assertKit` takes the identity and runs either the Git checks or the package checks. The receipt and `paths confirm` store `kitId`.
- **Test scenarios:**
  - A good package kit passes.
  - Each of these fails with `GATE_REQUIRED`:
    - one changed byte, including in `package.json`;
    - an added file under `src/`, or an extra top-level file or folder;
    - a removed file;
    - a link;
    - a group-writable folder, or a group-writable `~/.devtwin/kits`;
    - a file owned by another uid (simulated through the stat seam);
    - a kit outside `~/.devtwin/kits/`;
    - a manifest digest that does not match the files.
  - A config with both `kitCommit` and `kitDigest` is invalid, and so is a config with neither. A 12-hex digest in a config is invalid.
  - The fast path flags `kit-changed` when the manifest digest changes.
  - Old receipts (hook schema 1, skill schema 2) from a Git kit still validate.
  - The existing Git-kit tests pass unchanged.
- **Verification:** The focused tests pass, and so do the `live-*` and hook tests.

### U44. `kit install` and `kit list`

- **Goal:** Make a pinned package kit from the running package.
- **Files:** `src/kit/install.mjs` (new), `src/kit/commands.mjs` (new), `src/cli.mjs`, `src/hooks/owner-block.mjs`, `test/kit-install.test.mjs` (new).
- **Approach:**
  - Require an owned `<home>/.devtwin` at 0700, or refuse with `PATH_UNSAFE`. Create `kits/` at 0700.
  - Copy the runtime set into a temp folder under `kits/`, refusing links in the source. Write the manifest, recompute the digest, set the KTD4 modes last, then rename the folder to `<version>-<digest12>`.
  - Running it again for the same folder with a good digest is a no-op. A folder with a bad digest is refused with `KIT_CORRUPT` and never overwritten.
  - It plans first and applies with `--apply`, with no dialog (KTD5). It prints the next command, `devtwin live set-kit --kit <version>+<digest>`.
  - `kit install` from a Git clone is refused with a note to use the clone.
  - `kit list` shows each folder, its `kitId` and whether it is pinned.
  - Temp cleanup removes trees without following links. It restores owner write bits first.
- **Test scenarios:**
  - The installed files and modes match the manifest.
  - Running it twice is a no-op.
  - A tampered existing folder is refused.
  - A source link is refused.
  - A missing `~/.devtwin` is refused, and devtwin does not create it.
  - An interrupted install leaves only a temp folder, which the next run removes.
  - `kit list` marks the pinned kit.
  - The hook denies `kit install --apply` from an agent shell.
- **Verification:** The focused tests pass, using a temp home.

### U45. Live commands accept a package kit

- **Goal:** `live init`, `live set-kit`, `live migrate`, setup, hooks and jobs work with a package kit, and `set-kit` gets its owner dialog.
- **Files:**
  - `src/config/live.mjs`
  - `src/config/migrate.mjs`
  - `src/config/commands.mjs`
  - `src/setup/batch.mjs`
  - `src/setup/steps.mjs`
  - `src/agents/install.mjs`
  - `src/agents/hooks-install.mjs`
  - `test/live-commands.test.mjs`
  - `test/live-install.test.mjs`
  - `test/live-migrate.test.mjs`
  - `test/setup-batch.test.mjs`
- **Approach:**
  - `live init` and `set-kit` read the running kit's identity. `set-kit` takes `--commit <sha>` or `--kit <version>+<digest64>`.
  - `applyLiveSetKit` calls `requireOwnerApproval` with the KTD5 text.
  - `migrate` reads the kit through the identity helper. It allows a `kits` entry in the new config folder when the kit is a package kit under it.
  - `KIT_NOT_SIBLING` is not raised for a package kit under `<configDir>/kits`.
  - The `paths-confirm` batch line shows the `kitId`.
- **Test scenarios:**
  - `live init` from a package kit writes `kitVersion` and the full `kitDigest`.
  - `set-kit` from a Git kit to a package kit shows the dialog with both identities. A denied dialog changes nothing.
  - After `set-kit`, the hooks and the four jobs are pending, and one batch makes them clean.
  - After a rollback `set-kit` to the earlier kit, the hooks and jobs are pending again, and one batch makes them clean.
  - `set-kit` run from a kit other than the one named is refused.
  - `migrate` from a legacy folder works with a package kit installed.
- **Verification:** The full live, migrate and setup test files pass.

### U46. Pinned kit for skills, forwarding for humans

- **Goal:** Agent-invoked skills run the pinned kit. The global command forwards a human's live commands.
- **Files:**
  - `bin/devtwin.mjs`
  - `src/kit/forward.mjs` (new)
  - `src/hooks/commands.mjs` (session-start context line)
  - `skills/*/SKILL.md`
  - `templates/skills/*/candidate/SKILL.md`
  - `test/kit-forward.test.mjs` (new)
  - `test/skills-kit-path.test.mjs` (new)
- **Approach:**
  - Implement KTD6.
  - The session-start context names the pinned kit path.
  - Skills call that path, with `DEVTWIN_KIT` as the fallback. Remove any `devtwin` on PATH from the skills.
  - Replace kit-relative `docs/...` references in skills and templates with the published docs URLs.
  - Forwarding uses `spawnSync(process.execPath, [kitBin, ...args], { stdio: "inherit" })` and passes the exit code through.
- **Test scenarios:**
  - A live command is forwarded with the same arguments and exit code.
  - `set-kit --kit` and `init --kit` forward to the named kit under `~/.devtwin/kits/`.
  - These commands run locally: `--version`, `kit install`, `kit list` and `demo`.
  - An unapproved config, a kit outside `~/.devtwin/kits/` and a kit that fails the check are not forwarded. The error or stderr note names the reason.
  - `--pilot` picks the config.
  - A second hop is refused.
  - Without a live config, the command runs locally.
  - No skill or template resolves `devtwin` through PATH or names an unpacked `docs/` path.
  - The session-start context includes the kit path.
- **Verification:** The focused tests pass. The hook command lines do not change.

### U47. Release workflow and publish guard

- **Goal:** A tag the owner pushes publishes with provenance, after the gates, and never moves `latest`.
- **Files:**
  - `.github/workflows/release.yml` (new)
  - `package.json` (removes `private`, adds `repository`, `publishConfig` and `prepublishOnly`)
  - `scripts/publish-guard.mjs` (new)
  - `scripts/kit-digest.mjs` (new: prints the KTD3 digest of a tarball)
  - `scripts/package-allowlist.json`
  - `CHANGELOG.md` (new)
  - `docs/RELEASING.md` (the owner one-time steps)
  - `test/release-workflow.test.mjs` (new: static checks)
- **Approach:**
  - Implement KTD8. Pin actions by SHA, as in `ci.yml`.
  - The owner does these one-time steps. They are listed in `docs/RELEASING.md`, and the agent does none of them:
    1. Add a trusted publisher on npmjs.com for `devtwin`: repository `sundharesan11/devtwin`, workflow `release.yml`, environment `npm-release`.
    2. Create the `npm-release` environment with the owner as required reviewer, limited to `v*` tags.
    3. Add a tag ruleset so that only the owner can create, update or delete `v*` tags.
    4. On npm, require 2FA and disallow tokens.
- **Test scenarios:**
  - The workflow triggers only on `push` of `v*` tags.
  - The `id-token` write permission appears only in the publish job.
  - The publish job needs the gate job.
  - The tag check is present.
  - npm is an exact version, not a range.
  - The string `latest` does not appear in `release.yml`.
  - `repository.url` matches `sundharesan11/devtwin`.
  - The digest script matches `kit install` for the same tarball.
  - The publish guard refuses outside Actions and allows the explicit override.
- **Verification:** The static tests pass. `actionlint` passes if it is installed. No tag is pushed.

### U48. Docs and site

- **Goal:** Users see how to install, upgrade and roll back.
- **Files:**
  - `README.md`
  - `docs/GETTING-STARTED.md` (npm path first; `mkdir -m 700 ~/.devtwin`; `devtwin demo`)
  - `docs/LIVE.md` (steps 5 and 14: package kit path first, clone path for contributors; set-kit dialog and digest check)
  - `docs/UPGRADING.md` (new: upgrade, rollback, `npm audit signatures`, comparing the release digest, an nvm note)
  - `docs/RELEASING.md` (package release section; daily-use checklist updated, since backup and hooks are done)
  - `site/src/components/landing/*` (install snippet)
  - `scripts/acceptance.mjs` (new check `npm-install`, which runs the pack smoke test)
- **Approach:** Write in the house style and pass `check:writing`. The landing page uses the product-launch tone, with no status labels. The docs call the release an alpha.
- **Test scenarios:**
  - `check:writing` passes.
  - Docs links resolve.
  - The acceptance harness reports `npm-install` passed.
  - The site builds.
- **Verification:** As in the test scenarios.

---

## Verification Contract

- Run these in a clean clone at the final commit:
  - the full suite (`npm test` with `set -o pipefail`);
  - `check:package` and `check:writing`;
  - the acceptance harness, including `npm-install`;
  - the pack smoke test;
  - the site build.
- A manual dry run on the owner's machine, which the owner runs:
  1. `npm pack`, then a global install of the tarball.
  2. `kit install`, then `set-kit` to the package kit (the dialog appears).
  3. One batch. `agents status` and `schedule status` are clean.
  4. A new agent session uses the pinned kit path.
  5. Roll back to the Git kit, with one batch.
- An independent review of the diff before merge.

## Definition of Done

- U42 to U48 are merged on `main` with green gates.
- `RELEASING.md` lists the owner's one-time npm and GitHub steps and the first-release order.
- No publish, tag or release has happened without the owner's explicit approval.

## Risks

- **A wrong runtime set locks out a live kit.** One module defines the set. `kit install`, the audit, the digest script and the pack smoke test all use it.
- **A tampered global install gets pinned.** The release publishes the digest from the provenance-built tarball. The set-kit dialog and `UPGRADING.md` tell the owner to compare digests.
- **Forwarding hides which code ran.** Agents never forward. For humans, forwarding prints the `kitId`, checks the approved config digest, and refuses a second hop.
- **The placeholder `0.0.1` stays `latest`.** It is deprecated with a pointer to `devtwin@alpha` (an owner step).
- **A trusted-publishing setup error.** A failed publish changes nothing on npm, and the workflow can run again from the same tag.
- **Same-user tampering.** KTD4 states the limit. The full `assertKit` check runs on every live command and on receipt renewal.

## Open Questions

- At implementation time, check these against the current npm docs:
  - the minimum npm version for trusted publishing (the exact version to pin);
  - `npm deprecate` behavior on a package whose `latest` is the placeholder;
  - the `repository.url` format that provenance accepts.
- Decided: `kit install` prints the `set-kit` command and does not run it.

## Documentation / Operational Notes

- First release, all owner steps:
  1. Merge.
  2. Do the U47 one-time steps 1 to 4.
  3. Push tag `v0.1.0-alpha.1`.
  4. Approve the `npm-release` environment run.
  5. Check the draft GitHub release (version, commit, digest), then publish it.
  6. Deprecate `0.0.1` with `npm deprecate devtwin@0.0.1 "Use devtwin@alpha"`.
  7. Check `npm view devtwin dist-tags` and the provenance badge.
- Moving `latest` comes after the real-agent scenarios pass. It is one `npm dist-tag add devtwin@<version> latest`, which the owner approves separately.
