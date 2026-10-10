# Developer Context Kit

Keep project context between coding-agent sessions.

Developer Context Kit is a local CLI for recording project facts, decisions and handoffs outside the project repository. It builds bounded, source-linked briefs so you can carry reviewed context into the next session.

**Status: experimental pilot.** This is a **local package candidate**, not a daily-use agent installer. The `devctx` command is **NOT currently installed** globally by this checkout. All stateful commands require an explicit disposable pilot. Start with synthetic data.

[Start here](docs/GETTING-STARTED.md) · [Guided onboarding](docs/ONBOARDING.md) · [Documentation](docs/README.md) · [Roadmap](docs/ROADMAP.md)

## Why it exists

A repository tells an agent what the code is. It does not always explain why a decision was made, what remains uncertain, or where the last session stopped.

This kit provides a place to:

- Keep facts and decisions scoped to one project.
- Preserve sources, review status and supersession instead of silently replacing history.
- Produce a brief or selected-record Markdown handoff for a person or agent to read.
- Keep reusable toolkit code separate from private working context.

It does not make an agent remember automatically. Someone must invoke the CLI and supply the resulting context to the session.

## How it fits together

![Project sources are previewed through the CLI, approved into private stores, and read as briefs or selected handoffs. New observations return through explicit record operations.](docs/assets/architecture.svg)

1. Read bounded repository sources and preview proposed context.
2. Approve onboarding into a named scope and project. The project repository stays unchanged.
3. Resolve that project and produce a brief from its private records.
4. Give the brief to a session; record new evidence and decisions explicitly.
5. Review selected records before sharing a handoff or proposing a company learning.

The diagram shows the implemented pilot, not a live agent integration. See [architecture and boundaries](docs/ARCHITECTURE.md).

## Try it

Requirements: Node.js and npm, Git, and a macOS shell. The verified environment is macOS with Node v26.4.0. The declared Node floor is `>=22.13.0`, but that floor has not been independently verified. Linux support is not claimed; Windows is unsupported.

From a checkout containing this guide:

```sh
node bin/devctx.mjs help
DEMO_PARENT="$(mktemp -d /tmp/devctx-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

This runs offline synthetic checks in a fresh disposable directory. It creates fixture repositories and private pilot files; it does not install into your real agent homes or connect accounts. The report intentionally defers fresh-agent discovery. It is a test harness, not a normal client workspace.

For checkout instructions, expected results and troubleshooting, use [Getting started](docs/GETTING-STARTED.md). For the actual preview → approval → brief workflow, follow [Guided onboarding](docs/ONBOARDING.md).

## What works, and what does not

| Area | Available in the disposable pilot | Not delivered |
| --- | --- | --- |
| Project context | Onboarding preview/apply, scoped records, source hashes, bounded briefs | Real-project activation and migration |
| Continuity | Advisory handoffs and [selected-record Markdown export](docs/HANDOFF.md) | Automatic session injection, packet import or sharing |
| Skill creation | [Requirements, design approval, drafts and validation](docs/SKILL-BUILDER.md) | Conversational creator and live behavior evaluation |
| Skill sources | [12-source catalog, release checks, pinned acquisition and reviewed disposable installation](docs/SKILL-SOURCES.md) | Universal agent compatibility or weekly automatic updates |
| Identity and learning | Fake-provider identity checks and private hub proposals | Live Slack/email/issue connectors, sends or company-hub writes |

Claude and Codex filesystem layouts have fixture tests. Those tests do not prove that a fresh native session discovers or uses a skill. Gemini, Cursor and Command Code support is not established.

## Your data stays separate

The reusable repository contains code, schemas, generic templates and tests. Pilot configuration, project context and operation receipts live under separate private roots outside it. There is **no automatic private-to-public synchronization**.

Do not store secrets in records. Keep credentials in a separately approved credential store. Bitwarden and Composio integration is not implemented.

The pilot fence is **not a sandbox**. A coding agent or another same-user process can have wider access than this CLI. There is no backup or sync. Read the [limitations](docs/LIMITATIONS.md) and [security model](docs/SECURITY-MODEL.md) before evaluating private data.

A personal assistant setup, an agent host and a company knowledge hub are optional surrounding systems—not prerequisites. This kit does not install or replace them.

## Explore and contribute

- [Documentation index](docs/README.md): guides, contracts and design history.
- [Contributing](CONTRIBUTING.md): development setup, tests and public-safe examples.
- [Security reporting](SECURITY.md): keep vulnerabilities and private data out of public issues.
- [Release checklist](docs/RELEASING.md): what must pass before publication.
- [Roadmap](docs/ROADMAP.md): remaining work toward daily use.

## License

The toolkit is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE). Third-party skill sources retain their own licenses and notices. A catalog entry is not permission to redistribute its contents.

`"private": true` in `package.json` prevents accidental npm publication. It is not a substitute for a license or a statement about GitHub visibility. This checkout is an unreleased candidate; publication and rights clearance remain separate release steps.
