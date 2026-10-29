# Security model

The pilot fence and private file modes reduce accidental writes and reading. Source reads hold a no-follow descriptor, compare its identity before and after reading, and recheck ancestor identity. A residual race remains: a malicious same-user process can swap an ancestor between path checks or before later use. This is not a sandbox.

The core has no automatic private-to-public synchronization. A chosen agent host may transmit selected context to its provider, and direct tools can bypass this CLI's routing and fake connector checks. G-REPO and G-HOME are narrow metadata tripwires, not byte identity.

The root-free `skill-sources catalog` route reads only the bundled public catalog. `skill-sources check` makes unauthenticated, read-only requests to the GitHub API for repository, release, tag and commit metadata. GitHub sees the caller's IP; its unauthenticated limit is roughly 60 requests per hour, and each check can use up to eight requests. These routes write no local files and make no installation or safety claim. Redirects, response sizes and time are bounded; no upstream code is downloaded or executed.

Acquisition preview is also root-free and reads only pinned commit/tree metadata. Stage requests selected blob JSON, validates strict base64, and verifies Git SHA-1 object hashes and SHA-256 bytes before private pilot writes. It never clones, extracts archives, follows redirects, reads authentication, invokes upstream code or probes a host binary. Commit/tree identity relies on GitHub HTTPS metadata; commit/tree objects and signatures are not reconstructed or verified. The caller's tag/commit observation remains explicitly unverified, including membership in upstream history rather than a fork network.

Acquisition adds a dataRoot-only guard to the existing pilot gate. Ancestors above pilotRoot must be real directories owned by root or the caller; shared writable ancestors must be sticky. PilotRoot and any intermediates to dataRoot must already exist, be caller-owned and not group/other-writable; their device/inode identities are pinned. dataRoot and acquisition directories must be caller-owned 0700 nodes. No existing directory is chmodded, no run is adopted, and no stage targets agentHomes. Known `.gemini`, `.cursor` and `.commandcode` homes are now protected alongside existing homes for every pilot route. Unknown custom discovery roots must be supplied in `pilot.forbidden`.

Receipt publication uses exclusive hardlink creation rather than replacement. Its pending-link removal rechecks invocation-owned inode and parents, but Node has no inode-conditional unlink: a same-user replacement between the check and unlink remains possible. The final receipt is never rolled back. Receipt hashes detect changes relative to the receipt; they are not signatures and cannot detect malicious replacement of both payloads and receipt. CLI acquisition errors suppress absolute filesystem paths and raw errno/response bodies while preserving bounded rate-limit hints.

Independent acquisition plan and actual-diff reviews passed, with no material implementation findings. Local fixture tests and a separate two-file public-source smoke verified preview, private disposable staging, byte hashes, inert file modes and offline inspection. This evidence does not establish source safety, host compatibility or installation readiness, and does not remove the documented same-user races.

Source installation adds separate content-bound and target-plan-bound user evidence. Supplied interaction references are not identity authentication; record hashes are not signatures against malicious same-user rewriting. Missing declarations/requirements block installation, and reviewed dependency/compatibility declarations remain user assertions. The exact content response retains `caller-supplied-unverified` pin acceptance. No acquired helper or host process is executed.

The source adapter preserves raw metadata/legal bytes and rejects ambiguous metadata envelopes; name-only checks are not full YAML validation. It shares B's executor/lock but keeps independent decisions/ownership. Source inventory requires exact 0600/0700 modes, hashes and directories; outputs are verified before marker publication. Matching foreign bytes are never adopted. Personal Codex planning adds a read-only competing shared-root conflict; source checks cover three explicit sandbox roots, not plugins or arbitrary host overrides.

Updates/restoration revalidate staging and ownership. Removal requires the exact current content decision and intact stored receipt/bytes/modes, but deliberately does not require intact staging or current catalog metadata. This permits removal after staging loss while preserving edits. Writes remain in place with partial journals, without atomic rollback or a multi-host transaction. Node path-based operations retain the documented same-user residual race.

## Record, Git and agent-home trust

These rules reduce accidental damage and make tampering visible. They are not a defense against a malicious same-user process, which can rewrite records, manifests and the registry together. The residual race described above is unchanged.

