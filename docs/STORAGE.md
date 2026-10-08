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
