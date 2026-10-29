---
title: Roadmap
description: What devtwin can do today and what comes next, in priority order.
---

devtwin is an early local tool, not yet a packaged release. The order below favors daily use: protect private state, prove it on real projects, connect sessions, then bring over an existing setup.

## Available today

- Scoped project onboarding with preview and fingerprint approval, read-only toward the repository.
- Immutable context records: decisions, facts, constraints, unknowns and more, with supersession and history.
- Bounded context briefs with freshness labels.
- Agent proposals that you review and publish.
- Private, selected-record handoff packets.
- Bundled skills for Claude Code and Codex, with journaled install, uninstall, recovery and rollback check.
- Live mode: a private store under `~/.devtwin`, a pinned kit (a package kit folder or a Git clone) and your real skill folders.
- Personal profile, `devtwin-setup` skill and skill templates.
- Stack watch with approved hosts and dated Markdown or HTML digests.
- The [release radar](/docs/guides/stack-watch/#the-radar): ranked agent tools, approaches and adjacent tech, try-it guides, and weekly radar, hourly advisory and monthly review jobs.
- A `stackWatch` live-mode exception, so the watch and the radar run against your live config.
- Private drafts.
- Skill builder and third-party skill sources, installing into disposable pilot homes.
- A read-only `doctor`.
- [Lessons](/docs/guides/lessons-and-hooks/): agents save lessons for a project on their own, publish to a hub under your consent, and the agent hook delivers matching lessons while the agent works.
- A [tier table](/docs/security/security-model/#tiers) that decides what runs automatically, what runs under a standing consent and what always asks you.
- An audit log of automatic writes, the `activity` digest with a weekly notification, and `undo`.
- [Encrypted daily backups](/docs/guides/live-mode/#backup-and-restore) to a folder you approve, and an owner-run restore.
- Confirmed kit and config paths, so skills stop asking for them and the hook receipt renews itself.
- Owner answers on the terminal over SSH, as an opt-in.
- The agent hook for Claude Code and Codex, which also blocks owner-only commands from agent shells.
- A guided `setup` that walks through each setup step.
- An [organization hub](/docs/guides/organization-hub/) for sharing accepted lessons and "working on" notes with colleagues.
- [Preferences](/docs/guides/preferences-and-templates/) captured from your corrections and delivered through a managed block in your own agent instruction files, and output templates for an RCA, a report and a decision note.

Lessons, the hook, setup and the hub are tested against local fixtures. They have not yet run against a real hub host.

## Next

| Priority | Work | Status |
| --- | --- | --- |
| 1 | **Backup and restore** of private state, with recovery guidance and upgrade compatibility. | Implemented: encrypted daily backups to an approved folder and an owner-run restore into a new folder. Upgrade compatibility is still to be proven. |
| 2 | **Live activation** on a real machine: fresh Claude Code and Codex sessions finding the skills, with rollback verified. | Implemented. First activation on a real machine passed on 2026-10-25, including fresh non-interactive Claude Code and Codex sessions. Interactive sessions are still to be checked. |
| After 2 | **[Identity routing](/docs/guides/identity-routing/)**: bind each scope to its own GitHub and Slack accounts; read and draft first, sending later. | Designed, sequenced after live activation. |
| 3 | **Session start and end hooks**: resume and handoff adapters with a reviewable worker lifecycle. | Partly done. The agent hook delivers lessons and blocks owner-only commands; resume and handoff adapters are planned. |
| 4 | **Selective migration** from an existing personal setup: dry-run mapping, approved records only. | Planned. |
| 5 | **More connectors** beyond GitHub and Slack, with account and workspace verification. | Planned. |
| 6 | **Company knowledge hub** adapter with reviewed, sanitized promotion. | Implemented as the [organization hub](/docs/guides/organization-hub/). |
| Next | **Preferences and templates**: preferences captured from corrections you confirm, a managed block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and output templates. | Implemented; see [Preferences and templates](/docs/guides/preferences-and-templates/). |
| Next | **Release radar**: a weekly digest of vendor releases for your stack, with schedules and notifications. | Implemented; see [Stack watch and radar](/docs/guides/stack-watch/). |
| P6 | **Autonomy foundations**: the tier table and standing consents, the audit log with `activity` and `undo`, daily encrypted backups, confirmed paths and terminal answers over SSH. | Implemented. |
| P7 | **Matching and delivery**: where-things-live locations, action-matched lessons, a session summary and automatic handoffs. | Implemented. |
| P8 | **Promotion and sharing**: a daily promotion importer, a held queue for items that leave the machine, repository write-back, the weekly owner prompt and model retirements in the radar. | Implemented. |
| P9 | **Setup review**: a review of your setup, and real-agent acceptance checks. | Implemented. You run the real-agent scenarios yourself; they have not been run yet. |
| 7 | **Skill export**: explicit file selection with privacy and rights review. | Planned. |
| 8 | **Weekly skill updater** and scheduler, disabled until you enable it. | Planned. |
| 9 | **Open-source release**: versioned releases and a reviewed release process. | Planned. |

Priorities 5 to 8 don't block offline daily use. Nothing on this list connects an account, publishes, installs or migrates anything on its own.

## Frozen until the daily-use work ships

Skill-builder and skill-source features are frozen until priorities 1 to 4 ship. Bug and safety fixes continue. The create-from-template path (`skill template-list`, `template-seed`, `template-verify` and the templates) is the one exception.

## Known gaps being tracked

- CLI records name their caller (`claude`, `codex` or `human`) from environment variables. This is a label, not proof of who ran the command.
- `record publish --apply` does not check who the controller is.
- The default onboarding request ID comes from your flags, not file contents; pass a new `--request-id` after the repository changes.
- Bundled skills are checked for command routes, not every flag.

See [Limitations](/docs/security/limitations/) for the full list, and the [repository](https://github.com/sundharesan11/devtwin) for current work.
