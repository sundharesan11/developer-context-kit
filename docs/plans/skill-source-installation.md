# Reviewed Skill Source Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task in the assigned worker. Do not spawn workers. The coordinator obtains independent Claude plan and actual-diff reviews. Steps use checkbox syntax for tracking.

**Goal:** Install, update, restore and remove one explicitly reviewed third-party skill package in disposable Claude/Codex sandbox layouts, preserving selected upstream bytes, provenance and existing user files.

**Architecture:** Verify retained acquisition stages, map an explicit selected file set to one portable package, and bind content approval to that complete mapping and its declarations. Extract the existing package installer's shared filesystem operations and recovery inspection; personal skill-builder and source-package adapters retain separate validation, approval and ownership contracts. Reuse the pilot fence, private storage, install lock, plans and journals rather than create another filesystem installer.

**Tech Stack:** Node.js >=22.13.0, ESM, built-in filesystem/crypto/test modules; no added dependencies.

## Global Constraints

- Existing branch `feat/skill-builder`; inspected baseline `504a81272bef4106d88830bda7be33763da1c6c2`.
- No dependency additions, archives, clones, authentication, provider execution, live agent homes, scheduled jobs, project registration/migration, merge, push or PR.
- No new worker spawning. No network calls in tests. No acquired script or helper execution.
- Never weaken the pilot fence. Keep personal skill-builder A/B creation and approval contracts separate.
- Keep `caller-supplied-unverified` source pins and the acquisition assessment unchanged. Local hash verification is not release provenance verification.
- Preserve exact upstream bytes, including license and notice bytes; no frontmatter stripping, name rewriting, helper execution or executable-bit activation.
- The approval CLI records a supplied explicit user interaction; it cannot authenticate the human behind that interaction. Never fabricate production approval records.
- All milestone executions use synthetic fixtures only. Do not run content/action approval against a real acquired stage.
- Missing dependencies, unreviewed compatibility, excluded source files and unsupported package shapes remain visible. This milestone proves no real host discovery or twelve-source coverage.
- Preserve foreign files, edited managed files, extra directories, links and ownership conflicts. No adoption, force, overwrite or automatic recovery mode.
- All public repository examples are synthetic. Private verification reports and real approval records stay outside the repository.

---

## Inspected contracts and deliberate subset

`src/skill-sources/staging.mjs:inspectAcquisition` verifies complete inventories, stage receipts, SHA-1 Git blob identities, SHA-256 bytes and pilot digest. Its public result carries the complete manifest and file hashes, but no bytes. Acquisition permits 24 files, 128 KiB per file and 1 MiB total.

`src/skill-builder/validate.mjs` accepts only simple `name`/`description` frontmatter, root `SKILL.md`, and files below `references`, `scripts`, or `assets`, with depth four and a 256 KiB total limit. Do not broaden that validator for this task. Source packages use the same file-layout subset plus root license/notice files, but preserve raw upstream metadata. Guard the source frontmatter envelope before extracting a scalar name: every nonblank/noncomment column-zero line must match `^[A-Za-z0-9_-]+:(\s|$)`, keys must be unique and exactly one must be `name`. Reject quoted/complex/spaced keys, tabs, directives, tags, anchors, aliases, merge keys, flow constructs and document delimiters inside the block; reject name values that the existing scalar name parser cannot read. Indented block descriptions and plain-key nested metadata are retained, but do not claim full YAML/schema validation. This guard lives only in `package.mjs`; the personal parser remains unchanged. Unsupported names or layouts are visible holds.

`src/agents/package-install.mjs` owns private-path checks, safe disposable homes, installed inventory/hashes, case/file-directory conflict checks, shared install locking and in-place file writes. Its personal ownership marker is schema 2 and must remain backward compatible. Its update is not an atomic directory transaction: an interruption requires review. Extract reusable operations rather than forge a personal workspace or its approvals.

Existing personal sandbox layouts are `claude: .claude/skills` and `codex: .codex/skills`; retain those personal semantics. New source sandbox layouts are explicitly `claude: .claude/skills` and `codex: .agents/skills`, following the official documentation cited in the research audit. These remain disposable layouts, not live discovery evidence. For a source name, reject competing entries in `.codex/skills`, `.agents/skills`, or `.claude/skills` outside its selected target roots, even identical bytes; inspect parents without following links. Do not migrate or adopt legacy copies. A selected multi-host target may contain its own intact same-source receipt in another selected root.

