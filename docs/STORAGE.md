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

Source `.devtwin-owned.json` uses schema 3 and kind `skill-source-package`, with skill/source/repository/pin/stage identity, acquisition fingerprint, package/mapping digests, content decision, file hashes and run ID. It cannot adopt a bundled/personal marker. Output bytes are upstream bytes; the ownership marker is toolkit metadata. Source files, including helpers, are exactly 0600 and directories exactly 0700. Added owner-execute or special bits mark an installed source modified.

Apply consumes approval before journal creation. A failure in between leaves a consumed decision with no target writes; status shows consumption. Failures after journal creation retain recovery evidence and block later package applies to that home. Before ownership publication, the shared executor verifies output hashes and the exact file/directory inventory. Multi-host completion is journaled incrementally; success on one host does not hide a failed second host.

Clean-version restoration uses retained staging/content evidence and a new action approval. Interrupted writes require manual review, not automatic rollback. Removal needs the intact current decision and installed receipt/hashes but can proceed after staging loss. Source homes must be canonical paths; existing personal journal matching remains raw-string based, with broader personal canonicalization left separate.

## Record trust rules

Records are immutable, and a record ID is derived from its scope, project and request ID. On every read the store recomputes that ID and rejects a record whose stored ID does not match.

- **Request IDs are the idempotency key.** A caller chooses the request ID. Repeating the same request returns the existing record; reusing the ID with different content fails with `CONFLICT`.
- **Operation IDs are not caller input.** Public record APIs (`addRecord`, `commitBundle`, `supersedeRecord`, `proposeRecord` and `publishProposal`, behind the `record` commands) refuse an `operationId`. Only onboarding stamps one, through its internal commit path.
- **An operation claim must be vouched for.** A record that names a published operation is trusted only when that operation's manifest lists the record with the same record hash. A record that claims an unpublished operation is hidden as uncommitted.
- **Supersession must be well formed.** `supersedes` must be a list of distinct record IDs that does not include the record itself, and no cycle may exist among present records.

`readSnapshot` reports a record that breaks any of these rules as corrupt with `INTEGRITY` instead of trusting it. Corrupt records are left out of briefs and supersession.

### Reviewing a corrupt record

1. Run `doctor`. Its `bundles` check fails with a count of corrupt records.
2. `handoff export` for that project fails with `INTEGRITY` and names the corrupt record IDs.
3. Inspect `dataRoot/scopes/<scope>/projects/<project>/records/<record-id>/` locally. Keep the files; do not edit, rename or delete them, and do not paste their content into a public issue.
4. Decide with the owner what happened. The CLI has no repair or quarantine command, and `record supersede` cannot supersede a corrupt record.

### Record schema v2

New records use schema 2. Readers accept schema 1 and 2, and a schema 1 record is never rewritten.

- **Kinds.** Schema 2 adds the kinds `lesson` and `preference`.
- **Class.** `class` is `fact` or `lesson`. A fact stays in its project. A `lesson` record always has class `lesson`.
- **Reach.** The top-level `reach` is `personal`, `project` or `org`. A fact has project reach, and a preference never has project reach. The project store accepts project reach only. `applicability.level` keeps its schema 1 values.
- **Match.** `match` holds `paths`, `packages` and `topics`, at most 20, 20 and 10 distinct entries. Paths are repo-relative globs that use `*`, `?` and `**`. They follow the `file:` source rules: no absolute path, no `..` and no denied file such as `.env*` or `*.pem`.

### Personal and org homes

Personal and org records have their own homes. They need no registry entry or project binding. These homes are library functions in `src/records/personal.mjs`. `lesson accept` with a general target and `lesson copy` read or write the personal home. No CLI command writes to the org home: the hub copy of a lesson is the organization's copy.

