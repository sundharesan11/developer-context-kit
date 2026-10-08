# Portable Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan in place, with test-driven development. The implementing worker owns H1 and its review fixes; the coordinator arranges independent plan and actual-diff reviews. Do not dispatch nested workers.

**Goal:** Export explicitly selected project records as a bounded, deterministic private Markdown packet that a recipient can read without installing this toolkit.

**Architecture:** Resolve the exact pilot worktree, read its committed project snapshot, and project only selected records into a portable model. Validate and render that model independently of `buildBrief`, then exclusively create one private file under the existing pilot data root. No personal preferences, scope policies, binding paths, remote configuration, automatic record selection, or network access enter this pipeline.

**Tech Stack:** Existing dependency-free Node ESM, `node:test`, canonical JSON/SHA-256 utilities, immutable record store, pilot fence and private filesystem helpers. Keep the declared Node minimum unchanged.

## Global constraints

- One cohesive H1 task, evaluated with synthetic fixtures only.
- Runtime implementation starts only after the coordinator returns the independent Claude plan gate.
- Preserve the current pilot schema and fence, existing source installation behavior, immutable history and unrelated changes.
- Export is a private preview, not permission to distribute, publish, synchronize, activate a host, or execute documented commands.
- Never read real client files in this implementation task. Application execution, real-project evaluation and distribution are separate work.
- No raw `buildBrief` dump, policy loading, personal preference loading, additional record kind, new connector, schedule, import, or global-home write.
- Unsafe selected content holds the entire export for review; do not silently redact, truncate, substitute successor records, or skip a selected item.
- Strict cap: 12 selected records and 32,768 UTF-8 bytes for the complete final Markdown, including metadata, disclosures and digest footer.
- Tests use disposable pilot fixtures. Runtime output belongs only below `dataRoot/exports/handoffs/<scope>/<project>/`; no generated packets or private reports belong in the toolkit checkout.
- Use `apply_patch` for edits. Local scoped review commits are permitted after verification; no push, pull request, merge, release, or agent attribution.

## Reviewed contract

### CLI and library APIs

Add exactly this root-bound command; do not add `--all`, `--from-brief`, implicit selection, or root overrides:

```sh
node bin/devctx.mjs handoff export --pilot "$PILOT_FILE" \
  --scope acme --cwd "$ATLAS_REPO" \
  --record "$FACT_RECORD_ID" --record "$HANDOFF_RECORD_ID" \
  --as-of 2026-10-09T00:00:00.000Z \
  --out "$PILOT_DATA_ROOT/exports/handoffs/acme/acme.atlas/packet.handoff.md"
```

Variables above are explicit caller-selected synthetic pilot values. This command is documented for callers; the exporter never executes a command contained in a record. It returns the usual JSON CLI envelope with `{scope, project, asOf, records, packetHash, fileHash, bytes, output, publication: "not-approved"}`. `output` is relative to dataRoot, never an absolute path; `records` contains selected `{id, recordHash}` pairs.

New modules and exact public interfaces:

```text
// src/handoff/portable.mjs
HANDOFF_LIMITS = Object.freeze({ maxRecords: 12, maxBytes: 32768 })
buildPortableHandoff(roots, pilot, {scope, cwd, recordIds, asOf})
  -> Promise<{model, markdown, packetHash, fileHash, bytes}>
renderPortableHandoff(model)
  -> {markdown, packetHash, fileHash, bytes}; validates the portable model first

// src/handoff/privacy.mjs
assertPortableText(text, {field, recordId} = {})
  -> undefined on success; throws on failure; never returns rewritten text
portableRecord(record)
  -> validated explicit projection described below; never spreads metadata

// src/handoff/export.mjs
exportHandoff(roots, pilot, input, {faults = {}} = {})
  -> Promise<CLI result described above>
input = {scope, cwd, recordIds, asOf, out}
faults.beforeRecheck: test-only hook after build, before final recheck
```

```js
// src/handoff/commands.mjs
export const handoffExportCommand = {
  options: {
    pilot: { type: "string" },
    scope: { type: "string" }, cwd: { type: "string" },
    record: { type: "string", multiple: true },
    "as-of": { type: "string" }, out: { type: "string" }
  },
  run(values, ctx) {
    return exportHandoff(ctx.roots, ctx.pilot, {
      scope: values.scope, cwd: values.cwd, recordIds: values.record,
      asOf: values["as-of"], out: values.out
    });
  }
};
```

