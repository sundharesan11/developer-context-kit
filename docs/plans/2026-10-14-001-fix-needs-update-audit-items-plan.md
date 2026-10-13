---
title: Needs-Update Audit Items - Plan
type: fix
date: 2026-10-14
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Needs-Update Audit Items - Plan

## Goal Capsule

**Objective:** Close the five "Needs update" items from the 2026-10-12 project audit: stale status lines, roadmap order, placeholder bundled skills, the open core follow-ups and the stub auth/agent-protocol docs.

**Authority:** The user's answers in the planning session govern scope. Repository tests, `test/required-tests.json` and the package audit are hard gates. Existing safety guarantees (pilot fence, immutable records, no auto-broken locks, preserved user records) must not weaken.

**Stop conditions:** Stop and ask the user if a fix would weaken a pilot guard, change an existing required test's meaning, require renaming a required test, or touch anything in "Deferred to Follow-Up Work".

**Execution profile:** Run in waves. Wave 1 in parallel: U1, U2, U3, U5 and U7. Wave 2: U4 (after U2, because both edit `src/storage/lock.mjs`, and after U5, because both edit `src/onboarding/onboard.mjs`) and U6 (after U5). Wave 3: U8. `test/required-tests.json` is a shared hotspot; integrate its edits serially.

**Tail ownership:** The session owner runs `ce-code-review`, commits without agent attribution, pushes the branch, waits for all four CI jobs to pass, then fast-forwards `main` and pushes it. No PR.

---

## Product Contract

### Summary

The audit found five areas that are out of date or incomplete. This plan updates the docs to match current evidence, reorders the roadmap toward daily use, turns the three bundled skills into usable skills, and fully resolves the open core follow-ups listed in `docs/ROADMAP.md`.

### Problem Frame

- README, Getting Started, Limitations and Roadmap still say the Node 22.13.0 floor and Linux are unverified. CI run 38154524118 at `8f1133a` passed all four lanes (macOS and Ubuntu, Node 26.4.0 and 22.13.0) with 234 tests and 24 acceptance checks.
- The roadmap lists the skill builder as priority 1 while the daily-use blockers sit lower.
- The bundled skills are one-paragraph placeholders that only work from inside the toolkit checkout.
- Six "Known core follow-ups" are listed. The install, uninstall and reinstall journal-ID collision is already fixed (U8 only updates its status). Research confirmed real gaps in the other five, mapped as: agent-home write scope and acceptance forbidden paths → R4, R5; Git query errors → R6; low-level writes, locks, Git bounds and file identity → R7; operation IDs and supersession trust → R8; re-onboarding retirement → R9.
- `docs/AUTH.md` and `docs/AGENT-PROTOCOL.md` are three and five lines long.

### Requirements

- **R1.** Status statements cite the CI evidence (run, commit, date, lanes, counts). Linux and the Node floor stay labelled unsupported/not claimed; the test-pinned phrases remain.
- **R2.** The roadmap order becomes: 1 backup and restore, 2 real activation with one real project, 3 session start/end hooks, 4 selective migration, then connectors, company hub, skill export (milestone C), weekly updater, and open-source release last. Skill-builder and skill-source feature work is marked frozen (bug fixes only).
- **R3.** The three bundled skills have real triggers, steps, output meanings and stop rules. They call the CLI through one documented kit location, `DEVCTX_KIT`, and stop and ask when it is unset or not valid as defined in KTD7.
- **R4.** Only installers can write agent-home paths, and only the specific target home they opted into.
- **R5.** The acceptance harness accepts extra forbidden paths and records them in its report.
- **R6.** Unexpected Git query failures fail closed with a typed error. A genuine "not a Git repository" result keeps its current meaning.
- **R7.** Low-level writes, locks and Git output are hardened: no leaked partial or temp files after a failed write, lock handles always close, Git output and remote counts are bounded with typed `LIMIT` errors, and file identity is documented with SHA-256 as the authority.
- **R8.** Public record APIs refuse caller-supplied operation IDs. On-disk records that falsely claim an onboarding operation, or carry malformed, self-referencing or cyclic supersession, are reported as corrupt rather than trusted.
- **R9.** Re-onboarding a worktree retires earlier auto-created records from that same worktree by default, but only records whose kind the new onboarding re-creates. The preview lists what will be retired, the list is part of the plan fingerprint, and `--keep-previous` opts out. User-created records, records from other worktrees, and records already superseded or targeted by a user record are never retired.
- **R10.** `docs/AUTH.md` and `docs/AGENT-PROTOCOL.md` describe what the code actually does, including its known gaps.
- **R11.** The "Known core follow-ups" list reflects the resolved state, and newly found gaps are recorded.