- Operation IDs are stamped only by onboarding. Public record APIs refuse them. Request IDs remain caller-chosen idempotency keys.
- A record is trusted only when three conditions hold. Its ID matches its scope, project and request ID. Any operation it claims lists it in a published manifest with the same hash. Its supersession list is well formed and acyclic. Otherwise `readSnapshot` reports it as corrupt. See the manual review step in [Storage](STORAGE.md).
- The secret tripwire refuses or skips credential-like text. It covers private key blocks (including PGP), `Authorization` headers, bearer tokens, `x-api-key` and other credential assignments, and JWTs. It also covers classic and fine-grained GitHub tokens, AWS access and temporary keys, Slack tokens, LLM provider, Stripe, Google and npm keys, and URL user info. Field names `password`, `token`, `secret`, `api_key`, `private_key`, `access_key` and `credential` are refused, and so are names ending in `_token`, `_secret` or `_password` or in camelCase `Token`, `Secret` or `Password`. It is a tripwire, not clearance: other formats pass.
- SHA-256 of the exact bytes is the source identity authority. Stored `mtimeMs` values are informational. Hashes detect change; they are not signatures.
- Git queries fail closed. Only exit 128 with "not a git repository" counts as "not a repository". Any other failure, including a timeout or a refused repository, is `GIT_QUERY_FAILED`. Git output, remote count and remote URL length are bounded with `LIMIT`.
- Agent-home writes require the installer's one named target home, which must be listed in `pilot.agentHomes`. Other mutators cannot write any agent home. In live mode `agentHomes` is empty, and the bundled installer instead writes only `devtwin-*` entries directly inside the live config's named skill folders; see below.

## Live mode

Live mode ([Live activation](LIVE.md)) relaxes the fence for exactly the paths a live config names. It does not make the kit a sandbox.

