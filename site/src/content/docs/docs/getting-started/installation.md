---
title: Installation
description: Requirements for devctx, how to clone it, and how to set up a devctx alias while it is not yet published to npm.
---

`devctx` is not published to npm yet. You install it by cloning the repository and running the CLI from that checkout with Node.js. There are no third-party runtime dependencies, so there is nothing else to install.

## Requirements

| Requirement | Details |
| --- | --- |
| Node.js | 22.13 or later (`"engines": { "node": ">=22.13.0" }`) |
| Git | Any recent version. `devctx` reads Git metadata to identify projects. |
| Operating system | macOS is the reference platform. Linux is not officially supported yet. Windows is not supported. |

You do not need Claude Code, Codex, an API key or a database to try `devctx`.

## 1. Clone the repository

```sh
git clone https://github.com/sundharesan11/developer-context-kit.git
cd developer-context-kit
```

## 2. Check that it runs

```sh
node --version
node bin/devctx.mjs version
```

You should see a version line like this:

```json
{"ok":true,"command":"version","result":{"name":"devctx","version":"0.0.0-local"}}
```

Every `devctx` command prints exactly one line of JSON: `{"ok": true, ...}` on success, or `{"ok": false, "error": {...}}` on failure. To list every command:

```sh
node bin/devctx.mjs help
```

```json
{"ok":true,"command":"help","result":{"commands":["agents install","agents recover", ... ,"stack plan","version"]}}
```

The [CLI reference](/docs/reference/cli/) describes each command.

:::tip[Reading the output]
The output is compact JSON. Pipe it through `jq` (if you have it) or `python3 -m json.tool` to read it comfortably:

```sh
node bin/devctx.mjs help | python3 -m json.tool
```
:::

## 3. Add a `devctx` alias

Typing `node bin/devctx.mjs` gets long, and it only works from inside the checkout. Add a shell alias that points at the CLI by its absolute path. For zsh (the macOS default), add this line to `~/.zshrc`, replacing the path with where you cloned the kit:

```sh
alias devctx="node $HOME/code/developer-context-kit/bin/devctx.mjs"
```

Open a new terminal and check it:

```sh
devctx version
```

The rest of these docs use `devctx` in examples. If you skip the alias, run `node bin/devctx.mjs` from the checkout instead.

:::caution[Don't install it globally]
Do not run `npm install -g` or `npm link` for this checkout, and do not install an unrelated npm package that happens to be called `devctx`. Run the CLI from your clone.
:::

## 4. Optional: run the self-check

The repository ships an offline acceptance harness. It creates synthetic repositories and fake agent homes in a fresh temporary folder, then exercises onboarding, records, briefs, handoffs, installs and more. It makes no network requests and never touches your real agent folders.

```sh
DEMO_PARENT="$(mktemp -d /tmp/devctx-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

On a clean checkout you should see `"ok":true`, 32 checks marked `passed`, and one check, `fresh-agent-smoke`, marked `deferred`. That check needs a real agent session, so the harness does not run it.

:::note
The `package-allowlist` check fails if your checkout has untracked files, because it audits what would be packaged. Run the harness on a clean clone.
:::

The `pwd -P` line matters on macOS: `/tmp` is a symbolic link to `/private/tmp`, and `devctx` only accepts canonical paths.

## Why every command needs `--pilot`

Run a stateful command without one and you get this:

```sh
devctx context brief --scope example --cwd "$PWD"
```

```json
{"ok":false,"command":"context brief","error":{"code":"DEVCTX_GATE_REQUIRED","message":"v0 runs only inside a pilot fence","details":{}}}
```

Every command that reads or writes stored context needs `--pilot <file>`. The pilot file names the private folders `devctx` may use and the repositories it may read. Everything else, including your real agent homes and the kit checkout itself, is off limits to the CLI. The [Quickstart](/docs/getting-started/quickstart/) creates a disposable pilot for you; [Where your data lives](/docs/concepts/where-data-lives/) explains the pilot file in detail.

For daily use on your own machine there is a live config at `~/.devctx/live.json`. Set it up only after you have tried the Quickstart; see [Live mode](/docs/guides/live-mode/).

## Next steps

- [Quickstart](/docs/getting-started/quickstart/): onboard a throwaway project and read your first brief.
- [Limitations](/docs/security/limitations/): what `devctx` does not do yet.