### Scope Boundaries

- No real install, session hooks, backup implementation, migration, connectors or release work. Those are "Needs building".
- Linux and the Node floor are not promoted to supported platforms.

### Deferred to Follow-Up Work

- CLI records always use `recordedBy: {actor: "human", runId: "run_cli00001"}`, and `record publish` always passes `controller: true`. Document both in U8; changing them is a separate item.
- Making the default onboarding request ID depend on source hashes, so a changed repository does not need a new `--request-id`.
- Checking each command's flags (not just its route) inside bundled skills against the command's declared options.

---

## Planning Contract

### Key Technical Decisions

- **KTD1. Agent-home writes need an explicit target.** `assertWritable` refuses agent-home destinations unless the caller passes the one target home, which must be in `pilot.agentHomes`. Threaded through `withPilotLock` options. Chosen over a separate installer-only fence function, which would duplicate fence logic. *(session-settled: user-approved — U4 "all five, fully")*
- **KTD2. Git failures split by meaning.** A strict Git helper accepts only listed exit codes per query (`0`, plus `1` for `config --get-regexp`). "Not a repository" is recognised only from exit 128 with the "not a git repository" message under the existing `LC_ALL=C`. Every other failure, including a timeout and a "dubious ownership" refusal, throws the new code `GIT_QUERY_FAILED`. `LIMIT` stays reserved for output overflow and the remote and URL caps.
- **KTD3. File identity authority is SHA-256.** Keep the stored `mtimeMs` field for compatibility but document that it is informational; do not switch to nanosecond bigint fields. Avoids a binding-format change.
- **KTD4. `checkPreconditions` is left unchanged.** No production code calls it and it is outside the follow-up's named areas; only a regression test imports it.
- **KTD5. Separate internal onboarding commit from public record API.** Public `addRecord` and `commitBundle` reject `operationId`. Only onboarding may set `operationId`, through the internal commit path; supersession keeps using its existing internal path. `publishProposal` refuses a proposal file that carries `operationId` with `INVALID_INPUT`.
- **KTD6. Re-onboarding retires by default.** *(session-settled: user-directed — chosen over opt-in `--retire-previous` and over brief-only hiding: keeps briefs clean while history stays in supersession records)*. Scope *(session-settled: user-directed — chosen over retiring every earlier auto record and over project-wide retirement)*: the retire list covers auto-created records from every earlier published onboarding of the same worktree path, limited to kinds the new plan re-creates. It is sorted by record ID, carried only by the new client-profile bundle, and fingerprinted, so replay is deterministic.
- **KTD7. Skills locate the kit through `DEVCTX_KIT`.** *(session-settled: user-directed — chosen over the checkout-relative command)*. The code needs no change: the kit already resolves itself from `import.meta.url`. A valid `DEVCTX_KIT` is an absolute path whose real path is not inside the current repository or worktree, contains `bin/devctx.mjs` and a `package.json` named `developer-context-kit`, and is shown to the user for confirmation before the first CLI call in a session. The fence protects pilot roots, not the location of the pilot file, so the skills require the user to supply the pilot path and refuse one inside the current repository or the kit checkout.
- **KTD8. No new acceptance check.** The acceptance total (25, with 24 passed and one deferred) is pinned in CI and tests. The `--forbidden` option is proved by a unit-level test that runs the harness preflight.

### High-Level Technical Design