- **Personal.** `dataRoot/personal/records/<record-id>/` holds records with `personal` reach and the kinds `lesson` and `preference`. Writes use `stateRoot/locks/personal_records.lock`.
- **Org.** `dataRoot/scopes/<scope>/org/records/<record-id>/` holds `lesson` records with `org` reach for a scope that exists. Writes use the scope lock.
- **Integrity.** Each home uses the project store's bundle rules. The reader recomputes the record ID from the home and request ID, and checks the reach, kind, body hash and body size. A record that fails is reported as corrupt. Writes are staged, fsynced and renamed into place. Supersession names each target with its expected record hash.
- **Wrong reach.** Each home refuses a draft whose reach or kind does not belong there. The project store refuses any reach other than `project`.

### Lesson proposals

`lesson propose` writes one private file per proposal at `dataRoot/lesson-proposals/<prop_id>.json`. The folder is 0700 and each file is 0600. Writes use `stateRoot/locks/lesson_proposals.lock`.

- **Content.** A proposal holds the session ID, the scope, the project or `null`, the lesson (title, do or don't line, body and `match` block), its `state` and its `review`. A new proposal has the state `pending` and the review `unreviewed`.
- **ID.** The proposal ID is `prop_` and a digest of the session ID, scope, project and lesson. The same draft in the same session is one proposal.
- **Cap.** One session ID has at most three proposals. Rejected and accepted proposals still count.
- **Changes.** `lesson edit` replaces the file by atomic replace with a new `revision`. `lesson reject` and `lesson accept` set the state to `rejected` or `accepted` and keep the file. Accept records what it wrote in `outcome`.
- **Replacement.** A proposal from `lesson supersede-propose` also holds `supersedes`: the replaced hub lesson's ID, the SHA-256 of its hub file, its title, its author and the hub ID. The ID digest then covers it too. An accept that fails with `STALE_VERSION` keeps the proposal pending and writes the error code and reason to `lastAttempt`.
- **Machine only.** No command sends a proposal to a hub or another machine. Only `lesson accept` publishes a lesson, and only under a valid `hub-publish` consent.
- **Notes cache.** `hub sync` keeps the hub's active "working on" notes in `stateRoot/hubs/<hubId>/notes.json` (0600), written by atomic replace under the `hub-sync` lock. The hook reads it to report colleagues' notes; `hub leave` deletes it.
- **Tombstone memory.** `hub sync` and `published delete` keep the IDs of hub lessons whose valid tombstone this machine has seen in `stateRoot/hubs/<hubId>/tombstones.json` (0600), written by atomic replace under the `hub-sync` lock. The index and the hook leave those lessons out. The file holds at most 5000 entries; the oldest go first. A damaged file gives no hub lessons until the next sync writes it again. `hub leave` keeps it.
- **Notices.** `hub sync` keeps replacements of your own hub lessons in `stateRoot/hubs/<hubId>/notices.json` (0600), written by atomic replace under the `hub-sync` lock. An acknowledged notice keeps its entry with `ackedAt`, so the next sync does not add it again. The file holds at most 200 entries; the oldest acknowledged entries go first.

### Preferences and output templates

- **Preference proposals.** `pref propose` writes one private file per proposal at `dataRoot/pref-proposals/<pref_id>.json` (0600), under `stateRoot/locks/pref_proposals.lock`. The ID is `pref_` and a digest of the session ID and the preference key. The key is a digest of the text without case or spacing differences. `pref decline` and `pref accept` keep the file with the state `declined` or `accepted`, so the same text is refused later.
- **Preferences.** `pref accept` writes a `preference` record with personal reach to the personal store. `pref retire` adds the record ID to `dataRoot/pref-retired.json` (0600), and the instruction block leaves it out. The record stays. Setup sandbox records (request IDs that start with `req_setup_sandbox_`) hold advice for one repository and are never in the block.
- **Radar.** `stack digest --apply` also writes the listed items of that digest to `stateRoot/radar/items/none.json` or `stateRoot/radar/items/scopes/<scope>.json` (0600): the item ID, catalog name, kind, date and links, with no feed text. `radar guide --apply` writes `dataRoot/[scopes/<scope>/]guides/radar/guide-<item>.md` (0600) once. The advisory job keeps its alert memory in `stateRoot/radar/alerts.json`: the advisory keys already shown and the alert count of each day in the last week.
- **Schedules.** `schedule apply` and `schedule off` record each job's flag in `stateRoot/schedule/jobs.json`. Each run writes `stateRoot/schedule/receipts/<job>.json` with the last run time, the last attempt time and the result. The plists are `devtwin.<job>.plist` in an approved `launchAgents` path.
- **Output templates.** `template from` writes `dataRoot/templates/outputs/<kind>.<md|html>.json` (0600) by atomic replace. It holds the heading levels and texts, the SHA-256 of the source file and the time. It holds no other text of the source. The starters are in the kit at `templates/outputs/`.

### Isolation checks

`src/records/isolation.mjs` holds the checks for text that leaves a scope or comes from another person.

- **Outbound.** Text is checked for credential patterns, then for the names of every scope in the config. The names are the scope ID, the display name, each project ID, each binding root path and each remote host. A name matches only as a whole word, in any case. `github.com`, `gitlab.com`, `bitbucket.org` and any host found in two or more scopes are left out. A personal record is checked against every scope. An org record is checked against every other scope. A match fails with `ISOLATION`.
- **Lessons.** `lesson propose`, `lesson edit` and `lesson accept` check the lesson against every scope but its own. A general target is also checked against its own scope. `lesson copy` checks against every scope but the target.
- **Hub proposals.** A hub proposal keeps its own project check as a plain substring match. It is then checked against every other scope.
- **Inbound.** Another person's text has control, format and bidi characters removed. Its body is capped at 2,400 bytes, about 600 tokens. It is then fenced and labelled as claimed by the author's handle.

### Lesson match index

`lesson index --scope <scope>` builds one index file per scope at `stateRoot/lessons/<scope>.json`. The folder is 0700 and the file is 0600. The file is written by atomic replace under `stateRoot/locks/lessons_<scope>.lock`.

- **Sources.** The index reads the scope's project records, its org records, the personal store and the hub clone of a joined scope. It keeps only lessons and preferences that have a `match` block and an effective status of `observed` or `confirmed`. Superseded, proposed and disputed records are left out.
- **Entries.** Each entry holds the record ID, reach, scope, project, title, a one-line summary, the claimed author, the revisit date, the `match` block and the record hash.
- **Path map.** The index also maps each bound root to its scope and project, with the root's Git common directory. A linked worktree resolves to its parent project through that directory.
- **Fingerprint.** The `fingerprint` is the digest of the rest of the file. A rebuild writes only when the fingerprint changes, so the same records always give the same bytes.
- **Cache write.** The file is a cache of record data that a rebuild can replace at any time. For this reason, `lesson index` writes it with no preview and no plan fingerprint. It writes nothing outside `stateRoot`.

Globs match one path segment per `/`. `*` matches any run of characters in a segment and `?` matches one character. A `**` segment matches zero or more segments. A wildcard does not match a leading dot, so a dotfile matches only a pattern that starts with a literal dot. A path with `..` never matches.

### Agent hook state

The hook keeps its state in `stateRoot/hooks/`. The folders are 0700 and the files are 0600.

- **Receipt.** `hooks/kit-receipt.json` holds `schemaVersion` 1, `pilotPath` (the real path), `pilotSha256` (the SHA-256 of the pilot file bytes), `kitRoot`, `kitCommit` (null for a disposable pilot), `verifiedAt` and `ttlSeconds`. `hook verify` writes it by atomic replace with a TTL of seven days. The hook refuses a receipt that is older than its TTL, names another pilot path or another pilot file, or names another kit. In live mode the hook also reads the kit's `.git/HEAD` and compares it with `kitCommit`.
- **Sessions.** `hooks/sessions/<key>.json` holds the lesson IDs sent in one agent session, the count of index lines and whether the overflow line went out. The key is the SHA-256 of the agent name and the session ID. Each write is an atomic replace with no lock. Compaction removes the file. `hooks/sessions/<key>.notes.json` holds the session's note count, the areas it handled and the colleague notes it reported; compaction keeps it, so the six-note cap holds for the whole session. Session start removes session files older than 14 days and temp files older than one hour.
- **Budget log.** `hooks/budget.jsonl` gets one line per injection: the time, agent, session key, event, bytes, index lines and overflow lines. It holds no prompt text, path or lesson text. A log over 4 MiB moves to `budget.jsonl.1`.
- **Hook log.** `hooks/hook.log` gets one line per failure, with the error code only.
- **Cache writes.** The receipt, session files and logs are devtwin's own state, like the lesson index. They have no preview and no plan fingerprint. The hook writes only when the `hooks` folder already exists, so a hook with no receipt writes nothing.

## File identity and interrupted writes

SHA-256 of the exact bytes is the authority for source identity. A bound source must also match its device, inode, size and ancestor chain. The stored `mtimeMs` is kept for compatibility and is informational only; it is never compared across reads. Within one read, a change in size, modification time or change time during the read is refused as a changed file.

- A failed new-file write removes its own partial file, but only while the path still names the file that call created. A failed atomic replace removes its temporary file.
- Directory fsync opens the directory without following symlinks.
- Lock files are created exclusively without following symlinks. Release always closes the handle and removes the lock only if it is still the same file; a cleanup error never hides the action's error. Lock holder details are read from at most 4,096 bytes of a regular file. Locks are still never broken automatically; `locks release` removes a lock only after an approved preview shows its owner process on this machine is gone.
- Run receipts are fsynced with their directories. If a published onboarding lost its receipt in a crash, a replay writes it again; an existing receipt that differs fails with `RECOVERY_REQUIRED`.
- Git queries time out after 30 seconds and fail with `GIT_QUERY_FAILED`. Output over 16 MiB, more than 16 remotes or a remote URL over 2,048 bytes fails with `LIMIT`.

Agent-home paths are writable only by an installer, and only the one target home it names. That home must be listed in `pilot.agentHomes`. In live mode only the bundled installer writes outside the store, and only `devtwin-*` entries in the live config's named skill folders.

## Live store

A live config keeps its private state under `~/.devtwin`, at mode 0700. The live config is `~/.devtwin/live.json`. The store is `~/.devtwin/store`, with `config`, `data`, `state` and `inputs` inside it. The kit clone is `~/.devtwin/kit`. See [Live activation](LIVE.md).

- `state/live/approved-config.json` holds the config ID and the digest of the last approved live config. Live config commands update it under `state/locks/live.lock`.
- Each bundled install, update or uninstall writes `state/runs/<run-id>/journal.json`, with the config ID, kit commit, plan fingerprint and intended, started and completed actions. Before the first write the run folder keeps copies of the old and new file bytes under `copies/`. The run also records an inventory of each target skill folder for the rollback check.
- An installed entry holds `SKILL.md` and a `.devtwin-owned.json` receipt (schema 2, kind `skill-bundled`) with the skill, config ID, run ID, kit commit and file hash. Ownership needs a matching completed journal in this store. The kit commit is provenance only.
- An incomplete run blocks new applies until `agents recover` applies an approved recovery plan. Journals are written atomically. `agents recover --release` closes a run stuck on held entries or an unreadable journal and leaves the held files in place as foreign entries; an unreadable journal is kept as `journal.released.json`. Nothing is repaired automatically.
- Activation evidence stays in `state/evidence/`, created by the owner.
- A store copied by `live migrate` holds `state/live/migration.json`: the config ID, the legacy and new live config paths and digests, the new kit and the digest of the copied tree. Installed entries from the former devctx name keep their `.devctx-owned.json` receipt and stay owned until `agents install` or `agents uninstall` removes them. See [Migrating from devctx](MIGRATING.md).

There is no backup. A lost store leaves installed entries unowned; [Live activation](LIVE.md) gives the manual removal steps.

## Portable handoff files

Private handoff exports live only at `dataRoot/exports/handoffs/<scope>/<project>/<name>.handoff.md`, in 0700 directories with exclusive 0600 files. They are not record mutations or publication receipts. Preflight holds leave no packet; interrupted writes may retain incomplete files, never overwritten or automatically deleted. Discard invalid-footer artifacts from use and preserve evidence for manual inspection. See [HANDOFF.md](HANDOFF.md) for the selected-record and digest contracts.