These signatures define interfaces, not runtime stubs to land. Every runtime increment follows a failing behavioral test.

### Selection, consistency and exclusions

Validate scope with `assertScopeId`, selected IDs with `RECORD_ID`, and `asOf` before reads. Require 1–12 distinct IDs; reject duplicates, missing options, unknown keys in library input, malformed dates and impossible calendar dates with `INVALID_INPUT` (or `LIMIT` for the count cap). In particular, check `Array.isArray(recordIds)` before using it; missing `--record` yields INVALID_INPUT, never a TypeError. Require canonical UTC milliseconds: `new Date(asOf).toISOString() === asOf`.

First verify roots and pilot identity with `assertWritable(roots, [])`, require `pilot === roots.pilot`, and verify canonical cwd is within a declared pilot repository. Then call `resolveContext(roots, {scope, cwd})`, assert its exact root with `assertInPilot(pilot, resolved.worktree.root, "repos")`, and call `readSnapshot(roots, scope, resolved.project)`. Do not read another project's records or policies to resolve a missing selected ID.

Sort record IDs using code-unit order (`array.sort()`), not locale-dependent ordering. Require every selected ID to exist in this project, be effective, and have status observed, confirmed or disputed. Missing IDs, superseded records and proposed records return `RECORD_NOT_EXPORTABLE`; no successor is automatically selected. `readSnapshot` returns corruption without throwing, so explicitly execute `if (snapshot.corrupt.length) throw new DevctxError("INTEGRITY", "Project snapshot is incomplete")`. Corruption may hide supersession; no corrupt bytes or paths appear in the error. Hidden uncommitted records remain excluded and are counted.

No unselected title, body, source ref or actor is rendered. Exclusions show counts for `unselectedEffective`, `proposed`, `superseded`, `hiddenUncommitted`, `unselectedUnknown`, and `unselectedDisputed`, plus fixed exclusions for preferences, policies, binding paths/remotes, unselected record content, verification payloads, review notes, reviewer and user-reference identities, environment/task/worktree applicability and private proposal files. Counts may overlap only for the two explicitly labeled unknown/disputed subsets. `proposed` counts record-store records in that status only; private `proposals/*.json` files are not inspected or counted, so zero does not mean no pending proposals. This inventory is scoped to the resolved project. It says unknowns and disputes outside the selection have not been reviewed, even when their counts are zero.

Selected `unknown` kinds and disputed statuses are fully retained, with titles and IDs, in a dedicated index as well as their record sections. Every selected record shows original status and effective status. H1 does not repair duplicate historical profiles or automatically choose among them.

### Portable model and provenance

The model is a plain explicit object with these fields:

```text
schemaVersion: 1
scope, project, asOf: string
exportingWorktree: {revision: full Git HEAD hex | null,
                   branch: string | null, dirty: boolean}
records: [{
  id, recordHash, bodyHash, bodyBytes, bodyEndsWithLF,
  title, body, kind, status, effective, createdAt,
  recordedBy: {actor, runId},
  review: {reviewerRecorded: true, receipt: "owner-cli-confirmation"} | null,
  revisitAfter: canonical ISO timestamp | YYYY-MM-DD | null,
  applicability: {level, branch, commit},
  sources: [{ref, sha256: string | null, revision: string | null}
            | {kind: "user", recorded: true}],
  freshness: string[],
  sourceChecks: [{ref, recordedHash: string | null,
                  observedHash: string | null, state: string}]
}]
exclusions: {unselectedEffective, proposed, superseded, hiddenUncommitted,
             unselectedUnknown, unselectedDisputed}
```

Use the existing record hash and body hash in full, never claim they authenticate an actor. `recordHash` is an opaque reference to local metadata unavailable to the recipient; `bodyHash` is recipient-verifiable using the extraction rule below. Validate every emitted field, including source optional fields and run IDs; weak existing schema validation is not an export guarantee. Valid source projections are file, commit, record and issue refs, plus a presence-only marker for user refs. Validate structured reviewer and user refs with `assertActorRef` and `assertNoSensitive`, then withhold their values explicitly; confirmed records remain exportable and retain the receipt meaning. The only recorder fields exported are the actor enum and validated runId. Free-text environment applicability is excluded. Account refs inside selected title/body or unrelated provenance strings hold; they are never rewritten.

