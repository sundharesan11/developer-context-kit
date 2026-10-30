---
title: Installation
description: Requirements for devtwin, how to install it from npm, the offline demo, and how contributors run it from a Git clone.
---

`devtwin` installs from npm as one Node CLI with no third-party runtime dependencies.

## Requirements

| Requirement | Details |
| --- | --- |
| Node.js | 22.13 or later (`"engines": { "node": ">=22.13.0" }`) |
| Git | Any recent version. `devtwin` reads Git metadata to identify projects. |
| Operating system | macOS is the reference platform. Linux is not officially supported yet. Windows is not supported. |

You do not need Claude Code, Codex, an API key or a database to try `devtwin`.

## 1. Install from npm

```sh
npm i -g devtwin
```

## 2. Check that it runs

```sh
devtwin --version
```

You should see a version line like this:

```json
{"ok":true,"command":"version","result":{"name":"devtwin","version":"0.1.0-alpha.1"}}
```

Every `devtwin` command prints exactly one line of JSON: `{"ok": true, ...}` on success, or `{"ok": false, "error": {...}}` on failure. To list every command:

```sh
devtwin help
```

```json
{"ok":true,"command":"help","result":{"commands":["agents install","agents recover", ... ,"stack plan","version"]}}
```

The [CLI reference](/docs/reference/cli/) describes each command.

:::tip[Reading the output]
The output is compact JSON. Pipe it through `jq` (if you have it) or `python3 -m json.tool` to read it comfortably:

```sh
devtwin help | python3 -m json.tool
```
:::

## 3. Run the demo

```sh
devtwin demo
```

The demo creates synthetic repositories and fake agent homes in a fresh private temporary folder, then exercises onboarding, records, briefs, handoffs, installs and more. It makes no network requests and never touches your real agent folders.

You should see `"ok":true`. Most checks are marked `passed`. The checks that need a Git clone of the kit, such as the package audit and the live-mode checks, are marked `skipped`. Two checks, `fresh-agent-smoke` and `real-agent-scenarios`, are marked `deferred`, because they need real agent sessions.

## Live mode runs a pinned kit

For daily use, [live mode](/docs/guides/live-mode/) copies the installed package into a locked kit folder under `~/.devtwin/kits/` with `devtwin kit install`, and pins it. Hooks, jobs and agent skills run that pinned folder, never npm's global folder. A later `npm i -g` changes nothing until you pin the new kit. At the terminal, the global `devtwin` command runs live commands in the pinned kit for you.

## From a Git clone

Contributors run `devtwin` from a clone:

```sh
git clone https://github.com/sundharesan11/devtwin.git
cd devtwin
node bin/devtwin.mjs help
```

A clone runs the full offline acceptance harness, including the checks that the package skips:

```sh
DEMO_PARENT="$(mktemp -d /tmp/devtwin-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

On a clean checkout you should see `"ok":true`, 33 checks marked `passed`, and `fresh-agent-smoke` and `real-agent-scenarios` marked `deferred`. The `npm-install` check packs the kit, installs the tarball offline into a temporary folder and runs `devtwin demo` from it.

:::note
The `package-allowlist` check fails if your checkout has untracked files, because it audits what would be packaged. Run the harness on a clean clone.
:::

The `pwd -P` line matters on macOS: `/tmp` is a symbolic link to `/private/tmp`, and `devtwin` only accepts canonical paths.

## Why every command needs `--pilot`

Run a stateful command without one and you get this:

```sh
devtwin context brief --scope example --cwd "$PWD"
```

```json
{"ok":false,"command":"context brief","error":{"code":"DEVTWIN_GATE_REQUIRED","message":"v0 runs only inside a pilot fence","details":{}}}
```

Every command that reads or writes stored context needs `--pilot <file>`. The pilot file names the private folders `devtwin` may use and the repositories it may read. Everything else, including your real agent homes and the kit itself, is off limits to the CLI. The [Quickstart](/docs/getting-started/quickstart/) creates a disposable pilot for you; [Where your data lives](/docs/concepts/where-data-lives/) explains the pilot file in detail.

For daily use on your own machine there is a live config at `~/.devtwin/live.json`. Set it up only after you have tried the Quickstart; see [Live mode](/docs/guides/live-mode/).

## Next steps

- [Quickstart](/docs/getting-started/quickstart/): onboard a throwaway project and read your first brief.
- [Limitations](/docs/security/limitations/): what `devtwin` does not do yet.
