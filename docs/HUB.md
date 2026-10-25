# Organization hub

An organization hub is a Git repository that the developers of one organization share. devtwin keeps a local copy (a clone) of it. Accepted lessons and "working on" notes move between colleagues through the hub. All delivery reads the local clone, so the hook and `lesson match` never use the network. Only `hub sync` and a publish use it.

A scope joins at most one hub. A project in a scope without a hub runs in solo mode.

## Hub layout

The hub has one file per item:

| Path | Content |
| --- | --- |
| `hub.json` | `{ "hubId": "<id>", "schemaVersion": 1 }` |
| `lessons/<lsn_id>.md` | One lesson: a front matter line of JSON between two `---` lines, then the Markdown body |
| `notes/<handle>/<note_id>.json` | One note: the area, one line, the handle, the time and the expiry |
| `tombstones/<lsn_id>.json` | A request to remove a lesson, signed with a handle |

A developer adds or removes only their own files: their lessons, the notes in their own handle's folder and the tombstones they sign. devtwin refuses a write to any other path with `HUB_PATH_REFUSED`.

## Before you join

- The hub remote must use SSH: `ssh://host/path` or `user@host:path`. devtwin refuses HTTPS, `git://`, `file://`, local paths and transport helpers with `HUB_REMOTE_REFUSED`. An SSH login name such as `git@` is allowed. A password in the remote is refused.
- The live config must approve a hub root folder in the `hubRoot` write class. The clone goes to `<hub root>/<scope>`. Set it with `live write-classes --hub-root <folder>` ([LIVE.md](LIVE.md#set-the-write-classes)).
- For the scheduled sync, the live config must also approve `~/Library/LaunchAgents/devtwin.hub-sync.<scope>.plist` in the `launchAgents` write class.

## Join

`hub join` previews first. The preview checks that the remote answers (`git ls-remote` with a time limit) and shows the binding and the note consent that it records. Nothing is written.

```sh
node "$KIT/bin/devtwin.mjs" hub join --pilot "$LIVE_CONFIG" --scope <scope> --remote <ssh-remote> --handle <handle> --email <commit-email>
node "$KIT/bin/devtwin.mjs" hub join --pilot "$LIVE_CONFIG" --scope <scope> --remote <ssh-remote> --handle <handle> --email <commit-email> --apply --plan-fingerprint '<fingerprint>'
```

Run the apply only with explicit approval from the owner. The apply shows a macOS dialog with the remote, the handle, the commit email, the clone folder and the note rules. Nothing is written until you click Approve. Without a desktop session, the dialog denies.

- `--ssh-command <command>` sets a per-hub SSH command, for example to use the organization's own key. devtwin passes it to Git as `GIT_SSH_COMMAND`. Without it, devtwin uses `ssh -o BatchMode=yes -o ConnectTimeout=15`.
- `--hub-root <folder>` selects one of the approved hub root folders. Without it, devtwin uses the first one.

The apply clones with symlinks off, no submodules, no hook templates and only the SSH transport. It reads `hub.json` and binds the scope to its `hubId`. It records the handle, the commit email and the note consent in the store, at `config/hubs/<scope>.json`. A scope that already has a hub, or a hub that another scope joined, is refused with `CONFLICT`.

The note consent covers these rules. A note holds at most 10 repo-relative paths, one line in the form `<handle> on <branch> touching <area>, <area>`, the handle and the time. A note expires after 72 hours. The consent stores a digest of the rules. When the rules change, the consent is void.

## Identity and trust

Each commit names the recorded handle and email as per-command Git config. Global Git config, hooks and filters stay off. Agents show a hub lesson as "claimed by `handle:<handle>`", because the handle is a claim, not a proof. A tombstone removes a lesson only when its handle matches the lesson's author.

Hub identity rests on Git push access. Anyone who can push to the hub can add files under any handle. The handle and the email in a commit are not verified. Give push access only to the people whose lessons you want your agents to see.

Hub content is untrusted input from other people. devtwin reads each hub file through the no-follow, regular-file, size-capped reader. Git's own index must list the file as a regular file, so a committed symlink or submodule is refused before devtwin reads it. File size, file count and JSON depth have caps. Lesson text reaches agents only as fenced data with its claimed author, stripped of control characters and capped.

## Sync

```sh
node "$KIT/bin/devtwin.mjs" hub sync --pilot "$LIVE_CONFIG" --scope <scope>
node "$KIT/bin/devtwin.mjs" hub status --pilot "$LIVE_CONFIG" --scope <scope>
```

`hub sync` takes the `hub-sync` lock and fetches with a time limit. It pushes the items in the outbox, reads the hub files and rebuilds the lesson index with the hub as a source. A hub whose `schemaVersion` is newer than this kit supports is read-only: devtwin reads no lessons or notes from it, writes nothing to it and shows `HUB_SCHEMA_NEWER`.

When a push is rejected, devtwin fetches and rebases. It checks the item again and tries again, three times in all. It never force-pushes. After the last try, the item goes to the outbox in the store, at `state/hubs/<hubId>/outbox/`. Each sync tries the outbox again. Before each push, the item passes the sensitive-content check and the check against the names of every scope again. A note that is older than half its expiry is dropped instead of posted late.

`hub status` reads only local files and makes no network call. It shows the last sync time, the outbox size and the job state.

## Offline

When the fetch fails, `hub sync` keeps the old clone and the time of the last good sync. Delivery goes on from the old clone. When the last good sync is more than 24 hours old, `hub status` and `context brief` show "hub last synced N h ago".

## The hub sync job

The hub sync job is a user LaunchAgent that runs `hub sync --job` every 10 minutes. It has its own consent and its own off switch. The preview shows the plist path, the command and the interval:

```sh
node "$KIT/bin/devtwin.mjs" hub schedule --pilot "$LIVE_CONFIG" --scope <scope>
node "$KIT/bin/devtwin.mjs" hub schedule --pilot "$LIVE_CONFIG" --scope <scope> --apply --plan-fingerprint '<fingerprint>'
```

Run the apply only with explicit approval from the owner. It shows the owner dialog, writes the plist at mode 0600 and loads it with `launchctl`. At each start, the job command checks the live gate, the job's own flag and its last-run receipt. It skips a run within 9 minutes of the last one, so missed runs collapse into one run at wake. A disabled job makes no network call.

`hub schedule --off` removes the job, through the same preview and apply. When the job is off, notes and lesson updates stop for the scope until you run `hub sync` yourself.

The setup steps `hub-join` and `job-hub-sync` run the same commands. Without `--hub-remote`, setup skips the hub steps and the scope stays in solo mode.

## Leave

```sh
node "$KIT/bin/devtwin.mjs" hub leave --pilot "$LIVE_CONFIG" --scope <scope>
node "$KIT/bin/devtwin.mjs" hub leave --pilot "$LIVE_CONFIG" --scope <scope> --apply --plan-fingerprint '<fingerprint>'
```

Run the apply only with explicit approval from the owner. After the owner dialog, `hub leave` revokes the note consent, removes the hub sync job, turns delivery off and deletes the clone. It discards the items that are still in the outbox. Records in the personal store, the org home and the projects stay. What you already pushed stays in the hub.

## Publish a lesson

A lesson reaches the hub only when the owner accepts a proposal, or copies a personal lesson, in their own terminal. Agents write proposals with `lesson propose`. See [Agent protocol](AGENT-PROTOCOL.md#propose-a-lesson).

```sh
node "$KIT/bin/devtwin.mjs" lesson proposals --pilot "$LIVE_CONFIG" --scope <scope>
node "$KIT/bin/devtwin.mjs" lesson edit --pilot "$LIVE_CONFIG" --id <prop_id> --summary "<do or do not line>"
node "$KIT/bin/devtwin.mjs" lesson reject --pilot "$LIVE_CONFIG" --id <prop_id>
node "$KIT/bin/devtwin.mjs" lesson accept --pilot "$LIVE_CONFIG" --id <prop_id> --target hub
node "$KIT/bin/devtwin.mjs" lesson accept --pilot "$LIVE_CONFIG" --id <prop_id> --target hub --apply --plan-fingerprint '<fingerprint>'
```

Each command previews first. Run each apply only with explicit approval from the owner. `lesson edit` takes `--title`, `--summary`, `--body`, `--body-file`, and `--path`, `--package` and `--topic`, which replace the whole `match` block. Its preview shows the new lesson.

`--target` selects where the lesson goes:

| Target | Writes | Owner dialog |
| --- | --- | --- |
| `hub` | One file in the scope's hub | Yes |
| `hub+general` | The hub file and a record in your personal store | Yes |
| `project` | A lesson record in the proposal's project, or in `--project` | No |
| `general` | A record in your personal store | No |

- **Dialog.** For `hub` and `hub+general`, the apply shows a macOS dialog with the exact lesson text: the title, the do or don't line, the body and the match rules. Nothing is written until you click Approve. A denied or dismissed dialog writes nothing: no commit, no outbox item and no personal record, and the proposal stays pending. A lesson too long to show in full fails with `LIMIT`. Shorten it with `lesson edit`.
- **General.** Your personal store follows you to every organization. For this reason, a general target is checked against the names of every scope, also the lesson's own scope. The default target, `hub`, writes no personal copy.
- **Org copy.** The hub file is the organization's copy of the lesson. Accept writes no second copy to the org home in the store.
- **Identity.** The lesson ID is `lsn_` and a hash of the hub ID, your handle, the request ID and the creation time. The author is your claimed handle. The file's `localRecordHash` points back to the accepted draft. The full local record is never published.
- **Push.** Accept publishes one file and pushes it. A rejected push fetches, rebases and checks again, three tries in all. After the last try, the lesson goes to the outbox, and `hub status` counts it. The next `hub sync` pushes it.
- **Index.** After an accept, devtwin rebuilds the lesson index of the scope. A personal record is in every scope's index, so a general target rebuilds all of them.

### Copy a personal lesson to another hub

```sh
node "$KIT/bin/devtwin.mjs" lesson copy --pilot "$LIVE_CONFIG" --id <personal-record-id> --to-scope <scope>
node "$KIT/bin/devtwin.mjs" lesson copy --pilot "$LIVE_CONFIG" --id <personal-record-id> --to-scope <scope> --apply --plan-fingerprint '<fingerprint>'
```

Run the apply only with explicit approval from the owner. `lesson copy` publishes a lesson from your personal store to the hub of the target scope. It first checks the lesson against the names of every scope but the target, and fails with `ISOLATION` before the dialog. It then shows the owner dialog with the exact lesson text, and publishes through the same push and outbox path as accept.

## Owner actions

`hub join`, `hub leave --apply`, `hub schedule --apply`, `lesson accept` and `lesson copy` are owner actions. The devtwin hook denies them from an agent shell, also through terminal wrappers, and each one shows the owner dialog. The previews of `hub leave` and `hub schedule` stay open to agents. A stale `hub-sync` lock is released with `locks release --lock hub-sync`.
