# Readiness and remaining work

Status snapshot: 2026-10-27. This is a reviewed local pilot with an implemented and activated live mode, not a daily-use installer or a publicly released package. This file tracks product capabilities, not private projects, accounts or tasks.

Last recorded CI evidence: [Pilot CI](CI.md) run 38154524118 on `main` at commit `8f1133a`, 2026-10-11. All four lanes (macOS 15 and Ubuntu 24.04, each with Node 26.4.0 and 22.13.0) passed. That run is evidence for `8f1133a` only. A CI run for `b95ff72` is pending. Linux and the Node 22.13.0 floor remain evaluation lanes; support for them is not claimed.

Local evidence at `b95ff72` (macOS, Node 26.12.1, not CI): 498 of 498 tests across 44 files and a clean package audit. Acceptance ran 33 checks: 32 passed and one `fresh-agent-smoke` deferred.

Local evidence at `7c50e65` (macOS, not CI): 644 of 644 tests, a clean package audit and a clean writing check. Acceptance ran 33 checks: 32 passed and one `fresh-agent-smoke` deferred.

Skill-builder A/B, the source catalog, pinned acquisition, reviewed disposable source installation, portable selected-record handoff and live mode are implemented. Live mode passed its first activation on the owner's machine on 2026-10-25 at `b95ff72`; see [Live activation](LIVE.md). Phases P0 to P4 of the [next-phase plan](plans/2026-10-25-001-feat-devtwin-next-phase-plan.md) are implemented. P0 and P1 add the rename, `live migrate`, record schema v2, the personal and org homes, live write classes and the writing check. P2 adds the lesson match index, the agent hook with the owner-action block and the setup wizard. P3 adds the organization hub with lesson proposals, replacement, "working on" notes and published items. P4 adds preference capture, the managed instruction block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, and output templates. These are tested against synthetic fixtures and local SSH fixture hubs only. They are not yet activated on the owner's machine, and no real hub host has been tested. P6 of the [promotion-phase plan](plans/2026-10-27-001-feat-devtwin-promotion-phase-plan.md) is implemented too. It adds the tier table and standing consents, the audit log with `activity` and `undo`, daily encrypted backups, confirmed paths and terminal answers over SSH. P7 adds where-things-live locations, lessons that match shell commands, the session summary, the stop stub and `handoff write`. Both are tested against synthetic fixtures only. The public-alpha documentation adds a guided first run, architecture and release checklist. The core carries Apache-2.0; publication still needs the gates in [Releasing](RELEASING.md).

## What works in the pilot

The pilot provides scoped project onboarding, immutable context records, decisions and supersession, and bounded context briefs. It also provides advisory agent handoffs, disposable skill installation, fake-provider identity checks, private learning proposals and a read-only doctor. These are tool-level checks, not proof of real-agent behavior.

The toolkit is licensed under Apache-2.0. The npm package remains marked private to prevent accidental publication. Owner rights/history clearance and the explicit public-release decision remain open. There is no live connector or send operation and no automatic migration. Installation files alone do not prove discovery by an agent.

## Delivery order

The order favors daily use: protect private state first, then prove one real project, then connect sessions, then bring over an existing setup.

