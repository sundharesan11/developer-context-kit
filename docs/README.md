# Documentation

This folder holds devtwin's repository guides and maintainer contracts. For task-oriented user docs (quickstart, concepts, guides, CLI and error reference), use the documentation site at **[sundharesan11.github.io/devtwin/docs](https://sundharesan11.github.io/devtwin/docs/)**; its source is in `site/src/content/docs/docs/`. To ask questions about the code, use [DeepWiki](https://deepwiki.com/sundharesan11/devtwin).

Install devtwin with `npm i -g devtwin@alpha` and start with `devtwin demo`, a disposable synthetic project. Move to the [live activation runbook](LIVE.md) only after the demo.

## First use

| Question | Read |
| --- | --- |
| What is devtwin, and why use it? | [Project overview](../README.md) |
| How do I run a safe demo? | [Getting started](GETTING-STARTED.md) |
| How do preview, approval and context work? | [Guided onboarding](ONBOARDING.md) |
| What does devtwin do on its own, and when does it ask me? | [Tiers](SECURITY-MODEL.md#tiers) and [Activity and undo](HARNESS.md#activity-and-undo) |
| Where does each part fit? | [Architecture](ARCHITECTURE.md) |
| How do I activate it on my machine? | [Live activation](LIVE.md) |
| How do I upgrade to a new release, or roll back? | [Upgrading](UPGRADING.md) |
| I set it up under the old devctx name. How do I move? | [Migrating from devctx](MIGRATING.md) |
| How do I set up my personal profile, skill templates and announcement watch? | [Personal harness](HARNESS.md) |
| How do I turn on the weekly radar, advisory alerts and the review reminder? | [The radar](HARNESS.md#the-radar) and [Schedules](HARNESS.md#schedules) |
| How do I share lessons with colleagues through a hub? | [Organization hub](HUB.md) |
| What works and what remains? | [Roadmap](ROADMAP.md) and [Limitations](LIMITATIONS.md) |

## Workflow and data contracts

- [Storage](STORAGE.md): roots, immutable records, journals and failure recovery.
- [Handoff export](HANDOFF.md): selected private Markdown packets and disclosure limits.
- [Agent protocol](AGENT-PROTOCOL.md): task context, proposals and advisory boundaries.
- [Personal harness](HARNESS.md): personal profile, skill templates, announcement watch, the radar and its schedules, drafts and what each sends. It also covers the session summary, activity and undo, the weekly review, the setup review, the daily import and backups.
- [Organization hub](HUB.md): hub join, sync and leave, the hub sync job, identity and the trust model.
- [Skill builder](SKILL-BUILDER.md): requirements, approvals, drafts and disposable installation.
- [Skill sources](SKILL-SOURCES.md): catalog, acquisition, provenance and installation limits.
- [Auth boundary](AUTH.md): secret references, connector gate and approval contract; fake providers only, no live connectors.
- [Security model](SECURITY-MODEL.md): trust assumptions and known residual risks.

## Contribution and publication

- [Contributing](../CONTRIBUTING.md): test commands and public-safe changes.
- [Continuous integration](CI.md): job matrix, trust boundaries and run interpretation.
- [Writing rules](WRITING.md): the STE-based rule subset, its check and the allowlist policy.
- [Security reporting](../SECURITY.md): private vulnerability reporting.
- [Release checklist](RELEASING.md): publication gates, the npm release workflow and evidence.
- [Changelog](../CHANGELOG.md): what changed in each release.
- [Apache-2.0 license](../LICENSE) and [NOTICE](../NOTICE): toolkit terms and attribution.

## Design history

Plans describe their milestone, not proof that every planned feature shipped. Use the [Roadmap](ROADMAP.md) for current capability status.

- [Skill builder](plans/skill-builder.md)
- [Skill-source catalog](plans/skill-source-catalog.md)
- [Pinned acquisition](plans/skill-source-acquisition.md)
- [Reviewed source installation](plans/skill-source-installation.md)
- [Portable handoff](plans/portable-handoff.md)
- [Needs-update audit fixes](plans/2026-10-14-001-fix-needs-update-audit-items-plan.md)
- [Live activation](plans/2026-10-16-001-feat-live-activation-plan.md)
- [Personal harness template](plans/2026-10-16-001-feat-personal-harness-template-plan.md)
- [Organization identity routing](plans/2026-10-17-001-feat-organization-identity-routing-plan.md): planned, not implemented.
- [devtwin next phase](plans/2026-10-25-001-feat-devtwin-next-phase-plan.md): lessons, hooks, setup, hubs, preferences, release radar and onboarding. Phases P0 to P5 are implemented. Its P6 moved to P9 of the promotion-phase plan.
- [Promotion phase](plans/2026-10-27-001-feat-devtwin-promotion-phase-plan.md): tiers, consents, audit and undo, backups, delivery, promotion and the setup review. P6 to P9 are implemented. The real-agent scenarios and the colleague check wait for the owner.
- [Skill-collection research](research/skill-collections.md): dated upstream observations, not a live compatibility guarantee.
- Personal harness research: [context and memory](research/personal-harness/context-and-memory.md), [harness templates](research/personal-harness/harness-templates.md) and [starter skills](research/personal-harness/starter-skills.md).