```mermaid
flowchart LR
  U1[U1 Git fail-closed] --> U8
  U2[U2 Agent-home scope] --> U4[U4 Storage hardening] --> U8
  U3[U3 Acceptance --forbidden] --> U8
  U5[U5 Op-ID and supersession trust] --> U4
  U5 --> U6[U6 Re-onboarding retirement] --> U8
  U7[U7 Bundled skills] --> U8[U8 Docs and roadmap]
```

Re-onboarding flow (U6):

```mermaid
sequenceDiagram
  participant User
  participant Plan as planOnboard
  participant Store as internal commit
  User->>Plan: project onboard (no --apply)
  Plan->>Plan: read manifests of earlier onboardings of this worktree
  Plan->>Plan: retire list = their auto records of re-created kinds, not superseded, not targeted by user records
  Plan-->>User: preview incl. retires N + fingerprint
  User->>Plan: --apply --plan-fingerprint
  Plan->>Store: commit client-profile bundle with supersedes = retire list, other bundles without
  Store-->>User: records committed, prior auto records superseded
```

### Assumptions

- `onboard.mjs` is the only caller that passes `operationId` to `commitBundle` (research grep confirmed).
- Existing tests compute plan fingerprints dynamically, so adding retirement to the fingerprint does not break them.

---

## Implementation Units

### U1. Git queries fail closed

**Goal:** Unexpected Git query failures stop discovery with a typed error instead of being read as "no filters", "clean" or "not a repo".

**Requirements:** R6, R7 (Git bounds)

**Dependencies:** none

**Files:** `src/identity/git.mjs`, `src/config/store.mjs` (init repo check), `src/onboarding/scan.mjs`, `src/context/resolve.mjs` and `src/config/doctor.mjs` (surface `GIT_QUERY_FAILED` instead of folding it into other states), `src/errors.mjs` if codes are registered there, `test/identity.test.mjs`, `test/required-tests.json`

**Approach:**
- Add an exit-code allow list to the Git helper (KTD2). Apply it to bare/inside-git-dir checks, `--show-toplevel`, `--git-common-dir`, `--git-dir`, filter `--get-regexp`, `status` and `ls-files`.
- Add a timeout that throws `GIT_QUERY_FAILED`. Map buffer overflow to `LIMIT`. Cap remotes at 16 and each URL at 2 KiB, both `LIMIT`.
- Init's "inside a work tree" check uses the strict helper.

**Patterns to follow:** existing `git()` wrapper and env scrubbing in `src/identity/git.mjs`; `DevctxError` codes in `src/errors.mjs`.

**Test scenarios:**
- Unreadable include file in repo config: discovery rejects with `GIT_QUERY_FAILED`; canary filter never runs; worktree unchanged. Skip this one case only when running as root, where permissions are not enforced.
- Malformed `.git/config`: `GIT_QUERY_FAILED`, not "not a repo".
- Git stub that hangs past the timeout: `GIT_QUERY_FAILED`.
- `doctor` on a pilot whose bound repo has broken config reports `GIT_QUERY_FAILED` explicitly.
- A real non-repository directory still resolves as not a repo (`PROJECT_UNBOUND` / `INVALID_INPUT` paths unchanged).
- Git stub emitting output above the buffer: `LIMIT`.
- Repository with 17 remotes, or one URL above 2 KiB: `LIMIT`.
- Init with roots inside a repository whose config is broken: refused.
- Existing "repository fsmonitor never runs", "F3 Git probe refuses configured clean filter" and "N3 effective include…" tests still pass.

**Verification:** New tests added to `test/required-tests.json`; full suite green.

### U2. Agent-home writes need an explicit target

**Goal:** Non-installer mutators cannot write under any agent home; installers can write only their named target home.

**Requirements:** R4

**Dependencies:** none

**Files:** `src/config/pilot.mjs` (`assertWritable`), `src/storage/lock.mjs` (`withPilotLock`), `src/agents/install.mjs`, `src/agents/package-files.mjs`, `src/agents/package-install.mjs`, `src/skill-sources/installation.mjs`, `test/pilot.test.mjs`, `test/agents.test.mjs`, `test/required-tests.json`