- Only the named skill folders and repositories are exempt from the "inside pilotRoot and not protected" rules. A skill folder must be exactly `<home>/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) or `<home>/.agents/skills`, must already exist and must have no symlinked ancestor below the home. The rest of each protected home stays protected.
- In a skill folder the installer writes only `devtwin-*` entries. It never creates, removes or chmods the folder or its parents, and never touches a foreign, symlinked, edited or unowned entry. A conflict blocks only that agent.
- An entry is removable only when its receipt matches a completed journal in this store for the same config ID.
- Live commands run only from the kit the live config names, clean and detached at its commit. The home is the process home, and a different home is refused.
- The approved config digest in the store catches accidental edits to `live.json`. It does not stop deliberate same-user tampering: the same user can rewrite the live config and the digest together.
- The rollback check compares a skill folder with the inventory taken before an install run. It fails on `devtwin-*` differences and lists foreign changes for the owner. It restores nothing.
- Cursor also reads `~/.agents/skills` and sees the installed skills. The skills keep every confirmation for any caller.
- Onboarding copies some client repository text into the store, protected by mode 0700 and disk encryption only. Backups are encrypted, but see [Backups](#backups) for what that protects.

## Live-mode exceptions

The approved write classes in a live config ([Live-mode exceptions](LIVE.md#live-mode-exceptions)) are the only writes outside the store and the named skill folders. They widen the fence by exact paths only.

- The six classes are `hubRoot`, `instructionTargets`, `hookTargets`, `launchAgents`, `backupTargets` and `repoLearnings`. Each path has a fixed shape. A `repoLearnings` path is the exact root of a listed repository; it allows Git objects and one new learning branch there, never a file write. A hub root or a backup folder is a folder inside the home. An instruction target is `CLAUDE.md`, `AGENTS.md` or a `devtwin*.md` file in the Claude or Codex folder. A hook target is `settings.json` or `hooks.json` in those folders. A launch agent is a `devtwin.<name>.plist` file in `~/Library/LaunchAgents`. Every other path stays refused.
- The classes are covered by the approved config digest, so an accidental change is refused with `GATE_REQUIRED`. As for the rest of the live config, this does not stop deliberate same-user tampering.
- Only `live write-classes` changes the classes, through a preview and an apply with its fingerprint. The new config passes every fence check before its digest is approved. The devtwin hook denies its `--apply` from an agent shell, as for the other owner actions.
- The fence accepts a class path only when the caller names that class. A record, draft or onboarding write cannot reach a class path.
- A disposable pilot can list classes too. Its file targets must have the same shapes inside a listed fake agent home, and its hub folders must be inside `pilotRoot`.
- A learning branch ([HUB.md](HUB.md#write-a-lesson-to-the-repository)) is written with Git plumbing only: `hash-object --no-filters`, `mktree`, `commit-tree` and `update-ref`, with hooks, fsmonitor and global config off. None of them reads the working tree or runs a filter, so a filter driver in the repository's config never runs. devtwin never changes the working copy, the index, HEAD or the current branch. It creates only its own `devtwin/learning-<id>` ref, and only when the ref does not exist. The one later move is an undo, which adds a revert commit to that ref by fast-forward.
- Hub commands write only inside an approved `hubRoot` folder, and `hub schedule` writes only its own `devtwin.hub-sync.<scope>.plist` in `launchAgents`. `hub leave` deletes only the scope's clone folder and that plist.
- Only `agents install --hooks`, `agents uninstall --hooks` and `hub schedule` edit a class file. The hook commands edit only the `hookTargets` files, and `hub schedule` only its plist. The shared edit step limits edits to developer-owned files to the devtwin marker block or devtwin's own JSON entries. The prior bytes are backed up byte for byte in the run folder first. The file is read without following links and checked again immediately before the replace, but the same-user residual race between that check and the rename remains.

## Backups

The backup ([Storage](STORAGE.md#backups)) protects copies of the store that you keep away from the machine. It does not protect data on the machine.

- The key is in your login Keychain as a generic password. Any process that runs as your user can read that item, as it can read the store itself. An agent session can read it too.
- The key never goes into a file or a command line. devtwin sends it to `/usr/bin/security -i` on standard input and reads it from the standard output of `security find-generic-password -w`.
- `backup create` is automatic. `backup restore` is an owner action: the hook denies its apply from agent shells, and the apply shows the owner dialog. Restore writes only a new folder inside an approved `backupTargets` folder and never the live store. It checks the whole archive in memory before it writes. The restored files are plain text, so a backup folder that a cloud drive copies also copies them.
- `backup key export` is always ask. The devtwin hook denies its `--apply` from an agent shell, and the apply shows the owner dialog. Run it in your own terminal, outside any agent session, because the key goes to that terminal. Store the key in a password manager.
- Anyone with the key and one archive can read the whole store. Keep the exported key apart from the archives.

## Organization hubs

The full guide is [HUB.md](HUB.md).

- Hub identity rests on Git push access. Anyone with push access can add files under any handle, and devtwin does not verify the handle or the commit email. Agents show hub lessons as "claimed by" the handle. A tombstone removes a lesson only when its handle matches the lesson's author.
- Hub remotes are SSH only. HTTPS, `git://`, `file://`, local paths, transport helpers and a password in the remote are refused. Hub Git calls allow only the SSH transport, keep global config, hooks and filters off, and pass the handle and email as per-command config.
- Hub content is untrusted input. Clones keep symlinks off and use no submodules. Each hub file is read through the no-follow, regular-file, size-capped reader, and only when Git's index lists it as a regular file. File size, file count and JSON depth have caps. Lesson text reaches agents only as fenced, attributed data.
- Outbound hub items pass the sensitive-content check and the all-scope name check before they are queued and again when they are pushed. devtwin never force-pushes.
- "Working on" notes are the one item that leaves the machine with no per-item yes, under the note consent that `hub join` or `note consent` records. Only the hook edit path posts one, at most six per session; no command posts a note. The line is built from the branch name and the areas only, and the checks above run before the note is queued. Colleague notes reach agents only as fenced, attributed data.
- `hub join --apply`, `hub leave --apply`, `hub schedule --apply`, `lesson copy --apply`, `published delete --apply`, `note revoke --apply` and `note consent --apply` are owner actions. The devtwin hook denies them from agent shells, and each shows a macOS dialog with the exact content.
- `lesson accept --target hub` holds the lesson with no dialog, but only while a valid `hub-publish` consent exists for the scope. The lesson leaves after the consent's hold time, unless the owner cancels it first. See [Tiers](#tiers). Their previews stay open to agents. The dialog text reaches `osascript` only as arguments, never as script text. Without a desktop session, the dialog denies.

