---
title: "feat: Autonomous by default - Plan"
type: feat
date: 2026-10-27
topic: devtwin-promotion-phase
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# feat: Autonomous by default - Plan

## Goal Capsule

- **Objective:** Make devtwin a developer twin that works in the background. Agents and scheduled jobs capture, promote, deliver, back up and share knowledge on their own. The developer sets it up once, reads a short weekly digest, and is asked only when an action can affect every session, comes from outside, or cannot be undone. This answers the colleague review of 2026-10-26 (eight gaps, five suggestions) and then finishes the old P6.
- **Product authority:** This plan, then `docs/plans/2026-10-25-001-feat-devtwin-next-phase-plan.md`, then repository instructions (`AGENTS.md`, `CONTRIBUTING.md`, `docs/SECURITY-MODEL.md`). KTD38 replaces that plan's rule that every write needs the owner. Its other KTDs hold unless a KTD below amends one.
- **Execution profile:** Four phases, P6 to P9, built in order. U-IDs continue from the next-phase plan (U24 onward). The next-phase plan's U21 and U23 move into P9. Each phase ends with a green Verification Contract and the owner's review.
- **Stop conditions:** Stop and ask the owner when a unit needs a write location not named in this plan, when an automatic action would leave the machine without a standing consent, when a hook would need a model call or a network call, or when an action does not fit one tier in KTD38.
- **Tail ownership:** The owner approves every push, pull request and release of this repository. A commit-only request ends at the local commit.
- **Open blockers:** None. Four facts are checked at implementation time (see Open Questions).

---

## Product Contract

### Summary

- **Three tiers.** Automatic (local, reversible), consented once (leaves the machine under a standing consent), and always ask (affects every session, comes from outside, or cannot be undone).
- **Safe because reversible.** Every automatic change is a new record, written to an audit log, covered by a daily encrypted backup, and undone with one command.
- **The developer's touch points.** Setup once, a two-minute weekly digest, and rare prompts. No prompts during a session.
- **Background work.** Jobs import memory, refresh summaries, back up the store and send held items. They make no model calls.
- **In-session judgment.** The agent shapes lessons and writes handoffs as it works, and they apply on their own.
- **Delivery.** A capped summary at session start, lessons that match actions, and a handoff stub when a session stops.

### Problem Frame

The colleague review found that devtwin would be a fourth context store next to Claude memory, `CLAUDE.md` files and `docs/solutions`. She would adopt it only if it replaced one. She also counted about 400 repeated corrections across 40 sessions, and her agents asked her the same questions again and again. A tool that makes her approve every captured item would add the overhead it is meant to remove.

The first draft of this plan kept the next-phase rule that the owner approves every write, so it added an inbox, batch dialogs and a dialog per item. The owner rejected that on 2026-10-27: devtwin is the developer's harness, and agents running in the background should handle most of it. Approval now depends on what an action can harm, not on whether it writes.

Replacing Claude memory stays rejected: memory is free, native and self-correcting. devtwin promotes from it and adds sources, freshness, scope isolation, delivery to two agents and team sharing. The colleague's condition ("must replace one") is only partly met: devtwin takes over the hand-maintained global instruction files (P4) and the hand-written `docs/solutions` entries (U30). U23 checks with her whether that is enough.

### Actors

- A1. **Developer (owner):** sets up tiers and consents once, reads the weekly digest, answers the rare always-ask prompt, runs `undo`.
- A2. **Agent (Claude Code or Codex):** shapes lessons, writes handoffs and locations during the session; these apply automatically within the tier rules. Never grants a consent.
- A3. **Background jobs:** launchd jobs that import, summarize, back up and send held items. No model calls.
- A4. **Colleague:** reads promoted lessons through the hub or the repository's `docs/solutions`.

### Requirements

**Tiers, audit and undo**

- R1. Every devtwin write belongs to one of three tiers: automatic, consented, always ask. The tier comes from a fixed table of action, target and source, not from the caller.
- R2. Every knowledge write (records, handoffs, locations, imports) and every outbound item writes one audit entry. `undo --id <entry>` reverses one entry; `undo --since <time>` (always ask) reverses all entries after a time. Derived caches, stop stubs and backup rotation are not audited.
- R3. A weekly activity digest lists what devtwin did, what it holds for sending and what waits for the owner. It is also available on demand with `activity`.
- R4. A standing consent is granted once per target (one repository or one hub) in setup or by `consent grant`. It is revocable. It records the rules it covers, and a rule change voids it.
- R5. A consented outbound item waits 24 hours in a held queue before it is sent. A notification names it when it is held, `activity --held` shows its full text, and `undo` cancels it before it leaves.

**Promotion**

- R6. A daily job reads the Claude memory of bound repositories and their `docs/solutions` and promotes new or changed items as `observed` records, never touching the sources.
- R7. Memory from a project folder becomes project-scoped knowledge. Anything that would reach every organization's sessions (a global preference, a lesson to `general`) waits for the weekly `activity review`.
- R8. Each lesson goes to one or more targets: `project`, `general`, `hub`, `repo`. `project` is automatic, `general` waits for the weekly review, and `hub` and `repo` need a standing consent.
- R9. A `repo` write is a commit on a new branch, never a change to the working copy, the index or the current branch. Under its consent the branch is pushed after the hold. devtwin does not open a pull request.

**Delivery**

- R10. At session start in a bound project, the agent receives a summary of at most 1,200 characters: the project's "ask before" rules, top constraints and locations, and the last handoff's next step.
- R11. A lesson can match a shell command, such as `git push`. Its line arrives with the tool call. It is guidance; it cannot stop the command.
- R12. When a session stops or compacts, the hook records a handoff stub for that worktree. The next session start reports it unless a handoff from that session exists.

**Safety and friction**

- R13. A daily job writes an encrypted backup. `backup restore` restores into a new folder and never overwrites the live store.
- R14. Confirmed kit and config paths are remembered. Skills ask again only when either changes. The hook receipt lasts 30 days and renews itself at session start when the kit and config still match.
- R15. An always-ask prompt can be answered over SSH by an explicit opt-in.
- R16. An `environment` record can hold locations: a name, a kind and where it lives. A value that looks like a credential, a token or a connection string with a password is refused.
- R17. `docs/LIMITATIONS.md` and the site state what devtwin does not do: stop a command, prevent secrets printed to a terminal, fix commands that break when pasted, or poll long jobs.
- R18. In live mode, the radar reports upcoming model retirements from the fixed vendor deprecation pages.

**Review and checks**

- R19. The monthly setup review (old U21) also suggests stale promoted items, lessons that never matched in 30 days, memory items delivered twice, and consents that were never used.
- R20. The real-agent scenarios (old U23) cover the new behavior, and the colleague confirms whether devtwin replaced one store she maintained by hand.

### Tier table

