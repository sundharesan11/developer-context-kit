# Private portable handoff

`handoff export` produces a readable Markdown packet from explicitly selected records in one committed pilot project. A recipient needs no toolkit installation. This is a private preview, not approved for publication; human confidentiality and rights review is required before distribution. Commands in the packet are documented, not executed. Export does not verify application tests, credentials, runtime access or deployment.

Use an existing disposable pilot and the exact selected worktree. Set the variables to your own pilot paths and selected record IDs:

```sh
node bin/devctx.mjs handoff export --pilot "$PILOT_FILE" \
  --scope acme --cwd "$ATLAS_REPO" \
  --record "$FACT_RECORD_ID" --record "$HANDOFF_RECORD_ID" \
  --as-of 2026-10-09T00:00:00.000Z \
  --out "$PILOT_DATA_ROOT/exports/handoffs/acme/acme.atlas/packet.handoff.md"
```

There is no default selection, `--all`, brief import or root override. Missing, duplicate, proposed, superseded and other-project selections hold the export. Nothing selects a successor automatically. Multiple `--record` flags are allowed; duplicate singleton flags are rejected. Corruption anywhere in the project snapshot holds the export because it could hide supersession.

The destination must be a new file directly inside `dataRoot/exports/handoffs/<scope>/<project>/`. Its basename is 1–64 lowercase ASCII letters, digits, dots, underscores or hyphens, starting with a letter or digit, followed by `.handoff.md`. All existing export directories and dataRoot must be private 0700 directories; output is 0600. The fence continues to refuse protected homes and toolkit paths. Existing files, aliases, noncanonical paths, foreign or unsafe directory modes and alternate roots are refused without automatic repair or overwrite. Exported packets are rejected by the package audit even if mistakenly allowlisted.

Limits are 12 selected records and **32,768 UTF-8 bytes for the complete final packet**, including metadata and footer. Overflow fails with `DEVCTX_LIMIT` before creating export directories or a file. There is no truncation or budget-based omission of selected evidence.

## Evidence and exclusions

Each selected record retains its full ID, original record/body hashes, kind, status, effective status, title, body, creation/revisit dates, actor enum and run ID. Confirmed means an owner workflow receipt, not authentication. Reviewer presence and confirmation receipt are visible; reviewer and user-reference identities are withheld. User provenance appears as a presence-only marker. Branch/commit applicability is retained; environment/task/worktree metadata, verification payloads and review notes are excluded. Worktree applicability mismatches still appear as a freshness label.

Preferences, the personal profile, policies, binding paths/remotes and unselected title/body/source/actor data never enter the packet. The exporter does not call `buildBrief`. Project-scoped exclusion counts distinguish unselected effective, proposed, superseded and hidden uncommitted records. Unknown/disputed counts are labeled subsets of unselected effective records. The proposed count covers records only: private proposal files are uninspected and uncounted, so zero is not evidence that no proposals are pending.

Selected unknowns and disputes are indexed with their titles and IDs and retain their bodies. When none is selected, the packet says that explicitly; it does not claim none exists. Application tests and deployment state remain unknown to the exporter. Results stated by a selected record remain attributed claims.

## Holds and source portability

Unsafe selected text holds the whole packet; it is never rewritten or silently redacted. Credential-pattern hits return `DEVCTX_SENSITIVE_CONTENT`; nonportable text or malformed metadata returns `DEVCTX_HANDOFF_UNSAFE`. Selected body/title strings containing personal account refs or email-shaped text hold. Structured user/reviewer identities are explicitly excluded instead. File, commit, record and issue provenance can be retained. Unrecognized source metadata is excluded after its text is scanned.

This first version conservatively holds URL sources and URL-bearing text, home/Windows paths, remote aliases, control characters, CR and non-LF line separators. All leading-slash tokens hold, including API route literals and HTML closing tags preceded by `<`; internal slashes such as `and/or` are permitted. Ordinary `Next action: review`, `Blockers: none`, `sha256:abc`, `commit:abc` and relative `file:README.md` prose remain allowed. Bodies are inert fenced text, not active Markdown links or HTML. Pattern checks are tripwires, not a confidentiality guarantee; encoded sensitive information and arbitrary confidential prose still require human review.

New onboarding profiles use the project ID for the repository field. Historical records are unchanged. Selecting an older profile with an absolute path holds; it is not silently cleaned or retired. Duplicate historical profiles still need an explicit selection decision.

## Time and freshness

`--as-of` is required and must round-trip as a UTC ISO timestamp with milliseconds. It is an evaluation clock for review dates, not a historical snapshot or a wall-clock export time. The command reads present Git/source state. Equal selected evidence, scoped exclusions, observations and as-of values produce identical bytes regardless of selection order or output filename.

The header describes the **exporting worktree** revision, branch and dirty state. Freshness compares file sources against the exporting worktree only, never the first binding root or another original repository. A source revision is recorder-stated and not verified by export. For a documentation-only snapshot, cite snapshot file hashes; identify original application evidence separately in reviewed prose. A snapshot commit is not the application commit.

File observations show recorded and currently observed SHA-256 values and `current`, `needs-revalidation`, `source-missing`, `unbound-source` or `unverified-source`. Only explicitly approved file paths are read. No file sources means `not-file-verified`. Other labels include records later than as-of, branch/revision/worktree mismatch and `stale-by-date`. A date-only revisit value becomes due at UTC midnight; equality is due. Labels do not change original status.

A commit does not identify dirty bytes. Source hashes cover only named observed files, not the complete worktree. A clean tree does not show that tests ran. Branch/revision may be unknown. The exporter rebuilds the packet immediately before publication and refuses a changed result; this catches ordinary drift, not a malicious same-user race.

## Hash verification and interrupted writes

`recordHash` is an opaque reference to local metadata the recipient cannot reconstruct. `bodyHash` is recipient-verifiable. Bodies are emitted as an opening dynamic tilde fence with `text`, LF, exact body bytes, one separator LF, closing fence and LF. Recover the body by removing the fence lines and **exactly one separator LF** immediately before the closing fence. Preserve all additional trailing LFs. Compare SHA-256, `bodyBytes`, and the printed ending-LF flag. CR, NEL, line separator and paragraph separator characters hold instead of being normalized.

The final footer is exactly a separator LF, `Packet SHA-256 (all preceding bytes): sha256:<64 hex characters>`, and a final LF. Remove that complete footer including its initial separator LF; hash the remaining UTF-8 bytes to verify `packetHash`. The CLI also returns `fileHash`, the SHA-256 of the entire final file including its footer, plus byte count and a dataRoot-relative output path. Neither hash is a signature or sharing approval.

Writes are exclusive but non-atomic. Preflight failures create no packet. An I/O interruption can leave an incomplete private final file; retries never overwrite it. A missing or invalid footer means the artifact must be discarded from use, never consumed or shared. Preserve local evidence for manual inspection; there is no automatic deletion or rollback. The existing same-user filesystem residual race remains.

Before relying on the packet, independently check repository identity/instructions and revision, review unknowns and stale evidence, inspect documented commands, and rerun appropriate checks under the recipient's authority. A successful export proves neither application readiness nor agent discovery.