**Approach:** Implement KTD1. Agent homes are refused by default. A call may name one target home; destinations may then include that home in addition to the usual config, data and state root paths (journals, consumed-approval markers, decisions). Other agent homes stay refused. Every installer call site passes its target.

**Test scenarios:**
- Record add, onboarding commit and handoff export given an agent-home destination: `GATE_REQUIRED`.
- Installer opted into home A writing to home B: refused.
- Target home not listed in `pilot.agentHomes`: refused.
- Existing install, update, uninstall and skill-source install tests pass unchanged.

**Verification:** Full suite green; no installer test needed weakening.

### U3. Acceptance harness accepts extra forbidden paths

**Goal:** A caller can add forbidden paths to the acceptance run.

**Requirements:** R5

**Dependencies:** none

**Files:** `scripts/acceptance.mjs`, `test/ci.test.mjs` or a focused test file already in the allowlist, `test/required-tests.json`

**Approach:** Add a repeatable `--forbidden <absolute path>` option. Require absolute canonical paths, append to the pilot's `forbidden` list, and record the list in the report. Do not add an acceptance check (KTD8).

**Test scenarios:**
- `--forbidden` overlapping a pilot member root: harness fails at preflight with a non-zero exit and no fixture writes.
- Relative or non-canonical value: rejected with a usage error.
- Two `--forbidden` values: both appear in the report's forbidden list.

**Verification:** CI acceptance still reports 24 passed and one deferred.

### U4. Low-level storage hardening

**Goal:** Failed writes leave no stray files, locks always release their handles, and identity rules are explicit.

**Requirements:** R7

**Dependencies:** U2 (shares `src/storage/lock.mjs`), U5 (shares `src/onboarding/onboard.mjs`)

**Files:** `src/storage/fsx.mjs`, `src/storage/lock.mjs`, `src/storage/runs.mjs`, `src/onboarding/onboard.mjs` (receipt on replay only), `src/storage/source-read.mjs` (comments only, KTD3), `test/fsx.test.mjs`, `test/lock-plan.test.mjs`, `test/required-tests.json`

**Approach:**
- `writeNewFile`: on write or fsync failure, unlink the file only if its dev/ino still match, then rethrow. Add a fault seam for tests.
- `atomicReplace`: always remove the temp file on failure.
- `fsyncDir`: open with directory and no-follow flags.
- `readPrivateBytes`: also compare `ctimeMs`.
- `withLock`: always close the handle; capture lock identity right after open; read lock files without following symlinks; never break a foreign lock.
- Run receipts: fsync the directory; write a missing receipt on onboarding replay if absent or identical.

**Execution note:** Add the failure-injection tests first, confirm they fail on current code, then fix.

**Test scenarios:**
- Injected write failure in `writeNewFile`: file absent afterwards; retry succeeds.
- Injected rename failure in `atomicReplace`: no `.devctx-*.tmp` left.
- `withLock` with a stat failure in cleanup: handle closed, lock removed, original error surfaces.
- Foreign lock present: still `BUSY`, never removed ("a foreign lock is never broken" still passes).
- Crash between registry publish and receipt write, then replay: receipt exists afterwards.
- Existing `fsx` and lock/plan required tests pass.

**Verification:** Full suite green.

### U5. Operation-ID and supersession trust

**Goal:** Callers cannot claim onboarding operations, and corrupt supersession on disk is reported instead of trusted.

**Requirements:** R8

**Dependencies:** none

**Files:** `src/records/store.mjs`, `src/onboarding/onboard.mjs`, `src/identity/ids.mjs` (comments only), `test/records.test.mjs`, `test/required-tests.json`

**Approach:** Implement KTD5. In `readSnapshot`: mark as corrupt any record whose `operationId` is published but not in that operation's manifest bundles; validate `supersedes` is an array of record IDs; reject self-reference; mark cycle members corrupt; recompute record IDs from scope, project and request ID. `publishProposal` refuses a proposal file carrying `operationId` (KTD5). Corrupt-record errors name the record ID so an operator can find it.