File paths must satisfy `assertSourceRel` and `isDeniedRel` and be repository-relative. Hashes must match `sha256:` plus 64 lowercase hex characters; commits are 7–64 lowercase hex characters (HEAD must be full 40 or 64). Run IDs use `run_` followed by 8–64 lowercase letters, digits, underscores or hyphens. Unknown source schemes, malformed metadata and malformed dates hold with `HANDOFF_UNSAFE`. Render the header as "Revision of the worktree that produced this packet" and source revision fields as "recorder-stated revision (not verified by export)". Freshness compares sources against the exporting worktree only; it does not inspect another original repository behind a documentation snapshot.

For the first version all URL sources and URL-bearing selected text hold, including apparently clean HTTPS links; H1 has no host/rights review mechanism. Do not strip URLs and then export a misleading record. Source projection intentionally omits unrecognized source metadata; list this metadata exclusion in the packet, and scan strings in selected source metadata for sensitive/path/link content before projection. The record's full hash preserves a reference to its original local metadata without rendering it.

Run `assertNoSensitive` over emitted text and selected provenance strings. Structured file refs are validated as refs, not passed to a text rule that mistakes their `file:` prefix for a URI. Structured withheld identity fields follow the explicit validation/exclusion rule above. For selected body/title, branch labels, source extra metadata strings and other text, use these exact tripwires (no broad arbitrary `word:` rule):

