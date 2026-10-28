---
title: Limitations
description: What devtwin does not do yet, what it has not been proven to do, and the known gaps to plan around.
---

devtwin is an early, local-first tool. This page lists its honest limits in one place so the rest of the docs don't have to hedge every paragraph.

## Platform and installation

- **macOS is the reference platform.** Linux is not a supported platform yet, although the test suite also runs there. Windows is unsupported.
- **Node.js 22.13 or later.** There are no third-party runtime dependencies.
- **Not on npm.** Run it from a checkout with `node bin/devtwin.mjs`. Don't use `npm install -g`, `npm link` or an unrelated package with the same name.
- The version reports `0.0.0-local`. There is no versioned release or upgrade-compatibility promise yet.

## Your data

- **Backups need a folder you approve.** In live mode, `backup create` and the daily job write encrypted archives only to an approved backup folder inside your home. Until you approve one, there is no backup: losing `~/.devtwin` loses every record, decision, journal and piece of evidence, and leaves installed skills unowned. A disposable pilot has no backup. See [Backup and restore](/docs/guides/live-mode/#backup-and-restore).
- **Backups stay on the machine unless you move them.** A copy off the machine needs a backup folder that a sync service or an external copy job saves. The backup key lives in the macOS Keychain; without `backup key export`, an archive cannot be restored on another machine.
- **Restore is a manual swap.** `backup restore` writes a new folder and never the live store. You move the restored folders into `~/.devtwin/store` by hand, with every agent session stopped.
- Onboarding copies some repository text (README summary, declared commands, environment names) into the store. It is protected only by mode 0700 and your disk encryption. A lost laptop can expose it.
- No sync and no multi-device synchronization, and no import from other personal setups yet. `live migrate` only moves a live setup made under devtwin's former name; see [Migrate from devctx](/docs/guides/migrate-from-devctx/).

## Security boundary

- Not a sandbox. The pilot fence limits what the CLI writes, not what your agent host can do.
- Hashes, digests and the approved live-config digest detect accidental changes, not deliberate tampering by your own user account.
- Same-user filesystem races remain possible between path checks and use.
- Content scanning is a tripwire. It can miss encoded secrets and arbitrary confidential prose.

See the [security model](/docs/security/security-model/).

## Agents and sessions

- **Hooks deliver lessons and a short summary, not the brief.** The [agent hook](/docs/guides/lessons-and-hooks/) delivers matching lesson lines, a [session summary](/docs/guides/lessons-and-hooks/#the-session-summary) of at most 1,200 characters at session start, and blocks owner-only commands. Nothing injects the full brief when a session starts; you or a skill pull it explicitly. When a session stops, the hook records only where the worktree stood. The next step comes from a handoff that the agent writes with `handoff write`, and an agent can skip it.
- **Fresh-session discovery is proven narrowly.** The first live activation, on one machine with one repository, showed fresh non-interactive Claude Code and Codex sessions finding the skills and resolving the project. Interactive sessions have not been checked yet, and one machine is not broad compatibility. Installing skill files alone does not prove a session uses them.
- Cursor reads `~/.agents/skills` and will see the skills, but is untested.
- `devtwin-setup` is not yet installed by `agents install`.
- **Preferences arrive after `instructions apply`.** An accepted or retired preference changes nothing in the agent files until you apply the instruction block again. The Claude Code block depends on Claude Code reading the `@<path>` import in `~/.claude/CLAUDE.md`. The injection check refuses common shapes, not every phrasing, so the owner dialog is the real review.
- CLI records name their caller in `recordedBy` from environment variables: `claude`, `codex` or `human`. This is a label, not proof of who ran the command. `record publish --apply` always acts as the controller; the CLI does not check who is running it.
- The bundled skills are checked for valid command routes, not for every flag they pass.

## Lessons, hooks and hubs

- **Tested against fixtures only.** Hub tests use local bare repositories behind a fixture SSH command. A real SSH host has not been checked.
- **Codex coverage.** The hook sees Codex edits through `apply_patch`, but not files that Codex reads through the shell. On Codex, a `post-tool` lesson arrives after the edit ran. Shell paths are a best-effort guess.
- **No lock on session caps.** Two hook calls in one session at the same time can both send a lesson, and both can post a note past the six-note cap.
- **Exact roots.** A root reached through another symlink or a moved checkout does not match. A folder bound in two scopes gets no lessons.
- **The owner-action block is text-based.** It reads command text, not a parsed shell command. A command built in a way the text does not show can pass, and a harmless command that names an owner action can be denied. Previews stay open to agents, so every hub owner action also shows the owner dialog as a second gate. It does not protect a session that runs without the hook, or an agent that edits its settings files.
- **The hub trusts push access.** Anyone who can push can add lessons and notes under any handle. devtwin does not verify the handle or the commit email.
- **Deleted text stays in Git.** `published delete` removes the file and adds a tombstone, but Git history and colleagues' clones keep the text. A history rewrite is a manual step for the hub admin.
- **Tombstones.** A machine that never synced while a lesson file was there cannot tie a later tombstone to its author. It never delivered that lesson, but it does not remember the tombstone.
- **Deleting a replacement brings back the old lesson.** When you delete the only replacement of a lesson, the replaced lesson reaches agents again.
- **Contested replacements.** Two replacements pushed before either client fetched both land. devtwin delivers both as `contested` and does not choose a winner.
- **Notes are slow.** A note moves only when `hub sync` runs on both machines: up to about 20 minutes with the hub sync job. A note that waits in the outbox for more than half its 72-hour expiry is dropped.
- **Note cleanup.** Each developer's devtwin deletes only that developer's expired notes. A hub with more than 5000 note files fails to sync with `DEVTWIN_LIMIT` until the admin prunes it.
- **One lost item.** A publish that stops between its commit and its outbox write can lose that one item.
- **The hold is a delay, not a review.** A held lesson that nobody cancels leaves after its hold. It leaves only when `hub sync` or the `learning-send` job runs, so a machine that sleeps sends late. A lesson whose consent became void stays held. A new grant does not release it: it stays held as `consent-changed` until you cancel it, or, for a learning branch, run `learning send --branch` again.
- **The import trusts the local base.** The daily import has no network, so it reads `docs/solutions` from the remote-tracking ref as your repository holds it. A process that runs as you can move that ref. The learning-branch push checks the base against the remote; the import cannot.
- **Long repository paths.** Claude Code shortens a very long folder name and adds a hash. devtwin does not compute that form, so such a repository reports its memory as `absent`. A folder with more than 200 transcripts, or a transcript over 8 MB, reports `ambiguous` with the reason `proof-capped`.
- **macOS only for owner actions and the jobs.** The owner dialog needs a macOS desktop session, so owner actions deny over SSH unless you opt in with `live approval --mode dialog-or-tty`. The hub sync, activity, backup and send jobs are macOS LaunchAgents.
- **Isolation checks match whole names.** A bare project short name without its scope prefix is not matched. Lessons for every organization (the `general` target) wait for the weekly `activity review`.

## Onboarding and briefs

- The scanner reads a fixed, small set of files plus any `--doc` you add. It is not general knowledge ingestion or summarization.
- Declared commands are never run. A brief does not prove a fact is true or that tests pass.
- The default onboarding request ID is derived from your flags, not from file contents. After the repository changes, pass a new `--request-id`, or onboarding replays the old result.
- Briefs are capped at 12 items and 24,576 body bytes; extra records are listed as omitted.

## Handoff export

- Holds any selected record whose text contains URLs, absolute or home paths (including leading-slash route literals), or control characters. It does not rewrite them.
- Fails on a packet over 32,768 bytes or more than 12 records; there is no truncation.
- Observes only the exporting worktree's current state. It is not a historical snapshot and proves nothing about application tests or deployment.
- Writes are exclusive but not atomic. Discard any packet with a missing or invalid footer.

## Personal harness, stack watch and radar

- Evaluated with synthetic fixtures only. How a live model behaves with `devtwin-setup` or a template-made skill is not evaluated.
- Installing a template-made skill into your real agent homes is not available yet.
- In live mode the stack watch and the radar run only under the `stackWatch` exception.
- Live requests are always unauthenticated, so GitHub allows roughly 60 of them an hour.
- The bundled stack catalog covers eight items and seven radar sources, and no vendor changelog feeds; add feeds with `--feed`. Two radar sources are vendor model deprecation pages, read only for model IDs and retirement dates.
- The deprecation extractor reads table rows only. If a vendor page loads its table with a script, moves or redirects, that source fails and reports no retirements.
- Radar ranking uses your stack and stated interests only. Package names that are in a project but not in your profile stack do not rank.
- The radar jobs use macOS launchd and `osascript`. On other systems you cannot install the jobs, and devtwin shows no notifications.
- The monthly review reminder counts waiting preference and lesson proposals only, until the setup review lands.
- Relevance is whole-word term matching: it can miss announcements and match unrelated ones.
- Nothing reads or sends Slack messages. Drafts saved with `draft save` cannot be sent later.

## Accounts and connectors

- No live connectors, OAuth, connected accounts or send operations. [Identity routing](/docs/guides/identity-routing/) is designed but not shipped.
- Scope files contain an `accounts` list that nothing reads yet.

## Skill builder and skill sources

- Installs go only to a **disposable pilot's** agent homes, not your real homes.
- The skill validator accepts a strict frontmatter subset; it is not a full YAML or Agent Skills validator. Its link check is advisory.
- Helper scripts are copied as inert text and never run, so their behavior is unverified.
- Skill export and publication are not available.
- Third-party acquisition stages only the exact files you select. It does not infer dependencies, licenses to redistribute, or install recipes. A selected `SKILL.md` may depend on files you left out.
- Pins are caller-supplied and unverified: devtwin does not prove a tag points at the commit or that the commit is in upstream history.
- Caps: 24 files, 128 KiB per file, 1 MiB per stage, 256 KiB per installed package. Large collections hit `DEVTWIN_LIMIT` with no fallback.
- `taste-skill` has no stable release, so its check → pin → stage workflow is unavailable.
- Every catalog source is installation-unverified. There is no weekly updater.
- Path rules reject some legitimate secret-looking file names, such as some `id_mapping` or database files.
- Default agent homes are protected automatically. Other custom discovery folders are not detected; add them to the pilot's `forbidden` list.

## Not covered

These are outside what devtwin does, even when it runs in the background:

- **A lesson line cannot stop a command.** The hook adds guidance to the agent's context. It never returns a deny for a lesson, so a matching command still runs. Rules such as "ask before you push" work only when the agent reads them before it decides.
- **Secrets printed to a terminal.** devtwin does not watch terminal output. The sensitive-text check runs only on text that devtwin stores or sends.
- **Commands that break when pasted.** devtwin does not check or repair shell commands for your shell.
- **Polling long jobs.** devtwin does not watch a job and tell you when it ends.

Automatic items are reviewed after they land: you read the weekly digest and reverse an item with `undo`. The `activity review` dialog answers approve or deny for all the items in it, so reject the items you want to drop with `--reject` first. An item too long for one dialog can only be rejected. An agent that writes outside text again in its own words makes an agent write, which only that later review catches. The cap of 20 automatic writes counts each session on its own, and writes with no session in one bucket per caller and UTC day. A caller that passes a new session for each write still stops at 100 automatic writes per UTC day. The caller label comes from environment variables. Backups go only to folders inside your home folder, so a copy off the machine needs a folder that a sync service copies.

## Development status

Skill-builder and skill-source feature work is frozen except for bug and safety fixes until the daily-use priorities ship. See the [roadmap](/docs/project/roadmap/).