| Priority | Work | Exit evidence |
| --- | --- | --- |
| 1: daily-use blocker | Private-state backup and restore, recovery guidance, upgrade compatibility. **Implemented in P6 of the [promotion-phase plan](plans/2026-10-27-001-feat-devtwin-promotion-phase-plan.md):** encrypted daily backups to an approved folder, an owner-run restore into a new folder and the restore steps in [LIVE.md](LIVE.md#backup-and-restore). Upgrade compatibility remains | Restore into a separate private location, integrity checks, no live-file overwrite, documented failure recovery |
| 2: daily-use blocker | Controlled real-home activation and a small real-project onboarding pilot. **Implemented and activated on 2026-10-25; interactive sessions remain.** Live config, live-safe bundled install, rollback check and read-only onboarding; runbook in [LIVE.md](LIVE.md) | Reviewed target/file preview, approval, preserved foreign skills, fresh Claude and Codex sessions finding the intended skills, rollback verified |
| Unnumbered: organization identity routing | Bind each scope to its own GitHub and Slack accounts, verify the live identity and refuse a mismatch. **Planned in [2026-10-17-001](plans/2026-10-17-001-feat-organization-identity-routing-plan.md); not implemented.** | Exact-match identity gate, credentials resolved outside records, owner-typed confirmation for account applies, read and draft before send |
| Unnumbered: personal harness | Personal profile, setup skill, skill templates, manual announcement watch and private drafts; see [HARNESS.md](HARNESS.md). **Implemented except the live step of U5, U9 and U11** of [its plan](plans/2026-10-16-001-feat-personal-harness-template-plan.md) | Synthetic fixture tests and acceptance checks; installer wiring and live-mode watch after their gates |
| 3: daily-use blocker | Session start and end hooks: agent start, resume and handoff adapters with a reviewable worker lifecycle. **Partly implemented:** the agent hook ([Agent protocol](AGENT-PROTOCOL.md#agent-hook)) delivers lessons, gives a session ID and blocks owner-only commands; resume and handoff adapters remain | End-to-end context propagation and completion receipts; pruning requires user approval; advisory limits documented |
| 4: daily-use blocker | Registration and selective migration from an existing personal setup | Dry-run mapping and scope checks, approved selected records only, source preserved, no client-repo changes unless explicitly requested |
| 5: connected workflows | Live auth and connector adapters with actor/account/workspace verification | Explicit provider/account selection, secrets resolved outside records, mismatch tests, separate read/draft/send permissions |
| 6: learning distribution | Optional company knowledge hub adapter and sanitized promotion. **Implemented as the [organization hub](HUB.md)**, tested against local fixture hubs only | Reviewed proposal tied to source evidence and destination; explicit send approval; no company hub required for ordinary use |
| Next phase P5 to P6 | P5: the release radar, its schedules and notifications. **Implemented:** the live stack-watch exception, radar sources and ranking, Markdown and HTML digests, try-it guides, and the radar, advisory and review jobs ([HARNESS.md](HARNESS.md#the-radar)). The old P6 (the setup review and real-agent acceptance scenarios) moved to P9 of the promotion-phase plan. See the [plan](plans/2026-10-25-001-feat-devtwin-next-phase-plan.md) | The plan's verification contract for each unit |
| Promotion phase P6 to P9 | The [promotion-phase plan](plans/2026-10-27-001-feat-devtwin-promotion-phase-plan.md). P6, autonomy foundations: **implemented.** It adds the tier table and standing consents, the audit log, `activity` and `undo`, daily encrypted backups, confirmed paths and terminal answers over SSH ([SECURITY-MODEL.md](SECURITY-MODEL.md#tiers)). P7, matching and delivery: **implemented.** It adds locations, command lessons, the session summary and the stop stub with `handoff write` ([HARNESS.md](HARNESS.md)). Next: P8 promotion and sharing, and P9 the setup review and real-agent checks | The plan's verification contract for each unit |
| 7: skill distribution | Skill export (skill-builder milestone C): explicit file selection and privacy/rights review | Export preparation tests; export is not publication |
| 8: skill updates | Weekly third-party skill updater and scheduler | Disabled schedule and harmless run first; fresh-host discovery evidence; explicit user enablement |
| 9: open-source release | Core Apache-2.0, public-alpha guides and CI configured; provenance/history clearance, successful release-candidate CI and versioned release process remain | Owner rights clearance, fresh-machine setup, reviewed version/platform evidence, verified private reporting channel, explicit repository and release approval |

The owner deferred priority 1 on 2026-10-16, so priority 2 was built first. On 2026-10-17 the owner set the order live activation (priority 2) → organization identity routing → personal harness → session hooks. The harness was built before routing. The row numbers stay until the harness plan's renumbering (U11) lands. Backup now exists, but the live store has a backup only after the owner approves a backup folder; see [Limitations](LIMITATIONS.md). Priorities 5–8 need not block an offline daily-use pilot. The open-source release comes last. Do not build every connector before validating the core with one real project. None of these rows authorizes an account connection, publication, installation, migration or outbound action on its own.

**Frozen:** skill-builder and skill-source feature work is frozen until the daily-use blockers (priorities 1–4) ship. The create-from-template path (`skill template-list`, `skill template-seed`, `skill template-verify` and the templates under `templates/skills/`) may be built as part of the personal harness layer; it adds no install, export, validation or pilot-fence behavior; all other skill-builder and skill-source feature work stays frozen. Bug fixes and safety fixes continue. Skill export and the weekly updater resume at priorities 7 and 8.

## Skill-builder milestones

Frozen: bug fixes only. Milestone C is delivery priority 7. The approved design is [skill-builder.md](plans/skill-builder.md).

1. **A: private creation tooling implemented.** Requirements → approved design → immutable draft → validation. The conversational skill and live behavior evaluation remain deferred.
2. **B: disposable installation implemented and reviewed.** Approved generic/personal packages only, using owned copies and conflict-preserving removal. Plans bind content, validation and prior installed state. Installation preserves byte edits and refuses path-role changes and case-only renames. Real homes remain gated.
3. **C: clean export, not implemented.** Explicit file selection and privacy/rights review. Export preparation is not publication.

Live-model behavior evaluation needs an approved provider/account and synthetic fixture scope. Report it deferred when not run. Static format checks and scripted approval tests cannot demonstrate useful clarification, routing or writing quality. Fresh-session discovery is a separate activation check.

## Requested addition: third-party catalog and weekly updates

Frozen: bug fixes only. The weekly updater is delivery priority 8.

The twelve-source managed design is approved. See [source audit and delivery design](research/skill-collections.md) for verified repository names, observed releases, installation differences and exit evidence. The first bounded slice, the [read-only catalog and release checker](plans/skill-source-catalog.md), is implemented. It validates the twelve public recipes, resolves stable releases to commit IDs, compares a supplied prior lock, and reports absent releases or typed failures. It does not save locks, download packages, install skills or schedule jobs.

From the checkout, `node bin/devtwin.mjs skill-sources catalog` lists the preset without network access. `node bin/devtwin.mjs skill-sources check --source <id>` makes bounded public GitHub requests; read the [skill-source rate-limit note](SKILL-SOURCES.md) before sweeping all sources. Every source remains installation-unverified. Independent Claude catalog and acquisition actual-diff reviews passed, with no material acquisition findings. A separate two-file public-source preview → private disposable stage → offline inspect smoke passed; no acquired source content was executed.

The [pinned acquisition milestone](plans/skill-source-acquisition.md) implements root-free preview, explicit file staging exclusively in private pilot dataRoot, and offline inspection. It records caller-supplied-unverified pins and blob/SHA-256 provenance, preserves source-relative paths, and distinguishes incomplete publication from a verified content stage. Its normal tests use local fixtures and independent actual-diff review passed. This is separate from skill-builder B's installation contract and makes no safety, dependency completeness, compatibility or installed claim.

Optional acquisition follow-ups are safe run-ID diagnostics for failures before final receipt publication, more precise allowlisted field hints, and measuring repeated filesystem checks before raising the current caps. They do not broaden the reviewed staging milestone.

The [source installation bridge](plans/skill-source-installation.md) maps one explicitly reviewed stage to disposable Claude `.claude/skills` and Codex `.agents/skills` layouts. It preserves raw bytes/legal files, keeps content and single-use action decisions separate, shares the existing filesystem executor/lock, refuses adoption/edits/competing copies, and retains partial journals. Synthetic evidence covers install, update, clean restoration and removal; it establishes no real-source or fresh-host compatibility. Personal Codex retains its legacy layout with an additive shared-root conflict check. Source removal can survive staging loss if its current decision/receipt/installed files are intact.

Native host adapters/discovery, reviewed adoption, automatic update policies and a reusable automation-setup skill remain. Add the preset to initial onboarding only after those components pass their own gates. Keep recipes public and each user's installations, decisions, schedules and reports private.

The delivery sequence is read-only catalog/checker → package acquisition and explicit selections → disposable adapter/updater tests → reviewed local activation → fresh-host discovery checks → disabled schedule and harmless run → weekly enablement. Claude, Codex, Gemini CLI, Cursor and Command Code require explicit compatibility evidence; a common folder is not universal support. The weekly schedule has user approval, but no weekly updater, enabled schedule or twelve-source activation is claimed yet. Scheduler recipes remain generic; each user's schedule and execution receipts stay local.

## Portable selected-record handoff

The [H1 plan](plans/portable-handoff.md) implements explicit selected-record Markdown export under the existing pilot fence. [Handoff documentation](HANDOFF.md) defines the required evaluation clock, exporting-worktree observations, hashes, strict bounds, identity exclusions and unsafe-content holds. New profiles use project identity; historical records and shared briefs remain unchanged.

Synthetic tests cover CLI packets, deterministic bytes, scope isolation, disclosure/freshness, output refusal and overflow. The packet is a private preview, not sharing permission or proof of application execution. Import, distribution, real-project evaluation and live discovery remain separate milestones; source-installation evidence does not prove them.

## Known core follow-ups

The six residuals recorded by the bounded pilot review are resolved and merged to `main` ([plan](plans/2026-10-14-001-fix-needs-update-audit-items-plan.md)). They were recorded residuals, not claims that each was exploitable:

- Resolved: the CLI install → uninstall → reinstall journal-ID collision was fixed and reviewed in B, with fresh generated IDs, exclusive run directories and regression tests.
- Resolved: agent-home writes now require the installer's named target home, which must be listed in `pilot.agentHomes`; other mutators cannot write any agent home. The acceptance harness accepts repeated `--forbidden <path>` options and records them in its report. See [Security model](SECURITY-MODEL.md).
- Resolved: unexpected Git query failures, including timeouts and refused repositories, fail closed with `GIT_QUERY_FAILED`. Only exit 128 with "not a git repository" means "not a repository". The tests that prove filters and hooks do not run during discovery remain. See [Agent protocol](AGENT-PROTOCOL.md).
- Resolved: failed writes remove their own partial or temporary file, and lock handles always close. Run receipts are fsynced and restored on replay. Git output, remote count and remote URL length are bounded with `LIMIT`. SHA-256 is the file-identity authority; `mtimeMs` is informational. See [Storage](STORAGE.md).
- Resolved: public record APIs refuse caller-supplied operation IDs. Records that falsely claim an onboarding operation, or carry malformed, self-referencing or cyclic supersession, are reported as corrupt. This is a same-user local tool, not a security boundary against a malicious process with the same filesystem access. See [Storage](STORAGE.md).
- Resolved: re-onboarding a worktree retires earlier auto-created records that the new onboarding re-creates, unless `--keep-previous` is given. See [Guided onboarding](ONBOARDING.md).

Known items found during that work, not yet changed:

- CLI record commands set `recordedBy` from environment variables: `claude`, `codex` or `human`. This is a label for the audit trail, not an identity attestation.
- `record publish --apply` always acts as the controller. The CLI does not check who is running it.
- The default onboarding request ID is derived from the command inputs, not from source hashes. Re-running onboarding with the same flags after sources change reuses that ID, so it replays or refuses instead of onboarding again. Pass a new `--request-id` for a fresh onboarding.
- Bundled skills are checked for real command routes only. Their flags are not checked against each command's declared options.

Windows is unsupported. Multi-device synchronization is not implemented.

## Keep private data out of the release

The reusable repository holds code, generic skills, templates, schemas and tests. Local private stores hold project facts, client context, decisions, generated skills, approval evidence and evaluation artifacts. Credentials remain in an approved credential store. A Git push is not a backup of that private state.

An existing personal setup and this new toolkit are separate until a reviewed migration and activation occur. Do not interpret a globally installed older skill as proof that it is running this package.