## Tiers

`src/policy/tiers.mjs` holds one frozen table that gives each CLI route a tier. A test checks that every route in `src/cli.mjs` has a line, and that the always-ask routes match the routes that the hook denies. A `confirmed` or `disputed` record write is the exception: the hook cannot tell it from an `observed` write by its words, so only the owner dialog gates it.

| Tier | Who runs it | Examples |
| --- | --- | --- |
| Automatic | Agents and jobs, with no prompt | `record add` and `record supersede` of `observed` or `proposed` knowledge, `lesson accept --target project`, `lesson accept --target repo` (the local branch), `handoff write`, `handoff export`, `project onboard` |
| Consented | Agents and jobs, while a standing consent for the target is valid | `lesson accept --target hub`, the push of a learning branch, `learning send` |
| Always ask | The owner only, after the owner dialog | `activity review --apply`, `consent grant`, `consent revoke`, `project set`, `pref accept`, `lesson copy`, `hub join`, `instructions apply`, every `undo`, a `record add` or `record supersede` of `confirmed` or `disputed` knowledge or one that replaces a `confirmed` or `disputed` record, and the other owner actions |

- `lesson accept --target general`, alone or in a set such as `general,repo`, writes the other targets now and parks the general part in the waiting list of `activity review`. A lesson in the personal store reaches every organization, so only the owner's review writes it. The plan names it in `parked`. Any refused target still fails the whole accept before it writes anything.

## Weekly review

`activity review` is the one place where the owner answers the always-ask items. Its waiting list holds:

- Global preference candidates: the pending `pref` proposals, from an agent's `pref propose` or from a `user` memory that `import run` read. The proposal store is this part of the list.
- The general part of a `lesson accept`.
- A record write refused by the session or day cap. The waiting item keeps the draft. The audit log never holds its text.
- Items from content that devtwin fetched or synced itself. No automatic write path makes one today: `hub sync` delivers hub lessons from the clone, and the radar writes digests.

The last three are files at `stateRoot/review/<wait_id>.json`, in a folder at mode 0700 and files at mode 0600. Each is written with an exclusive, no-follow create under the review lock and removed when the owner answers.