**Test scenarios:**
- `addRecord` with `operationId`: `INVALID_INPUT`.
- Proposal file edited to carry `operationId`, then published: `INVALID_INPUT`, no record written.
- A store containing a newly corrupt record: handoff export fails with `INTEGRITY` naming that record ID.
- Hand-planted record claiming a published operation: listed as corrupt, not effective.
- Self-superseding record and an A↔B cycle: corrupt; no other record wrongly hidden.
- Record whose stored ID does not match its request ID: corrupt.
- Missing `supersedes` field: corrupt, not `INTERNAL`.
- "supersession preserves history…" and "F2 operation ids…" still pass.

**Verification:** Full suite green.

### U6. Re-onboarding retires previous auto-created records

**Goal:** A second onboarding supersedes the first onboarding's auto-created records by default, visibly and deterministically.

**Requirements:** R9

**Dependencies:** U5

**Files:** `src/onboarding/onboard.mjs`, `src/onboarding/commands.mjs` (`--keep-previous`), `src/records/store.mjs` (internal commit path), `test/onboard.test.mjs`, `test/required-tests.json`

**Approach:** Implement KTD6 per the sequence diagram. Enumerate earlier published onboarding operations for this scope, project and worktree path from the registry; collect their bundle records of kinds the new plan re-creates; drop records already superseded or referenced by user records. The plan output gains this retire list (record IDs and hashes), sorted and included in the fingerprint. Only the new client-profile bundle carries it as `supersedes`. `--keep-previous` empties it. Retire candidates must pass U5's integrity checks. If a retry finds staged bundles whose `supersedes` differs from the recomputed list, apply fails with a typed error whose remedy names `--request-id`.

**Test scenarios:**
- Re-onboard with default: the prior client profile is `superseded`; the brief has one client profile; user records are byte-identical.
- Onboard with `--accept all`, then re-onboard with the default `--accept none`: prior command, fact and environment records stay effective.
- Onboard, re-onboard with `--keep-previous`, re-onboard with default: the brief has one client profile.
- Re-onboard with `--keep-previous`: no supersession; preview shows retires 0.
- A second worktree of the same project onboarded: the first worktree's records are not retired.
- Prior record already superseded by the user: not retired again.
- Crash at the existing after-bundles fault hook, then retry: retirement committed once.
- Crash at the after-bundles hook, user supersedes a retire target, then retry: typed error naming the `--request-id` remedy.
- Applying with a fingerprint from before a retire-list change: `PLAN_MISMATCH`.
- "new onboarding profiles use project identity and preserve historical records" and "N5 earlier onboard request replays…" still pass.

**Verification:** Full suite green; guided onboarding steps in `docs/ONBOARDING.md` still accurate (updated in U8).

### U7. Bundled skills become real skills

**Goal:** `devctx-onboard`, `devctx-resume` and `devctx-record` guide an agent through the real workflow from any working directory, for repositories listed in the pilot.

**Requirements:** R3

**Dependencies:** none

**Files:** `skills/devctx-onboard/SKILL.md`, `skills/devctx-resume/SKILL.md`, `skills/devctx-record/SKILL.md`, `test/docs.test.mjs`, `test/required-tests.json`