This conservative rule means a source installed to both hosts must be updated or removed with both hosts selected; a subset action holds on the unselected copy. Add one explicit personal behavior tightening: personal Codex plans/status report conflict if a same-name entry exists in `.agents/skills`. This is read-only, creates no paths, and does not change personal approval/receipt/write semantics. The same shared install lock serializes both adapters.

One mapping describes one skill root and every file in one retained stage. A root-level skill and a nested skill both work. A stage containing multiple skills is held until the caller creates a bounded single-package selection. Nothing selects from the twelve-source catalog automatically.

## File map

| Path | Responsibility |
| --- | --- |
| `src/agents/package-files.mjs` (new) | Shared safe home/parent checks, inventories, file hashes, role conflicts, journal inspection, and create/update/remove filesystem operation extracted from the current installer. |
| `src/agents/package-install.mjs` | Delegate filesystem operations to the shared module; preserve personal approvals, ownership schema and CLI, with an explicit read-only competing `.agents/skills` conflict check. |
| `src/skill-builder/validate.mjs` | Extract the existing local Markdown-link checker for shared use without changing personal frontmatter or path validation. |
| `src/skill-sources/package.mjs` (new) | Exact mapping schema, required-file coverage, inert byte loading, content validation and review fingerprint. |
| `src/skill-sources/installation.mjs` (new) | Separate immutable source approval records, source ownership inspection, install plans/apply/status and provenance binding. |
| `src/skill-sources/installation-commands.mjs` (new) | Strict inline JSON/option parsing and source command adapters. |
| `src/cli.mjs` | Register six pilot-only source installation routes and sanitize their pilot-load errors. |
| `test/skill-source-package.test.mjs` (new) | Mapping, requirements, upstream bytes, license/notices, content-bound reviews and validation holds. |
| `test/skill-source-install.test.mjs` (new) | Fixture-only CLI lifecycle, ownership protection, update/restore/remove, faults, concurrency and stale decisions. |
| `test/skill-install.test.mjs` | Focused cross-adapter ownership/recovery regressions if needed; retain existing regression coverage. |
| `test/helpers.mjs` | Shared synthetic staged-package fixture only if both new suites need it. |
| `test/required-tests.json` | Register lifecycle and refusal evidence as mandatory tests. |
| `scripts/package-allowlist.json` | Add this plan now; add exact new runtime/test files with their implementation. |
| `README.md`, `docs/SKILL-BUILDER.md`, `docs/SECURITY-MODEL.md`, `docs/STORAGE.md`, `docs/LIMITATIONS.md`, `docs/research/skill-collections.md` | Document commands, private records, approval boundaries, supported subset and recovery limits; correct acquisition/installation status without overstating live coverage. |

## Exact data and interface contracts

### Mapping v1

`reviewSourcePackage(roots, {stageRunId, mapping}) -> Promise<Review>` lives in `package.mjs`. It always calls `inspectAcquisition`, reads each declared file with bounded `readPrivateBytes`, compares size/blob/SHA-256 again, and calls inspection again after reads before returning. Buffers used by apply come from this validated read, not a later unchecked path copy.

```js
const mapping = {
  schemaVersion: 1,
  name: "example-skill",
  skillRoot: "skills/example-skill", // empty string means repository root
  files: [
    { source: "LICENSE", target: "LICENSE" },
    { source: "skills/example-skill/SKILL.md", target: "SKILL.md" },
    { source: "skills/example-skill/references/guide.md", target: "references/guide.md" }
  ],
  requiredPaths: ["LICENSE", "skills/example-skill/SKILL.md", "skills/example-skill/references/guide.md"],
  licensePaths: ["LICENSE"],
  noticePaths: [],
  dependencies: [],
  compatibility: { claude: "unreviewed", codex: "unreviewed" },
  review: { fileCompleteness: "unreviewed", licensesAndNotices: "unreviewed", dependencies: "unreviewed" }
};
```