```js
const PORTABILITY_TRIPWIRES = [
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\//i,
  /\b(?:mailto|data|javascript|vbscript):\S/i,
  /\bfile:(?:\/|[A-Za-z]:[\\/])/i,
  /(^|[\s(<"'`=])\/\S/u,
  /~(?:[A-Za-z0-9._-]+)?[\\/]/u,
  /[A-Za-z]:[\\/]/u,
  /\\\\[^\\\s]+\\/u,
  /[\w.-]+@[\w.-]+:[\w./~-]/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:email|github|slack|linear|handle):[A-Za-z0-9._@+-]+/i
];
```

The leading-slash rule deliberately holds all leading-slash tokens, including API routes and protocol-relative links; this limitation must be documented. It preserves internal slashes such as `and/or` and ordinary `Next action: review`, `Blockers: none`, `sha256:abc` and `commit:abc` prose. Relative `file:README.md` prose is inert and allowed; absolute file URIs hold. All email-shaped text holds, including synthetic addresses; the structured presence-only user marker is the route for withheld provenance. Reject CR and non-LF line separators instead of normalizing body bytes. Construct synthetic unsafe strings in tests to avoid planting secret-like literals or home paths in tracked code. Reject, do not normalize or redact. Diagnostics contain only a bounded field label, selected ID and reason code, never offending text, raw errno or absolute paths. Escaped/encoded secrets and arbitrary confidential prose cannot be proven safe by pattern matching; the packet explicitly requires human confidentiality and rights review before sharing.

Do not scan a binding root and reject it merely because it is absolute: binding roots/remotes are never part of the portable projection. Likewise, structured worktree applicability remains excluded with a visible disclosure; any absolute path inside selected body/title/source text holds.

### Time, freshness and digest definition

`asOf` is a required caller-supplied evaluation clock, not a claim of a historical filesystem snapshot or an export timestamp. Current Git and approved source bytes are observed during this invocation. Identical selected records, projected exclusions, worktree observations, source observations and `asOf` produce identical bytes regardless of output filename, wall clock or selection order. Changed observations or `asOf` change the packet digest. No call to `Date.now()` or random output ID participates in rendering.

For each selected record, accumulate labels in fixed order: `recorded-after-as-of`, `different-branch`, `different-revision`, `different-worktree`, `stale-by-date`, then file-source states sorted by source ref. A date-only `revisitAfter` becomes due at UTC midnight; label `stale-by-date` when `asOf >= revisitAfter`. Preserve the review date. Do not rewrite record status. Worktree applicability is compared locally, with only the mismatch label exported.

For file sources use `resolved.worktree.root`, never `binding.roots[0]`. Only read file refs listed in `binding.approvedSources`, via `readApprovedSource`. Export recorded and observed content hashes and one of `current`, `needs-revalidation`, `source-missing`, `unbound-source`, or `unverified-source` (record lacks a valid original hash). Bound source read errors map to a non-current label or a safe typed failure; never fall back to a different worktree. Records with no file sources say `not-file-verified`; this is not a verified-current claim. Only use `current` when there are bound, readable file sources with matching hashes and no other caveat. Distinct labels are deduplicated in deterministic order.

Dirty state always appears near the top: a commit identifies committed history, not current dirty bytes; hashes only cover named observed files, not the entire worktree. A clean tree does not prove tests ran. Detached HEAD and no commits remain explicit `unknown` branch/revision labels. Retain test/deployment/operational state as unknown unless a selected record states an attributed result; export itself executes none of those checks.

The renderer produces LF-delimited CommonMark with these sections, always present: identity/as-of/exporting-worktree revision/dirty state; trust and scope notices; selected-record manifest; selected evidence; unknowns and disputes; exclusions; recipient checks. Body text appears verbatim inside a dynamically sized fenced `text` block (longer than any run of fence characters in the body), preventing Markdown HTML/images/links from becoming active markup. Emit exactly `fence + "text\n" + body + "\n" + fence + "\n"`. To recover body bytes, take bytes after the opening fence's LF through the bytes before the closing fence, then remove exactly the one separator LF immediately before that closing fence. Retain any additional LF because it belongs to the body. Render `bodyBytes` and `bodyEndsWithLF` next to bodyHash, and test empty, no-final-LF, one-final-LF, multiple-final-LF, tabs and Unicode bodies independently. CR/U+0085/U+2028/U+2029 hold. Inline metadata is escaped or emitted with a safe delimiter, never interpolated as raw markup. Empty sections say explicitly that none was selected, not that none exists.

Let `content` be the complete UTF-8 Markdown including its final LF but excluding the digest footer. `packetHash = sha256(content)`. Append exactly `\nPacket SHA-256 (all preceding bytes): <packetHash>\n`, and define `fileHash = sha256(markdown)` for the final bytes. The CLI returns both; only packetHash is embedded. Document that the extra separator LF belongs to the footer, so independent verification removes the entire footer starting with that LF. Check the 32,768-byte cap after appending the footer. No budget omissions are permitted.

### Private publication boundary

`out` must be an absolute canonical path whose parent is exactly `join(roots.dataRoot, "exports", "handoffs", scope, project)` and whose basename matches `[a-z0-9][a-z0-9._-]{0,63}\.handoff\.md`. No arbitrary nesting, traversal, relative path, root override, alternate export root or overwrite. This narrow destination is additive to the existing `assertWritable` fence, not a fence replacement.

Before any output mutation, build and validate the complete packet, validate the destination, reject an existing final node (file, symlink, hardlink, directory or special node), and validate existing ancestors from pilotRoot through dataRoot and the export parent as real caller-owned directories without group/other write permission. dataRoot and existing export directories must be private 0700. Do not chmod or adopt foreign directories. Use `ensurePrivatePath` only after validation, to create absent export descendants with 0700. Re-run `assertWritable` and ancestor checks before the exclusive 0600 `writeNewFile`, then `fsyncDir` on the parent. Recheck that the output bytes/hash and mode match before returning success.

Rebuild the packet immediately before directory creation and compare `fileHash`; changes to selected records, effective states, exclusions, source bytes, Git state or freshness yield `SOURCE_CHANGED` and no packet. `faults.beforeRecheck` provides a focused deterministic race fixture. This catches ordinary concurrent drift, not a malicious same-user race. Node path-based operations and partial write failures retain the existing residual race; do not claim atomic rollback. Preflight errors leave no output; an I/O interruption may retain an incomplete private file that must be inspected manually, never overwritten on retry. A packet without a valid independently verified footer must be discarded as an artifact, never consumed or shared; do not automatically delete evidence or overwrite it. Retain the existing non-atomic writer in H1 rather than introducing a new storage publication protocol.

## H1: selected-record portable Markdown export

**Files to create**

- `src/handoff/privacy.mjs`: strict portable text and selected-record projection.
- `src/handoff/portable.mjs`: selection, scoped exclusions, freshness, deterministic model and Markdown rendering.
- `src/handoff/export.mjs`: dataRoot-only destination and exclusive private publication.
- `src/handoff/commands.mjs`: CLI option mapping with sanitized failures.
- `test/handoff.test.mjs`: deterministic packet, selection, privacy, provenance and freshness tests.
- `test/handoff-export.test.mjs`: CLI, destination, consistency and output mode tests.
- `docs/HANDOFF.md`: contract, usage, digest verification, holds and recipient instructions.

**Files to modify**

- `src/cli.mjs`: one lazy `handoff export` route with `rootOptions: false`; permit repeated declared-multiple options while keeping singleton refusal; sanitize root-load failures for this route without changing other routes.
- `src/onboarding/onboard.mjs`: use `plan.project` instead of `plan.root` in the newly generated profile's repository field only. Old records remain byte-identical.
- `test/onboard.test.mjs`: portable new-profile regression and immutable historical-body assertion.
- `test/cli.test.mjs`: extend help assertion if needed. The existing root-bound route assertion lives in `test/pilot.test.mjs` and covers the new route without modification.
- `test/docs.test.mjs`: pin the handoff limitations and `docs/HANDOFF.md` link.
- `test/package.test.mjs` and `scripts/check-package.mjs`: reject generated packet suffixes even when explicitly allowlisted, in both checkout inventory and dry-run pack inventory.
- `scripts/acceptance.mjs`: add `handoff-export-portable` and require its ID in the existing acceptance contract.
- `scripts/package-allowlist.json`: add this plan and every new generic module/test/doc explicitly; no output packets, private reports, golden packet files or new dependencies.
- `test/required-tests.json`: require every new named test below, including package/profile regressions.
- `README.md`, `docs/STORAGE.md`, `docs/SECURITY-MODEL.md`, `docs/LIMITATIONS.md`, `docs/ROADMAP.md`: document H1 behavior and precise remaining limitations. Clarify that skill-package export remains separate.

No edits to `src/context/brief.mjs`, record schemas, pilot schemas, source installation modules or historical fixture snapshots are needed. The public plan contains generic design only; execution receipts and review identifiers go in the private H1 report.

- [ ] **1. Confirm the gate and capture the baseline.** Read the coordinator's completed plan-review decision and repair material findings before runtime edits. Record baseline HEAD, branch and clean/dirty status in the private report. Run `node scripts/run-tests.mjs` and `node scripts/check-package.mjs`; the inherited baseline is 208 tests across 28 files. Report actual output rather than assuming this count. Keep the plan's new allowlist entry in sync so its presence does not create a false baseline failure.

- [ ] **2. Write a failing CLI acceptance test.** Create `test/handoff-export.test.mjs` with this real fixture test. It must fail because the command is missing, before adding the command or implementation:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { seedCommittedProject, draftFor, runCli, now, fixtureGit } from "./helpers.mjs";
import { addRecord } from "../src/records/store.mjs";

test("handoff CLI exports selected evidence only to private dataRoot", async (t) => {
  const s = await seedCommittedProject(t);
  const record = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const out = join(s.dataRoot, "exports/handoffs/acme/acme.atlas/packet.handoff.md");
  const before = await fixtureGit(s.repo, ["status", "--porcelain"]);
  const result = await runCli(["handoff", "export", "--pilot", s.path,
    "--scope", "acme", "--cwd", s.repo, "--record", record.recordId,
    "--as-of", "2026-10-09T00:00:00.000Z", "--out", out]);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  const markdown = await readFile(out, "utf8");
  assert.match(markdown, /Fixture body/);
  assert.ok(markdown.includes(record.recordId));
  assert.ok(!markdown.includes(s.repo) && !markdown.includes(s.dataRoot));
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(result.json.result.publication, "not-approved");
  assert.equal(await fixtureGit(s.repo, ["status", "--porcelain"]), before);
});
```