| Tier | Actions | Who acts | Owner sees |
|---|---|---|---|
| **Automatic** | Import and promote memory and `docs/solutions` items to `project`; agent lessons, constraints, facts and locations to `project` (`record add`, `record supersede`, `lesson accept --target project`); handoffs (`handoff write`, `handoff export`); onboarding commits; writing a local learning branch; `undo --id` of an entry from the calling session. Not audited, because they are derived or rotated: summaries, index rebuilds, stop stubs, backups and their rotation | Agents and jobs | The weekly digest; `undo` |
| **Consented** | Push a learning branch to one repository; publish a lesson to one hub (both with the held queue, KTD41); post "working on" notes (KTD10 rules, not held); `undo --id` of an item already sent | Agents and jobs, after a one-time consent per target | A notification when an item is held, the digest, `consent revoke` |
| **Always ask** | `consent grant`, `consent revoke`; `activity review` (global preferences, lessons to `general`, items from fetched or synced outside sources); `undo --since` and undo of another session's entries; `import map`; `project set`; `backup key export`; `live approval`; and every route already in `OWNER_ACTIONS`: `lesson copy`, `published delete`, `hub join`, `hub leave`, `hub schedule`, `pref accept`, `pref retire`, `instructions apply`, `live migrate`, `record publish`, `agents install`, `agents uninstall`, `live set-kit`, `live add-repo`, `live init`, `live write-classes`, `live stack-watch`, `schedule apply`, `schedule off`, `lesson notices`, `note revoke`, `note consent`, and the `OWNER_SETUP_STEPS` steps | The owner, with the owner dialog | A prompt, at most once a week for `activity review` |

The outside-source rule covers only content devtwin fetched or synced itself. Text an agent re-writes from outside material counts as an agent write; it is caught after the fact through the digest, the unreviewed labels (KTD43) and `undo`.

### Key Flows

- F1. **Background promotion.** The daily job imports changed memory and `docs/solutions` files. Each becomes an `observed` project record with its source hash. The digest lists them. Next session start, the summary and lesson lines can use them.
- F2. **In-session capture.** The developer corrects the agent. The agent writes a lesson for this project, with a command match when the correction is about an action. It applies at once as `observed`. When a session stops, the agent writes a handoff; the hook writes a stub either way.
- F3. **Share with the team.** The agent marks a lesson for the hub or the repository. Under the target's consent it enters the held queue, and a notification names it. After 24 hours a job publishes it or pushes the learning branch. The owner opens the pull request.
- F4. **Weekly digest.** A notification says "devtwin learned 7 things, 2 held for sending, 1 preference waits for you". `activity` shows the list. The owner undoes anything wrong and answers the preference prompt.
- F5. **Recover.** `backup restore --from <file> --to <new folder>`, check the report, point the live config at it by hand.

### Acceptance Examples

- AE1. The memory file "Always ask before pushing" (`type: feedback`) in a bound repository's folder becomes an `observed` project lesson with command match `git push` within one daily run, with no prompt. A second run with no change adds nothing.
- AE2. `undo --id <entry>` for that lesson writes a retraction, and the next session start no longer shows it.
- AE3. With a consent for repository R, a lesson marked `repo` creates branch `devtwin/learning-<id>`; `git status` and HEAD in R are unchanged. The branch is pushed 24 hours later. Without the consent it stays local and the digest says "needs consent".
- AE4. In that repository the session-start summary lists "Ask before: git push", and `git push origin main` gets the lesson line with the tool call, once per session.
- AE5. A session stops with three changed files and no handoff. The next session start in that worktree reports "Last session stopped ... 3 changed files; no handoff".
- AE6. A `type: user` memory "Keep answers short" waits for `activity review` as a preference. It reaches the global instruction block only after the owner dialog.
- AE9. An agent shell runs `undo --since 2026-01-01`; the hook denies it. `undo --id` of an entry from another session is denied too.
- AE7. "DB URL: `.env` in the repo root" is stored. "DB URL: `postgres://user:secret@host/db`" is refused.
- AE8. `backup restore` into a non-empty folder fails. Restore into an empty folder reports every file verified.

### Success Criteria

- In a normal week the developer answers at most one prompt and spends about two minutes on the digest.
- No knowledge write or outbound item lacks an audit entry, and `undo` reverses each one, or cancels it while held.
- The session-start summary and action lessons stay inside the measured budget (`budget report`).
- No path changes a memory file or a working copy, and nothing leaves the machine without a standing consent or an owner prompt.

### Scope Boundaries

- No import from `CLAUDE.md` or `AGENTS.md`; onboarding reads them as sources.
- No write to oogway-brain or other team stores; the only team targets are the hub and `docs/solutions` (R8).
- No change to or deletion of memory files, ever.
- No pull request creation. No push over HTTPS remotes.
- No model call in a hook or a background job. Judgment stays in the developer's own visible agent sessions.

#### Deferred to Follow-Up Work

- A global install (a `devtwin` command on the PATH without a checkout).
- Scanning project source for model IDs to match retirements per project.
- Dropping branch names from "working on" notes, and pruning other organizations' remotes from records (review section 6).
- Linux support.

### Colleague review mapping

| Review item | Covered by |
|---|---|
| Gap 1 / Suggestion 2: fourth store; importers and write-back | R6-R9; U28, U30 |
| Gap 2 / Suggestion 1: brief not loaded automatically | R10; U31 (P4 shipped the preference block) |
| Gap 3 / Suggestion 4: lessons match files only | R11; U32 |
| Gap 4 / Suggestion 3: handoffs depend on habit | R12; U33 |
| Gap 5 / Suggestion 5: no backup, no encryption | R13; U24 |
| Gap 6 / Suggestion 5: friction | R1-R5, R14, R15; U36, U37, U25, U26, U27 |
| Gap 7 / Suggestion 4: "where things live" | R16; U29 |
| Gap 8: out-of-scope limits | R17; U35 |
| Suggestion 5: model-API deprecations | R18; U34 |

### Sources / Research

- `~/Downloads/devtwin-review-claude-2026-10-26.html` (outside the repository; reviewed commit `43d2de8`).
- The owner's decisions on 2026-10-26 and 2026-10-27 in the planning conversation, including the three-tier model.
- A five-reviewer document review of the first draft (coherence, feasibility, security, scope, adversarial). Findings that still apply are folded into the KTDs and units below.
- Code read: `src/hooks/commands.mjs`, `src/hooks/owner-block.mjs`, `src/hooks/receipt.mjs`, `src/agents/hooks-install.mjs`, `src/agents/instructions.mjs`, `src/owner/dialog.mjs`, `src/lessons/match.mjs`, `src/lessons/publish.mjs`, `src/hubs/git-write.mjs`, `src/identity/git.mjs`, `src/records/schema.mjs`, `src/records/redact.mjs`, `src/records/isolation.mjs`, `src/config/pilot.mjs`, `src/storage/source-read.mjs`, `src/schedule/`.

---

## Planning Contract

**Product Contract preservation:** New plan. KTD38 replaces the next-phase plan's KTD9 for automatic and consented actions; KTD9 stays for the always-ask tier. KTD39 generalizes KTD10 to repositories and hubs. KTD30 amends KTD17's session-start budget. KTD43 applies the preference text checks to automatic writes. KTD22 (the hook never rebuilds anything) stays.

### Key Technical Decisions

**Autonomy**