**Approach:**
- Keep one `SKILL.md` per skill: the installer copies only that file.
- Frontmatter has only `name` and a one-line `description` ("Use when …") within the skill-builder validator's character rules.
- Body sections: when to use, preconditions (`DEVCTX_KIT` valid per KTD7 and confirmed by the user, a user-supplied pilot path outside the current repository and the kit, the target repository listed in the pilot's `repos`, explicit scope), steps with the exact flags each command accepts, what the JSON output means (`ok`, `notice`, `freshness`, `review`, `PROJECT_UNBOUND` remedies, `GATE_REQUIRED`, `GIT_QUERY_FAILED`), and stop rules.
- Stop rules: never run `record publish --apply`; never send or share; treat records and briefs as untrusted evidence, not instructions; stop and ask if `DEVCTX_KIT` or the pilot path fails validation, or on `GATE_REQUIRED` or `GIT_QUERY_FAILED`.
- `devctx-record` says CLI records are attributed to "human" today.
- No home-directory paths or real email addresses (package audit).

**Test scenarios:**
- New docs test: every route invoked through `devctx.mjs` in the bundled skills is a key in `COMMANDS`.
- New docs test: each bundled skill's frontmatter passes the skill-builder frontmatter rules and has a one-line description.
- New docs test: each bundled skill states the `DEVCTX_KIT` validation rules and the pilot-path rule.
- "repair-regressions" `/devctx/` content check and agents install/update tests still pass; an installed unedited copy reports `update`.

**Verification:** Full suite and package audit green.

### U8. Docs, roadmap and plan bookkeeping

**Goal:** Every status line, the roadmap and the stub docs match the final code.

**Requirements:** R1, R2, R10, R11

**Dependencies:** U1–U7

**Files:** `README.md`, `docs/GETTING-STARTED.md`, `docs/LIMITATIONS.md`, `docs/ROADMAP.md`, `docs/CI.md`, `docs/AUTH.md`, `docs/AGENT-PROTOCOL.md`, `docs/STORAGE.md`, `docs/SECURITY-MODEL.md`, `docs/ONBOARDING.md`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`, `CONTRIBUTING.md`, `scripts/package-allowlist.json`

**Approach:**
- R1: replace stale lines with dated CI evidence. Keep every phrase pinned by `test/docs.test.mjs`. Add a "Last verified run" line to `docs/CI.md`.
- R2: rewrite the priority table and the "Priorities 5–7" sentence; mark skill-builder and skill-source sections frozen; keep ordered-work mentions in RELEASING, ONBOARDING, GETTING-STARTED, README and CONTRIBUTING consistent.
- R10: `AUTH.md` covers secret-reference forms, account config validation, the verify/read/draft gate order and error codes, the unused outbound policy, and the approval contract. `AGENT-PROTOCOL.md` covers scope and worktree resolution, brief reading, envelope fields and freshness, completion drafts, propose versus publish, hub proposals, and the CLI caveats in Deferred.
- R11: mark the six follow-ups resolved with pointers; add the deferred CLI items.
- `docs/STORAGE.md` and `docs/SECURITY-MODEL.md`: operation-ID, supersession-trust and SHA-256 identity rules, plus the manual review step for a record reported corrupt. `docs/ONBOARDING.md`: retirement preview, `--keep-previous`, and the `--request-id` recovery after a changed retry. `docs/ARCHITECTURE.md`: `DEVCTX_KIT` and its validation. `docs/AGENT-PROTOCOL.md` lists `GIT_QUERY_FAILED` with a stop-and-ask remedy.
- Add this plan file to `scripts/package-allowlist.json` in sorted order.
- Final CI counts are filled in after the branch CI run.

**Test expectation:** Existing docs tests (pinned phrases, links, CLI routes) and the package audit pass.

**Verification:** `npm test` and `npm run check:package` green; no doc claims a count or run that was not observed.

---

## Verification Contract

- `npm test`: all tests pass, zero failures; every new test name is in `test/required-tests.json`.
- `npm run check:package`: `ok: true`, no findings.
- `actionlint .github/workflows/ci.yml` passes if the workflow is touched.
- `git diff --check` is clean.
- Branch CI: all four jobs (macOS and Ubuntu, Node 26.4.0 and 22.13.0) succeed, with 24 acceptance passes and one deferred.
- `ce-code-review` over the full branch diff, with findings resolved or explicitly deferred with the user.

## Definition of Done

- All units complete; R1–R11 each traceable to a passing test or a doc change.
- No pilot guard weakened; no required test renamed or removed.
- No dead-end or experimental code left in the diff.
- Commits carry no agent attribution.
- After green branch CI, `main` is fast-forwarded and pushed, and the `main` CI run is green.
