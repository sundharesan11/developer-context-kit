---
title: Organization hub
description: Share accepted lessons and short "working on" notes with colleagues through a Git repository that your organization owns, under consents that you grant and can revoke.
sidebar:
  label: Organization hub
---

An **organization hub** is a Git repository that the developers of one organization share. devtwin keeps a local clone of it. Lessons that you accept, and short "working on" notes, move between colleagues through the hub. Their agents then get your lesson at the moment they touch the same area.

All delivery reads the local clone, so the hook and `lesson match` never use the network. Only `hub sync` and a publish do.

A scope joins at most one hub. A scope without a hub runs in solo mode: lessons stay on your machine.

This page is a summary. The full contract is in [docs/HUB.md](https://github.com/sundharesan11/devtwin/blob/main/docs/HUB.md).

## What the hub holds

| Path | Content |
| --- | --- |
| `hub.json` | `{ "hubId": "<id>", "schemaVersion": 1 }` |
| `lessons/<lsn_id>.md` | One lesson: a front matter line of JSON, then the Markdown body |
| `notes/<handle>/<note_id>.json` | One "working on" note |
| `tombstones/<lsn_id>.json` | A request to remove a lesson, signed with a handle |

You add or remove only your own files: your lessons, the notes in your own handle's folder and the tombstones you sign. A write to any other path fails with `DEVTWIN_HUB_PATH_REFUSED`.

## Before you join

- Create a private Git repository with a `hub.json` file, and give push access only to the people whose lessons you want your agents to see.
- The remote must use SSH: `ssh://host/path` or `user@host:path`. HTTPS, `git://`, `file://`, local paths and a password in the remote fail with `DEVTWIN_HUB_REMOTE_REFUSED`.
- Approve a hub root folder in the live config: `live write-classes --hub-root <folder>`. The clone goes to `<hub root>/<scope>`.
- For the scheduled sync, also approve `~/Library/LaunchAgents/devtwin.hub-sync.<scope>.plist` with `--launch-agent`.

See [Write classes](/docs/reference/configuration/#write-classes).

## Join

```sh
node "$KIT/bin/devtwin.mjs" hub join --pilot "$LIVE_CONFIG" --scope example \
  --remote ssh://git.example.com/example/hub.git --handle sample-dev --email dev@example.com
```

The preview checks that the remote answers and shows the binding and the note consent. Nothing is written. Add `--apply --plan-fingerprint <fp>` to join. The apply shows a macOS dialog with the remote, handle, commit email, clone folder and note rules, and writes nothing until you click **Approve**.

- `--ssh-command <command>` sets a per-hub SSH command, for example to use the organization's own key.
- `--hub-root <folder>` selects one of the approved hub roots.
- The clone has symlinks off, no submodules, no hook templates and only the SSH transport.
- Joining also records your consent to post "working on" notes, under the rules shown in the dialog.

## Sync

```sh
node "$KIT/bin/devtwin.mjs" hub sync --pilot "$LIVE_CONFIG" --scope example
node "$KIT/bin/devtwin.mjs" hub status --pilot "$LIVE_CONFIG" --scope example
```

`hub sync` fetches, pushes what waits in the outbox, deletes your own expired notes and rebuilds the lesson index. A rejected push is rebased and checked again, three tries in all. devtwin never force-pushes. After the last try, the item stays in the outbox for the next sync.

`hub status` reads local files only: the last sync time, the outbox size and the job state.

A hub with a newer `schemaVersion` than this kit supports is read-only: devtwin reads nothing from it and writes nothing to it, and shows the warning `HUB_SCHEMA_NEWER`.

### Offline

When the fetch fails, the old clone stays and delivery goes on from it. When the last good sync is more than 24 hours old, `hub status` and `context brief` show "hub last synced N h ago".

### The hub sync job

```sh
node "$KIT/bin/devtwin.mjs" hub schedule --pilot "$LIVE_CONFIG" --scope example
```

The job is a user LaunchAgent that runs `hub sync --job` every 10 minutes. It has its own consent and its own off switch, `hub schedule --off`. Missed runs collapse into one run at wake. Without the job, notes and lesson updates move only when you run `hub sync`.

### Leave

`hub leave` revokes the note consent, removes the job, turns delivery off and deletes the clone. Items still in the outbox are discarded. Your records stay. What you already pushed stays in the hub.

## Publish a lesson

A lesson reaches the hub only when a proposal is accepted under your `hub-publish` consent, or when you copy a personal lesson in your own terminal. Agents write proposals with `lesson propose`; see [Lessons and hooks](/docs/guides/lessons-and-hooks/#let-agents-propose-lessons).

Grant the consent once for the scope, in your own terminal:

```sh
node "$KIT/bin/devtwin.mjs" consent grant --pilot "$LIVE_CONFIG" --kind hub-publish --scope example
node "$KIT/bin/devtwin.mjs" consent grant --pilot "$LIVE_CONFIG" --kind hub-publish --scope example --apply --plan-fingerprint '<fingerprint>'
```

The grant shows the owner dialog with the scope, the hub and the rules. The setup step `consent-hub` runs the same command. `consent list` shows each consent, and `consent revoke` ends one.

After that, an agent or you can publish a proposal:

```sh
node "$KIT/bin/devtwin.mjs" lesson accept --pilot "$LIVE_CONFIG" --id prop_0123456789abcdef01234567 --target hub
node "$KIT/bin/devtwin.mjs" lesson copy --pilot "$LIVE_CONFIG" --id rec_0123456789abcdef01234567 --to-scope example
```

- `lesson accept --target hub` shows no dialog. While the consent is valid, the apply puts the lesson in the [held queue](#held-items). Without a valid consent, it fails with `DEVTWIN_APPROVAL_REQUIRED`, "Needs consent", and writes nothing: no held item, no commit, no outbox item, and the proposal stays pending.
- A kit update that changes the consent rules makes the consent void. Grant it again to review the new rules.
- The text passes the credential check and the check against every scope name before it is held, and again when it is sent.
- The hub file names you by your claimed handle. Your full local record is never published.
- `lesson copy` is an owner action. It publishes a lesson from your personal store to the hub of another scope, after the owner dialog. It first checks the text against the names of every other scope and fails with `DEVTWIN_ISOLATION` before the dialog.

### Held items

A lesson accepted to the hub waits in the held queue before it leaves your machine. The wait is the consent's hold time, 24 hours by default.

- **Notification.** One notification names the hub and the lesson title when it is held.
- **See it.** `activity --held` shows each held item with the full text that would leave. `activity` shows the accept with its state: `held`, `sent`, `outbox`, `dropped` or `cancelled`.
- **Send.** After the hold, `hub sync` and the hourly `learning-send` job send it. Each send runs the credential check and the scope-name check again. A text that now names another scope is dropped and reported, not sent.
- **Cancel.** `undo --id <audit entry>` removes the lesson from the queue, or from the outbox when its push failed. It shows the owner dialog. Once the lesson is on the hub, use `published delete`.
- **Grant.** A held lesson is sent only under the grant it was queued under. After you grant the consent again, it stays held as `consent-changed`; `activity --held` shows that in `blocked`, and `undo` cancels it.
- **Revoke.** `consent revoke` cancels the scope's held items, then removes the consent. When a send is running, it stops with `DEVTWIN_BUSY` and changes nothing; run it again.

```sh
node "$KIT/bin/devtwin.mjs" activity --pilot "$LIVE_CONFIG" --held
node "$KIT/bin/devtwin.mjs" undo --pilot "$LIVE_CONFIG" --id aud_0123456789abcdef01234567
```

## Write a lesson to the repository

A lesson can also go into the project's own repository as a learning branch, so the team reviews it there like any other change. devtwin opens no pull request.

```sh
node "$KIT/bin/devtwin.mjs" lesson accept --pilot "$LIVE_CONFIG" --id prop_0123456789abcdef01234567 --target project,repo
```

- **Branch.** devtwin writes one commit on a new branch, `devtwin/learning-<id>`. It adds one file, `docs/solutions/lessons/<slug>.md` by default, on top of the learnings base. The file has front matter with the title, the date, `category: lesson`, the tags and `source: devtwin <record id>`.
- **Your work stays.** devtwin writes Git objects and the new branch only. It never changes your working copy, the index, HEAD or your current branch.
- **Approval.** List the repository in the `repoLearnings` [write class](/docs/reference/configuration/#write-classes). The commit uses the handle and email that `hub join` recorded for the scope.
- **Place.** The learnings base defaults to the branch that `refs/remotes/origin/HEAD` names. Change the folder or the base with [`project set`](/docs/reference/cli/#project-set), an owner action. The base must be a remote-tracking ref. With no base, the write fails and names `project set`.
- **Push.** Grant `consent grant --kind repo-push --repo <root>` once. The grant records the repository's push URL. Each branch then waits in the held queue for the hold time, and the hourly `learning-send` job pushes it to that URL over SSH. It never force-pushes. Without a consent, the branch stays local and `activity` lists it as waiting. `learning send --branch` queues it after you grant the consent, and queues again a branch held under an earlier grant.
- **Push checks.** The push runs from a new, empty repository that reads your repository's objects but none of its config, refs or hooks, so no `pushurl`, `insteadOf` or `pushInsteadOf` setting can send it elsewhere. devtwin checks that the commit adds only the lesson file, and that its parent is on the remote's base branch. A branch whose base is not on the remote stays held as `base-not-on-remote`. The push names the commit by its ID.
- **HTTPS.** devtwin does not push over HTTPS. It prints the exact `git push` command for you instead.
- **Refusals.** An existing branch or file, a repository that requires signed commits, a changed push URL, or text that names another organization stops the write or the push.
- **Undo.** `undo --id <audit entry>` adds a revert commit to the learning branch, and pushes it after the hold when the branch was pushed. Once the lesson is in the learnings base, or the remote branch is gone, undo refuses and names the `git revert` to run by hand.

## Replace a lesson

A lesson can go stale, and a colleague can be right. When planned work conflicts with a delivered lesson, the agent stops and asks you. You follow the lesson, or you replace it:

```sh
node "$KIT/bin/devtwin.mjs" lesson supersede-propose --pilot "$LIVE_CONFIG" --scope example \
  --session ses_0123456789abcdef --predecessor lsn_0123456789abcdef01234567 \
  --title "Retry budget for the billing client" --summary "Do set a retry budget of three." \
  --body "The client now deduplicates charges." --path 'src/billing/**'
node "$KIT/bin/devtwin.mjs" lesson accept --pilot "$LIVE_CONFIG" --id prop_0123456789abcdef01234567 --target hub
```

- A replacement accepts to the `hub` target only, under the same `hub-publish` consent. The preview names the lesson it replaces.
- After the next `hub sync`, the old lesson stops matching on every machine and the replacement is delivered in its place.
- When another replacement reached the hub first, the send stops with `DEVTWIN_STALE_VERSION`. Nothing is published, and the held item is dropped with the reason `stale`.
- **Contested.** Two replacements pushed before either client saw the other both land. Both are delivered with a `contested: ` prefix, and the old lesson stops matching. devtwin does not choose a winner. The contest ends when one author deletes their replacement.
- A replacement with a wrong hash or an unknown lesson replaces nothing. It is delivered as a plain lesson.

### Replacement notices

When someone replaces one of your lessons, `hub sync` keeps a notice. `context brief` and the hook's session-start line show it. You have no veto: a replacement is live as soon as it is on the hub.

```sh
node "$KIT/bin/devtwin.mjs" lesson notices --pilot "$LIVE_CONFIG" --scope example
node "$KIT/bin/devtwin.mjs" lesson notices --pilot "$LIVE_CONFIG" --scope example --ack
```

An agent can list notices but cannot close one, so it cannot hide a replacement from you.

## Working on notes

A "working on" note tells colleagues that you are changing an area:

```text
sample-dev on feat/retry touching src/billing, src/payments
```

- **When.** The hook posts a note the first time a session edits an area, at most six per session. Only edit calls post: Claude Code `Edit`, `Write`, `MultiEdit` and `NotebookEdit`, and Codex `apply_patch`. No command posts a note.
- **Content.** The line is built from the branch name and the areas only, never from a prompt or agent text. An area is the first two folder levels of a path. A note holds at most 10 areas.
- **Checks.** The line passes the credential check and the check against every scope name before it is queued, and again when it is pushed.
- **Expiry.** A note expires after 72 hours. Each `hub sync` deletes your own expired notes.
- **Consent.** Notes leave your machine without a per-item yes, under the note consent you gave at `hub join`. Lessons do so only under a `hub-publish` consent.

When an agent's tool call touches the area of a colleague's active note, the hook adds one fenced block that names the colleague and the note. A session gets each note once and at most two note reports. Your own notes are never reported to you.

```sh
node "$KIT/bin/devtwin.mjs" note list --pilot "$LIVE_CONFIG" --scope example
node "$KIT/bin/devtwin.mjs" note revoke --pilot "$LIVE_CONFIG" --scope example --delete-notes
node "$KIT/bin/devtwin.mjs" note consent --pilot "$LIVE_CONFIG" --scope example
```

`note revoke` stops notes and discards queued ones; `--delete-notes` also removes your active notes from the hub. Lessons still arrive. When a kit update changes the note rules, the consent is void until you run `note consent` again.

## What you published

```sh
node "$KIT/bin/devtwin.mjs" published list --pilot "$LIVE_CONFIG" --scope example
node "$KIT/bin/devtwin.mjs" published delete --pilot "$LIVE_CONFIG" --scope example --id lsn_0123456789abcdef01234567
```

- `published list` reads the hub clone. It shows your lessons with their status (`active`, `superseded`, `contested` or `tombstoned`), your notes, your tombstones and the outbox.
- `published delete` removes your lesson file and adds a tombstone, or removes your note, in one commit. The preview always says: Git history and colleagues' existing clones keep the text. A history rewrite is a manual step for the hub admin.
- You can delete only your own items. Another author's lesson fails with `DEVTWIN_HUB_PATH_REFUSED`.
- When you delete the only replacement of a lesson, the old lesson reaches agents again. The preview says so.

A tombstone removes a lesson on other machines only when its handle matches the lesson's author. A machine that has seen a valid tombstone never delivers that lesson again.

## Owner actions

These commands need you at the keyboard. The devtwin hook denies them from an agent shell, and each one except `lesson notices` shows the owner dialog:

- `hub join`, `lesson copy`, `published delete`, `hub leave`, `hub schedule`, `lesson notices --ack`, `note revoke`, `note consent`, `consent grant`, `consent revoke` and `project set`, with `--apply`.

An agent can run the previews and show you what an action would do. `lesson accept --target hub` is not an owner action: it holds the lesson with no dialog while your `hub-publish` consent for the scope is valid.

Without a desktop session, the dialog denies, unless you opted in to [terminal answers](/docs/security/security-model/#owner-answers-over-ssh). `hub status`, `hub sync`, `note list`, `published list` and every preview stay open to agents.

## Trust model

- **Push access is the identity.** Anyone who can push to the hub can add files under any handle. devtwin does not verify the handle or the commit email. Agents show a hub lesson as "claimed by" its handle.
- **Hub content is untrusted input.** Each file is read without following links, with caps on size, count and JSON depth. A committed symlink or submodule is refused. Lesson and note text reaches agents only as fenced data with its claimed author.
- **Git history keeps everything.** A deleted lesson stays in the history and in colleagues' clones.

See [Limitations](/docs/security/limitations/#lessons-hooks-and-hubs) and the [security model](/docs/security/security-model/#organization-hubs).
