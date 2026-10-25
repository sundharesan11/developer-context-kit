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
- Live mode: a private store under `~/.devtwin`, a pinned kit clone and your real skill folders.
- Personal profile, `devtwin-setup` skill and skill templates.
- Manual stack watch with approved hosts and dated digests.
- Private drafts.
- Skill builder and third-party skill sources, installing into disposable pilot homes.
- A read-only `doctor`.

## Next

| Priority | Work | Status |
| --- | --- | --- |
| 1 | **Backup and restore** of private state, with recovery guidance and upgrade compatibility. | Planned. Deferred so live activation could be proven first. |
| 2 | **Live activation** on a real machine: fresh Claude Code and Codex sessions finding the skills, with rollback verified. | Implemented; real-machine verification in progress. |
| — | **[Identity routing](/docs/guides/identity-routing/)**: bind each scope to its own GitHub and Slack accounts; read and draft first, sending later. | Designed, sequenced after live activation. |
| 3 | **Session start and end hooks**: resume and handoff adapters with a reviewable worker lifecycle. | Planned. |
| 4 | **Selective migration** from an existing personal setup: dry-run mapping, approved records only. | Planned. |
| 5 | **More connectors** beyond GitHub and Slack, with account and workspace verification. | Planned. |
| 6 | **Company knowledge hub** adapter with reviewed, sanitized promotion. | Planned. |
| 7 | **Skill export**: explicit file selection with privacy and rights review. | Planned. |
| 8 | **Weekly skill updater** and scheduler, disabled until you enable it. | Planned. |
| 9 | **Open-source release**: versioned releases and a reviewed release process. | Planned. |

Priorities 5 to 8 don't block offline daily use. Nothing on this list connects an account, publishes, installs or migrates anything on its own.

## Frozen until the daily-use work ships

Skill-builder and skill-source features are frozen until priorities 1 to 4 ship. Bug and safety fixes continue. The create-from-template path (`skill template-list`, `template-seed`, `template-verify` and the templates) is the one exception.

## Known gaps being tracked

- CLI records are attributed to `human` with a fixed run ID, whoever runs the command.
- `record publish --apply` does not check who the controller is.
- The default onboarding request ID comes from your flags, not file contents; pass a new `--request-id` after the repository changes.
- Bundled skills are checked for command routes, not every flag.

See [Limitations](/docs/security/limitations/) for the full list, and the [repository](https://github.com/sundharesan11/devtwin) for current work.
