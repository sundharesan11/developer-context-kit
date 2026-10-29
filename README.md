# devtwin

**Clone the developer.** devtwin keeps your project context, decisions and handoffs between coding-agent sessions, so the next session starts where the last one stopped.

[![CI](https://github.com/sundharesan11/devtwin/actions/workflows/ci.yml/badge.svg)](https://github.com/sundharesan11/devtwin/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/sundharesan11/devtwin)

[Website](https://sundharesan11.github.io/devtwin/) · [Docs](https://sundharesan11.github.io/devtwin/docs/) · [Getting started](docs/GETTING-STARTED.md) · [DeepWiki](https://deepwiki.com/sundharesan11/devtwin) · [Roadmap](docs/ROADMAP.md)

A repository tells an agent what the code is. It rarely says why a decision was made, what is still unknown, or where the last session stopped. devtwin keeps that knowledge as private, source-linked records outside the repository and turns them into a short, bounded brief for each new session.

## What it does

| Pillar | What you get |
| --- | --- |
| **Project context** | Onboard a repository read-only, then keep its facts, decisions, constraints, commands, unknowns, locations and handoffs as source-linked records. Each record links to its sources by hash, so a brief can tell you when evidence has changed. Records are superseded, never silently overwritten. |
| **Works in the background** | Agents and daily jobs write project lessons, constraints, facts, locations and handoffs as `observed` records, with no prompt. Every write goes to an audit log, appears in a weekly digest and reverses with `undo`. A daily job imports Claude memory and `docs/solutions`, and another writes an encrypted backup. devtwin reads Claude memory and never writes it: memory captures, devtwin promotes. Anything that reaches every session, leaves the machine or cannot be undone still asks you. See [Tiers](docs/SECURITY-MODEL.md#tiers). |
| **Every coding agent** | Bundled `devtwin-onboard`, `devtwin-resume`, `devtwin-record` and `devtwin-capture` skills give Claude Code and Codex the same context through the same CLI. |
| **Delivered when they apply** | At session start in a bound project, the agent gets a summary of at most 1,200 characters: the project's "ask before" rules, top constraints, where things live (never their values) and the next step of the last handoff. A lesson is one "do" or "don't" with a reason, tied to paths, packages, topics or a shell command such as `git push`. The devtwin agent hook shows a short index line when an agent reads or edits matching code or runs a matching command, at most four per session. When a session stops without a handoff, a stop stub records where that worktree stood, and the agent answers it with `handoff write`. Agents accept lessons for the current project on their own; a lesson for every project waits for your weekly `activity review`. See [Agent protocol](docs/AGENT-PROTOCOL.md#8-lessons-for-the-work-in-hand). |
| **Preferences and templates** | When you correct an agent, it can propose the correction as a preference, and you accept it in the weekly `activity review`. Accepted preferences reach every Claude Code and Codex session through a marked block in your own `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, never a repository's files. Starter templates for an RCA, a report and a decision note can be replaced by the structure of an output you liked. |
| **Team sharing** | Join a Git repository your organization hosts as a hub to share lessons with colleagues, or send a lesson to the team's repository as a commit on a `devtwin/learning-<id>` branch, never your working copy or current branch. Each target needs a one-time consent. An outbound item waits in a held queue, 24 hours by default, where you can read it and cancel it with `undo`. Short "working on" notes warn a colleague's agent when you change the same area. See [Organization hub](docs/HUB.md). |
| **Organization identity routing** *(planned)* | Each scope binds its own GitHub and Slack accounts, and devtwin checks the live identity before acting. This is designed, not built yet; see the [roadmap](docs/ROADMAP.md). |
| **Personal harness** | Clone it as a personal-harness template: a small private profile, skill templates you turn into your own private skills, and a watch on vendor announcements for your stack. A monthly setup review (`review plan`, `review apply`) suggests stale imported items, lessons that never matched and consents you never used. See the [harness guide](docs/HARNESS.md). |
| **Release radar** | A weekly digest, in Markdown or HTML, of releases in your stack, new agent tools, approaches and adjacent tech, ranked by your stack and interests. In live mode it also reports upcoming model retirements. Each item can open a short "how to try this" guide. Hourly advisory checks notify you at once about an urgent fix, and each scheduled job has its own consent and off switch. See [the radar](docs/HARNESS.md#the-radar). |

## How it works

![Project sources pass through tiered CLI operations into private stores, and are read as session summaries, briefs or selected handoffs. Agents and jobs write new observations back as audited records.](docs/assets/architecture.svg)

1. **Read.** devtwin scans a bounded set of repository files (README, agent instructions, manifests) and Git metadata. Onboarding never writes to the repository.
2. **Learn in the background.** Agents record decisions, lessons, locations and handoffs as they work. A daily job promotes new Claude memory and `docs/solutions` items. These writes are automatic: each one is an `observed` record, written to the audit log and reversible with `undo`.
3. **Ask only when it matters.** A global preference, a lesson for every project, a consent and every `undo` need you, in an owner dialog or the weekly `activity review`. Sending to a hub or a repository needs a one-time consent per target, and each item waits 24 hours in a held queue first.
4. **Keep private.** Records live in local stores outside the repository, with private file modes. A daily job writes an encrypted backup.
5. **Deliver.** The session-start summary gives the key rules in at most 1,200 characters. The agent hook adds matching lesson lines while the agent works, and never uses the network. `context brief` returns at most 12 items and 24 KiB, with sources, freshness and unknowns.
6. **Hand off.** At each stopping point the agent writes a handoff with `handoff write`, and the next session starts from it. Selected records can also go out as a [handoff packet](docs/HANDOFF.md).

More in [Architecture](docs/ARCHITECTURE.md).

## Quick start

You need Node.js 22.13 or later and Git. There is nothing to install: devtwin has no third-party dependencies.

```sh
git clone https://github.com/sundharesan11/devtwin.git
cd devtwin
node bin/devtwin.mjs help
```

Every command prints one line of JSON, `{"ok": true, ...}` or `{"ok": false, "error": {...}}`. To call it from anywhere, add an alias with the checkout's absolute path to your shell profile:

```sh
alias devtwin="node $HOME/code/devtwin/bin/devtwin.mjs"
```

Then run the offline demo. It builds synthetic repositories, a disposable pilot and fake agent homes in a fresh temporary folder, and checks onboarding, records, briefs, handoffs, installs and the personal harness end to end:

```sh
DEMO_PARENT="$(mktemp -d /tmp/devtwin-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

Expect `"ok": true`, with 32 checks `passed`, and `fresh-agent-smoke` and `real-agent-scenarios` `deferred` (they need a real agent). The demo never touches your real agent homes or accounts.

Next steps:

- [Getting started](docs/GETTING-STARTED.md): the demo in detail, with troubleshooting.
- [Guided onboarding](docs/ONBOARDING.md): preview, approve, brief and record on a synthetic project, step by step.
- [Live activation](docs/LIVE.md): run devtwin on your own machine against real repositories and agent skill folders.
- [Migrating from devctx](docs/MIGRATING.md): `devtwin live migrate` moves a setup made under the old name.
- [Organization hub](docs/HUB.md): join a hub, share lessons and post "working on" notes.

## How it compares

| | Repo files (`AGENTS.md`, `CLAUDE.md`) | Hosted agent memory | devtwin |
| --- | --- | --- | --- |
| Where it lives | In the repository, shared with everyone who clones it | On the vendor's service | Local private stores, outside the repository |
| Works across agents | Depends on which file each agent reads | Usually one product | Claude Code and Codex through the same CLI |
| Sources and freshness | None | Usually none | Every record is hashed against its sources |
| History | Git history of one file | Varies | Immutable records with supersession |
| Writes | Anyone edits the file | Often automatic | Agents write project knowledge, audited and undoable; anything global or outbound asks you |

devtwin complements repository instruction files rather than replacing them: repository instructions always take precedence over a brief.

## Status and requirements

- **Status.** devtwin is a local package candidate at version `0.0.0-local`. Live mode is implemented, and its first activation on a real machine passed, including fresh non-interactive Claude Code and Codex sessions that found the skills and read the brief. Lessons, the agent hook, the setup wizard, the organization hub, preferences and output templates are implemented and tested against local fixtures. They are not yet activated on a real machine or tested on a real hub host. The tiers, standing consents, the audit log with `activity` and `undo`, and daily encrypted backups are implemented. So are the session summary, command lessons, locations and the stop stub. The daily import, the held queue, repository write-back, the weekly review, model retirements and the monthly setup review are implemented too. These are tested against synthetic fixtures and local bare repositories. The real-agent scenario kit is ready; its runs with real agents have not been done yet. Organization identity routing is on the [roadmap](docs/ROADMAP.md); known gaps are in [Limitations](docs/LIMITATIONS.md).
- **Install.** Run devtwin from a checkout. A global `devtwin` command is NOT currently installed by cloning; use the alias above. The npm name `devtwin` is reserved with a placeholder package; the CLI is not published to npm yet, and `package.json` stays `"private": true` to prevent accidental publication.
- **Requirements.** Node.js `>=22.13.0` and Git. macOS is the reference platform. CI also runs on Ubuntu, but Linux support is not claimed yet. Windows is unsupported.
- **Safety.** Every stateful command needs an explicit pilot file: a disposable pilot for evaluation, or a live config for one real machine. There is no automatic private-to-public synchronization. An organization hub receives only the lessons accepted under your `hub-publish` consent or copied by you, and the "working on" notes you consent to. A repository receives a learning branch only under your `repo-push` consent, after the hold. The pilot fence is not a sandbox: it limits this CLI, not your agent or other processes. Read the [security model](docs/SECURITY-MODEL.md) before using private data.

## Contributing

Contributions are welcome. Start with [Contributing](CONTRIBUTING.md) for setup, tests and the rules for keeping examples public-safe. Report vulnerabilities privately as described in [Security](SECURITY.md). The [documentation index](docs/README.md) lists every guide and maintainer contract.

## License

[Apache-2.0](LICENSE); see [NOTICE](NOTICE). Third-party skill sources listed in the catalog keep their own licenses.
