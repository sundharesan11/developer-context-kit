# Storage

Configuration, data and state are separate private roots inside a pilot. A registry snapshot is the only project visibility switch. Records and manifests are immutable; successors supersede earlier records. Locks are never broken automatically, and orphan staging remains for explicit repair. New private files use mode 0600 and private directories use 0700.

Private skill workspaces live under `dataRoot/personal/skill-workspaces/<workspace-id>`, `dataRoot/scopes/<scope>/skill-workspaces/<workspace-id>`, or `dataRoot/scopes/<scope>/projects/<project>/skill-workspaces/<workspace-id>`. Each scope is checked before use. Requirements, designs, approval decisions, draft revisions and validation receipts are immutable files. Drafts are staged before directory publication; incomplete staging is reported and kept for manual repair. The builder uses `stateRoot/locks/skill-builder.lock`. B can copy an approved personal revision only to named disposable pilot agent homes, using `stateRoot/locks/install.lock` and a v2 ownership receipt.

Local-install approval consumption is recorded under `stateRoot/skill-installs/consumed/<workspace>/<decision-id>.json`. Each apply uses a unique `stateRoot/runs/<run-id>/journal.json` with intended and completed actions. Incomplete journals are reported without automatic repair. A manually reconciled journal moves to `runs/<run-id>/reviewed/journal.json`; consumed decisions remain consumed.

Third-party acquisition is separate. It writes exclusively beneath `dataRoot/skill-sources/staging/stage_<32 lowercase hex>/`: exact selected source paths under `files/`, plus `receipt.json`. It never writes agent homes, configRoot or stateRoot. Directories are 0700 and all staged files are 0600, even if the original Git mode was executable. Receipts preserve the caller pin, selection, tree/blob IDs, original modes, sizes, SHA-256 values, preview fingerprint and pilot digest. They attest to selected bytes, not dependency completeness or installation.

All downloads verify before directory creation. Run directories and files are exclusive and never adopted or overwritten. The complete receipt is written/fsynced as `.receipt-pending`, exclusively linked to `receipt.json`, then the temporary link is removed and directories are fsynced. No final receipt is ever deleted on failure. `STAGE_UNCONFIRMED` includes a run ID and `next:"inspect"`; inspect may establish a completed stage after an interrupted success response.

The dataRoot filesystem must support hard links. Unsupported link creation fails safely with `STORAGE_ERROR`, preserves the pending receipt, and inspection reports `STAGE_INCOMPLETE`; there is no replacement or copy fallback. Failures before publication currently omit the run ID, so incomplete directories may need to be found by listing the private staging parent manually.

| Inspection state | Result |
| --- | --- |
| No container/run | `STAGE_NOT_FOUND` |
| No final receipt, including a partial pending file | `STAGE_INCOMPLETE` |
| Final and pending are two links to the same inode | `STAGE_INCOMPLETE` |
| One-link final receipt, no pending, exact files/hashes/modes verify | `staged` |
| Corrupt receipt, changed/missing/extra files or a different pending inode | `INTEGRITY` |
| Unsafe permissions, symlinks or unexplained hardlinks | `PATH_UNSAFE` |

Inspection makes no network calls or repairs. Retry always creates a fresh run. Keep incomplete runs for manual review; disposable pilot disposal is an explicit user action. Editing the pilot, including its forbidden paths, changes its digest and makes old receipts return `GATE_REQUIRED` for `pilotDigest`; this is a changed inspection gate, not proof of tampering.

Source installation keeps write-once content and action records at `dataRoot/skill-sources/decisions/<decision-id>.json`. Records bind the pilot digest, interaction/response and canonical record hash. Content records retain the entire normalized mapping, required/legal files, dependencies, compatibility, stage/blob/hash provenance and disclosures. Content decisions remain reusable; no source approval is derived from personal A/B decisions.

Single-use action consumption lives at `stateRoot/skill-source-installs/consumed/<decision-id>.json`. Source apply shares `stateRoot/locks/install.lock` and writes `runs/<run-id>/journal.json` with kind `skill-source-local`, decision/content IDs, fingerprint, target home and intended/completed actions. Both package adapters reject incomplete shared journals. No history, stage, decision or partial target is pruned automatically.

Source `.devctx-owned.json` uses schema 3 and kind `skill-source-package`, with skill/source/repository/pin/stage identity, acquisition fingerprint, package/mapping digests, content decision, file hashes and run ID. It cannot adopt a bundled/personal marker. Output bytes are upstream bytes; the ownership marker is toolkit metadata. Source files, including helpers, are exactly 0600 and directories exactly 0700. Added owner-execute or special bits mark an installed source modified.

Apply consumes approval before journal creation. A failure in between leaves a consumed decision with no target writes; status shows consumption. Failures after journal creation retain recovery evidence and block later package applies to that home. Before ownership publication, the shared executor verifies output hashes and the exact file/directory inventory. Multi-host completion is journaled incrementally; success on one host does not hide a failed second host.

Clean-version restoration uses retained staging/content evidence and a new action approval. Interrupted writes require manual review, not automatic rollback. Removal needs the intact current decision and installed receipt/hashes but can proceed after staging loss. Source homes must be canonical paths; existing personal journal matching remains raw-string based, with broader personal canonicalization left separate.

## Portable handoff files

Private handoff exports live only at `dataRoot/exports/handoffs/<scope>/<project>/<name>.handoff.md`, in 0700 directories with exclusive 0600 files. They are not record mutations or publication receipts. Preflight holds leave no packet; interrupted writes may retain incomplete files, never overwritten or automatically deleted. Discard invalid-footer artifacts from use and preserve evidence for manual inspection. See [HANDOFF.md](HANDOFF.md) for the selected-record and digest contracts.
