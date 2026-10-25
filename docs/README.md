# Documentation

Start with a disposable synthetic project. Live mode for one real machine is implemented; follow the [live activation runbook](LIVE.md) only after the demo.

## First use

| Question | Read |
| --- | --- |
| What is this, and why use it? | [Project overview](../README.md) |
| How do I run a safe demo? | [Getting started](GETTING-STARTED.md) |
| How do preview, approval and context work? | [Guided onboarding](ONBOARDING.md) |
| Where does each part fit? | [Architecture](ARCHITECTURE.md) |
| How do I activate it on my machine? | [Live activation](LIVE.md) |
| I set it up under the old devctx name. How do I move? | [Migrating from devctx](MIGRATING.md) |
| How do I set up my personal profile, skill templates and announcement watch? | [Personal harness](HARNESS.md) |
| What works and what remains? | [Roadmap](ROADMAP.md) and [Limitations](LIMITATIONS.md) |

## Workflow and data contracts

- [Storage](STORAGE.md): roots, immutable records, journals and failure recovery.
- [Handoff export](HANDOFF.md): selected private Markdown packets and disclosure limits.
- [Agent protocol](AGENT-PROTOCOL.md): task context, proposals and advisory boundaries.
- [Personal harness](HARNESS.md): personal profile, skill templates, announcement watch, drafts and what each sends.
- [Skill builder](SKILL-BUILDER.md): requirements, approvals, drafts and disposable installation.
- [Skill sources](SKILL-SOURCES.md): catalog, acquisition, provenance and installation limits.
- [Auth boundary](AUTH.md): secret references, connector gate and approval contract; fake providers only, no live connectors.
- [Security model](SECURITY-MODEL.md): trust assumptions and known residual risks.

## Contribution and publication

- [Contributing](../CONTRIBUTING.md): test commands and public-safe changes.
- [Continuous integration](CI.md): job matrix, trust boundaries and run interpretation.
- [Security reporting](../SECURITY.md): private vulnerability reporting.
- [Release checklist](RELEASING.md): publication gates and evidence.
- [Apache-2.0 license](../LICENSE) and [NOTICE](../NOTICE): toolkit terms and attribution.

## Design history

Plans describe their milestone, not proof that every planned feature shipped. Use the Roadmap for current capability status.

- [Skill builder](plans/skill-builder.md)
- [Skill-source catalog](plans/skill-source-catalog.md)
- [Pinned acquisition](plans/skill-source-acquisition.md)
- [Reviewed source installation](plans/skill-source-installation.md)
- [Portable handoff](plans/portable-handoff.md)
- [Needs-update audit fixes](plans/2026-10-14-001-fix-needs-update-audit-items-plan.md)
- [Skill-collection research](research/skill-collections.md): dated upstream observations, not a live compatibility guarantee.