- `activity review` previews every item with its full text. It writes nothing, and agents may run it.
- `--apply` with the plan fingerprint shows the owner dialog. The hook denies it from agent shells.
- One dialog holds up to ten items, as long as their full text fits the dialog limit of 2000 characters. An item that does not fit with others gets its own dialog. An item too long for any dialog stays waiting, and the owner can only reject it.
- The dialog answers approve or deny. Approving a dialog accepts every item in it. Denying leaves them all waiting.
- `--reject <id>` removes an item for good, after one dialog that lists the rejected titles.
- Each accept and each reject adds an audit entry with route `activity review` and actor `human` before it writes.
- An accepted preference becomes a personal `preference` record. The review then writes the instruction block again with no second dialog, but only when every target holds the block without the new preferences. Then the only new text is text the dialog showed. Otherwise the review writes nothing to the targets, and `instructions apply` shows the whole block first.
- An accepted general lesson becomes a personal `lesson` record. A record draft becomes an `observed` project record. The owner is the actor of both.
- The `activity-weekly` job sends one notification a week with the counts, and names `activity review` when items wait for it.
- A consent stores the target, the hold time in hours (1 to 168, 24 by default), the time it was granted and the digest of its rules. The rules list the checks that the consented action runs. A change to the rules changes the digest, and the stored consent is then void. A consented action with no valid consent fails with `APPROVAL_REQUIRED` and the message "Needs consent".
- There are two consent kinds. `repo-push` names the real path of a bound repository root. It also records the repository's push URL at grant time, and its rules include the project's learnings folder and base, so `project set` voids it. `hub-publish` names a scope that joined a hub. Consents live at `stateRoot/consents/<kind>/<sha256 of the target>.json`, in folders at mode 0700 and files at mode 0600, written by atomic replace under a lock.
- `consent list` is read-only. It also shows the note consent of each hub, which `note consent` and `note revoke` manage.
- Every `undo` is always ask. The `--session` that a caller passes cannot be proven, so it is shown in the plan and kept in the audit entry, and grants nothing. The hook denies `undo --apply` from agent shells, and the apply shows the owner dialog. An undo is never undone. An undo that stopped between its retraction and its restores resumes on the next run.
- `lesson accept --target hub` adds a `hub-lesson` audit entry (tier `consented`), then puts the lesson in the held queue. Nothing leaves the machine at accept time.
- A held item waits for the consent's hold time. One notification names the target and the title at once, and `activity --held` shows the full text. After the hold, `hub sync` or the hourly `learning-send` job runs the sensitive scan and the isolation check again before the push. An item that fails a check is dropped and reported. An item whose consent is gone or void stays held.
- Each held item records the grant it was queued under. The sender reads the consent again for each item, under the held-queue lock, and sends the item only under that grant. After a new grant, the item stays held with the reason `consent-changed`. `activity --held` shows the reason, `undo` cancels the item, and `learning send --branch` queues a learning branch again under the new grant.
- The audit log stays append-only. When an item leaves the queue, a `held-state` entry that names the item's entry records `sent`, `outbox`, `dropped` or `cancelled`.
- `undo` of a `hub-lesson` entry removes the item from the held queue, or from the outbox when its push failed. Once the lesson is on the hub, `undo` refuses and points to `published delete`, which the owner runs: the lesson is in the hub's Git history.
- A learning branch push goes to the consent's recorded URL, named in the command, never to a remote name. The item stays held while the repository's configured push URL differs from the recorded one.
- Every Git command of the push runs in a new bare repository at `stateRoot/tmp/learning-push-<random>` (mode 0700), which devtwin removes afterwards. It has Git's default config, no refs and no hooks, and reads the source repository's objects through `objects/info/alternates`. So the repository's own config cannot redirect the push or change what it runs: no `pushurl`, `insteadOf`, `pushInsteadOf`, `receivepack`, `uploadpack` or `push.followTags` applies. Global and system config, hooks and replace refs are off, and only SSH is allowed.
- Before the push, devtwin checks the commit in that repository: one parent, and a diff that adds the one lesson file and nothing else. A revert must remove that file and nothing else. It then reads the learnings base branch on the consent's URL. The commit's parent must be the remote tip, or an ancestor of a tip that is in the local objects. Otherwise the item stays held as `base-not-on-remote`, so a moved local remote-tracking ref cannot carry other commits out. The push names the commit by object ID, `<oid>:refs/heads/devtwin/learning-<id>`, and never forces. For an HTTPS remote, devtwin pushes nothing and prints the command for the owner.
- Every Git call devtwin makes sets `GIT_NO_REPLACE_OBJECTS`, so a replace ref cannot change the tree a learning commit is built on. The write checks the new commit the same way before it creates the branch.
- `undo` of a learning branch adds a revert commit on its own ref. A pushed branch gets the revert pushed after the hold. Once the lesson is in the learnings base, or the remote branch is gone or moved, `undo` refuses and names the manual `git revert`.
- `consent revoke` also cancels the target's held items and the outbox items that came from them. It takes the hub-sync, held-queue and consent locks in that order, cancels the items, then removes the consent. When a lock is busy, it stops with `BUSY` before it changes anything, and the owner runs it again. The consent rules include the held queue, so a consent granted before the queue existed is void and must be granted again.
- `paths confirm` is always ask. A confirmation makes skills stop asking for the kit and config paths, so an agent must not be able to write one. The hook denies `paths confirm --apply` from agent shells, and the apply shows the owner dialog with both paths. While the confirmed values match, the hook renews the kit receipt at session start. A changed kit HEAD, kit path, config path or config file ends the confirmation, and the receipt then is not renewed. Renewal also stops 90 days after the confirmation: the session-start line then asks for `paths confirm` again, which runs the full checks.
- An agent session makes at most 20 automatic knowledge writes. Writes with no `--session` count in one bucket per caller and UTC day, with the same cap. Each caller also makes at most 100 automatic writes per UTC day across all sessions. The write past either limit fails with `GATE_REQUIRED` and names the limit in `details.bucket`. Its draft is not lost: it waits for the weekly `activity review`, and `details.waiting` names the item.
- Automatic lesson and record text passes the plain-rule checks that preferences use, plus the sensitive and scope-name checks. Titles and summaries get every check. Bodies get the marker and override checks only, because a body can use Markdown structure and package names such as `@types/node`.
- Only the `import-daily` job writes as a devtwin job (actor `other`), which the session and day limits do not count. It passes its job context in the process; no argument or variable gives it to a CLI run. `import run` from a shell writes as its caller and counts toward the caller's limits. Its first write over a limit waits in `activity review`, and the run stops there.
- A record that a CLI write makes names its caller in `recordedBy`: `claude` when `CLAUDECODE` is set, `codex` when a `CODEX_` variable is set, and `human` otherwise. This is a label for the audit trail, not a gate: any process can unset those variables. A `confirmed` record needs a reviewer, and a `confirmed` or `disputed` write shows the owner dialog whoever runs it. Every record write, whatever its status, passes the text checks and adds an audit entry. Only `undo` writes a `retraction`; `record add` and `record supersede` refuse that kind.

