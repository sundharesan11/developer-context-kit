# Readiness and remaining work

Status snapshot: 2026-10-08. The core at `a446760` is a reviewed synthetic local pilot, not a production-ready or publicly released package. This file tracks product capabilities, not private projects, accounts or tasks.

## What works in the pilot

The verified baseline has 88 passing tests, 23 passing synthetic acceptance checks, and a passing package audit. It provides scoped project onboarding, immutable context records, decisions and supersession, bounded context briefs, advisory agent handoffs, disposable skill installation, fake-provider identity checks, private learning proposals, and a read-only doctor. These are tool-level checks, not proof of real-agent behavior.

The package remains private and unlicensed for redistribution. There is no live connector or send operation, no automatic migration, and no public release. Installation files alone do not prove discovery by an agent.

## Delivery order

| Priority | Work | Exit evidence |
| --- | --- | --- |
| 1 — in progress | Approved skill builder: private requirements, design approval, drafts and validation; then disposable installation and clean export preparation | Per-milestone tests and independent review; exact-hash approval checks; explicit live-evaluation status |
| 2 — daily-use blocker | Controlled real-home activation and a small real-project onboarding pilot | Reviewed target/file preview, approval, preserved foreign skills, fresh Claude and Codex sessions finding the intended skills, rollback verified |
| 3 — daily-use blocker | Registration and selective migration from an existing personal setup | Dry-run mapping and scope checks, approved selected records only, source preserved, no client-repo changes unless explicitly requested |
| 4 — operational readiness | Private-state backup and restore, recovery guidance, upgrade compatibility | Restore into a separate private location, integrity checks, no live-file overwrite, documented failure recovery |
| 5 — connected workflows | Live auth and connector adapters with actor/account/workspace verification | Explicit provider/account selection, secrets resolved outside records, mismatch tests, separate read/draft/send permissions |
| 6 — runtime integration | Agent start/resume/handoff adapters and reviewable worker lifecycle | End-to-end context propagation and completion receipts; pruning requires user approval; advisory limits documented |
| 7 — learning distribution | Optional company knowledge adapter and sanitized promotion | Reviewed proposal tied to source evidence and destination; explicit send approval; no company hub required for ordinary use |
| 8 — open-source release | License and provenance review, public-safe package, installation guide, CI and versioned release process | Owner rights clearance, fresh-machine setup, supported-version/platform test matrix, explicit repository and release approval |

Priorities 5–7 need not block an offline daily-use pilot. Do not build every connector before validating the core with one real project. None of these rows authorizes an account connection, publication, installation, migration or outbound action on its own.

## Skill-builder milestones

The approved design is [skill-builder.md](plans/skill-builder.md).

1. **A: private creation.** Requirements → approved design → immutable draft → validation. No installation.
2. **B: disposable installation.** Approved generic/personal packages only, using owned copies and conflict-preserving removal. Real homes remain gated.
3. **C: clean export.** Explicit file selection and privacy/rights review. Export preparation is not publication.

Live-model behavior evaluation needs an approved provider/account and synthetic fixture scope. Report it deferred when not run. Static format checks and scripted approval tests cannot demonstrate useful clarification, routing or writing quality. Fresh-session discovery is a separate activation check.

## Known core follow-ups

These are recorded residuals from the bounded pilot review, not claims that each is exploitable:

- The CLI install → uninstall → reinstall sequence can collide with its default journal ID. An explicit fresh `--run-id` is the current workaround; fix and test the full cycle before routine installation.
- Tighten which mutators can write agent-home paths, and allow the acceptance harness to receive the run's additional forbidden paths.
- Fail closed on unexpected Git configuration-query errors; retain the tests that prove filters and hooks do not execute during discovery.
- Review low-level interrupted-file writes, lock-handle cleanup, Git output bounds and file-identity precision.
- Clarify caller-supplied operation IDs and on-disk supersession trust. This is a same-user local tool, not a security boundary against a malicious process with the same filesystem access.
- Decide how repeated onboarding retires old effective brief records.

The baseline was verified on macOS with Node v26.4.0. The declared minimum Node version has not been independently verified. Linux support needs its own suite and acceptance run; Windows is unsupported. Multi-device synchronization is not implemented.

## Keep private data out of the release

The reusable repository holds code, generic skills, templates, schemas and tests. Local private stores hold project facts, client context, decisions, generated skills, approval evidence and evaluation artifacts. Credentials remain in an approved credential store. A Git push is not a backup of that private state.

An existing personal setup and this new toolkit are separate until a reviewed migration and activation occur. Do not interpret a globally installed older skill as proof that it is running this package.
