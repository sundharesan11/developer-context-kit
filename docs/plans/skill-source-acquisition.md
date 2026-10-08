# Skill Source Acquisition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The coordinator owns independent Claude plan and actual-diff review. Implementation starts only after that plan gate passes; this plan grants no installation, publication, or scheduling authority.

**Goal:** Acquire an explicitly selected set of files at a supplied immutable public GitHub release pin into a new private disposable pilot staging run, with verifiable provenance and offline inspection.

**Architecture:** A root-free preview resolves a pinned commit's tree and binds exact file metadata into a deterministic fingerprint. A pilot-bound stage repeats that preview, verifies selected blob bytes, and writes exclusively beneath `dataRoot`; an offline inspector accepts only a complete, internally consistent run. Acquisition remains separate from skill-builder approval and agent installation.

**Tech Stack:** Node.js `>=22.13.0`, ESM, built-in fetch/crypto/fs, `node:test`, existing catalog, canonical hashing, `DevctxError`, and pilot APIs. No new dependencies or subprocesses.

## Global constraints

- Baseline: `feat/skill-builder` at `ad3bca3`; existing catalog/checker and skill-builder A/B gates remain intact.
- Planning edits own only this document and its exact entry in `scripts/package-allowlist.json`. The implementation file map below becomes edit scope only after the coordinator approves the reviewed plan.
- Never clone repositories, extract archives, execute upstream code, follow redirects, read credentials, probe native providers, install dependencies, write live homes, create jobs, push, or merge.
- Normal tests use synthetic local HTTP responses and disposable private pilots. Live network is not a test prerequisite.
- Only public catalog identities may be requested. Repository URLs, arbitrary hosts, auth headers, branches, release assets, glob selections, directory expansion, and transport overrides are not CLI inputs.
- Preserve exact selected bytes and repository-relative paths, including explicitly selected licenses/notices. Do not automatically discover dependencies or assert safety, compatibility, license clearance, completeness of a skill, or installation.
- Data and receipts stay outside the checkout, exclusively within a validated pilot's `dataRoot`. No acquisition writes to `configRoot`, `stateRoot`, `inputsRoot`, repositories, or any `agentHomes` member.
- Use exclusive new run directories and exclusive new files; never adopt, overwrite, resume, repair, or delete an existing run automatically. Publish the completed receipt by an exclusive hardlink, never overwrite or remove the final receipt, and never infer completion from directory existence.
- Same-user hostile filesystem races remain a documented residual; this is not a sandbox or an authenticity signature service.

## Bounded deliverable and evidence

The usable path is `check` → choose a pin and explicit files → `preview` → `stage` with the preview fingerprint → offline `inspect`. One source and one selection per invocation avoids a second package manager. Root-level `SKILL.md`, nested skill files, supporting references and license files work equally, within the caps below. A selected executable is inert bytes stored as mode 0600, with its original Git mode recorded.

The existing `checkSource()` returns `{sourceId, channel, tag, commit, status}`. Users copy only the four pin fields into acquisition. Reuse `validatePriorLock(pin, source.id)` for their exact shape. A pin is a **caller-supplied release observation**, not signed evidence and not a claim that the tag still points to that commit or remains latest. Never resolve the tag again during acquisition, substitute a new commit, use an audit default-branch SHA as an observed release, or manufacture a pin from `no_release`. The checker remains the explicit route for checking moved tags/latest releases.

Primary API references, checked by the coordinator for this milestone:

- [Git commits](https://docs.github.com/en/rest/git/commits#get-a-commit): use the immutable commit endpoint and its `tree.sha`.
- [Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree): recursive responses can truncate; reject `truncated: true`, rather than treating missing entries as absent files.
- [Git blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob): JSON/base64 bytes, blob size and object ID; public access does not need credentials.
- [Git object format](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects): blob object ID is SHA-1 of `blob <byte length>` followed by NUL and raw bytes.

Trust is limited: GitHub HTTPS and returned commit/tree identities bind the manifest; this slice does not reconstruct and hash commit/tree objects or verify signatures. It does independently verify every blob's Git object ID and SHA-256 of the staged bytes. SHA-256 receipt hashes detect local changes relative to a receipt, not malicious replacement of both receipt and files.

## File ownership and interfaces

| File | Action and responsibility |
| --- | --- |
| `src/skill-sources/selection.mjs` | Create strict selection/pin validation, caps, manifest validation, fingerprint and blob hashing. |
| `src/skill-sources/github-package.mjs` | Create bounded commit/tree/blob transport; preview and verified in-memory download. |
| `src/skill-sources/staging.mjs` | Create dataRoot-only boundary, exclusive private writes, receipt and offline inspection. |
| `src/skill-sources/acquisition-commands.mjs` | Create the three CLI adapters and bounded JSON argument parsing. |
| `src/cli.mjs` | Register three routes, route-specific duplicate/root-option handling and request injection. |
| `src/config/pilot.mjs` | Add only default `.gemini`, `.cursor`, `.commandcode` protected home roots. Preserve existing paths and gates. |
| `test/skill-acquisition.test.mjs` | Create selection, HTTP fixture, CLI and provenance tests. |
| `test/skill-staging.test.mjs` | Create filesystem, receipt, fault and no-write-boundary tests. |
| `test/pilot.test.mjs` | Extend exact root-free allowlist and added protected-root regressions. |
| `test/required-tests.json` | Add named milestone gate tests. |
| `scripts/package-allowlist.json` | Add the exact new runtime/test files; preserve unrelated entries. |
| `README.md`, `docs/ROADMAP.md`, `docs/STORAGE.md`, `docs/SECURITY-MODEL.md`, `docs/LIMITATIONS.md` | Document actual verified commands, storage, caps, residuals and remaining work after implementation. Preserve pinned baseline disclaimers. |
| `docs/plans/skill-source-acquisition.md` | Track completed checkboxes and public-safe review status only. |

Do not change `github.mjs`, the twelve-source catalog, skill-builder modules, installers, shared `safeJoin` segment rules, or auth integrations. Keep a small dedicated bounded HTTP client in `github-package.mjs`: the acquisition budgets differ from the checker and preserving the checker's mature contract is preferable to a transport refactor in this slice.

```js
// selection.mjs; all functions validate before returning defensive copies.
export const ACQUISITION_LIMITS = Object.freeze({
  files: 24, fileBytes: 131072, totalBytes: 1048576,
  pathBytes: 200, depth: 16, treeEntries: 10000,
  metadataBodyBytes: 2097152, blobBodyBytes: 262144,
  responseTotalBytes: 8388608, requests: 26,
  requestMs: 5000, operationMs: 30000, receiptBytes: 65536
});
export function validateSelection(source, pin, files) {} // {pin, files}, sorted paths
export function validateManifest(value) {} // exact Manifest shape below
export function manifestFingerprint(manifest) {} // digest(manifest), existing canonical.mjs
export function gitBlobSha(bytes) {} // lowercase 40 hex

// github-package.mjs; request is injectable only by library/test callers.
export async function previewAcquisition(source, {pin, files}, {request = fetch} = {}) {}
// => Preview, no bytes or writes
export async function downloadAcquisition(source, {pin, files, fingerprint}, {request = fetch} = {}) {}
// => {preview, blobs: [{path, bytes: Buffer, sha256}]}; repeated preview + blobs,
//    one operation-wide deadline/request/byte budget, never trusts passed metadata

// staging.mjs; roots is rootsFromPilot(loadPilot(...)), not arbitrary destination.
export async function stageAcquisition(roots, source, input, {request = fetch, now = () => new Date(), runIdBytes = () => randomBytes(16), faults = {}} = {}) {}
// input: {pin, files, fingerprint}; => StageResult
export async function inspectAcquisition(roots, runId) {} // => StageResult; offline/read-only

// acquisition-commands.mjs
export const previewCommand = {options: {}, async run(values, context) {}};
export const stageCommand = {options: {}, async run(values, context) {}};
export const inspectCommand = {options: {}, async run(values, context) {}};
```

The declarations above specify signatures, not implementation stubs to commit. `Manifest` has exact keys `{schemaVersion:1, sourceId, repository:{owner,name}, pin:{sourceId,channel,tag,commit}, tree, selection, files, totalBytes}`. `tree` is lowercase 40-hex, `selection` is the sorted explicit path array, `files` has one sorted `{path, blob, mode, size}` per selected path. `blob` is lowercase 40-hex, `mode` is the string `"100644"` or `"100755"`, and `size` is a nonnegative safe JSON integer. Source ID/repository must match the bundled catalog and `pin.sourceId`; selection and files must match exactly, including order. `totalBytes` is a safe JSON integer equal to the sum. `manifestFingerprint()` is `digest(manifest)`: SHA-256 over existing `canonicalJson` bytes (sorted object keys, no whitespace), with the existing `sha256:` prefix; it excludes time, destination and downloaded byte hashes.

`Preview` is exactly `{status:"previewed", manifest, fingerprint, assessment}`. `assessment` is exactly `{pin:"caller-supplied-unverified", content:"selected-files-only", safety:"unreviewed", compatibility:"unverified", dependencies:"unreviewed", installation:"not-installed", redistribution:"unreviewed"}`. Every successful CLI result repeats it. Acquisition does not verify tag-to-commit binding or membership in the named upstream repository's history; GitHub can serve commit objects from its fork network. Do not use a `ready`, `safe`, `approved`, `supported` or `installed` status.

`StageResult` is exactly `{status:"staged", runId, fingerprint, manifest, files, assessment}`; its `files` are sorted `{path, blob, mode, size, sha256}`. It contains no raw content or absolute paths. Returned metadata is sufficient to locate files by `dataRoot/skill-sources/staging/<runId>/files/<path>` and inspect the exact provenance. Empty files are permitted and hashed correctly.

## Strict inputs, caps and typed failures

- Pin object uses exactly the four existing prior-lock fields; invalid source, tag, SHA, unknown key or wrong type returns `INVALID_INPUT` before requests or writes. The tag is descriptive provenance; only the commit enters URLs.
- Selection is a JSON array of 1–24 strings. Each is ASCII `[A-Za-z0-9._/-]`, 1–200 bytes, at most 16 components, with each component 1–100 chars. Reject leading/trailing slash, empty/`.`/`..` components, backslash, percent escapes, colon, whitespace, controls, non-ASCII, absolute paths and drive/UNC forms.
- Reject exact duplicates, case-folded duplicates, case-folded directory aliases (`A/x` with `a/y`), and file/directory-prefix conflicts (`a` with `a/b`). Reject any component ending in dot and case-insensitive `.git`. Only after these shape rules pass, apply existing `isDeniedRel()` and map a deny hit to `INVALID_INPUT`, never leak its internal `PATH_ESCAPE`. This conservative policy also excludes legitimate names such as `id_mapping` and `*.db`/`*.sqlite`; it is not a secret scanner or proof that upstream text is safe. Do not silently normalize, skip, deduplicate or rename input.
- Sort accepted paths by ASCII lexical comparison, independent of locale; use that order throughout. Errors name safe field/index or bounded enum details, not entire input or response bodies.
- Preview only accepts selected tree entries whose mode/type agree (`blob`/`100644` or `100755`), size fits caps and SHA is valid. Symlinks `120000`, gitlinks `160000`, directories and unsupported modes selected as files are `UNSUPPORTED_ENTRY`. Every selected ancestor must be an exact tree entry with type `tree` and mode `040000`; no alias lookup. Reject duplicate paths and case-folded/prefix role collisions affecting selected paths and their ancestors in the upstream tree. Unselected valid symlinks/gitlinks do not fail a selection.
- For every unselected tree entry, require a nonempty path string of at most 4096 UTF-16 units, no NUL, no leading/trailing slash, and no empty/`.`/`..` component; require a lowercase 40-hex SHA and nonempty string type/mode. For known modes require their correct type (`040000` tree, `100644`/`100755`/legacy `100664` blob, `120000` blob, `160000` commit), but tolerate an unknown mode on an unselected entry. Require a nonnegative safe integer size only for blob entries. Spaces, plus, at-signs, non-ASCII, trailing dots and denied selection names on unrelated entries do not fail the tree. Apply strict ASCII/selection rules only to selected paths and ancestors. Use ASCII-only lowercasing to detect conflicts with selected paths; an unselected non-ASCII Unicode-fold alias is a documented residual and is never written. Reject malformed metadata, cap excess and any truncated tree even if selected files appear. Full tree validation does not expand the selection.
- Each JSON stream enforces declared length when uncompressed, streamed decoded-response byte limits even if compressed, fatal UTF-8 and valid JSON. Validate declared length as a nonnegative integer when present. Abort on both per-request and remaining operation deadlines; cancel all bodies in `finally`. No retries or pagination fallback. Failed HTTP response bodies are not read or echoed.
- Fixed origin `https://api.github.com`, constructed `/repos/<catalog owner>/<catalog name>/git/...` paths, `redirect:"manual"`, `Accept: application/vnd.github+json`, `User-Agent: devctx-skill-sources`. No token/env auth, cookies or response-provided URLs. Reuse catalog identity validation rather than accepting a URL.

All codes below are passed to `DevctxError` and appear with the existing `DEVCTX_` prefix:

| Code | Trigger |
| --- | --- |
| `USAGE` | Missing/duplicate/unknown options, malformed JSON or oversized inline JSON. |
| `INVALID_INPUT` | Semantic invalid pin, selection, source, fingerprint or run ID. |
| `SELECTION_CONFLICT` | Duplicate, alias or file/directory collision. |
| `SELECTION_MISSING` | An exact selected file/ancestor is absent from a complete valid tree. |
| `UNSUPPORTED_ENTRY` | Selected symlink, gitlink, directory or other unsupported file type. |
| `LIMIT` | Selection, tree, response, decoded bytes or request-count cap exceeded. |
| `UPSTREAM_INVALID` | Malformed response, truncated tree, identity/type/size disagreement, invalid base64. |
| `INTEGRITY` | Blob object hash mismatch, receipt tamper, extra/missing/changed staged file or metadata. |
| `PREVIEW_CHANGED` | Recomputed manifest fingerprint differs from supplied preview fingerprint. |
| `REDIRECT_REFUSED` | Any 3xx, including repository moves, without following Location. |
| `SOURCE_NOT_FOUND` | 404 on pinned commit/tree/blob; no branch/release fallback. |
| `GITHUB_UNAUTHORIZED`, `GITHUB_FORBIDDEN`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`, `UPSTREAM_HTTP` | Same sanitized HTTP categories as existing checker; use bounded numeric retry hints only. |
| `NETWORK_TIMEOUT`, `NETWORK_UNAVAILABLE` | Request/body deadline or unavailable network; no raw transport error. |
| `GATE_REQUIRED`, `PATH_UNSAFE` | Invalid/mutated pilot, destination outside dataRoot, forbidden home, unsafe node/ancestor/permissions/link. |
| `CONFLICT` | Generated run directory already exists; never reuse it. |
| `STAGE_INCOMPLETE` | Safe run exists but completion receipt is absent. |
| `STAGE_NOT_FOUND` | Valid run ID has no directory. |
| `STORAGE_ERROR` | Unexpected local write/fsync/read failure; omit raw filesystem errors/absolute paths. |
| `STAGE_UNCONFIRMED` | Final receipt was linked but a subsequent operation failed; details are exactly `{runId,next:"inspect"}` and no success is returned. |

## Task 1: Deterministic selections and GitHub preview/download

**Files:** Create `selection.mjs`, `github-package.mjs`, and `test/skill-acquisition.test.mjs` at paths in the file map. Register exact new package entries and named tests with their owning change.

**Consumes:** `validateSourceRecipe`, `validatePriorLock`, `digest`, `DevctxError`.
**Produces:** `validateSelection`, `validateManifest`, `manifestFingerprint`, `gitBlobSha`, `previewAcquisition`, `downloadAcquisition` and the exact shapes above.

- [ ] Write a synthetic fixture with a root `SKILL.md`, nested `skills/demo/SKILL.md`, `skills/demo/references/guide.md`, `LICENSE`, and an unselected symlink/gitlink. Construct blob IDs from real fixture bytes, not repeated-letter fake blob hashes. Its injected `request` accepts only expected constructed URLs and asserts no auth headers plus manual redirects; preserve `URL.search` so `?recursive=1` is actually tested.
- [ ] Add passing contract assertions and negative tables for every selection rule. Representative assertions:

```js
assert.deepEqual(validateSelection(source, pin, ["LICENSE", "SKILL.md"]).files,
  ["LICENSE", "SKILL.md"]);
assert.throws(() => validateSelection(source, pin, ["A/x", "a/y"]),
  {code: "DEVCTX_SELECTION_CONFLICT"});
assert.throws(() => validateSelection(source, pin, ["../SKILL.md"]),
  {code: "DEVCTX_INVALID_INPUT"});
assert.equal(gitBlobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
```

- [ ] Run `node --test test/skill-acquisition.test.mjs`; expect new exports/tests to fail before implementation.
- [ ] Implement strict validation and the deterministic manifest, then the bounded transport. A preview requests only `GET /git/commits/<pin.commit>` and `GET /git/trees/<commit.tree.sha>?recursive=1`. Require commit `sha` equal the pin, a valid `tree.sha`, tree response `sha` equal the requested tree, `truncated === false`, and bounded array `tree`. Ignore response URL fields. Emit no blob content and make no filesystem writes.
- [ ] Implement download by rebuilding preview with the same shared operation budget, comparing the caller fingerprint before any blob fetch, and then requesting one `GET /git/blobs/<blob SHA>` per selected file in canonical order. Require response SHA/size to equal tree metadata, `encoding === "base64"`, and string content. Accept only base64 alphabet/padding and CR/LF line wrapping; strip only CR/LF, require canonical padded base64 roundtrip, then verify length and hashes. The core byte binding is:

```js
const compact = content.replace(/[\r\n]/g, "");
if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
  throw new DevctxError("UPSTREAM_INVALID", "Invalid GitHub blob encoding");
}
const bytes = Buffer.from(compact, "base64");
if (bytes.toString("base64") !== compact || bytes.length !== expected.size) {
  throw new DevctxError("UPSTREAM_INVALID", "Invalid GitHub blob size or encoding");
}
const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
if (actual !== expected.blob) throw new DevctxError("INTEGRITY", "Git blob hash mismatch");
const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
```

- [ ] Extend local HTTP fixtures for redirects at every endpoint, 404, 401/403/429/5xx, malformed/chunked/compressed/oversized/truncated bodies, slow headers and slow body, invalid UTF-8, request cancellation, empty blob, malformed padding, wrong decoded size and one-byte hash mutation. Exercise independent metadata versus decoded-byte caps, total byte budget and operation deadline; no actual GitHub calls.
- [ ] Add pin immutability tests: only the supplied commit URL appears; tag/ref/latest-release endpoints are never requested. Different ordering of the same selection gives the same fingerprint; changing pin, path, blob, mode or size changes it. Freeze one fixed manifest literal and its independently calculated literal `sha256:` fingerprint as a golden vector. A mismatched fingerprint fetches no blobs. Include unrelated paths containing spaces, plus, at-signs, non-ASCII and unknown/legacy modes, while selected unsupported modes still fail.
- [ ] Run `node --test test/skill-acquisition.test.mjs test/skill-sources.test.mjs`; expect all passing, including unchanged checker observations and budgets. Record evidence; do not auto-commit.

## Task 2: Private exclusive staging and offline integrity inspection

**Files:** Create `src/skill-sources/staging.mjs`, `test/skill-staging.test.mjs`; modify only the additive protected-home list in `src/config/pilot.mjs` and corresponding `test/pilot.test.mjs` cases.

**Consumes:** Task 1 validated manifests and verified byte buffers; `assertWritable`, `isWithin`, `info`, `checkNode`, `writeNewFile`, `readPrivateBytes`, `fsyncDir`, `digest`.
**Produces:** `stageAcquisition`, `inspectAcquisition`, completion receipt and StageResult.

Private layout is fixed; no caller destination or run ID is accepted for stage:

```text
dataRoot/skill-sources/staging/stage_<32 lowercase hex>/
  files/<exact selected repository-relative paths>
  .receipt-pending                         # exists only during publication/interruption
  receipt.json
```

The run ID is `stage_` plus `runIdBytes().toString("hex")`; the library-only hook must return a Buffer of exactly 16 bytes, otherwise `INVALID_INPUT` before networking. It defaults to cryptographic randomness; the CLI never supplies it. Inspect accepts exactly `/^stage_[0-9a-f]{32}$/`. `receipt.json` is bounded to 64 KiB with exact keys `{schemaVersion:1, kind:"skill-source-stage", runId, createdAt, pilotDigest, manifest, fingerprint, files, assessment, receiptHash}`. `createdAt` is a canonical valid ISO UTC instant, `pilotDigest` is the loaded pilot digest, `files` is the StageResult list, and `receiptHash` is `digest` of all other fields. A pilot digest mismatch is `GATE_REQUIRED` with `{field:"pilotDigest"}`, not an accusation of content tampering. This completion receipt, rather than a mutable status field or directory existence, is the commit marker.

Inspect first applies node safety checks, then this state table. The temporary two-link receipt state is inspected with explicit lstat checks before using `readPrivateBytes`, whose ordinary one-link rule still applies to all payloads and completed receipts. Neither inspect nor retry repairs any state.

| On-disk state | Result |
| --- | --- |
| Missing container or run directory | `STAGE_NOT_FOUND` |
| Run present without final receipt, with or without pending file | `STAGE_INCOMPLETE` |
| Final receipt has nlink 2 and pending is its same device/inode, with no unsafe nodes | `STAGE_INCOMPLETE` |
| Final receipt has nlink 1, no pending, and all validation succeeds | `staged` |
| Malformed/oversized receipt, unknown keys, hash mismatch, payload mismatch or extra entry | `INTEGRITY` |
| Pending is a different inode alongside a one-link final receipt | `INTEGRITY` |
| Any symlink, wrong ownership/permissions, nonregular file, or unexplained hardlink | `PATH_UNSAFE` |

Tiered trust rules apply at the start and each revalidation:

1. Above `pilotRoot`, through its parent: lstat must show real directories, owned by uid 0 or the caller. Group/other-writable ancestors require the sticky bit (`0o1000`). Reject other owners and non-sticky writable ancestors. Preserve canonical/symlink checks; do not require private modes or pin system ancestor identities.
2. `pilotRoot` must already exist, be a real caller-owned directory and have no `0o022` bits; 0755 is accepted. Capture its device/inode once per invocation and require the same identity thereafter. This is the trust anchor.
3. Strictly between pilotRoot and dataRoot: every directory must already exist, be real, caller-owned and have no `0o022` bits. Pin every device/inode. Acquisition never creates these intermediates.
4. dataRoot and acquisition containers must be caller-owned private 0700 directories when existing; single nonrecursive mkdir at 0700 may create a missing dataRoot itself or containers. Pin device/inode and never chmod. Run and payload directories follow the exclusive ownership rules below. Inspect applies all tiers read-only; missing containers return `STAGE_NOT_FOUND`.

- [ ] Write tests using `makePilot` and fixture bytes that assert all output directories are owner-private 0700, all files/receipt 0600, source-relative uppercase paths remain intact, original executable mode is metadata only, receipt and blobs rehash correctly, and two runs do not reuse paths. Snapshot config/state/inputs/repos/agentHomes/forbidden trees before and after: they must match even when download or writing fails.
- [ ] Write fault tests before implementation; run `node --test test/skill-staging.test.mjs test/pilot.test.mjs` and expect new acquisition tests to fail.
- [ ] Add `.gemini`, `.cursor`, `.commandcode` to `protectedPaths()` alongside existing default agent homes. This intentionally strengthens every pilot-gated route: a dataRoot-only guard cannot recognize an unlisted live discovery home, so the additive known-home guard belongs in this slice. Test fake-home paths, Darwin case aliases and existing valid pilots. Do not probe executables or infer custom configuration. Unknown custom discovery roots must appear in `pilot.forbidden`; only existing Claude/Codex environment overrides and known defaults are automatic.
- [ ] Implement a private acquisition guard that calls `assertWritable(roots, destinations)`, additionally requires every destination within dataRoot, and enforces the four trust tiers above before/after download and before each mutation. Never chmod. Use `join()` only after validation and containment checks; leave lowercase-only shared `safeJoin()` unchanged. Add tests for pilotRoot 0775, group-writable intermediate, caller-owned sticky 1777 ancestor (accepted), non-sticky 0777 ancestor (refused), and existing dataRoot 0755 (refused without chmod). Normal pilots exercise root-owned system ancestors.
- [ ] Wrap every filesystem/helper call in staging.mjs: rethrow DevctxError with its code and a fixed safe message but replace details with `{field}` or validated run-relative `{rel}`; map raw errno/errors to `STORAGE_ERROR` with `{operation}` from `inspect`, `mkdir`, `read`, `write`, `link`, `unlink-pending`, `fsync`. Never pass through `details.path` or raw exception messages. After final receipt publication, use `STAGE_UNCONFIRMED` with `{runId,next:"inspect"}` for failure. Serialize errors from the entire fault matrix and assert no sandbox path, fakeHome path or injected raw error text appears.
- [ ] Download and verify all selected bytes in bounded memory before making any directory. Only dataRoot itself and its descendants may be created; its parent/intermediates must already satisfy the trust tiers. Ensure private shared `skill-sources` and `staging` containers one component at a time; concurrent creation of a shared container may accept EEXIST only after the full existing-private-node checks. Create the new run with nonrecursive `mkdir` mode 0700; EEXIST is `CONFLICT`, even for an empty matching directory. Capture its device/inode; validate that identity and its entire parent chain before every subsequent mutation. No retry by adopting that directory.
- [ ] Create `files` and needed selected ancestor directories exclusively inside this new run. Maintain an in-memory map of directories created by this invocation and their device/inode values, so shared selected ancestors can be reused only if that exact node is still present. Reject unexpected existing entries, symlinks, hardlinks, FIFO/device nodes, path-role/case collisions or changed ancestors. Write payload files with `writeNewFile`, then private-read and rehash them before completion. Do not use `atomicReplace`, `ensureRoots`, `writeRunReceipt`, or the installer; they offer broader writes or adopt existing containers/runs.
- [ ] Fsync payload directories from leaves upward. Write and fsync the complete receipt bytes exclusively to `.receipt-pending` with `writeNewFile`; record that pending file's device/inode. Publish with `linkSync(pending, receipt.json)`, whose EEXIST is `CONFLICT` and never overwrites. Fsync the run; revalidate parents and invocation-owned pending inode, unlink only that pending path, fsync run again and staging parent, then inspect before success. Node has no inode-conditional unlink: the check/unlink window remains a same-user race, and this is not perfect foreign-replacement protection. Never unlink/roll back the final receipt. Before-link failure leaves an incomplete run; after-link failure returns `STAGE_UNCONFIRMED` with the run ID and inspect instruction, without success output. A later inspection determines the truth, with no automatic recovery.
- [ ] Implement read-only inspection using the state table: revalidate all trust tiers and run identity, perform bounded no-follow reads, reject unknown keys/types, verify receiptHash/run ID/catalog/pin/manifest/fingerprint/file list and pilotDigest (mismatch is GATE_REQUIRED), enumerate only the bounded run tree, reject extra entries and unsafe nodes, verify payload Git SHA/SHA-256/length/ownership/mode/nlink. Enumeration cap `24 * 16 + 3` covers at most 360 selected ancestor directories + 24 payloads + `files/` + final receipt + pending receipt. No recursion beyond selected depth plus fixed layout. Recheck receipt/run/ancestor identities before returning. No network, writes, repair or raw file output.
- [ ] Exercise library-only `faults.afterRunCreated`, `faults.afterFileWritten({index})`, `faults.beforeReceipt`, `faults.afterReceiptLinked`, and `faults.afterReceipt` (after pending unlink) callbacks. Inject throws, failed writes/fsyncs, parent replacement and receipt replacement. Before-link failure yields no final receipt; after-link failure returns runId and later inspect returns incomplete for the matching two-link pending state, or staged after pending unlink if intact. Truncated pending alone is incomplete; truncated final receipt is integrity failure. No partial success means no success output, not absence of the final receipt after publication.
- [ ] Include two calls with fixed `runIdBytes: () => Buffer.alloc(16, 7)` to force a collision, empty foreign run, receipt-only spoof, changed pin/digest, case-only rename, changed permissions, hardlinked payload, truncated receipt, extra payload, parent symlink and forbidden-root overlap. Second call downloads before discovering its collision; assert requests happened before the conflict, no requests afterward, zero writes to the existing run and an identical tree snapshot. Concurrent independent stages produce distinct runs. Invalid RNG return type/length fails before requests; CLI stage rejects `--run`.
- [ ] Run `node --test test/skill-staging.test.mjs test/pilot.test.mjs test/fsx.test.mjs test/skill-install.test.mjs`; expect pass and unchanged old installation boundaries. Record evidence; do not auto-commit.

## Task 3: Explicit CLI and documented end-to-end evidence

**Files:** Create `src/skill-sources/acquisition-commands.mjs`; modify `src/cli.mjs`, the new test files, `test/pilot.test.mjs`, `test/required-tests.json`, exact package entries, and the five docs from the file map.

**Consumes:** Preview/download/stage/inspect interfaces above, bundled source lookup, existing JSON envelope.
**Produces:** Exactly these commands:

```text
devctx skill-sources preview --source <catalog-id> --pin-json <object> --files-json <array>
devctx skill-sources stage --pilot <pilot-file> --source <catalog-id> --pin-json <object> --files-json <array> --preview-hash <sha256:fingerprint>
devctx skill-sources inspect --pilot <pilot-file> --run <stage-id>
```

`preview` is `rootFree:true, rootOptions:false`. Stage and inspect remain pilot-bound but also use `rootOptions:false`; declare their one allowed `pilot` string option locally. This retains the existing missing-pilot gate and enables the existing duplicate-option rejection without admitting config/data/state override flags. Extend request injection only to `skill-sources preview` and `skill-sources stage` alongside existing check; inspect has no request capability. Do not make any existing route root-free.

Inline pin JSON is at most 1024 UTF-8 bytes; files JSON at most 8192 bytes. Check byte caps before parsing. Require all flags exactly once with correct types; `--preview-hash` is exactly `sha256:` plus 64 lowercase hex. All library semantic checks still run. CLI output uses the existing success/error envelope, exit 0 on complete success, exit 2 for usage and exit 1 otherwise. Errors never echo upstream content, response headers, tokens, raw errors or absolute private paths.

- [ ] Write CLI tests through `main(args, {request, stdout, home, env})` with local transport and disposable pilot. Assert preview reads metadata only and writes nothing, stage downloads exact files into a new run, inspect works with a request function that throws on invocation, and old catalog/check behavior remains unchanged. Missing pilot must fail before networking.
- [ ] Run new tests failing first, then implement route objects and registrations. Route option code follows this exact shape:

```js
const selectionOptions = {
  source: {type: "string"}, "pin-json": {type: "string"},
  "files-json": {type: "string"}
};
// preview options: selectionOptions
// stage options:
const stageOptions = {
  ...selectionOptions, pilot: {type: "string"}, "preview-hash": {type: "string"}
};
// inspect options:
const inspectOptions = {pilot: {type: "string"}, run: {type: "string"}};
```

- [ ] Cover `--flag=value`, duplicate flags, unknown flags, malformed/oversized JSON, empty selection, wrong source/pin, missing fingerprint, all forbidden root flags, and unknown run. Confirm rejected input causes zero requests/writes. Existing `skill discover`, all skill-builder and installer gates still require pilot.
- [ ] Add these exact required test names: `skill acquisition rejects ambiguous selections before requests`; `skill acquisition verifies pinned blob bytes with bounded local transport`; `skill staging writes only private dataRoot and completes receipt last`; `skill staging inspection refuses incomplete and changed runs`; `skill acquisition CLI preserves old gates and explicit selection`.
- [ ] Update docs with an end-to-end synthetic example, explicit license selection, private receipts and unverified assessment. The tag is a caller-copied label: advise copying fields from one's own fresh check, disclose unverified tag binding/repository history and fork-network objects, and do not add tag resolution. Document trust tiers, pending/final receipt states, offline inspect, manual disposal, pilotDigest changes (even a new forbidden path) invalidating the old gate, and unknown custom-home limitations.
- [ ] Document quota arithmetic: check uses at most 8 anonymous requests, preview 2, stage 2+N (26 at 24 files), so the full maximum is 36; GitHub's usual 60/hour/IP anonymous quota can make a repeated large stage rate-limited. Preserve bounded `retryAfterSeconds`/`resetAt` hints and state that rate limits during download leave no writes. No auth fallback. Document caps as intentional: data-heavy skills and large repositories may return LIMIT without fallback. Taste has no acquisition route while it has no stable release observation; no branch policy is invented. Keep dependency discovery, native host packages, adapters/updaters, export, installation and automation as later milestones.
- [ ] Run `node scripts/run-tests.mjs`; expect `ok:true`, zero failures and all required names passed. Run `node scripts/acceptance.mjs`; expect the existing synthetic acceptance gates unchanged. Run `node scripts/check-package.mjs`; expect `ok:true` with dry-run packing. Run `git diff --check`; expect no whitespace errors. All fixture network remains local. Record actual counts, never extrapolate from baseline counts.
- [ ] Ask the coordinator for independent Claude actual-diff review with the exact changed files, test outputs and boundary/fault evidence. Fix material findings and obtain focused re-review before reporting implementation complete. No local commit or publication is implied.

## Planning and review gates

- [x] Read catalog research, roadmap, existing resolver, CLI, pilot, private storage and fixture APIs.
- [x] Define bounded deliverable, exact interfaces, ownership, caps, typed errors, privacy boundaries and regression/fault tests.
- [x] Independent Claude plan review completed; conditional findings resolved and focused coordinator paragraph re-check passed.
- [x] Coordinator authorizes the implementation file ownership above.
- [x] Implementation and fixture verification completed: 185 tests across 26 files, 23 synthetic acceptance checks, package audit and whitespace checks passed. Acceptance requires `--pilot-root` naming a new disposable directory and `--report` outside the checkout.
- [ ] Independent Claude actual-diff review completed and material findings resolved.

Review provenance and actual test evidence belong in the coordinator's private artifact, with only public-safe status recorded here. Until both implementation checkboxes pass, this document describes a plan and makes no capability claim.
