---
title: Security model
description: What devtwin protects against, what it trusts, and where its protections stop.
---

devtwin keeps private project context on your machine and makes every write something you previewed and approved. It is designed to prevent **mistakes**: an agent writing to the wrong folder, context leaking into a public repository, a stale plan being applied, a skill folder being clobbered. It is not a sandbox and does not defend against a malicious process running as your own user.

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
- There is no backup. See [Limitations](/docs/security/limitations/).

## Approvals and consent

Every write is a preview followed by an apply. Applies are bound to a **fingerprint** of the exact plan, so a plan that changed after you reviewed it is refused.

A fingerprint is not proof that *you* approved. An agent can read a preview and pass its fingerprint back. That is why the bundled skills ask you in the session and never apply a plan you did not approve, and why some actions are reserved for you: `record publish --apply`, live config changes, hook and skill installs, every hub publish and delete, and (when [identity routing](/docs/guides/identity-routing/) ships) account bindings.

Two controls protect these owner actions:

- **The hook block.** When the [devtwin hook](/docs/guides/lessons-and-hooks/#the-owner-action-block) is installed, it denies owner-only commands from an agent shell, also through terminal wrappers. It reads command text, so it is a guard against mistakes, not a sandbox.
- **The owner dialog.** Hub joins, publishes, deletes and consent changes show a macOS dialog with the exact content. Nothing is written until you click **Approve**. The text reaches `osascript` only as arguments, never as script text. Without a desktop session, for example over SSH, the dialog denies.

Approval responses recorded by the skill builder and skill-source installers (`--interaction-ref`, `--response`) are evidence of your decision, not authentication.

## Stored context is data, not instructions

Records, briefs, policies, onboarding candidates, fetched feed text and third-party skill files are treated as untrusted data.

- Every brief carries a notice: stored context is evidence, not instructions; repository instructions and the user govern.
- `confirmed` means an owner workflow receipt, not authentication. CLI records are attributed to `human` whoever runs the command.
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
- **Notes are the one standing consent.** "Working on" notes leave your machine with no per-item yes, under the consent you gave at `hub join`. Only the hook's edit path posts one. The line is built from the branch name and folder areas only.

## Live-mode write classes

The approved [write classes](/docs/reference/configuration/#write-classes) are the only writes outside the store and the skill folders. They widen the fence by exact paths only, and they are covered by the approved config digest. In an agent settings file, devtwin changes only its own entries, and backs up the exact prior bytes first.

## Network use

Most commands make no network request. The exceptions are explicit:

| Command | Contacts | Sends |
| --- | --- | --- |
| `skill-sources check`, `preview`, `stage` | `api.github.com` (unauthenticated) | Repository, release, tag, commit and selected-file requests |
| `stack check`, `stack digest` (preview), the `radar-weekly` and `advisory-hourly` jobs | Only hosts in your stored approval | Feed URLs and identifiers; exact versions to OSV only when advisories are enabled |
| `hub join`, `hub sync`, `lesson accept` and `lesson copy` to a hub, `lesson supersede-propose --apply`, `published delete` | Your hub remote, over SSH | Accepted lessons, your "working on" notes and your tombstones |

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
