# Changelog

This file lists the notable changes in each devtwin release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/). A prerelease version goes to the `alpha` dist-tag on npm.

## [Unreleased]

## [0.1.0-alpha.1]

The first npm release. Install it with `npm i -g devtwin`. A Git clone stays a supported install for contributors.

### Added

- **npm package.** The package holds only the runtime files: `bin/`, `src/`, `skills/`, `templates/`, `schemas/`, `catalog/`, the license files and the README. Tests, docs, scripts and the site stay in Git. The package audit checks that the pack equals this runtime set.
- **Offline demo.** `devtwin demo` runs the disposable demo from the installed package, with no network and no Git clone.
- **Kit identity.** A package kit has an identity: its version plus a SHA-256 digest of its runtime files, written as `npm:<version>+sha256:<digest>`. `devtwin --version` reads the version from `package.json`. It adds the commit for a Git kit and the first 12 hex digits of the digest for a package kit. `devtwin kit list` shows a package kit's full kit ID.
- **`kit install` and `kit list`.** `devtwin kit install --apply` copies the installed package into a locked, read-only folder under `~/.devtwin/kits/` and checks the copy against its digest. The command prints the `live set-kit` command to run next. `kit list` shows the kit folders and the pinned one.
- **`live set-kit --kit` with an owner dialog.** Pinning a kit, or changing the pinned kit, now needs the owner's approval in a terminal dialog. The dialog names the old and new kit IDs and folders. For a package kit, it tells the owner to compare the digest with the one in the GitHub release. `live init --kit` also accepts a package kit.
- **Pinned kit for hooks, jobs and skills.** Hooks, jobs and agent-invoked skills run from the pinned kit folder, never from npm's global folder. A later `npm i -g` changes nothing until the owner pins a new kit.
- **Forwarding for a person at the terminal.** The global `devtwin` command forwards live commands to the pinned kit when the live config is approved and the kit passes its identity check. It prints the kit ID on stderr. Agents never use the global command.
- **Release workflow.** A `v*` tag that the owner pushes starts `.github/workflows/release.yml`. The workflow runs the gates on macOS with Node 22.13.0 and 26.4.0, publishes with npm trusted publishing and provenance after the owner approves the `npm-release` environment, and creates a draft GitHub release with the kit digest. It never moves the default dist-tag.
- **Upgrade guide.** `docs/UPGRADING.md` describes the upgrade, the rollback, the provenance and digest checks, nvm, and the move from a Git clone to a package kit.
- **`npm-install` acceptance check.** From a Git clone, the acceptance harness packs the kit, installs the tarball offline and runs `devtwin demo` from that install.

### Changed

- `package.json` has a description, keywords and the documentation site as its homepage.
- `package.json` no longer has `"private": true`. A `prepublishOnly` guard refuses a publish outside GitHub Actions unless `DEVTWIN_ALLOW_LOCAL_PUBLISH=1` is set.

[Unreleased]: https://github.com/sundharesan11/devtwin/compare/v0.1.0-alpha.1...HEAD
[0.1.0-alpha.1]: https://github.com/sundharesan11/devtwin/releases/tag/v0.1.0-alpha.1