- KTD38. **Approval follows harm, in three tiers.** `src/policy/tiers.mjs` holds one frozen table that maps (route, target, source) to a tier, covering every write route in `src/cli.mjs`. Every write path asks it. Automatic actions run with no prompt. Consented actions run when a matching consent exists and otherwise stop at "needs consent". Always-ask actions keep KTD9: the hook denies them from agent shells and the owner dialog shows the exact text. The owner-block stays word-only, so every always-ask variant has its own route words: global preferences and `general` lessons are accepted only through `activity review`; `pref accept` stays always ask; `lesson accept` leaves `OWNER_ACTIONS` and itself refuses `general`, `hub` and `repo` without the matching tier. The test checks that `OWNER_ACTIONS` equals the always-ask route set. Records take `recordedBy` from the caller (`claude` or `codex` from the hook session tag, `other` with a job run ID for jobs), replacing the fixed human author in `src/lessons/publish.mjs`. (session-settled: user-directed — chosen over owner approval of every write and over a batch inbox: devtwin is the developer's background harness, and safety comes from undo, isolation and backup.)
- KTD39. **Standing consents per target.** `consent grant --kind repo-push --repo <root>` and `--kind hub-publish --scope <scope>` are always-ask actions. Each consent stores the target, the rule digest (the hold time, the checks, the file template or hub layout, and for a repository the learnings folder, base and remote URL) and the time. Branches written before a consent existed are not queued by the grant; the digest lists them and `learning send --branch` queues one under the consent. A changed rule digest voids it. `consent revoke` is always ask and also cancels held items for that target. The existing note consent (KTD10) is listed by `consent list` but keeps its own rules.
- KTD40. **The audit log is the source of the digest and of undo.** Each knowledge write and outbound item appends an entry to `stateRoot/audit/<yyyy-mm>.jsonl` (0600) under the audit lock, keyed by the write's request ID and appended before the write, so a crash leaves an entry that `activity` reports as "never landed" rather than a record nobody knows about. An entry holds the entry ID, time, tier, route, target, record or item IDs, source hash, actor and session key. It never holds body text. Undo reverses by kind:
  - A local record gets a record of the new kind `retraction` (allowed in project, personal and org homes, never delivered by the index, brief or summary) that supersedes the current head of that record's chain.
  - Undo of a supersede entry retracts the successor and writes a restored copy of the predecessor.
  - A held item is removed from the held queue and the hub outbox.
  - A pushed learning branch gets a revert commit, pushed by fast-forward of its own `devtwin/learning-<id>` ref only. Undo refuses, and tells the owner to revert by hand, once that commit is reachable from the learnings base or the remote branch is gone.
  - A published hub lesson gets the author's own tombstone under the hub consent.
  Undo rebuilds the affected indexes (every scope for a personal record) and the project summary before it returns. `undo --id` is automatic only for an entry with the calling session's key; any other undo is always ask. Undo of an undo is refused.
- KTD41. **Outbound items wait in a held queue.** A consented item goes to `stateRoot/held/<target>/<id>.json` with a `sendAfter` 24 hours ahead, and one notification names the target and title at once. A hub accept enqueues there instead of publishing inline. After `sendAfter`, the hub-sync job or the hourly `learning-send` job re-runs the sensitive scan and the isolation check and hands the item to the existing publish or push path; push failures go to the existing outbox. `consent grant --hold-hours` accepts 1 to 168 and is part of the rule digest. Notes keep the KTD10 rules and are not held.
- KTD42. **Promoted items start as `observed`.** Imported and agent-written knowledge is stored with status `observed`, which is already delivered by the index and the brief and marked as unreviewed. The owner can confirm an item later; nothing waits for that. Automatic writes may supersede only `observed` records; a `confirmed` record changes only through the owner.
- KTD43. **Automatic text gets the preference checks and a label.** Lesson, handoff and location text written automatically passes the plain-rule checks that preferences use (`src/prefs/store.mjs`: no Markdown structure, no devtwin markers, no `@` import, no "ignore other instructions" text) plus the sensitive and scope-name checks, at write time and again at summary render. Each unconfirmed line in the summary and in lesson output starts with its source and "unreviewed" (for example "unreviewed, from memory:"). An agent session makes at most 20 automatic writes; later ones go to `activity review`.

**Promotion**

- KTD25. **Memory captures, devtwin promotes.** devtwin reads memory and never writes it. (session-settled: user-approved — chosen over replacing Claude memory: memory is free, native and self-correcting.)
- KTD26. **The importer reads only what it can prove is bound.** For each bound repository root, the importer computes the Claude project folder name from the root's real path. Before reading, it checks that the session transcripts in that folder record a working directory equal to the root or one of its linked worktrees, and no other path. Otherwise it skips the folder and reports "ambiguous". Memory files are read with the no-follow, regular-file, size-capped reader from `src/storage/source-read.mjs` (a read-only exception for the computed folder). `MEMORY.md` is skipped. `docs/solutions/**/*.md` is read from the tree of the project's learnings base commit through Git plumbing with hooks and filters off, never from the working copy, so a checked-out feature branch or unreviewed pull request does not feed the import. The commit is part of the source hash. The cap is 200 files. A bound repository that was never onboarded is skipped and counted. Folders it finds but cannot map are counted in the digest. `import map --folder <path> --scope <s>` (always ask) maps an extra workspace folder to one scope.
- KTD27. **Mapping is mechanical; the agent refines.** The dedupe hash covers the body plus `name` and `metadata.type`, not volatile front matter. Mapping: `feedback` → project lesson; `user` → personal preference candidate (always ask, per R7); `project` → project fact, or constraint when the text says "must", "never" or "always"; `reference` → environment location. A fixed, tracked table `catalog/habit-commands.json` maps habit words to command prefixes ("push", "pushing" → `git push`; "merge" → `gh pr merge`; "deploy"; "print env" → `printenv`), so "Always ask before pushing" gets `git push`. A `docs/solutions` file becomes a project lesson. In-session, the capture skill tells the agent to sharpen observed lessons it sees (better title, match block) by superseding them, which is automatic.
- KTD29. **Repository write-back writes objects and one new ref.** The class `repoLearnings` lists exact bound repository roots. devtwin writes the blob, tree and commit with Git plumbing, on top of the project's learnings base (`project set --learnings-base`, default the remote default branch from `refs/remotes/origin/HEAD`; with neither, the write fails and names `project set`), and creates `refs/heads/devtwin/learning-<id>`. The commit adds exactly one file, `<learnings dir>/<slug>.md`, where the learnings dir is repo-relative, checked with `assertSourceRel`, and defaults to `docs/solutions/lessons`. It never touches HEAD, the index or the working tree, and refuses when the ref exists. The only existing ref it may later move is its own learning ref, by fast-forward, for an undo (KTD40). Author and committer come from the scope's recorded Git identity, passed as per-command `-c user.name -c user.email`; with no recorded identity the write fails before anything lands. Signing-required repositories fail with a clear message. The push uses the consent's recorded SSH remote URL explicitly (never a remote name), the binding's SSH command, and per-command overrides that disable `pushurl`, `insteadOf` and `pushInsteadOf`. It refuses when the repository's configured push URL differs from the recorded one, never forces, and refuses HTTPS (printing the exact command for the owner). Tests use a local bare-repository transport that only the test seam can select. (session-settled: user-approved — chosen over a local commit only and over push plus pull request.)

**Delivery**

- KTD30. **The session summary is a cache the hook only reads, plus the stub.** Record writes, index rebuilds, lesson and handoff writes, and the daily import rebuild `stateRoot/summaries/<scope>/<project>.json` under the scope lock. `undo` is also a writer. Content order: "ask before" lessons for the project (any lesson with a command match whose text says "ask" or "confirm"), up to five constraints and locations (confirmed first, then newest), and the last handoff's next step with its time. At session start the hook appends the cache, then reads the stub for the current worktree directly (KTD32) and adds its line when the stub is newer than the cached handoff time. Text is rendered with the `renderInbound` rules from `src/records/isolation.mjs`: control, format and bidi characters removed, a fence longer than any backtick run inside, labelled as data. Total at most 1,200 characters, so the session-start budget for a bound project rises from about 100 to about 400 tokens (amends KTD17).
- KTD31. **Action lessons match simple commands.** A lesson `match` block gains `commands`: one to three lowercase words. A new splitter in `src/hooks/shell-words.mjs` (separate from the owner-block's deliberately conservative word list) splits on `;`, `&&`, `||` and `|` outside quotes, unwraps one `sh -c` or `bash -c`, drops leading `VAR=value` words and the wrappers `env`, `command`, `sudo`, `xargs`, `time`, `nohup`, takes the basename of a path executable, and removes Git and GitHub global options (`-C <dir>`, `-c k=v`, `--no-pager`, `--git-dir`). A lesson matches when the remaining words start with its prefix. Strength sits between package and topic. There is still no `deny` (KTD8), so R11 states the line cannot stop the command; "ask before" lessons also go in the summary (KTD30) so the agent knows before it decides.
- KTD32. **The stop stub is mechanical and per worktree.** A new `Stop` hook for Claude Code and Codex runs `devtwin hook --event stop`. The existing `pre-compact` event also writes the stub, after the project lookup and before its current early return; its installed entry is unchanged. The hook writes `stateRoot/handoffs/<scope>/<project>/<worktree-hash>.json` by atomic replace: time, branch, short HEAD, the changed-file count and at most ten repo-relative paths (quoted and length-capped when shown), and the session key. It runs one `git status --porcelain` with hooks and filters off and a 2-second limit, which is a new Git call on the hook path. A stub is answered when a handoff record from the same session key exists. (session-settled: user-approved — chosen over parsing the session transcript.)

**Safety and friction**

- KTD33. **The backup is one encrypted file, keyed from the Keychain, made daily.** A `backup-daily` launchd job (U20 pattern) archives `configRoot`, `dataRoot` and `stateRoot` except rebuildable caches (index, summaries, hook sessions, budget log, hub clones). It holds, in a fixed order, the registry lock, every scope lock in sorted order, and the prefs, lesson-proposal, hub-sync, audit, held-queue and consent locks while reading, or skips the run with `BUSY`. The archive is a JSON manifest (path, mode, size, SHA-256) and the file bytes, sealed with AES-256-GCM; decryption completes in memory before any write. The random 256-bit key is stored in the macOS Keychain (service `devtwin-backup`) by piping an `add-generic-password` line to `/usr/bin/security -i`, so the key is never in argv or a file. Any process running as the user can read that Keychain item; the backup protects copies kept away from the machine, not data on it, and `docs/SECURITY-MODEL.md` says so. The class `backupTargets` holds archives; restore writes only to a new, empty 0700 folder inside a `backupTargets` folder. The job keeps 14 daily archives. Until `backup key export` (always ask) has run once, the digest warns that backups cannot be restored on another machine. (session-settled: user-approved — chosen over a typed passphrase.)
- KTD34. **SSH approval is opt-in and only for always-ask prompts.** A live config key `approval: "dialog" | "dialog-or-tty"` (default `dialog`). In `dialog-or-tty`, GUI absence is decided from the launchd session type (`launchctl managername` is not `Aqua`), never from `SSH_*` variables; with a GUI session the dialog is always required. The code prompt and the answer use `/dev/tty`, so the JSON result line on stdout stays clean. The hook block still denies agent shells. `docs/SECURITY-MODEL.md` states that this mode is one control plus a TTY check.
- KTD35. **Confirmed paths renew themselves.** `paths confirm` (part of setup) records the real paths of the kit and the live config, the kit's `.git/HEAD` contents and the config's SHA-256 in `stateRoot/confirmed-paths.json`. The session-start line says "kit and config confirmed" when they still match; skills skip the path question then. The receipt default TTL moves from 7 to 30 days, and the session start renews it when the confirmed paths still match, so the weekly `hook verify` goes away. A mismatch drops the confirmation and asks once.
- KTD36. **Locations, never values.** An `environment` record may carry `locations`: up to 20 entries of `{ name, kind, where }`, with `kind` one of `file`, `directory`, `host`, `service`, `secret-store`. `where` must be a repo-relative path, a home-relative path, a host name or a named service. It is refused when the sensitive scan matches, when it contains a URL with user info or a query, an `=` assignment, or a high-entropy run of 24 or more characters.
- KTD37. **Deprecations are a fixed extractor, not page text.** A new radar source kind `deprecations` fetches a fixed vendor page under the stack-watch exception, extracts model IDs and retirement dates with a fixed pattern, and reports only those. An extraction that finds zero rows on a page that had rows before is reported as a source failure, not as "no retirements".

### High-Level Technical Design

Tiers and flow:

```mermaid
flowchart LR
  MEM[Claude memory of bound repos] -->|daily import job| AUTO
  SOL[repo docs/solutions] -->|daily import job| AUTO
  AG[agent in session] -->|lesson, handoff, location| AUTO
  subgraph AUTO[Automatic tier]
    REC[(observed records)]
  end
  AUTO --> AUD[(audit log)]
  AG -->|mark hub or repo| CONS{consent for target?}
  CONS -->|no| NEED[digest: needs consent]
  CONS -->|yes| HELD[(held queue, 24 h)]
  HELD -->|hub-sync job| HUB[(org hub)]
  HELD -->|learning-send job| BR[branch devtwin/learning-id pushed]
  HELD --> AUD
  AG -->|user-type preference, outside source| ASK[Always ask: owner dialog]
  AUD --> DIG[weekly digest + undo]
  REC --> SUM[summary cache]
  REC --> IDX[match index]
  SUM -->|session start| HK[devtwin hook]
  IDX -->|path, package, topic, command| HK
  HK --> AGT[agent session]
  JOB[backup-daily job] --> BAK[(encrypted backups)]
```

A session:

```mermaid
sequenceDiagram
  participant A as Agent
  participant H as devtwin hook
  participant S as state
  A->>H: SessionStart
  H->>S: renew receipt, read summary, read worktree stub
  H-->>A: live line, "ask before" rules, summary (<= 1,200 chars)
  A->>H: PreToolUse Bash "git -C app push origin main"
  H->>S: split and match command
  H-->>A: lesson line (guidance)
  Note over A: developer corrects the agent
  A->>S: lesson for this project (automatic, observed, audited)
  A->>H: Stop / PreCompact
  H->>S: write worktree stub
```

Unit dependency graph:

```mermaid
flowchart TB
  subgraph P6[P6 Autonomy foundations]
    U36[U36 Tier table and standing consents]
    U37[U37 Audit log, digest and undo]
    U24[U24 Daily encrypted backup]
    U27[U27 Self-renewing paths and receipt]
    U26[U26 SSH approval for always-ask]
    U35[U35 Stated limits]
  end
  subgraph P7[P7 Matching and delivery]
    U29[U29 Where-things-live locations]
    U32[U32 Action-matched lessons]
    U31[U31 Session summary]
    U33[U33 Stop stub and handoffs]
  end
  subgraph P8[P8 Promotion and sharing]
    U28[U28 Daily promotion importer]
    U41[U41 Held queue and senders]
    U30[U30 Targets and repo write-back]
    U25[U25 Weekly owner prompt]
    U34[U34 Model retirements]
  end
  subgraph P9[P9 Review and agent checks]
    U21[U21 Setup review]
    U23[U23 Real-agent scenarios and colleague check]
  end
  U36 --> U37
  U36 --> U26
  U37 --> U31
  U29 --> U31
  U32 --> U31
  U31 --> U33
  U37 --> U33
  U24 --> U28
  U37 --> U28
  U29 --> U28
  U32 --> U28
  U36 --> U41
  U37 --> U41
  U41 --> U30
  U28 --> U30
  U37 --> U25
  U28 --> U25
  U30 --> U21
  U33 --> U21
  U25 --> U21
  U34 --> U21
  U21 --> U23
  U26 --> U23
  U27 --> U23
  U35 --> U23
```

U24 before U28 is a deliberate safety gate: automatic promotion starts only once the store is backed up every day.

### Implementation Constraints

- Keep the zero-dependency rule. Encryption uses Node `crypto`; Keychain access uses `/usr/bin/security`.
- Every write path asks the tier table first. Automatic writes still use the existing plan functions internally, with no fingerprint prompt; they record an audit entry instead.
- The hook stays fail-open, lock-free and network-free. U33 adds one time-limited Git call; its failure exits quietly.
- Background jobs follow the U20 launchd pattern: live gate, config flag, receipt, skip if already run in the period, no model call.
- New private folders are 0700 and files 0600 with exclusive no-follow writes.
- Every new file goes into `scripts/package-allowlist.json`, every new test name into `test/required-tests.json`, every acceptance change into the counts in `.github/workflows/ci.yml`.
- Fixtures use `example` scopes. No real client, repository or account name in tracked files. Credential-like fixtures are split by string concatenation.

---

## Implementation Units

| U-ID | Title | Main files | Depends on |
|---|---|---|---|
| U36 | Tier table and standing consents | `src/policy/`, `src/consent/` | none |
| U37 | Audit log, weekly digest and undo | `src/audit/`, `src/schedule/jobs.mjs` | U36 |
| U24 | Daily encrypted backup and restore | `src/backup/` | none |
| U27 | Self-renewing paths and receipt | `src/paths/`, `src/hooks/receipt.mjs` | none |
| U26 | SSH approval for always-ask prompts | `src/owner/` | U36 |
| U35 | Stated limits | `docs/LIMITATIONS.md`, site | none |
| U29 | Where-things-live locations | `src/records/` | none |
| U32 | Action-matched lessons | `src/lessons/match.mjs`, `src/hooks/shell-words.mjs` | none |
| U31 | Session summary | `src/context/summary.mjs`, `src/hooks/commands.mjs` | U29, U32, U37 |
| U33 | Stop stub and automatic handoffs | `src/hooks/stub.mjs`, `src/handoff/` | U31, U37 |
| U28 | Daily promotion importer | `src/import/` | U24, U29, U32, U37 |
| U41 | Held queue and senders | `src/held/`, `src/schedule/jobs.mjs` | U36, U37 |
| U30 | Targets and repository write-back | `src/lessons/publish.mjs`, `src/learnings/` | U28, U41 |
| U25 | Weekly owner prompt | `src/prefs/`, `src/audit/digest.mjs` | U28, U37 |
| U34 | Model retirements in the radar | `src/stack/` | none |
| U21 | Setup review (moved, extended) | `src/review/` | U25, U30, U33, U34 |
| U23 | Real-agent scenarios and colleague check (moved, extended) | `scripts/agent-scenarios/` | U21, U26, U27, U35 |

### Phase P6: Autonomy foundations

### U36. Tier table and standing consents

**Goal:** Decide once, in one place, which writes need nobody, a consent or the owner.
**Requirements:** R1, R4; KTD38, KTD39.
**Dependencies:** None.
**Files:** `src/policy/tiers.mjs` (new), `src/consent/store.mjs` (new), `src/consent/commands.mjs` (new), `src/hooks/owner-block.mjs`, `src/lessons/publish.mjs`, `src/records/commands.mjs`, `src/notes/commands.mjs`, `src/hubs/join.mjs`, `src/cli.mjs`, `src/setup/steps.mjs`, `test/tiers.test.mjs` (new), `test/consent.test.mjs` (new), `test/owner-block.test.mjs`, `docs/SECURITY-MODEL.md`, `docs/AGENT-PROTOCOL.md`.
**Approach:** `tierOf({ route, target, source })` returns `automatic`, `consented` or `always-ask`, and throws for an unknown combination. Write paths call it before their plan function. `lesson accept --target project` becomes automatic and `lesson accept` leaves `OWNER_ACTIONS`; the command refuses other targets unless their tier allows them. `pref accept` stays always ask. `recordedBy` comes from the caller. Setup gains `consent-repo` and `consent-hub` steps. `consent list` shows the note consent from `src/hubs/join.mjs` read-only.
**Patterns to follow:** `src/notes/` consent digest (KTD10); `src/setup/steps.mjs` step primitives.
**Test scenarios:**
- Happy path: an agent's `lesson accept --target project --apply` writes with no dialog, records actor `claude` or `codex`, and returns the tier.
- Error path: an agent's `lesson accept --target general --apply` is refused with "waits for activity review".
- Happy path: `consent grant --kind repo-push` after the dialog records the target and rule digest.
- Integration: every write route in `src/cli.mjs` has a tier (the test enumerates the route table).
- Edge case: a consent whose rule digest changed reads as void, and the consented action returns "needs consent".
- Error path: an unknown action and target pair throws, and nothing is written.
- Error path: `consent grant --apply` from a hooked agent shell is denied.
- Integration: every route in `OWNER_ACTIONS` maps to `always-ask` in the tier table, and every `always-ask` route is in `OWNER_ACTIONS`.
**Verification:** The tier table is the only place a route's approval rule is decided.

### U37. Audit log, weekly digest and undo

**Goal:** Make every automatic action visible and reversible.
**Requirements:** R2, R3; KTD40, KTD42, KTD43.
**Dependencies:** U36.
**Files:** `src/audit/log.mjs` (new), `src/audit/undo.mjs` (new), `src/audit/digest.mjs` (new), `src/audit/commands.mjs` (new), `src/audit/checks.mjs` (new, the KTD43 text checks shared with `src/prefs/store.mjs`), `src/records/store.mjs`, `src/records/schema.mjs` (`retraction` kind, `HOME_KINDS`), `src/records/personal.mjs`, `src/context/brief.mjs`, `src/lessons/index.mjs`, `src/schedule/jobs.mjs` (`activity-weekly`), `src/schedule/notify.mjs`, `src/hooks/owner-block.mjs`, `src/cli.mjs`, `test/audit.test.mjs` (new), `test/schedule.test.mjs`, `docs/STORAGE.md`, `docs/HARNESS.md`.
**Approach:** Writers append an audit entry keyed by request ID before writing. `activity [--since] [--held]` reads the log. The weekly job sends one notification with counts and runs nothing else. `undo` dispatches by entry kind; held and outbound kinds land in U41 and U30 through the same interface. The owner-block gains `undo --since`; `undo --id` checks the entry's session key against the caller's.
**Test scenarios:**
- Happy path: an automatic lesson write adds one entry, and `undo --id` writes a retraction; the next session start no longer shows the lesson. Covers AE2.
- Happy path: undo of an import entry whose lesson an agent later sharpened retracts the sharpened head.
- Happy path: undo of a sharpen entry restores the earlier version.
- Happy path: the owner's `undo --since` reverses three entries in reverse order.
- Error path: `undo --since` from a hooked agent shell, and `undo --id` of another session's entry, are denied. Covers AE9.
- Edge case: a retraction record never appears in the brief, the index or the summary.
- Edge case: an entry whose write never landed is reported as such.
- Edge case: undo of an undo is refused.
- Error path: automatic lesson text with a devtwin marker or "ignore other instructions" is refused at write time.
- Edge case: the 21st automatic write in one session goes to `activity review`.
- Edge case: the log never contains body text (checked against a fixture body).
- Error path: a corrupt month file is skipped with a warning, and other months still read.
- Integration: the weekly job's notification text lists counts for learned, held and waiting items.
**Verification:** Every automatic writer added later in this plan has a test that checks its audit entry.

### U24. Daily encrypted backup and restore

**Goal:** Back up the store every day without the developer doing anything.
**Requirements:** R13; KTD33.
**Dependencies:** None.
**Files:** `src/backup/archive.mjs` (new), `src/backup/keychain.mjs` (new), `src/backup/commands.mjs` (new), `src/schedule/jobs.mjs` (`backup-daily`), `src/config/pilot.mjs` (`backupTargets`), `src/config/live.mjs`, `src/hooks/owner-block.mjs`, `src/cli.mjs`, `test/backup.test.mjs` (new), `docs/STORAGE.md`, `docs/LIVE.md`, `docs/SECURITY-MODEL.md`.
**Approach:** `backup create` is automatic (the job and on demand). `backup restore` checks the folder rules, decrypts in memory, verifies every hash and mode, then writes. `backup key export` is always ask and writes an export receipt. The key seam is `ctx.keychain`.
**Execution note:** Confirm the `security -i` stdin route with a throwaway Keychain item before building on it.
**Test scenarios:**
- Happy path: create then restore into an empty folder yields identical bytes and modes. Covers AE8.
- Edge case: caches are absent from the archive; the 15th daily archive removes the oldest.
- Edge case: a held scope or audit lock makes the job skip with `BUSY` and try again next day.
- Error path: restore into a non-empty folder or outside `backupTargets` fails before writing. Covers AE8.
- Error path: a flipped byte fails authentication and writes nothing.
- Error path: `backup key export --apply` from a hooked agent shell is denied.
- Integration: until an export receipt exists, the digest carries the "not restorable elsewhere" warning.
**Verification:** No argv in any test contains the key.

### U27. Self-renewing paths and receipt

**Goal:** Stop asking for paths and stop the weekly `hook verify`.
**Requirements:** R14; KTD35.
**Dependencies:** None.
**Files:** `src/paths/confirm.mjs` (new), `src/hooks/receipt.mjs`, `src/hooks/commands.mjs`, `src/setup/steps.mjs`, `skills/devtwin-resume/SKILL.md`, `skills/devtwin-record/SKILL.md`, `skills/devtwin-onboard/SKILL.md`, `templates/skills/*/candidate/SKILL.md`, `test/paths.test.mjs` (new), `test/hooks.test.mjs`.
**Approach:** Setup runs `paths confirm`. The session-start path compares the confirmed paths and renews the receipt when they match. Skill text changes from "confirm once per session" to "confirm only when the hook line does not say confirmed".
**Test scenarios:**
- Happy path: after confirm, the session-start line says confirmed and the receipt's `verifiedAt` moves forward.
- Edge case: an edited config or a new kit HEAD drops the confirmation and does not renew.
- Error path: `paths confirm --apply` from a hooked agent shell is denied.
**Verification:** `test/skill-templates.test.mjs` passes with the new skill text.

### U26. SSH approval for always-ask prompts

**Goal:** Let the owner answer the rare prompt over SSH, by opt-in.
**Requirements:** R15; KTD34.
**Dependencies:** U36.
**Files:** `src/owner/dialog.mjs`, `src/owner/tty.mjs` (new), `src/config/live.mjs`, `src/config/pilot.mjs`, `test/owner-tty.test.mjs` (new), `docs/SECURITY-MODEL.md`, `docs/LIVE.md`.
**Approach:** `requireOwnerApproval` checks the session type, then shows the dialog or, in `dialog-or-tty` with no GUI, uses `/dev/tty`. `live approval --mode` is always ask.
**Test scenarios:**
- Happy path: `dialog-or-tty`, a non-Aqua session and the right code approves.
- Error path: `SSH_TTY` set in an Aqua session still requires the dialog.
- Error path: a wrong code, no `/dev/tty` or the default mode denies.
**Verification:** The JSON result on stdout is unchanged by the prompt.

### U35. Stated limits

**Goal:** Say plainly what devtwin does not do.
**Requirements:** R17.
**Dependencies:** None.
**Files:** `docs/LIMITATIONS.md`, the site's limitations page, `test/docs.test.mjs`.
**Approach:** Add "Not covered": a lesson line cannot stop a command; secrets printed to a terminal; commands that break when pasted; polling long jobs. Also state the tier model's trade-off: automatic items are reviewed after the fact, through the digest and `undo`.
**Test expectation:** A docs test checks the section heading and its items.
**Verification:** `npm run -s check:writing` and the site build pass.

### Phase P7: Matching and delivery

### U29. Where-things-live locations

**Goal:** Record where things live, never their values.
**Requirements:** R16; KTD36.
**Dependencies:** None.
**Files:** `src/records/schema.mjs`, `schemas/record.schema.json`, `src/records/redact.mjs`, `src/records/commands.mjs`, `src/context/brief.mjs`, `test/records-v2.test.mjs`, `test/redact.test.mjs`.
**Approach:** Add `locations` to environment drafts with its own validator and `scanValueLike` next to `scanSensitive`. Location writes from an agent are automatic. The brief and the summary render them one per line.
**Test scenarios:**
- Happy path: "DB URL: `.env` in the repo root" is stored and shown. Covers AE7.
- Error path: a URL with user info, a `KEY=value` line and a 32-character random string are each refused. Covers AE7.
- Edge case: 21 locations fail the cap; records without `locations` stay valid.
**Verification:** Existing record tests stay green.

### U32. Action-matched lessons

**Goal:** Deliver habit lessons at the command they are about.
**Requirements:** R11; KTD31.
**Dependencies:** None.
**Files:** `src/hooks/shell-words.mjs` (new), `src/lessons/match.mjs`, `src/lessons/propose.mjs`, `src/lessons/commands.mjs`, `src/lessons/index.mjs`, `src/hooks/commands.mjs`, `test/shell-words.test.mjs` (new), `test/lesson-match.test.mjs`, `test/hooks.test.mjs`.
**Approach:** Add `commands` to the match block and `--command` to propose and edit. The pre-tool path in `respond()` returns early when a call has no paths, so shell calls get their own branch that runs the splitter and the command match. The hook log records delivered lesson IDs (never command text), which U21 uses.
**Test scenarios:**
- Happy path: `git push origin main` and `git -C app push` match the `git push` lesson once per session. Covers AE4.
- Edge case: `FOO=1 env git push`, `cd x && git push`, `bash -c "git push"` and `/usr/bin/git push` match.
- Edge case: `git pushd`, `echo git push`, `git commit -m "a; git push"` and `git status` do not match.
- Edge case: a fifth match in a session becomes the overflow line.
- Error path: a `commands` entry over three words or with shell operators fails validation.
**Verification:** `budget report` counts the new lines; owner-block tests are unchanged.

### U31. Session summary

**Goal:** Give every session in a bound project its key rules without a skill call.
**Requirements:** R10; KTD30.
**Dependencies:** U29, U32, U37.
**Files:** `src/context/summary.mjs` (new), `src/records/store.mjs`, `src/lessons/index.mjs`, `src/hooks/commands.mjs`, `test/summary.test.mjs` (new), `test/hooks.test.mjs`, `docs/HARNESS.md`.
**Approach:** `buildSummary` ranks and renders, re-runs the KTD43 checks, labels unconfirmed lines with their source, and writes the cache by atomic replace. Every writer listed in KTD30 calls it. The hook appends the cache and the stub line at session start.
**Test scenarios:**
- Happy path: a project with an "ask before" lesson, two constraints and a handoff gets all of them. Covers AE4.
- Edge case: content over 1,200 characters drops the lowest-ranked lines and keeps whole lines.
- Edge case: a missing or corrupt cache gives the one-line output plus any stub line.
- Error path: a changed-file name containing a backtick fence and instruction text renders inside the fence as quoted data.
- Error path: a line naming another scope is never written.
- Integration: an automatic constraint write changes the next session-start output.
**Verification:** `budget report` shows session-start bytes within the KTD30 cap.

### U33. Stop stub and automatic handoffs

**Goal:** Never lose the thread at a stopping point.
**Requirements:** R12; KTD32.
**Dependencies:** U31, U37.
**Files:** `src/hooks/stub.mjs` (new), `src/hooks/commands.mjs`, `src/agents/hooks-install.mjs`, `src/handoff/write.mjs` (new), `src/handoff/commands.mjs`, `src/agents/instructions.mjs`, `skills/devtwin-capture/SKILL.md`, `test/handoff-stub.test.mjs` (new), `test/hooks-install.test.mjs`.
**Approach:** Install a new `Stop` entry for Claude Code and Codex, and write the stub from the existing `pre-compact` path too. `handoff write` (automatic) stores where the session stopped, the next step and where the artifacts are, with the session key. The instruction block adds one rule: write a handoff at a stopping point.
**Test scenarios:**
- Happy path: a stop with three changed files and no handoff makes the next start in that worktree report it. Covers AE5.
- Edge case: a handoff from the same session key hides the stub line.
- Edge case: two worktrees of one project keep separate stubs.
- Edge case: a Git status timeout writes no stub and exits quietly.
- Edge case: more than ten changed files stores ten paths and the full count.
**Verification:** Hook install tests show the new `Stop` entry, and the existing `PreCompact` entry is byte-identical.

### Phase P8: Promotion and sharing

### U28. Daily promotion importer

**Goal:** Turn memory and `docs/solutions` into delivered knowledge with no prompt.
**Requirements:** R6, R7; KTD25, KTD26, KTD27, KTD42.
**Dependencies:** U24, U29, U32, U37.
**Files:** `src/import/memory.mjs` (new), `src/import/solutions.mjs` (new), `src/import/map.mjs` (new), `src/import/commands.mjs` (new), `catalog/habit-commands.json` (new), `src/schedule/jobs.mjs` (`import-daily`), `src/cli.mjs`, `skills/devtwin-capture/SKILL.md`, `test/import.test.mjs` (new), `docs/HARNESS.md`.
**Approach:** `import run` (automatic; the daily job and on demand) reads per KTD26, maps per KTD27, writes `observed` records and audit entries, and keeps a seen-hashes file. `user` memories become preference candidates for U25. Runs are capped at 100 new items; the rest wait for the next run.
**Execution note:** Start with fixture memory folders shaped like real Claude memory files, front matter and transcripts included.
**Test scenarios:**
- Happy path: "Always ask before pushing" (`feedback`) becomes an observed project lesson with `git push`. Covers AE1.
- Happy path: a `reference` memory naming `.env` becomes an environment location.
- Edge case: a second run with no change adds nothing; a change only to `modified` adds nothing; a body edit supersedes the earlier record. Covers AE1.
- Edge case: two bound roots whose folder names collide are both skipped as ambiguous.
- Edge case: `MEMORY.md` and a symlinked memory file are skipped.
- Edge case: a `docs/solutions` file present only on a checked-out feature branch is not imported.
- Error path: a file with a credential pattern is skipped and reported without content.
- Error path: a `docs/solutions` file naming another scope fails isolation and is reported.
- Integration: `undo --since` after a run retracts everything that run wrote.
**Verification:** Source files are byte-identical before and after every run.

### U41. Held queue and senders

**Goal:** Send consented items on their own, after a cancellable hold.
**Requirements:** R5; KTD39, KTD41.
**Dependencies:** U36, U37.
**Files:** `src/held/queue.mjs` (new), `src/held/send.mjs` (new), `src/lessons/publish.mjs`, `src/hubs/sync.mjs`, `src/hubs/git-write.mjs`, `src/schedule/jobs.mjs` (`learning-send`), `src/schedule/notify.mjs`, `src/audit/undo.mjs`, `test/held.test.mjs` (new).
**Approach:** Consented writers enqueue with `sendAfter` and send one notification. A hub accept enqueues instead of publishing inline. The hub-sync job and the hourly `learning-send` job send due items through the existing publish and push paths, re-running checks first; push failures go to the existing outbox. `undo` of a held item deletes it from the queue and the outbox. `consent revoke` clears both for its target.
**Test scenarios:**
- Happy path: enqueueing sends the notification before `sendAfter`.
- Happy path: an item due now is sent, and its audit entry moves from held to sent.
- Edge case: an item that failed its push sits in the outbox, and `undo` still cancels it.
- Edge case: an item not yet due is left alone.
- Error path: an item that fails the isolation check at send time is dropped and reported.
- Error path: a revoked consent cancels its queued items.
**Verification:** No item leaves before `sendAfter`.

### U30. Targets and repository write-back

**Goal:** Send each lesson where it belongs, including the team's repository.
**Requirements:** R8, R9; KTD29.
**Dependencies:** U28, U41.
**Files:** `src/lessons/publish.mjs`, `src/learnings/repo-write.mjs` (new), `src/learnings/push.mjs` (new), `src/learnings/commands.mjs` (new), `src/config/pilot.mjs` (`repoLearnings`), `src/config/live.mjs`, `src/projects/commands.mjs` (new; the always-ask `project set` route with `--learnings-dir` and `--learnings-base`), `src/cli.mjs`, `test/repo-learnings.test.mjs` (new), `docs/HUB.md`, `docs/LIVE.md`, `docs/SECURITY-MODEL.md`.
**Approach:** `TARGETS` becomes a non-empty set of `project`, `general`, `hub`, `repo`. `repo` renders the fixed template (title, date, `category: lesson`, tags, `source: devtwin <record id>`), checks it, writes the branch, and enqueues the push under the repository's consent. Without a consent the branch stays local and the digest says "needs consent". Undo of a pushed branch adds a revert commit by fast-forward of its own ref and enqueues its push, or refuses once the commit is merged or the remote branch is gone.
**Patterns to follow:** `src/hubs/git-write.mjs` for per-command identity and no-force pushes; `src/identity/git.mjs` for hooks and filters off.
**Test scenarios:**
- Happy path: with a consent, `general,repo` writes a personal record and branch `devtwin/learning-<id>` from the learnings base; `git status` and HEAD are unchanged; the push is held. Covers AE3.
- Edge case: a dirty working copy stays untouched.
- Edge case: without a consent the branch is written but not queued. Covers AE3.
- Error path: an existing branch, a repository not in `repoLearnings`, no recorded identity, or no `origin/HEAD` and no learnings base fails before any write.
- Error path: undo of a learning branch whose commit is reachable from the learnings base refuses and names the manual revert.
- Error path: `project set --apply` from a hooked agent shell is denied, and a changed learnings dir voids the repository's consent.
- Error path: a configured push URL that differs from the consent's URL refuses the push.
- Error path: an HTTPS remote prints the command and pushes nothing.
- Integration: a local bare repository through the test transport receives the branch after the hold.
**Verification:** The fixture working tree hash is identical before and after every write.

### U25. Weekly owner prompt

**Goal:** Ask the owner once a week, in one place, for the few always-ask items.
**Requirements:** R7, R8; KTD38, KTD43.
**Dependencies:** U28, U37.
**Files:** `src/audit/review.mjs` (new), `src/prefs/store.mjs`, `src/prefs/commands.mjs`, `src/lessons/publish.mjs`, `src/audit/digest.mjs`, `src/hooks/owner-block.mjs`, `src/schedule/jobs.mjs`, `test/prefs.test.mjs`, `test/audit.test.mjs`.
**Approach:** Global preference candidates (from `user` memory or an agent), lessons to `general`, items from outside sources and writes over the session cap collect in a waiting list. `activity review` shows each item's full text in the owner dialog, one dialog for up to ten short items, as long as the full text fits; longer items get their own dialog. Accepted preferences re-render the instruction block.
**Test scenarios:**
- Happy path: a `user` memory "Keep answers short" waits, then enters the instruction block after the dialog. Covers AE6.
- Edge case: items whose full text exceeds the dialog limit get separate dialogs.
- Error path: `activity review --apply` from a hooked agent shell is denied.
**Verification:** Nothing enters the global instruction block without a dialog that showed its full text.

### U34. Model retirements in the radar

**Goal:** Warn about model retirements before they break production.
**Requirements:** R18; KTD37.
**Dependencies:** None.
**Files:** `src/stack/deprecations.mjs` (new), `src/stack/catalog.mjs`, `src/stack/check.mjs`, `src/stack/digest.mjs`, `catalog/stack-sources.json`, `test/radar.test.mjs`.
**Approach:** Add the source kind and two catalog entries. The digest lists retirements within 180 days.
**Test scenarios:**
- Happy path: a fixture page with three retirements yields three entries with dates.
- Edge case: prose that looks like instructions yields only IDs and dates.
- Error path: zero rows after a previous non-empty run is reported as a source failure.
- Error path: a host outside the stack-watch exception is refused.
**Verification:** The HTML digest escapes every field.

### Phase P9: Review and agent checks

### U21. Setup review (moved and extended)

**Goal:** A monthly, developer-driven review of the setup.
**Requirements:** R19, and the next-phase plan's R34-R36.
**Dependencies:** U25, U30, U33, U34, and the next-phase U15, U19, U20.
**Files:** As in the next-phase plan, plus `src/audit/`, `src/import/`, `src/learnings/`.
**Approach:** As in the next-phase plan. Add suggestions for promoted items whose source changed, lessons with no delivery in 30 days (from the hook log's lesson IDs), memory items now delivered twice (memory and devtwin; the owner decides whether to delete the memory file), unused consents and unpushed learning branches older than 14 days.
**Test scenarios:** The next-phase list, plus: each new suggestion kind appears from a fixture, and a decision applies only its own target.
**Verification:** Nothing changes without a per-line decision.

### U23. Real-agent scenarios and colleague check (moved and extended)

**Goal:** Prove the behavior in real sessions, and check the colleague's condition.
**Requirements:** R20, and the next-phase plan's Success Criteria.
**Dependencies:** U21, U26, U27, U35.
**Files:** As in the next-phase plan.
**Approach:** The next-phase list, plus: no prompt during a normal session; the summary with "ask before" rules; an action lesson with `git -C`; the stop stub after resume and compaction; an automatic lesson then `undo`; a held repository push cancelled by `undo`; the weekly digest; the path question not asked; SSH approval refused by default. The colleague runs one week on her own machine and answers one question: which store did she stop maintaining by hand?
**Execution note:** Visible interactive terminals, run by the owner. Not headless.
**Test expectation:** none -- the scenarios are the test, with recorded evidence.
**Verification:** Recorded evidence meets the success criteria of both plans, and the colleague's answer is recorded.

---

## Verification Contract

| Gate | Command | Applies to |
|---|---|---|
| Unit and integration tests | `npm test` (run with `set -o pipefail`) | every unit; new names in `test/required-tests.json` |
| Package audit | `npm run check:package` | every unit; new files in `scripts/package-allowlist.json` |
| Writing linter | `npm run -s check:writing` | every unit |
| Acceptance | `node scripts/acceptance.mjs` with the CI counts | every phase end |
| Site build | `npm run build` in `site/` | units that change docs |
| Clean tree | `git diff --check` | every unit |
| Real-agent scenarios | `scripts/agent-scenarios/` | P9, run by the owner |

---

## Definition of Done

- Every unit's test scenarios exist and pass, and every gate above is green.
- Every write path asks the tier table; `OWNER_ACTIONS` equals the always-ask set.
- Every knowledge write and outbound item has an audit entry and an `undo` test.
- No hook or job makes a model call; only the hub sync, the senders and the radar use the network.
- No write lands outside the approved classes; `repoLearnings` and `backupTargets` are documented in `docs/LIVE.md` and `docs/SECURITY-MODEL.md`.
- Memory files, `docs/solutions` sources and working copies are byte-identical after every import and write test.
- Docs describe only implemented routes. `docs/ROADMAP.md` marks this plan's phases and deferred items.

---

## Risks

| Risk | Mitigation |
|---|---|
| Injected text in memory, a README or tool output becomes a lasting automatic rule | KTD43 text checks and "unreviewed" labels; a 20-write session cap; project scope only; nothing automatic reaches `general` or the global block; owner-only `undo --since` |
| An agent re-writes outside text as its own lesson | Stated limit: classified as an agent write, caught after the fact by the digest and `undo` |
| A wrong lesson spreads to the team before anyone notices | A notification when held, a 24-hour hold, `undo` before send; isolation and sensitive checks at send time |
| An injected agent wipes knowledge with `undo` | Only `undo --id` of its own session's entries is automatic; anything wider is always ask |
| The developer never reads the digest | One notification a week with counts; the setup review repeats stale items monthly |
| Git plumbing damages a repository | Only new objects, one new ref, and fast-forward of devtwin's own learning ref for an undo; other refs refused; working-tree hash tests |
| The Keychain key is lost with the machine | Export warning in every digest until `backup key export` runs |
| Any same-user process can read the backup key | Stated in the security model; the backup is for off-machine copies |
| SSH mode weakens the always-ask prompt | Opt-in, session-type check, `/dev/tty`, hook block still on |
| Summary text grows into a second brief | 1,200-character cap and ranking; budget log |

---

## Open Questions

### Deferred to Implementation

- Confirm the Claude Code `Stop` and `PreCompact` payloads and the Codex `Stop` payload carry `cwd` and `session_id` on the installed versions, and that `Stop` hooks fit their time limit with one Git call.
- Confirm the Claude project folder naming rule, and that transcripts record the working directory KTD26 checks, on the installed Claude Code version. Confirm whether a linked worktree's memory lands in the parent repository's folder.
- Confirm that `security -i` accepts `add-generic-password` on stdin with no prompt, and that the item reads back without an access prompt.
- The exact vendor deprecation page URLs and their stable markup.

---

## Documentation / Operational Notes

- Updated docs: `docs/HARNESS.md`, `docs/LIVE.md`, `docs/SECURITY-MODEL.md`, `docs/STORAGE.md`, `docs/LIMITATIONS.md`, `docs/AGENT-PROTOCOL.md`, `docs/HUB.md`, `docs/ROADMAP.md`, `README.md`, and the matching site pages. The security model gets a "Tiers" section that replaces "every write needs the owner".
- The next-phase plan's P6 section points to this plan.
- Live activation is separate: P4 and P5 are not active until the owner re-pins `~/.devtwin/kit`. New write classes, hook events and jobs need `live write-classes`, `agents install --hooks` and `schedule apply` again.