Run `node --test test/handoff-export.test.mjs`; retain the expected assertion failure (`code` is nonzero) in the private RED log. Do not count an import failure or fixture typo as valid RED evidence.

- [ ] **3. Add selection/render/privacy tests before their implementation.** Create `test/handoff.test.mjs` with dynamic module imports after checking the expected exported functions exist, so initial failures are deliberate assertions. Use the existing `twoScopes`, `draftFor`, `now`, `supersedeRecord`, `readSnapshot` and canonical hash helpers. Add the following exact named behavioral tests:

| Required test name | Fixture and observable assertion |
| --- | --- |
| `handoff deterministic bytes and digest bind explicit as-of and selected hashes` | Add two safe records at fixed `now`; reverse selection order and export to two names; exact bytes and hashes match. Recompute both digests independently. Change asOf, selected body via a new record, or source observation and assert a different digest. |
| `handoff selection refuses empty duplicate missing proposed and superseded records` | Table of invalid selections and malformed canonical dates; assert typed failures and no successor substitution. |
| `handoff scope isolation excludes other projects preferences and policies` | Globex canary plus same-scope second-project canary; select acme records only. Add private preference/policy canaries and an unavailable required policy. Export still succeeds without any of them; wrong-scope cwd fails without revealing the other project. |
| `handoff discloses selected unknowns disputes provenance and exclusion counts` | Select unknown, disputed, command and handoff records; leave effective/proposed/superseded and unknown/disputed examples unselected. Assert precise counts, selected titles/hashes/actor/source refs, fixed omissions and no unselected title/body. Confirm result claims remain attributed and application test/deploy status is not inferred. Pending proposal files are excluded/uninspected and do not alter proposed-record count. |
| `handoff withholds structured account identities and environment metadata` | Confirmed record with reviewer and user-source refs; assert receipt/presence markers and full original record hash remain but no email/github/slack/linear/handle refs or free-text environment canary occurs in bytes. Personal identifiers in body/title still hold; actor enum and validated runId remain. |
| `handoff holds unsafe text metadata paths and links without rewriting` | Table of synthetic token, POSIX/Windows/home paths, unsafe title, URL query/fragment/userinfo, SCP host alias, URL source, unsafe run ID, account-shaped body text and source extra metadata. All hold with safe diagnostics. Positive rows: Next action/Blockers prose, completionDraft body shape, hash/commit labels, relative file ref prose and and/or. Leading-slash route literals hold as documented. Safe multiline bodies including fences/HTML are preserved inertly; malformed metadata holds. |
| `handoff body bytes can be independently recovered and hashed` | Extract empty, Unicode/tab, no-final-LF, one-final-LF and multiple-final-LF bodies using the documented separator rule and verify bodyHash/bodyBytes/bodyEndsWithLF. CR and non-LF line separators hold. |
| `handoff refuses corrupt snapshots and selected-content overflow` | Corrupt an unselected bundle to test supersession uncertainty; separately select a 32 KiB body that exceeds the final packet cap, 13 tiny records, and multibyte bodies. Assert INTEGRITY or LIMIT, no truncation, no rendered packet. |
| `handoff freshness uses resolved worktree source hashes and explicit evaluation date` | Bound README match/change/delete, unapproved ref, missing recorded hash, wrong branch/commit/worktree applicability, due/future/invalid revisitAfter and records later than asOf. Assert labels and recorded/observed hashes. Seed a multi-root binding where root zero differs from selected cwd to prove exact-root reads. |
| `handoff dirty detached and unverified evidence caveats remain visible` | Dirty README, detached HEAD and no-file-source records. Assert dirty warning, unknown branch label and not-file-verified; command record is inert and marker file never appears. |