## Owner answers over SSH

The live config key `approval` is `dialog` by default. `dialog-or-tty` is an opt-in that lets the owner answer an always-ask prompt on a terminal when there is no GUI session.

- The mode is one control plus a terminal check. It is not a second factor. A process that can read and write the owner's terminal can answer the prompt.
- GUI presence comes from the launchd session type (`launchctl managername`), never from `SSH_*` variables. In a GUI session (`Aqua`), or when the type cannot be read, the dialog is required.
- The terminal answer is used only when the caller is not an agent (no `CLAUDECODE` or `CODEX_` variable) and stdin is the SSH login's own terminal. That terminal is a TTY whose device is the one `SSH_TTY` names. Otherwise the prompt denies.
- This mode does not stop a process of the same user that drives a terminal, for example one that opens a pseudo-terminal and clears those variables. It is a convenience for an owner over SSH, not a barrier against agents. The `dialog` mode is the barrier.
- With no GUI session, devtwin opens `/dev/tty`, shows the cleaned dialog text and a random six-letter code, and reads one line. Only the exact code approves. A wrong answer, end of input, a 300-second timeout or no terminal denies. The prompt never reaches stdout, so the JSON result line stays the same.
- The hook still denies always-ask commands from agent shells. `live approval --apply` is itself always ask and shows the owner dialog.

## Preferences and the instruction block

- Preferences reach agents through user-level files only: `~/.claude/devtwin.md`, a marker block in `~/.claude/CLAUDE.md` and a marker block in `~/.codex/AGENTS.md`. Each must be an approved `instructionTargets` path. A repository's own instruction files are never a target.
- Preference text is checked at propose, accept and render time. It must be one plain rule: no Markdown structure, no devtwin markers, no `@` import and no text that tells the agent to ignore other instructions. It also passes the sensitive-content check and the check against the names of every scope.
- `pref accept --apply`, `pref retire --apply` and `instructions apply` are owner actions. The hook denies them from agent shells, and each shows the owner dialog with the exact text. Their previews stay open to agents.
- Preferences never enter a hub or a handoff packet. Handoff export reads project records only.

## Setup

`setup status`, `setup plan --step <id>` and `setup apply --step <id>` (and the `devtwin setup` terminal loop) add no write location. Each step wraps an existing command and its preview, and its apply needs the fingerprint of that preview.

- The steps that run an owner action are `skills-claude`, `skills-codex`, `write-classes-hooks`, `hooks-claude`, `hooks-codex`, `paths-confirm`, `backup-folder`, the hub and consent steps and the scheduled job steps. The devtwin hook denies `setup apply` for these steps from an agent shell, and denies the `devtwin setup` terminal loop.
- A setup batch (`setup apply --steps` or `--all-pending`) runs several owner steps after one owner dialog that lists every change. The hook denies it from agent shells. The batch passes each step an in-process grant in place of that step's dialog. The grant is bound to the batch fingerprint, the step and the step's fingerprint, stands for one dialog and ends with the step. No argument or environment variable can stand for one. A step whose preview changed after the approval stops the batch with `STALE_VERSION`.
- The terminal loop refuses to run without a terminal. A terminal prompt protects against accidents. It is not proof that the owner is present.
- The `sandbox` step reads the project scan and writes no agent setting. Env example files are read only when the source reader allows them, and only their key names are kept. Accepted recommendations become personal preference records in the store.

