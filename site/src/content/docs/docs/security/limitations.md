---
title: Limitations
description: What devctx does not do yet, what it has not been proven to do, and the known gaps to plan around.
---

devctx is an early, local-first tool. This page lists its honest limits in one place so the rest of the docs don't have to hedge every paragraph.

## Platform and installation

- **macOS is the reference platform.** Linux is not a supported platform yet, although the test suite also runs there. Windows is unsupported.
- **Node.js 22.13 or later.** There are no third-party runtime dependencies.
- **Not on npm.** Run it from a checkout with `node bin/devctx.mjs`. Don't use `npm install -g`, `npm link` or an unrelated package with the same name.
- The version reports `0.0.0-local`. There is no versioned release or upgrade-compatibility promise yet.

## Your data

- **No backup, restore or sync.** Losing `~/.devctx` (or a pilot's roots) loses every record, decision, journal and piece of evidence, and leaves installed skills unowned. Back up the folder yourself until backup and restore ships.
- Onboarding copies some repository text (README summary, declared commands, environment names) into the store. It is protected only by mode 0700 and your disk encryption. A lost laptop can expose it.
- No multi-device synchronization and no migration from an existing personal setup yet.

## Security boundary

- Not a sandbox. The pilot fence limits what the CLI writes, not what your agent host can do.
- Hashes, digests and the approved live-config digest detect accidental changes, not deliberate tampering by your own user account.
- Same-user filesystem races remain possible between path checks and use.
- Content scanning is a tripwire. It can miss encoded secrets and arbitrary confidential prose.

See the [security model](/docs/security/security-model/).

## Agents and sessions

- **No automatic session hooks.** Nothing injects the brief when a session starts or records a handoff when it ends. You or a skill pull context explicitly.
- **Fresh-session discovery is not proven.** Installing skill files does not prove a new Claude Code or Codex session finds and uses them. Live-mode activation on a real machine is still being verified.
- Cursor reads `~/.agents/skills` and will see the skills, but is untested.
- `devctx-setup` is not yet installed by `agents install`.
- CLI records are attributed to `actor: "human"` with a fixed run ID, whoever runs the command. `record publish --apply` always acts as the controller; the CLI does not check who is running it.
- The bundled skills are checked for valid command routes, not for every flag they pass.

## Onboarding and briefs

- The scanner reads a fixed, small set of files plus any `--doc` you add. It is not general knowledge ingestion or summarization.
- Declared commands are never run. A brief does not prove a fact is true or that tests pass.
- The default onboarding request ID is derived from your flags, not from file contents. After the repository changes, pass a new `--request-id`, or onboarding replays the old result.
- Briefs are capped at 12 items and 24,576 body bytes; extra records are listed as omitted.

## Handoff export

- Holds any selected record whose text contains URLs, absolute or home paths (including leading-slash route literals), or control characters. It does not rewrite them.
- Fails on a packet over 32,768 bytes or more than 12 records; there is no truncation.
- Observes only the exporting worktree's current state. It is not a historical snapshot and proves nothing about application tests or deployment.
- Writes are exclusive but not atomic. Discard any packet with a missing or invalid footer.

## Personal harness and stack watch

- Evaluated with synthetic fixtures only. How a live model behaves with `devctx-setup` or a template-made skill is not evaluated.
- Installing a template-made skill into your real agent homes is not available yet.
- The stack watch is manual; there are no schedules. It refuses a live config with `DEVCTX_GATE_REQUIRED` for now.
- GitHub requests are unauthenticated, limited to roughly 60 per hour.
- The bundled stack catalog covers eight items and no vendor changelog feeds; add feeds with `--feed`.
- Relevance is whole-word term matching: it can miss announcements and match unrelated ones.
- Nothing reads or sends Slack messages. Drafts saved with `draft save` cannot be sent later.

## Accounts and connectors

- No live connectors, OAuth, connected accounts or send operations. [Identity routing](/docs/guides/identity-routing/) is designed but not shipped.
- Scope files contain an `accounts` list that nothing reads yet.

## Skill builder and skill sources

- Installs go only to a **disposable pilot's** agent homes, not your real homes.
- The skill validator accepts a strict frontmatter subset; it is not a full YAML or Agent Skills validator. Its link check is advisory.
- Helper scripts are copied as inert text and never run, so their behavior is unverified.
- Skill export and publication are not available.
- Third-party acquisition stages only the exact files you select. It does not infer dependencies, licenses to redistribute, or install recipes. A selected `SKILL.md` may depend on files you left out.
- Pins are caller-supplied and unverified: devctx does not prove a tag points at the commit or that the commit is in upstream history.
- Caps: 24 files, 128 KiB per file, 1 MiB per stage, 256 KiB per installed package. Large collections hit `DEVCTX_LIMIT` with no fallback.
- `taste-skill` has no stable release, so its check → pin → stage workflow is unavailable.
- Every catalog source is installation-unverified. There is no weekly updater.
- Path rules reject some legitimate secret-looking file names, such as some `id_mapping` or database files.
- Default agent homes are protected automatically. Other custom discovery folders are not detected; add them to the pilot's `forbidden` list.

## Development status

Skill-builder and skill-source feature work is frozen except for bug and safety fixes until the daily-use priorities ship. See the [roadmap](/docs/project/roadmap/).
