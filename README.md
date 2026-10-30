# devtwin

**Clone the developer.** devtwin gives your coding agents your taste and your project knowledge, in every project and every agent.

[![CI](https://github.com/sundharesan11/devtwin/actions/workflows/ci.yml/badge.svg)](https://github.com/sundharesan11/devtwin/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/sundharesan11/devtwin)

[Website](https://sundharesan11.github.io/devtwin/) · [Docs](https://sundharesan11.github.io/devtwin/docs/) · [Getting started](https://github.com/sundharesan11/devtwin/blob/main/docs/GETTING-STARTED.md) · [Roadmap](https://github.com/sundharesan11/devtwin/blob/main/docs/ROADMAP.md)

Your agents can read any codebase. They can't read why it was built that way, the mistakes you never repeat, or where you stopped yesterday. devtwin keeps that knowledge on your disk and gives it to Claude Code and Codex when a session starts.

## Why use it

- **Never teach an agent the same process twice.** Your preferences and lessons follow you into every project and every agent.
- **Run your agents like one team.** Start a task in Claude Code and finish it in Codex. Both read the same brief and the last handoff.
- **Pick up where you stopped.** Each session starts with the project's rules, its top constraints and the next step from the last handoff.
- **Stay in control.** Everything lives in plain files on your machine. Agents write as they work, every write is logged, and `undo` reverses any of them.
- **Share what your team learns.** Send a lesson to your team's hub or repository, only with your consent.

## Quick start

You need Node.js 22.13 or later. devtwin has no dependencies.

```sh
npm i -g devtwin@alpha
devtwin demo
```

The demo runs in a new temporary folder with sample projects and fake agent homes. It needs no network and never touches your real agents or accounts. Expect `"ok": true`.

Name the `@alpha` tag when you install. Without it, npm installs an old placeholder.

Every command prints one line of JSON. Run `devtwin help` to list the commands.

## How it works

![Project sources pass through tiered CLI operations into private stores, and are read as session summaries, briefs or selected handoffs. Agents and jobs write new observations back as audited records.](https://raw.githubusercontent.com/sundharesan11/devtwin/main/docs/assets/architecture.svg)

1. **Onboard a project.** devtwin reads the repository and never writes to it. It keeps decisions, constraints, commands and handoffs as records that link to their sources.
2. **Learn while you work.** Agents record lessons and handoffs on their own. The audit log keeps every write, and `undo` reverses it.
3. **Start every session ready.** The agent gets a short summary at the start. The full brief is one command away. A lesson appears when the agent opens a file or runs a command that it matches.
4. **Decide what spreads.** A lesson for every project, or anything that leaves your machine, waits for your approval.

Read [Architecture](https://github.com/sundharesan11/devtwin/blob/main/docs/ARCHITECTURE.md) for the details.

## What's included

| Feature | What it does | Guide |
| --- | --- | --- |
| Project context | Records with sources, and a short brief for each session | [Agent protocol](https://github.com/sundharesan11/devtwin/blob/main/docs/AGENT-PROTOCOL.md) |
| Lessons | A "do" or "don't" with a reason, shown when matching code is in hand | [Lessons](https://github.com/sundharesan11/devtwin/blob/main/docs/AGENT-PROTOCOL.md#8-lessons-for-the-work-in-hand) |
| Handoffs | The next step for the next session, in any agent | [Handoffs](https://github.com/sundharesan11/devtwin/blob/main/docs/HANDOFF.md) |
| Team hub | Share lessons and "working on" notes through a Git repository your team hosts | [Organization hub](https://github.com/sundharesan11/devtwin/blob/main/docs/HUB.md) |
| Personal harness | Use it as a personal-harness template: a private profile and skills built from templates | [Harness guide](https://github.com/sundharesan11/devtwin/blob/main/docs/HARNESS.md) |
| Release radar | A weekly digest of releases and tools that touch your stack | [The radar](https://github.com/sundharesan11/devtwin/blob/main/docs/HARNESS.md#the-radar) |
| Backup and undo | A daily encrypted backup, an audit log and `undo` | [Security model](https://github.com/sundharesan11/devtwin/blob/main/docs/SECURITY-MODEL.md#tiers) |
| Accounts per org *(planned)* | Each org uses its own accounts, checked before every action | [Roadmap](https://github.com/sundharesan11/devtwin/blob/main/docs/ROADMAP.md) |

devtwin works alongside `AGENTS.md` and `CLAUDE.md`. Instructions in a repository always take precedence over a brief.

## Use it on your own machine

The demo uses throwaway folders. To run devtwin on your real projects, follow [Live activation](https://github.com/sundharesan11/devtwin/blob/main/docs/LIVE.md). [Upgrading](https://github.com/sundharesan11/devtwin/blob/main/docs/UPGRADING.md) explains how to move to a new release or roll back.

Live mode runs a pinned copy of the kit under `~/.devtwin/kits/`, never from npm's global folder. A later `npm i -g` changes nothing until you pin the new kit.

## Work on devtwin

Contributors run devtwin from a Git clone:

```sh
git clone https://github.com/sundharesan11/devtwin.git
cd devtwin
node bin/devtwin.mjs help
```

[Contributing](CONTRIBUTING.md) covers setup, tests and the rules for public-safe examples. The [documentation index](https://github.com/sundharesan11/devtwin/blob/main/docs/README.md) lists every guide.

## Status

devtwin is an alpha. The first release is `0.1.0-alpha.1` on npm, under the `alpha` tag.

- Live mode works on a real machine, and fresh Claude Code and Codex sessions find the skills and read the brief.
- Lessons, the agent hook, the team hub, preferences, backups and the weekly review pass their tests against local fixtures. Runs with real agents are still to come.
- Accounts per org are planned. Known gaps are in [Limitations](https://github.com/sundharesan11/devtwin/blob/main/docs/LIMITATIONS.md).
- devtwin needs Node.js 22.13 or later and Git. macOS is the reference platform. CI also runs on Ubuntu, but Linux support is not claimed yet. Windows is unsupported.

## Safety

- Your data stays in private files on your machine. There is no automatic private-to-public synchronization.
- A team hub or repository gets a lesson only after your one-time consent, and each one waits 24 hours by default, so you can cancel it.
- The pilot fence is not a sandbox. It limits this CLI, not your agent or other processes.

Read the [security model](https://github.com/sundharesan11/devtwin/blob/main/docs/SECURITY-MODEL.md) before you use private data. Report vulnerabilities privately as described in [Security](SECURITY.md).

## License

[Apache-2.0](LICENSE); see [NOTICE](NOTICE). Third-party skill sources in the catalog keep their own licenses.