Use assertion patterns such as `assert.rejects(fn, {code: "DEVCTX_HANDOFF_UNSAFE"})`, byte equality with `assert.equal(a.markdown, b.markdown)`, and `assert.equal(sha256(content), result.packetHash)`. Keep `SENSITIVE_CONTENT` for existing credential-pattern hits; portability failures use `HANDOFF_UNSAFE`. Run `node --test test/handoff.test.mjs` and retain RED evidence before implementing each behavior group.

- [ ] **4. Implement the smallest portable projection and renderer.** Add the privacy and portable modules with the exact contract above. Reuse `DevctxError`, ID/schema constants, `assertNoSensitive`, `readSnapshot`, `resolveContext`, `readApprovedSource`, `canonicalJson`, `digest` and `sha256`. Explicitly reject nonempty `snapshot.corrupt`; validate every copied field instead of using raw object spreads. Render the fixed recipient instructions: verify repository identity/exporting-worktree revision and instructions locally; review unknowns/disputes and stale evidence; inspect documented commands before rerunning them; check results independently; reject an invalid packet footer; review confidentiality/rights before sharing. Run `node --test test/handoff.test.mjs` to GREEN, then tidy internal helpers without changing the public API.

- [ ] **5. Add output refusal and race tests.** Extend `test/handoff-export.test.mjs` before filesystem implementation with these exact names:

