# Readiness and remaining work

Status snapshot: 2026-10-09. The core at `a446760` is a reviewed synthetic local pilot, not a production-ready or publicly released package. Skill-builder A and B tooling is implemented. B at `1a850d9` passed independent implementation review after repairs. The read-only skill-source foundation is implemented at `5fcf53e`; pinned acquisition adds private staging and offline inspection. The installation bridge adds reviewed mappings and disposable source install/update/restoration/removal. Its post-fix full suite passes 208 tests across 28 files; focused independent re-review is pending. This file tracks product capabilities, not private projects, accounts or tasks.

## What works in the pilot

The historical core baseline had 88 passing tests, 23 passing synthetic acceptance checks, and a passing package audit. It provides scoped project onboarding, immutable context records, decisions and supersession, bounded context briefs, advisory agent handoffs, disposable skill installation, fake-provider identity checks, private learning proposals, and a read-only doctor. These are tool-level checks, not proof of real-agent behavior. The current branch also passes its package audit; the core acceptance count is not a new B-specific behavior test.

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

1. **A: private creation tooling implemented.** Requirements → approved design → immutable draft → validation. The conversational skill and live behavior evaluation remain deferred.
2. **B: disposable installation implemented and reviewed.** Approved generic/personal packages only, using owned copies and conflict-preserving removal. Plans bind content, validation and prior installed state. Byte edits, path-role changes and case-only renames are preserved/refused. Real homes remain gated.
3. **C: clean export, not implemented.** Explicit file selection and privacy/rights review. Export preparation is not publication.

Live-model behavior evaluation needs an approved provider/account and synthetic fixture scope. Report it deferred when not run. Static format checks and scripted approval tests cannot demonstrate useful clarification, routing or writing quality. Fresh-session discovery is a separate activation check.

## Requested addition: third-party catalog and weekly updates

The twelve-source managed design is approved. See [source audit and delivery design](research/skill-collections.md) for verified repository names, observed releases, installation differences and exit evidence. The first bounded slice, the [read-only catalog and release checker](plans/skill-source-catalog.md), is implemented. It validates the twelve public recipes, resolves stable releases to commit IDs, compares a supplied prior lock, and reports absent releases or typed failures. It does not save locks, download packages, install skills or schedule jobs.

From the checkout, `node bin/devctx.mjs skill-sources catalog` lists the preset without network access. `node bin/devctx.mjs skill-sources check --source <id>` makes bounded public GitHub requests; read the README rate-limit note before sweeping all sources. Every source remains installation-unverified. Catalog/acquisition baseline verification passed 185 tests across 26 files, 23 synthetic acceptance checks, package audit including dry-run packing, and whitespace checks. Independent Claude catalog and acquisition actual-diff reviews passed, with no material acquisition findings. A separate two-file public-source preview → private disposable stage → offline inspect smoke passed; no acquired source content was executed.

The [pinned acquisition milestone](plans/skill-source-acquisition.md) implements root-free preview, explicit file staging exclusively in private pilot dataRoot, and offline inspection. It records caller-supplied-unverified pins and blob/SHA-256 provenance, preserves source-relative paths, and distinguishes incomplete publication from a verified content stage. Its normal tests use local fixtures and independent actual-diff review passed. This is separate from skill-builder B's installation contract and makes no safety, dependency completeness, compatibility or installed claim.

Optional acquisition follow-ups are safe run-ID diagnostics for failures before final receipt publication, more precise allowlisted field hints, and measuring repeated filesystem checks before raising the current caps. They do not broaden the reviewed staging milestone.

The [source installation bridge](plans/skill-source-installation.md) maps one explicitly reviewed stage to disposable Claude `.claude/skills` and Codex `.agents/skills` layouts. It preserves raw bytes/legal files, keeps content and single-use action decisions separate, shares the existing filesystem executor/lock, refuses adoption/edits/competing copies, and retains partial journals. Synthetic evidence covers install, update, clean restoration and removal; it establishes no real-source or fresh-host compatibility. Personal Codex retains its legacy layout with an additive shared-root conflict check. Source removal can survive staging loss if its current decision/receipt/installed files are intact.

Native host adapters/discovery, reviewed adoption, automatic update policies and a reusable automation-setup skill remain. Add the preset to initial onboarding only after those components pass their own gates. Keep recipes public and each user's installations, decisions, schedules and reports private.

The delivery sequence is read-only catalog/checker → package acquisition and explicit selections → disposable adapter/updater tests → reviewed local activation → fresh-host discovery checks → disabled schedule and harmless run → weekly enablement. Claude, Codex, Gemini CLI, Cursor and Command Code require explicit compatibility evidence; a common folder is not universal support. The weekly schedule has user approval, but no weekly updater, enabled schedule or twelve-source activation is claimed yet. Scheduler recipes remain generic; each user's schedule and execution receipts stay local.

## Known core follow-ups

These are recorded residuals from the bounded pilot review, not claims that each is exploitable:

- The CLI install → uninstall → reinstall journal-ID collision is fixed and reviewed in B, with fresh generated IDs, exclusive run directories and regression tests.
- Tighten which mutators can write agent-home paths, and allow the acceptance harness to receive the run's additional forbidden paths.
- Fail closed on unexpected Git configuration-query errors; retain the tests that prove filters and hooks do not execute during discovery.
- Review low-level interrupted-file writes, lock-handle cleanup, Git output bounds and file-identity precision.
- Clarify caller-supplied operation IDs and on-disk supersession trust. This is a same-user local tool, not a security boundary against a malicious process with the same filesystem access.
- Decide how repeated onboarding retires old effective brief records.

The baseline was verified on macOS with Node v26.4.0. The declared minimum Node version has not been independently verified. Linux support needs its own suite and acceptance run; Windows is unsupported. Multi-device synchronization is not implemented.

## Keep private data out of the release

The reusable repository holds code, generic skills, templates, schemas and tests. Local private stores hold project facts, client context, decisions, generated skills, approval evidence and evaluation artifacts. Credentials remain in an approved credential store. A Git push is not a backup of that private state.

An existing personal setup and this new toolkit are separate until a reviewed migration and activation occur. Do not interpret a globally installed older skill as proof that it is running this package.