All object keys are exact. Names obey existing `SKILL_NAME`, maximum 64 characters, excluding reserved `devtwin-`, `synced` and `anthropic-skills` names. Source paths use the acquisition path rules; targets use existing package path rules plus exact root `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `NOTICE`, `NOTICE.md`, `NOTICE.txt`, `COPYING`, `COPYING.md`, `COPYING.txt`. Root legal filenames are case sensitive. Reject duplicate/case-folded paths, path-role conflicts, marker collisions, and inherited object properties. Sort set-like arrays and file mappings before hashing.

Require nonempty `licensePaths`; `noticePaths` can be empty only with explicit user review of license/notice completeness. Every staged path must appear exactly once in `files`; every mapped source must exist in the stage; every required/license/notice path must be mapped. `SKILL.md` at the chosen root is always required and maps to root `SKILL.md`. Within-root files retain relative paths exactly. Only legal files named in `licensePaths` or `noticePaths` can come from outside `skillRoot`, and their target must equal their original basename. The review lists those relocations explicitly. Arbitrary renaming, flattening references, omitted staged files and overlays are unsupported.

Declarations are caller-authored review evidence, not an automatic dependency scanner. Each dependency is `{name, status}` where `name` is a bounded plain string and `status` is `unreviewed`, `missing`, or `user-confirmed-present`. Each compatibility value is `unreviewed`, `unsupported`, or `user-reviewed-sandbox`. Each `review` value is `unreviewed` or `user-reviewed`. Unknown values/fields fail closed. Every unresolved dependency or completeness/legal review blocks approval. Compatibility must be reviewed for each selected installation agent; unsupported and unreviewed hosts remain shown in review output. At least one sandbox host must be reviewed before content approval.

Decode content using fatal UTF-8, reject NUL/binary content, enforce the existing 24-file/128 KiB/256 KiB/depth-four package limits including legal files. Use `parseFrontmatter(text, {nameOnly:true})` for the top-level scalar name and require a nonempty body; extra metadata is unvalidated, visible as `frontmatter: name-only-unverified`, and retained exactly. Export `checkPackageLinks(files, assertRel)` from the existing validator and use it in both validators, preserving personal behavior. Source link checking permits the source legal-file paths. Missing local Markdown links hold the package; `unchecked` reference forms hold it too rather than silently infer completeness. Legal files are retained byte-for-byte without interpreting them as skills. Scripts can be copied inertly, remain 0600, and are reported as unverified; user approval is not execution permission.

`Review` contains `schemaVersion`, `stageRunId`, `sourceId`, repository identity, full pin, tree, acquisition fingerprint, unchanged `acquisitionAssessment`, canonical mapping, each source/target/size/mode/blob/SHA-256 row, relocation rows, validation result, `holds`, `disclosures`, and `packageDigest`. `packageDigest` is the canonical digest of all those fields except itself. No timestamp or absolute private path enters the content digest. A separate internal loader returns `{review, files}` with Buffer values; public review output never contains file bodies. All mapping, content, source pin, assessments and dependency/compatibility changes invalidate approval. Actual installation state comes from observed target inventories, never from the acquisition assessment.

Blocking review hold codes are `REVIEW_REQUIRED`, `DEPENDENCY_MISSING`, `DEPENDENCY_UNREVIEWED`, `NO_REVIEWED_HOST`, `UNSUPPORTED_LAYOUT`, `UNSUPPORTED_NAME`, `BINARY_CONTENT`, `PACKAGE_LIMIT`, `MISSING_LINK`, `UNCHECKED_LINK`, and `LEGAL_TARGET_COLLISION` (including a root LICENSE and nested LICENSE both mapped to LICENSE). Malformed/unsafe input still throws typed errors. At install-plan time add `COMPATIBILITY_UNREVIEWED` or `COMPATIBILITY_UNSUPPORTED` for each selected host as applicable. Nonblocking digest-bound disclosure codes are `NAME_ONLY_FRONTMATTER`, `INERT_UNVERIFIED_HELPERS`, `EXECUTABLE_MODE_NOT_ACTIVATED`, `LEGAL_RELOCATION`, `CALLER_UNVERIFIED_PIN`, and `ACQUISITION_ASSESSMENT`. These disclosures do not become safety/compatibility claims when approved.

### Shared sandbox filesystem operations

Extract these functions from `package-install.mjs` to `package-files.mjs`, retaining their semantics and adding bounded traversal where needed:

```js
safeHome(roots, targetHome); // pilot-only; refuses real-home overlaps
agentsCheck(agents); // exact own keys in existing AGENT_HOMES
checkAgentParents(targetHome, agent, layouts = AGENT_HOMES);
entries(dir, prefix = "", {strictModes = false} = {}); // bounded, private regular files
fileHashes(files); // Buffer and string values both supported
roleConflict(oldFiles, newFiles);
journals(roots, targetHome); // shared incomplete/reviewed history
performPackageAction(roots, action, {files, priorReceipt, nextReceipt, journalPath}, {faults});
```

`performPackageAction` handles `create`, `update`, `remove` with the existing `writeFiles`, `removeFiles`, `writeNewFile`, `atomicReplace`, fsync and `beforeReceipt` behavior. It rechecks pilot destinations and parent safety, verifies output file hashes before writing the final ownership marker, and accepts already validated receipt data from its adapter. It does not grant approval, discover hosts, choose packages, acquire files or fabricate personal workspace state. Both adapters call this function; neither contains a second copy loop. Parent/target identity checks are repeated at action boundaries; portable Node path-based calls retain the documented residual same-user race.

Source reads and source observation require exact modes: `(mode & 0o7777) === 0o600` for files and `0o700` for directories, including decision records and target parents. Shared inventory's optional strict mode preserves the existing personal default. Owner execute or special bits on any installed source file produce `modified`, even when bytes match.

`journals` recognizes source journals with kind `skill-source-local` and checks exact schema/decision binding alongside existing personal and legacy records. Preserve the existing personal `skill-package-local` journal predicate byte-for-byte when extracting it. Any incomplete or malformed journal for the selected home blocks both adapters. Existing manual reviewed-journal semantics remain unchanged; this milestone does not automatically move a journal into `reviewed`. Existing personal journal target-home matching remains raw-string based; source commands require `targetHome === realpathSync.native(targetHome)` so source aliases cannot split their recovery history. Broader personal path canonicalization is separate work.

### Source approvals, plans and apply

Functions exported by `installation.mjs`:

```js
approveSourceContent(roots, input, {decisionId, interactionRef, responseText});
planSourceInstall(roots, {contentDecisionId, targetHome, agents, mode});
approveSourceAction(roots, input, {decisionId, fingerprint, interactionRef, responseText});
applySourceInstall(roots, input, {decisionId, fingerprint, runId}, {faults = {}} = {});
sourceInstallStatus(roots, input);
```

`input` for content approval is `{stageRunId, mapping, packageDigest}`. Other `input` objects are `{contentDecisionId, targetHome, agents, mode}`; mode is exactly `install` or `uninstall`. `install` covers both a forward update and deliberate restoration to an earlier approved version. There is no automatic latest-version or rollback selection.

Decision IDs use `dc_[a-z0-9_-]{8,64}` and interactions use the existing `user:` reference syntax. Exact content response is `Approved source content <packageDigest> with caller-supplied-unverified pin`. Exact action response is `Approved source <mode> <planFingerprint>`. Both are required and separately checked; a digest alone is not approval. Content decisions are reusable and never consumed; action decisions are single-use, including restoration and removal decisions.

Store write-once records below `dataRoot/skill-sources/decisions/<decisionId>.json` using exclusive private writes. Content decision stores exact normalized review, digest, stage ID, interaction and response; action decision stores kind, mode, complete finalized plan, content decision ID/digest, interaction and response. Reads validate exact keys, digests and pilot binding. No personal generic/nonconfidential attestation is fabricated for upstream content. No source approval can authorize a personal package action or vice versa.

The source marker `.devtwin-owned.json` uses a distinct schema 3 and kind `skill-source-package`, with exact fields: `schemaVersion`, `kind`, `skill`, `sourceId`, `repository`, `pin`, `stageRunId`, `acquisitionFingerprint`, `packageDigest`, `contentDecision`, `mappingDigest`, `files`, `runId`. It retains per-target hashes and source provenance; stage receipts and content decisions retain the full mapping/blob/mode/legal/dependency details. A source receipt never adopts a schema 1/2 marker, a foreign source identity, or matching foreign bytes. A different skill root for the same source/name is a conflict; moving roots requires separately approved uninstall followed by new install. For install/update/restore validate ownership by loading and fully revalidating the referenced content decision/stage and comparing the complete expected marker and installed inventory. Missing/corrupted evidence blocks those operations.

Uninstall is deliberately mode-aware: its supplied contentDecisionId must exactly equal the installed marker's contentDecision, even when another approval describes identical bytes. Require the intact write-once content decision, validated stored review/digest/response/pilot binding, matching receipt and exact installed inventory/hashes/modes. Do not revalidate stage files, current bundled catalog identity or current acquisition assessment constants for uninstall. Do not apply install compatibility/completeness holds to removal. A missing/corrupt decision or edited target still blocks removal. A missing/corrupt stage alone blocks update/restore but permits removal of an intact owned package through a fresh action approval.

Plans use `finalizePlan` and bind pilot digest, source content decision/digest, full package digest, targetHome, selected agents, explicit source layout map, mode, exact target paths, file hashes, competing-root absence/inventory and each prior receipt digest. Status vocabulary is `create`, `installed`, `update`, `remove`, `absent`, `modified`, `conflict`. Plan output retains review holds; install action approval/apply rejects any holds, unsafe actions or no-op-only plans. Uninstall applies the mode-aware ownership gate above; unsafe actions and no-op-only plans still fail. Source/skill-root identity cannot change across an update. Restoration of an older retained approval is explicitly shown by its pin/stage/digest, not labelled a newer release.

Apply uses the same `stateRoot/locks/install.lock`, re-plans while locked, checks fingerprint, loads the action decision, and refuses reused run IDs/decisions. Exclusive consumed records live at `stateRoot/skill-source-installs/consumed/<decisionId>.json`. Write consumed marker, create `runs/<runId>/journal.json`, reload approvals and (only for install) staged bytes, check target inventories again, invoke shared operations and append each completed action. Journal is `{schemaVersion:1, kind:"skill-source-local", decision, contentDecision, planFingerprint, targetHome, intended, completed}`. Fault hooks are `afterConsume`, `afterJournal`, `beforeReceipt`, and `afterAction` for deterministic partial-host tests. A consumed approval cannot retry after an uncertain result. Status returns consumed decisions and incomplete/reviewed run IDs plus per-host observed state; uninstall status uses the same stage-independent ownership checks as uninstall plans.

No automatic rollback is attempted on interrupted writes. A successful intact version can be restored through a fresh target plan and action approval using an older retained content approval, with the exact same collision/edit checks as an update. All stages/decisions/journals remain retained; no history pruning. If old evidence is unavailable, restoration fails closed.

### CLI surface

All routes require `--pilot`; `rootOptions:false` prevents root overrides and repeated options. JSON input limits are 32 KiB; use `--agent-json '["claude","codex"]'` to retain duplicate-option rejection.

| Route | Additional flags |
| --- | --- |
| `skill-sources package-review` | `--run`, `--mapping-json` |
| `skill-sources content-approve` | `--run`, `--mapping-json`, `--package-digest`, `--decision`, `--interaction-ref`, `--response` |
| `skill-sources local-plan` | `--content-decision`, `--home`, `--agent-json`, `--mode` |
| `skill-sources local-approve` | plan flags plus `--decision`, `--plan-fingerprint`, `--interaction-ref`, `--response` |
| `skill-sources local-apply` | plan flags plus `--decision`, `--plan-fingerprint`, optional `--run-id` |
| `skill-sources local-status` | plan flags |

Errors are typed and sanitized at source API boundaries. Do not echo arbitrary parser/filesystem errors, raw bytes or private absolute paths in failures. Successful explicit target plans include their intended paths. Existing routes and acquisition assessments retain their contracts.

## Task 1: Extract and verify shared filesystem operations

**Files:** `src/agents/package-files.mjs`, `src/agents/package-install.mjs`, `test/skill-install.test.mjs`, `scripts/package-allowlist.json`.

**Consumes:** Existing personal plan/apply/status functions and all 32 baseline installation regression cases.

**Produces:** The shared interfaces above, with the old personal public API unchanged.

- [ ] Read the existing installer and run `node --test test/skill-install.test.mjs` before editing.
- [ ] Add a meaningful failing regression that mutates an output file in `beforeReceipt` and expects apply to refuse a successful receipt; ensure output verification occurs after that fault boundary.

```js
await assert.rejects(applyPackageInstall(x.p.roots, selection, input,
  {fingerprint: x.plan.fingerprint, decisionId: "dc_local001", runId: "run_verify001"},
  {faults: {beforeReceipt: async (action) => writeFile(join(action.path, "SKILL.md"), "changed")}}
), {code: "DEVTWIN_INTEGRITY"});
```

- [ ] Run `node --test test/skill-install.test.mjs`; confirm the new assertion fails for the intended reason.
- [ ] Extract shared functions and replace the personal create/update/remove branch with `await performPackageAction(roots, action, {files, priorReceipt: prior.receipt, nextReceipt, journalPath}, {faults})`. Retain the exact schema-2 marker construction in the personal adapter. Add output verification after `beforeReceipt` and before marker publication.
- [ ] Run the same focused suite; all existing and new cases must pass. Inspect the diff for changed approval or personal ownership semantics.

## Task 2: Verified package mappings and explicit content review

**Files:** `src/skill-sources/package.mjs`, link-check extraction in `src/skill-builder/validate.mjs`, content-decision portion of `src/skill-sources/installation.mjs`, `test/skill-source-package.test.mjs`, optional fixture helper, allowlist.

**Consumes:** `inspectAcquisition`, acquisition path rules, fatal UTF-8 reads, `validatePackage`, canonical digest/private storage.

**Produces:** `reviewSourcePackage`, validated Buffer loader, immutable content approval and loader.

- [ ] Build a synthetic Git tree/blob transport with repository-root `LICENSE`, nested `SKILL.md`, a reference, and a nonexecuted script containing a sentinel write. Use `stageAcquisition` with injected transport; no HTTP calls.
- [ ] Write the failing review test with exact-byte and assessment assertions:

```js
const review = await reviewSourcePackage(p.roots, {stageRunId, mapping});
assert.equal(review.acquisitionAssessment.pin, "caller-supplied-unverified");
assert.equal(review.acquisitionAssessment.installation, "not-installed");
assert.equal(review.files.find((f) => f.target === "LICENSE").sha256, sha256(licenseBytes));
assert.deepEqual(review.holds.map((h) => h.code).sort(), ["NO_REVIEWED_HOST", "REVIEW_REQUIRED"]);
```

- [ ] Run `node --test test/skill-source-package.test.mjs`; confirm missing implementation fails.
- [ ] Implement the exact schema and validation flow above, then content approval. Make `unreviewed` the only default presentation; never silently convert it to user-reviewed. Store only explicit supplied declarations.
- [ ] Cover root/nested skills; absent license/notice/required reference; unselected files; extra mapping keys; case/path-role aliases; illegal targets; root legal collisions; binary/invalid UTF-8/NUL; package total limits lower than acquisition limits; ambiguous name frontmatter refusal; multiline/extra metadata byte retention; missing/unchecked links; missing dependencies; per-host compatibility; explicit relocation visibility; stage tampering; stale digest; malformed interaction/response; exclusive decision IDs; unknown pilot/no writes.
- [ ] Run `node --test test/skill-source-package.test.mjs test/skill-staging.test.mjs`; all pass and script sentinel remains absent.

## Task 3: Source lifecycle through the shared installer

**Files:** `src/skill-sources/installation.mjs`, `src/skill-sources/installation-commands.mjs`, `src/cli.mjs`, shared journal recognition, `test/skill-source-install.test.mjs`, mandatory test list and allowlist.

**Consumes:** Validated source review/content decisions, shared filesystem operations, pilot lock and plan primitives.

**Produces:** Separate source ownership/approvals and all six CLI routes.

- [ ] Add failing fixture-only lifecycle tests: review/approve A, plan/approve/install A to both sandbox layouts, approve B, plan/approve/update B, fresh plan/approve/restore A, fresh plan/approve/remove A. Hash every installed file and assert exact license/notice bytes after each step.

```js
assert.equal(restoration.actions.every((a) => a.status === "update"), true);
assert.equal(restoration.packageDigest, approvedA.packageDigest);
assert.equal(sha256(await readFile(join(target, "SKILL.md"))), sha256(versionA));
assert.equal(await readFile(join(target, "LICENSE"), "utf8"), licenseText);
```

- [ ] Run `node --test test/skill-source-install.test.mjs`; confirm missing routes/functions fail.
- [ ] Implement source receipt/decision validation, plan/apply/status and CLI adapters using the contracts above. Use one shared action executor for both adapters. New routes remain pilot-only and receive no transport.
- [ ] Add fail-closed tests for foreign same-byte directories, personal schema-2 markers, another source/root, competing legacy/shared-root copies, Claude reserved names, user edits, extra file/empty directory, symlink/hardlink, unsafe permissions, stale target plan, altered stage/mapping/decision, wrong response/digest, reused decisions/run IDs, case-only updates and file-directory transitions. Assert before/after tree equality for refusals before mutation.
- [ ] Test each ambiguous frontmatter form listed in M1; preserve multiline description/nested metadata bytes. Test installed script chmod 0700 as modified, source decision owner-execute/special bits refusal, and unchanged personal mode semantics.
- [ ] Test corrupt/missing stage: install/update/restore refuse, but mode-aware uninstall with exact current content decision succeeds. Test cross-decision removal conflict even for identical content. Test single-host subset action against an existing dual-host source copy holds, and later personal Codex planning refuses a competing source `.agents/skills` entry without writing.
- [ ] Add partial-write fault tests at each defined hook, including one completed host followed by failure. Assert retained journal/consumption state, blocked retry, visible partial host state, and refusal by both source/personal adapters. Restoration after a clean update succeeds; restoration over an edited or incomplete target fails.
- [ ] Add install-lock contention test, matching existing `withPilotLock` behavior; no second concurrent mutation and no foreign lock removal.
- [ ] Run `node --test test/skill-source-package.test.mjs test/skill-source-install.test.mjs test/skill-install.test.mjs test/cli.test.mjs test/pilot.test.mjs`. Register the new required named tests after observing their exact passing titles.

## Task 4: Documentation, audit and independent implementation gate

**Files:** Documentation file map above, this plan's progress, private verification report outside Git.

**Consumes:** Actual implemented commands and observed verification results.

**Produces:** Accurate bounded capability documentation and reviewable evidence.

- [ ] Document selected/required/legal files, explicit two-step approvals, sandbox paths, private records and exact supported subset. Explain that inspection cannot prove dependency completeness and that user declarations stay attached to the approval.
- [ ] Document restoration as reapplication of retained approved content after a clean install, and interrupted writes as `RECOVERY_REQUIRED`. No atomic/multi-host transaction or automated recovery claim.
- [ ] Update research status to distinguish implemented acquisition and bounded sandbox installation from future twelve-source recipes, host discovery, native adapters and scheduling.
- [ ] Run `node scripts/run-tests.mjs` and require JSON `ok:true`, zero failures and no missing mandatory tests.
- [ ] Run `node scripts/check-package.mjs` and require `ok:true`, `pack:"run"`, empty findings. Run `git diff --check` and require exit 0.
- [ ] Self-review actual diff: no dependencies, private data, live-home access, network test calls, acquired execution, personal approval weakening or expanded discovery claims.
- [ ] Write private evidence report naming commands/results, supported cases and limits. Ask coordinator for actual-diff Claude review. Apply material fixes and rerun affected checks; request focused re-review when required.
- [ ] Only after review approval and clean verification, create scoped local commits if requested by the coordinator. Do not merge, push or open a PR.

## Exit evidence and separate future work

Completion needs passing fixture evidence for root/nested mappings, legal-file retention, immutable reviews, both sandbox layouts, install/update/restore/remove, unchanged user files, shared locking and partial-write holds, plus full suite, package audit, whitespace and an independent Claude actual-diff review. Merely creating decisions, directories or journals is not success evidence.

Separate future milestones: broader frontmatter/binary layouts; per-source recipes across all twelve catalog entries; trusted release-pin resolution; automated dependency discovery; live host inventory and Codex layout migration; native plugin/CLI adapters; managed overlays and renames; reviewed adoption; transaction recovery after partial updates; unattended update policies; scheduler configuration and activation. None is implied by this milestone.

## Review record

- Plan gate: independent Claude review returned CONDITIONAL. M1–M5 and O1–O8 were incorporated, and coordinator focused recheck approved all four tasks on 2026-10-09. `docs/ROADMAP.md` is additionally authorized for milestone status alignment. Private report retains Orca provenance.
- [x] Tasks 1–3: shared executor, source review/decisions and complete sandbox lifecycle implemented with red-green regressions and fixture coverage.
- [x] Task 4 documentation and verification: post-fix full suite passed 208 tests across 28 files, package audit including dry-run pack passed with no findings, whitespace passed.
- [x] Implementation gate: independent Claude actual-diff review and focused F1/evidence re-review passed. Runtime checkpoint `9baab2d` has no remaining material review findings; private records retain the review reports and Orca provenance.
- The initial review found an indented continuation of the source `name` scalar could bypass the envelope. The source-only guard now tracks its governing top-level key and refuses any nonblank indented line while that key is `name`, including comments across blank lines. Added evidence covers reciprocal valid marker refusal, personal apply blocked by malformed source journals, and per-host state after a first-host failure. The personal parser is unchanged. Conservative shared-parent/removal restrictions and the pre-existing personal journal alias residual remain documented.