| Required test name | Fixture and observable assertion |
| --- | --- |
| `handoff output refuses alternate roots aliases existing nodes and unsafe parents` | Table: repo, inputsRoot, configRoot, stateRoot, agent home, external root, forbidden path, toolkit checkout, protected-home fixture, relative path, traversal, nested filename, symlink ancestor/final, existing file/hardlink/directory and unsafe parent mode. Assert typed refusal and unchanged sentinel bytes/modes. Never write into a real protected home to set up a case. |
| `handoff direct APIs require matching pilot before reads or writes` | Missing pilot, forged roots, nonidentical pilot and out-of-fence cwd fail without creating directories. Existing CLI root-free test still passes. |
| `handoff CLI accepts repeated --record and refuses duplicate single-value options` | Actual CLI with two different repeated record flags succeeds; missing record yields INVALID_INPUT. Duplicate pilot/out/as-of/cwd/scope stays USAGE. Exercise existing skill-source singleton duplicates to prove their refusal is unchanged. |
| `handoff preflight failures create no export file or directories` | Unsafe selected content, malformed selection and strict byte overflow fail before creation, using tree snapshots. Existing output name reports CONFLICT and remains untouched. |
| `handoff export rechecks selected evidence before exclusive publication` | `faults.beforeRecheck` changes a bound source, adds a record or supersedes selection; assert SOURCE_CHANGED (or nonexportable selection), no output. A clean retry at another name produces identical bytes; duplicate name cannot overwrite. |
| `handoff CLI errors do not echo private paths or unsafe content` | Exercise root-load, input, source and storage failures through `runCli`, including checkNode PATH_UNSAFE for unsafe export-parent mode; assert bounded safe errors and no absolute fixture roots, body snippets or raw errno strings. |

Run `node --test test/handoff-export.test.mjs` and retain the new expected RED assertions.

- [ ] **6. Implement export and CLI mapping to GREEN.** Add the exporter and command module. The lazy route in `src/cli.mjs` is exactly:

```js
"handoff export": {
  rootOptions: false,
  load: async () => (await import("./handoff/commands.mjs")).handoffExportCommand
},
```

Keep safe route-specific error conversion in the command/export boundary and extend the existing pilot-load sanitizer to this route. All errors from this route retain only safe code/field/ID/reason values; general errors use STORAGE_ERROR. Call `writeNewFile` only after two equal build results and fresh fence/parent checks. Run `node --test test/handoff.test.mjs test/handoff-export.test.mjs test/cli.test.mjs test/pilot.test.mjs` to GREEN.

For duplicate-token validation use the loaded declaration, not a hardcoded flag exception:

```js
if (seen.has(token.name) && impl.options[token.name]?.multiple !== true) {
  throw new DevctxError("USAGE", "Duplicate command option");
}
seen.add(token.name);
```

For helper failures construct a new `DevctxError` from a closed set of known error codes, bounded field enums, selected record ID regex and fixed reason enums. Never spread original error details or preserve its original message. This includes the PATH_UNSAFE `{path}` emitted by `checkNode`.

- [ ] **7. Make new onboarding profiles portable without history edits.** First add `new onboarding profiles use project identity and preserve historical records` to `test/onboard.test.mjs`: onboard a fresh synthetic project and assert its brief includes its project ID and no absolute root; preserve bytes/hashes of an earlier synthetic absolute-path record and prove export of that old selected record holds. Run `node --test test/onboard.test.mjs` to observe RED. Then change only the profile value:

```js
repository: plan.project,
```

