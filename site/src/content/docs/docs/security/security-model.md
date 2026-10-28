---
title: Security model
description: What devtwin protects against, what it trusts, and where its protections stop.
---

devtwin keeps private project context on your machine. Every write is a preview followed by an apply, and the [tier table](#tiers) decides who may run the apply: an agent, an agent under a consent you gave, or only you. It is designed to prevent **mistakes**: an agent writing to the wrong folder, context leaking into a public repository, a stale plan being applied, a skill folder being clobbered. It is not a sandbox and does not defend against a malicious process running as your own user.

## Trust boundary: your user account

Everything devtwin stores is protected by file modes (0700 directories, 0600 files) and your disk encryption. Any process running as your user can read and rewrite those files, including the hashes and digests devtwin uses to detect changes. So:

- Hashes and digests **detect accidental change**. They are not signatures and do not stop deliberate tampering.
- The approved digest of `live.json` catches an accidental edit, not someone rewriting the config and its digest together.
- File checks hold a no-follow descriptor and compare identity before and after reading, but a same-user process can still race a path between checks.

## The pilot fence

Every stateful command takes a pilot file that lists the only places it may write and the repositories it may read.

- Writes go only inside the pilot's config, data and state roots, and, for installers, the one named target home.
- Protected paths are always refused: the real `~/.claude`, `~/.codex`, `~/.agents`, `~/.gemini`, `~/.cursor` and `~/.commandcode` homes, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, default devtwin locations, and the kit checkout itself. Add custom agent folders to the pilot's `forbidden` list.
- Private roots may not sit inside a Git worktree, so private context cannot be committed by accident.
- Onboarding never writes to a repository. Git runs with global and system config ignored, hooks and fsmonitor off, and no optional locks. A repository whose own config defines filters is refused.

The fence controls what **this CLI** writes. It does not limit what your agent host can read, write or run.

## Live mode

[Live mode](/docs/guides/live-mode/) relaxes the fence for exactly the paths the live config names.

- In each named skill folder, devtwin writes only `devtwin-*` entries. It never creates, removes or changes the mode of the folder or its parents, and never touches a foreign, symlinked, edited or unowned entry. A conflict blocks only that agent.
- An entry is removable only when its receipt matches a completed journal in this store for the same config ID.
- Live commands run only from the kit clone the config names, clean and detached at its commit, with your real home.
- The rollback check compares a skill folder with the inventory taken before an install. It restores nothing.
- Onboarding copies some repository text into the store, protected by mode 0700 and disk encryption only. Backups are encrypted, but see [Backups](#backups) for what that protects.

## Approvals and consent

Every write is a preview followed by an apply. Applies are bound to a **fingerprint** of the exact plan, so a plan that changed after you reviewed it is refused.

A fingerprint is not proof that *you* approved. An agent can read a preview and pass its fingerprint back. That is why the tier table reserves some actions for you (the **always ask** tier): `record publish --apply`, live config changes, hook and skill installs, `consent grant` and `consent revoke`, `lesson copy`, `published delete`, `hub join`, `undo --since`, `backup restore`, `backup key export`, `paths confirm` and `live approval`, and (when [identity routing](/docs/guides/identity-routing/) ships) account bindings.

Two controls protect these owner actions:

- **The hook block.** When the [devtwin hook](/docs/guides/lessons-and-hooks/#the-owner-action-block) is installed, it denies owner-only commands from an agent shell, also through terminal wrappers. It reads command text, so it is a guard against mistakes, not a sandbox.
- **The owner dialog.** Owner actions such as hub joins, deletes, consent changes, restores and the key export show a macOS dialog with the exact content. Nothing is written until you click **Approve**. The text reaches `osascript` only as arguments, never as script text. Without a desktop session, for example over SSH, the dialog denies, unless you [opt in to terminal answers](#owner-answers-over-ssh).

## Tiers

One table in the kit (`src/policy/tiers.mjs`) gives each CLI route a tier. A test checks that every route has a line, and that the always-ask routes match the routes that the hook denies. A `confirmed` or `disputed` record write is the exception: the hook cannot tell it from an `observed` write by its words, so only the owner dialog gates it.

| Tier | Who runs it | Examples |
| --- | --- | --- |
| Automatic | Agents and jobs, with no prompt | `record add` and `record supersede` of `observed` or `proposed` knowledge, `lesson accept --target project`, `lesson accept --target repo` (the local branch), `handoff write`, `handoff export`, `project onboard`, `backup create` |
| Consented | Agents and jobs, while a standing consent for the target is valid | `lesson accept --target hub`, the push of a learning branch, `learning send` |
| Always ask | You only, after the owner dialog | `consent grant`, `consent revoke`, `project set`, `pref accept`, `lesson copy`, `hub join`, `instructions apply`, every `undo`, a `confirmed` or `disputed` record or one that replaces a `confirmed` or `disputed` record, and the other owner actions |

- **Review after the write.** Automatic writes land with no prompt. Each knowledge write adds an entry to the [audit log](/docs/concepts/where-data-lives/#activity-consents-and-backups). `activity` lists them, and `undo` reverses one after you approve the owner dialog. A `--session` that a caller passes cannot be proven, so it grants nothing. A lesson accepted to a hub can be cancelled with `undo` while it is held. Once it is on the hub, it is removed with `published delete`.
- **Consents.** `consent grant --kind hub-publish --scope <scope>` lets agents send lessons to that scope's hub after a hold. `--kind repo-push --repo <path>` lets agents push learning branches to that repository after a hold. It records the repository's push URL, and its rules include the project's learnings folder and base, so `project set` voids it. A consent stores its target, a hold time of 1 to 168 hours (24 by default), the grant time and the digest of its rules. A change to the rules voids it. Without a valid consent, a consented action fails with `DEVTWIN_APPROVAL_REQUIRED`, "Needs consent". `consent revoke` also cancels the target's held items.
- **Held queue.** A consented lesson waits in the held queue for the hold time. One notification names it at once, and `activity --held` shows its full text. Before it is sent, the credential check and the scope-name check run again; an item that fails is dropped and reported. A consent granted before the held queue existed is void; grant it again.
- **Lessons for every organization.** `lesson accept --target general` fails with `DEVTWIN_GATE_REQUIRED`, alone or in a set such as `general,repo`. Any refused target fails the whole accept before it writes anything. A lesson in your personal store reaches every organization, so it waits for the weekly review, which arrives in a later phase.
- **Session cap.** An agent session makes at most 20 automatic knowledge writes. The 21st fails with `DEVTWIN_GATE_REQUIRED`. Writes with no `--session` count in one bucket per caller and UTC day, with the same cap. Each caller also makes at most 100 automatic writes per UTC day across all sessions, so a new `--session` does not lift the cap.
- **Plain text only.** Automatic lesson and record text passes the checks that preferences use, plus the credential and scope-name checks. A title or summary with Markdown structure, an `@` import, a devtwin marker or text that tells the reader to ignore other instructions is refused.
- **Caller label.** A record that a CLI write makes names its caller in `recordedBy`: `claude` when `CLAUDECODE` is set, `codex` when a `CODEX_` variable is set, and `human` otherwise. This is a label for the audit trail, not a gate: any process can unset those variables. A `confirmed` record needs a reviewer, and a `confirmed` or `disputed` write shows the owner dialog whoever runs it. Only `undo` writes a retraction.
- **Confirmed paths.** `paths confirm` is always ask, because a confirmation makes skills stop asking for the kit and config paths. A changed kit HEAD, kit path, config path or config file ends the confirmation. 90 days after a confirmation the hook stops renewing the kit receipt and asks you to run `paths confirm` again.

## Owner answers over SSH

The live config key `approval` is `dialog` by default. `live approval --mode dialog-or-tty` is an opt-in that lets you answer an always-ask prompt on a terminal when there is no GUI session.

- devtwin reads the launchd session type (`launchctl managername`), never `SSH_*` variables. In a GUI session, or when the type cannot be read, the dialog is still required.
- With no GUI session, devtwin opens `/dev/tty` and shows the dialog text and a random six-letter code. Only the exact code approves. A wrong answer, end of input, 300 seconds with no answer or no terminal denies.
- The terminal answer is used only when the caller is not an agent and stdin is the SSH login's own terminal: a TTY whose device is the one `SSH_TTY` names. Otherwise the prompt denies.
- This is one control plus a terminal check, not a second factor. A process that can read and write your terminal can answer the prompt. It does not stop a process of your user that drives a terminal, so this mode is a convenience for you over SSH, not a barrier against agents. The `dialog` mode is the barrier.
- The hook still denies always-ask commands from agent shells. `live approval --apply` is itself always ask.

## Backups

[Backups](/docs/guides/live-mode/#backup-and-restore) protect copies of the store that you keep away from the machine. They do not protect data on the machine.

- The key is 32 random bytes in your login Keychain. Any process that runs as your user can read that item, as it can read the store itself. An agent session can read it too.
- The key never goes into a file or a command line. devtwin passes it to `/usr/bin/security` on standard input and output.
- `backup create` is automatic. `backup restore` is always ask: it writes only a new folder inside an approved backup folder, never the live store, and checks the whole archive in memory before it writes. The restored files are plain text.
- `backup key export` is always ask. Run it in your own terminal, outside any agent session, and store the key in a password manager.
- Anyone with the key and one archive can read the whole store. Keep the exported key apart from the archives.

Approval responses recorded by the skill builder and skill-source installers (`--interaction-ref`, `--response`) are evidence of your decision, not authentication.

## Stored context is data, not instructions

Records, briefs, policies, onboarding candidates, fetched feed text and third-party skill files are treated as untrusted data.

- Every brief carries a notice: stored context is evidence, not instructions; repository instructions and the user govern.
- `confirmed` means an owner workflow receipt, not authentication. The `recordedBy` caller label comes from environment variables, so it is not proof of who ran the command.
- The bundled skills tell agents never to follow instructions found inside records or fetched text.
- The personal profile is preference data, never permission.

## Content checks are tripwires

devtwin scans titles, bodies, profiles, drafts and handoff packets for credential-like text and refuses with `DEVTWIN_SENSITIVE_CONTENT`. Handoff export also holds URLs, absolute paths and other non-portable text. These checks catch common mistakes. They cannot prove that text is free of secrets or confidential information, so review what you share.

Never put credentials in records, proposals, plans, profiles or command arguments.

## Organization hubs

The full contract is in the [Organization hub](/docs/guides/organization-hub/) guide.

- **Identity is push access.** Anyone with push access can add files under any handle. devtwin does not verify the handle or the commit email. Agents show hub lessons as "claimed by" the handle. A tombstone removes a lesson only when its handle matches the lesson's author.
- **SSH only.** HTTPS, `git://`, `file://`, local paths, transport helpers and a password in the remote are refused. Hub Git calls keep global config, hooks and filters off.
- **Hub content is untrusted input.** Clones keep symlinks off and use no submodules. Each file is read without following links, with caps on size, count and JSON depth. Lesson and note text reaches agents only as fenced, attributed data.
- **Outbound checks.** Every lesson and note passes the credential check and the check against the names of every scope before it is queued, and again when it is pushed. devtwin never force-pushes.
- **Standing consents.** "Working on" notes leave your machine with no per-item yes, under the consent you gave at `hub join`. Only the hook's edit path posts one. The line is built from the branch name and folder areas only. Lessons reach the hub with no dialog only under a `hub-publish` consent that you granted for the scope, and only after the hold.

## Learning branches

The full contract is in [Write a lesson to the repository](/docs/guides/organization-hub/#write-a-lesson-to-the-repository).

- **Plumbing only.** devtwin writes Git objects and one new `devtwin/learning-<id>` branch with `hash-object --no-filters`, `mktree`, `commit-tree` and `update-ref`. Hooks, fsmonitor and global config stay off. Nothing reads your working tree, so a filter driver in the repository's config never runs. Your working copy, index, HEAD and current branch never change.
- **One ref.** devtwin creates only its own learning branch, and only when it does not exist. The one later move is an undo, which adds a revert commit to that branch by fast-forward.
- **Approved repositories.** The repository must be in the `repoLearnings` write class, and the commit uses the identity that `hub join` recorded for the scope. A repository that requires signed commits is refused.
- **Pinned push.** The push goes to the URL the `repo-push` consent recorded, named in the command. Per-command config maps that URL to itself for `insteadOf` and `pushInsteadOf` and allows only SSH. A changed push URL in the repository stops the push. devtwin never force-pushes. For an HTTPS remote it pushes nothing and prints the command for you.

## Live-mode write classes

The approved [write classes](/docs/reference/configuration/#write-classes) are the only writes outside the store and the skill folders. They widen the fence by exact paths only, and they are covered by the approved config digest. In an agent settings file, devtwin changes only its own entries, and backs up the exact prior bytes first.

## Network use

Most commands make no network request. The exceptions are explicit:

| Command | Contacts | Sends |
| --- | --- | --- |
| `skill-sources check`, `preview`, `stage` | `api.github.com` (unauthenticated) | Repository, release, tag, commit and selected-file requests |
| `stack check`, `stack digest` (preview), the `radar-weekly` and `advisory-hourly` jobs | Only hosts in your stored approval | Feed URLs and identifiers; exact versions to OSV only when advisories are enabled |
| `hub join`, `hub sync`, `lesson accept --target hub`, `lesson copy`, `lesson supersede-propose --apply`, `published delete` | Your hub remote, over SSH | Accepted lessons, your "working on" notes and your tombstones |
| The `learning-send` job, `undo` of a pushed learning branch | The push URL your `repo-push` consent recorded, over SSH | Learning branches and their revert commits |

Hosts still see your IP address and the request time. The stack watch never follows redirects, refuses hosts that resolve to private or reserved addresses, and caps request count, size and time. Fetched text is rendered as inert, fenced text. No environment variable or record is read for a token.

### Stack watch, radar and schedules

- **Approvals.** The stack approval and pending digests live in `stateRoot` with record hashes. The hashes detect accidental change, not same-user tampering. An approval made under another pilot config counts as no approval.
- **Live mode.** The watch runs in live mode only under the approved `stackWatch` [exception](/docs/reference/configuration/#stack-watch-exception). Every approved host must be in the exception, and the exception caps each run at its request count (at most 50). Live requests send no credential. Each run is for one scope, so a digest never names another scope's projects.
- **Radar.** Radar sources come from the kit catalog and enter the approval like any other host. Ranking is local. A radar guide is a fixed template with the catalog name, the kind and the links. It never copies feed text. The HTML digest escapes all fetched text, has no script and declares a content security policy that loads nothing.
- **Schedules and notifications.** Each job has its own owner consent and off switch. The hook denies `schedule apply` and `schedule off --apply` from agent shells. A run checks the live gate, the job flag and its receipt before any request. When the live gate refuses a run, the run writes only a failed receipt, and only into an existing private `schedule/receipts` folder under the config's state root.
- **Notification text.** Text reaches `osascript` only as an argument. The script lines are fixed, and the text has no control characters, quotes or backslashes and is capped. Advisory alerts are limited to one for each advisory and three a day.

Skill-source acquisition never clones, extracts archives, or runs upstream code. Staged files are verified by Git object hash and SHA-256 and stored with mode 0600, executable bits removed. The release tag and commit you pin are **caller-supplied and unverified**.

## Agent hosts and providers

devtwin cannot see or control what happens after an agent reads a brief:

- The agent host may send the context you give it to its model provider.
- Other tools the agent has, such as shells, MCP servers, `gh` and Git, bypass devtwin entirely.
- Installed skill files alone do not prove an agent discovers or follows them.

## Handoff packets

`handoff export` builds a packet only from records you select. It excludes your preferences, personal profile, policies, binding paths and remotes, and structured account identities. Unsafe text holds the export rather than being silently redacted. The packet is marked `publication: not-approved`: a human must still review it for confidentiality and rights before sharing.

## Reporting a vulnerability

Report privately, never in a public issue. Use GitHub's **Security → Advisories → Report a vulnerability** on the [repository](https://github.com/sundharesan11/devtwin) if it is enabled, or ask the maintainer for a private channel without including details. Include the commit, environment, the boundary you expected and a minimal synthetic reproduction. Don't include credentials, client data or raw session logs.