## Portable handoff boundary

Handoff export uses a selected-project projection, not the personal brief. It excludes preferences, policies, binding paths/remotes and structured account identities; unsafe selected text holds instead of being redacted. Strict final byte bounds and dataRoot-only exclusive writes preserve the pilot fence. Bodies are inert fenced text. Pattern checks cannot establish confidentiality or rights, and hashes do not authenticate evidence. Present observations are checked twice, but path-based non-atomic writes retain the same-user residual race. Invalid-footer artifacts must not be consumed or shared. See [HANDOFF.md](HANDOFF.md).

## Personal harness layer

The [personal harness layer](HARNESS.md) adds a personal profile, an announcement watch, private drafts and skill templates. It keeps the same trust limits.

- **Personal profile.** The profile is stored under `configRoot/profile/` with mode 0600, and its revision hashes catch accidental edits only. A same-user process can rewrite the revisions and the pointer together, so the profile is trusted only as far as the same-user boundary. The brief marks it as preference data, never permission, and never an override of repository instructions or the user. Handoff export excludes it. Validation refuses secret-named fields and credential-like text; that is a tripwire, not clearance.
- **Fetched text.** Fetched feed and release text is untrusted data, never instructions. The parser bounds depth, element count, entry count and field sizes, reduces HTML to plain text in linear time, and the digest quotes titles and excerpts inside fences. A link is rendered live only when it is `https` on the source's own host (the feed's host, or `github.com` for releases); other links are shown inactive. Matching is local, deterministic term matching; a match is not a safety or compatibility claim.
- **Feed URLs.** Under the feed URL rules, a feed URL must be `https`, with no user name, password, port or fragment. Its host must be a DNS name with at least two labels that is not an IP literal or `localhost`. Each request goes only to a host in the stored approval. The host is resolved first and refused if any answer is a private, loopback, link-local or reserved address, and the connection uses exactly the checked address. Redirects are not followed. Response size, total transfer, request count and time are bounded.
- **Requests.** Request content is limited to feed URLs and identifiers, plus exact versions to OSV only when advisories are enabled. Hosts still see the caller's IP address, the request time and the fixed user agent. A GitHub token can come only from organization identity routing's public-read binding, which is not built yet, so GitHub requests are unauthenticated today. No environment variable or record is read for a token.
- **Approvals.** The stack approval and pending digests are stored in `stateRoot` with record hashes that detect accidental change, not same-user tampering. An approval made under another pilot config counts as no approval.
- **Live mode.** The watch runs in live mode only under the approved `stackWatch` exception ([LIVE.md](LIVE.md#the-stack-watch-exception)). Every approved host must be in the exception, and each run is capped at the exception's request count (at most 50). Live requests send no credential. Each run is for one scope, so a digest never names another scope's projects.
- **Radar.** Radar sources come from the kit catalog and enter the approval like any other host. Ranking is local. A radar guide is a fixed template with the catalog name, the kind and the links; it never copies feed text. The HTML digest escapes all fetched text, has no script and declares a content security policy that loads nothing.
- **Schedules and notifications.** Each job has its own owner consent and off switch, and the hook denies `schedule apply` and `schedule off --apply` from agent shells. A run checks the live gate, the job flag and its receipt before any request. When the live gate refuses a run, the run writes only a failed receipt, and only into an existing private `schedule/receipts` folder under the config's state root. Notification text reaches `osascript` only as an argument: the script lines are fixed, and the text has no control characters, quotes or backslashes and is capped. Advisory alerts are limited to one for each advisory and three a day.
- **Drafts and templates.** `draft save` reads its body only from the inputs root, refuses sensitive content and writes a private file that is never sent. `skill template-seed` and `skill template-verify` write nothing; seeded files are written by the user and checked byte for byte.