Run `node --test test/onboard.test.mjs test/context.test.mjs test/handoff.test.mjs` to GREEN. Do not update historical records or duplicate-profile semantics.

- [ ] **8. Extend package privacy checks before adding new allowlist entries.** Add the exact test `package audit refuses generated handoff packets even when allowlisted` using `pkgFixture` with a synthetic `packet.handoff.md`. Assert a nonzero audit result containing only a finding type, not the packet content. Exercise the pack-entry predicate too. Add an unconditional `generated-handoff-packet` finding for `/\.handoff\.md$/i` in checkout and npm pack entries; no golden-file exception. Run `node --test test/package.test.mjs`, observe the new test RED before the guard and GREEN after adding the guard plus exact generic paths to the allowlist.

- [ ] **9. Write docs and enforce the test contract.** Create `docs/HANDOFF.md` from the reviewed contract and link it from README. Explain fixed asOf semantics, packet and body byte/hash verification, selected-content failures, count-only exclusions, withheld identities, uncounted private proposal files, leading-slash route holds, disclosure limits, exporting-worktree-only freshness and manual recipient verification. State that source revisions are recorder-stated, recordHash is opaque to recipients, and invalid-footer artifacts must be discarded rather than consumed/shared. Update storage/security/limitations/roadmap with observed H1 capability and deferred distribution, import, activation and real-agent execution. Add `handoff docs describe private selected export and unexecuted commands` to `test/docs.test.mjs`, pinning those phrases. Add all exact new test names above to `test/required-tests.json` and every new generic file to the package allowlist; do not weaken existing entries or runner behavior.

- [ ] **10. Add synthetic CLI acceptance.** In `scripts/acceptance.mjs`, seed a fresh safe fact and handoff record explicitly, invoke the CLI twice with fixed asOf and different export basenames, read both packets, and assert equal bytes/digests, scoped content, disclosures, 0600 mode and unchanged synthetic repository tree. Add a selected-content overflow invocation and an inputsRoot output refusal with no packet. Register `handoff-export-portable` in both the check call and required array; never select an arbitrary onboarding snapshot wholesale.

- [ ] **11. Verify the complete review package.** Run these commands from the checkout, retaining exit codes and exact JSON summaries privately:

```sh
node --test test/handoff.test.mjs test/handoff-export.test.mjs test/onboard.test.mjs
node scripts/run-tests.mjs
node scripts/check-package.mjs
git diff --check
```

Expected: focused tests pass, full runner has zero failures and no missing required tests (count exceeds inherited 208/28), package audit includes dry-run packing and no findings, and diff check has no output. Run the synthetic acceptance harness with a fresh absent pilotRoot outside the checkout and a private report path. Set both explicitly in the private report; never add their local paths to public docs:

```sh
node scripts/acceptance.mjs --pilot-root "$H1_PILOT_ROOT" --report "$H1_ACCEPTANCE_REPORT"
```

Expected: all existing required checks plus `handoff-export-portable` pass, with only the existing fresh-agent smoke deferred. Inspect the actual generated packet in the private export directory and independently verify its footer/hash and disclosed limits. Package audit is mandatory again after any final docs or test-file addition.

- [ ] **12. Deliver for actual-diff review and own the fixes.** Write the private `H1-IMPLEMENTATION.md` with baseline/HEAD, precise changed files, RED/GREEN commands and results, retained synthetic CLI output path, packet hashes, acceptance report, plan gate and actual-diff review evidence, local commit IDs and unverified limits. If tests pass, stage only the H1 paths and create a local scoped commit. Ask the coordinator for the independent actual-diff review. Repair material findings test-first, rerun affected and required checks, and report the final bounded outcome without publishing or touching any real project.

## Self-review before plan gate

- The single H1 task covers explicit selection, deterministic time/revision/hash contract, strict byte bounds, project isolation, status/freshness/unknown/exclusion disclosures, inert commands, unsafe-content holds and private output refusal cases.
- The plan keeps profile portability to newly written records and keeps freshness improvements local to export; neither historical record storage nor shared brief semantics changes.
- The test and package contracts explicitly include new files and behaviors; generated packets remain private even if mistakenly allowlisted.
- Independent plan and actual-diff review remain coordinator-owned. Prior source-installation evidence is not rerun as a separate milestone.
