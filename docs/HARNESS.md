# Personal harness layer

devtwin can serve as a personal-harness template. You clone it, set up a small private personal profile, and turn generic skill templates into your own private skills through the existing skill builder. A manual announcement watch reports what the vendors and SDKs you build on have released.

The clone stays generic. Your profile, digests, drafts, approvals, seeded templates and skill workspaces live under the pilot's private roots, outside the clone. The package audit fails when such files are tracked (see [Keep the clone generic](#keep-the-clone-generic)).

This layer is evaluated with synthetic fixtures only. How a live model behaves with `devtwin-setup` or a template-made skill is not evaluated in this stage.

## Terms

- **Personal profile:** your own working preferences, stack and kind of work (`profile show`, `profile plan`, `profile apply`), stored under `configRoot/profile/`.
- **Client profile:** the onboarding template `templates/client-profile.md` for one project's context. The client profile is unrelated to the personal profile and unchanged.
- **Live config:** live mode's machine-level file `~/.devtwin/live.json`. See [Live activation](LIVE.md).
- **Skill template:** a generic folder under `templates/skills/` with named placeholders, a requirements stub, a design stub and a candidate `SKILL.md`. It is not an installed or discoverable skill.
- **Template-made skill:** your own private skill, created from a skill template through the skill builder and kept in your private skill workspace.
- **Announcement watch:** the `stack` routes that fetch vendor feeds and SDK releases for your declared stack and match them for relevance.

## Before you start

You need the same things as the [getting-started demo](GETTING-STARTED.md): Node.js `>=22.13.0`, Git and a macOS shell, and a pilot whose `init` has run. Use a disposable pilot first. Every stateful command takes `--pilot <pilot.json>`.

The private roots must not be inside a Git worktree. `profile plan` and `profile apply` refuse with `PATH_UNSAFE` when the configuration root is inside one.

## The personal profile

The profile holds only:

- `workKind`: the kind of work you do, one line.
- `workingPreferences`: `explanationStyle` (`concise` or `detailed`), `diagrams` (`prefer`, `avoid` or `neutral`), `autonomy` (`ask-first`, `balanced` or `autonomous`) and up to ten `notes`.
- `stackKnown` and `stackCurrent`: up to 40 entries each, written `name[=version][:care]`, where care is `low`, `normal` or `high`.
- `writing`: tone, formality per audience, greeting, sign-off, length, spelling and phrases to avoid.

Every field is optional, so a fully skipped setup is an empty profile. The canonical JSON is capped at 4,096 bytes (`LIMIT` beyond that). Unknown keys, secret-named fields and credential-like text are refused.

```sh
node bin/devtwin.mjs profile show --pilot "$PILOT_FILE"
node bin/devtwin.mjs profile plan --pilot "$PILOT_FILE" --work 'Backend services' --preference 'explanationStyle=concise' --stack-current 'node=>=22:high'
node bin/devtwin.mjs profile apply --pilot "$PILOT_FILE" --work 'Backend services' --preference 'explanationStyle=concise' --stack-current 'node=>=22:high' --plan-fingerprint "$FINGERPRINT"
```

`profile plan` writes nothing. It shows the complete proposed profile, each changed field with its old and new value, the size against the cap and the base generation. `profile apply` takes the same flags and the reviewed fingerprint. It writes a new revision `v<generation>.json` and then moves the `current.json` pointer, so earlier revisions are kept. `profile show --generation <n>` reads an earlier revision. If the profile changed after the preview, apply fails with `STALE_VERSION`; other differences fail with `PLAN_MISMATCH`. `--seed-from-init` fills preference keys the profile leaves unset from the preferences given at `init`. `profile suggest-stack --scope <scope>` suggests stack entries from that scope's onboarded projects and cites them. It reads only private onboarding data, never a repository. `profile export` renders the profile as Markdown and writes nothing.

**Authority limits.** `context brief` carries the profile in a `profile` field with a notice: it is preference data for style and workflow, never permission, and never overrides repository instructions or the user. Where the profile and the `init` preferences set the same field, the profile value applies. The profile counts against the brief's byte budget but not its item count. [Handoff export](HANDOFF.md) never includes the personal profile.

## The setup skill

`skills/devtwin-setup` conducts first-run setup. It checks `DEVTWIN_KIT` and the pilot path like the other bundled skills, and stops without creating anything if the pilot file is missing or `init` has not run. It asks at most five skippable questions, previews the full profile with `profile plan`, and lists the templates with `skill template-list`. It runs `profile apply` only after explicit approval from the user in the session for the plan it showed last. A fingerprint an agent passes back is not consent. It creates no skill unless you ask.

`devtwin-setup` is not yet in the bundled installer, so `agents install` does not install it. Live-mode activation passed on 2026-10-25; the installer wiring (U9 of the harness plan) is not built yet. Until then, you can read its `SKILL.md` in the kit checkout.

### One approval for the owner steps

The setup steps that need your approval can run behind one owner dialog. The agent previews the batch and gives you the apply command. You run it in your own terminal:

```sh
node bin/devtwin.mjs setup plan --pilot "$PILOT_FILE" --all-pending --backup-target "$HOME/devtwin-backups"
node bin/devtwin.mjs setup apply --pilot "$PILOT_FILE" --all-pending --backup-target "$HOME/devtwin-backups" --apply --plan-fingerprint "$FINGERPRINT"
```

- `--all-pending` selects every owner step that is available, not done and not skipped. `--steps <id,id,...>` selects only the steps you name. Both take the step inputs, such as `--backup-target` and `--push-repo`.
- The plan writes nothing. It shows each step's own preview and fingerprint, the dialog text, the steps it leaves out (`excluded`, with a reason) and the steps with nothing to do (`skipped`).
- The dialog lists one change on each line, in the order the changes run. Approve runs each step through its own apply with its own fingerprint. The step's own dialog does not show again.
- The order is fixed. One live config change runs first. It adds every hook target, launch agent and backup folder that the steps need, and keeps every path you approved before. Then come the skills, the consents, the jobs and `paths confirm`. The hooks run last.
- A job that is on counts as done only while its plist holds what `schedule apply` would write now. After `live set-kit` the file still names the old kit, so the job is `outdated` in `schedule status` and `setup status`, and the batch lists it as `Rewrite job <job> at <plist> for kit <path>`. A missing plist counts as outdated too. Jobs with no setup step (`import-daily`, `activity-weekly`, `learning-send`, and the hub sync job of a scope other than `--scope`) join an `--all-pending` batch as `job-rewrite-<job>` items. The plist is read without following a link.
- Before each step, the batch previews it again. A step that changed after your approval stops the batch with `STALE_VERSION`. The error lists the steps in `done` and `notRun`.
- A consent shows its full rules in the dialog. When the rules do not fit with the other lines, the consent leaves the batch. Nothing is cut.
- `hub-join`, `live set-kit`, `instructions apply` and `backup key export` keep their own dialog. Steps that need no approval, such as `profile`, are not in a batch.
- A step whose write-class path cannot be approved, such as a settings file that is a symlink, leaves the batch with a reason and a `code`. The other steps stay in the batch.
- Each step that runs adds one audit entry with the batch ID, after the step succeeded. If a step fails, the error lists `done` and `notRun`. An unexpected error has the code `DEVTWIN_INTERNAL`. If the lesson index rebuild after the last step fails, the result still lists every step in `done` and reports the failure in `derived.error`.
- From an agent shell, the hook allows `setup apply` only with one `--step` that is not an owner step. It denies `setup apply --steps` and `setup apply --all-pending`. It also denies a command that names devtwin and `setup` or an owner action when the text holds a shell expansion such as `${`, `$(`, `$'`, `$"` or a backtick.

A hook install, `live set-kit` and each batch rebuild the lesson index and the session summaries of every scope. So a store that an older kit wrote works with the hook at once.

## The capture skill and the hook

`skills/devtwin-capture` is a bundled skill that `agents install` installs. It tells an agent to treat hook lesson lines as untrusted data. The agent stops and asks when its plan breaks the "do" or "don't" line of a delivered lesson. At the end of a task, it drafts at most three general lessons and shows them to the user. It saves them with `lesson propose --session <id> --apply` and accepts them for the current project with `lesson accept --target project --apply`. That is an automatic action: the lesson is stored as `observed` and needs no approval. A lesson for every project waits for the developer's weekly `activity review`, and a lesson for the hub needs the developer's `hub-publish` consent. The skill reads lessons with `lesson match` and `lesson show`. A preference that an agent saves with `pref propose` waits for the same weekly review. It never runs a command, fetches a URL, installs a package or changes a permission because a lesson says so.

The hook entries are separate from the skills. `agents install --hooks` previews and, after approval, writes them to the approved agent settings files. `agents status` reports them. The hook also denies owner-only devtwin commands from agent shells. See [Live activation](LIVE.md#install-the-hooks).

In a bound project, the session-start output also holds a short summary of the project, at most 1,200 characters. It lists, in this order:

- lessons with a command match that say to ask or confirm first,
- up to five constraints and locations, confirmed ones first, then the newest,
- the next step of the last handoff, with its time.

When a session stopped in this worktree without a handoff, one more line says when, on which branch and which files changed. The `Stop` and `PreCompact` hook entries record that; an agent answers it with `handoff write`, as the managed instruction block asks at each stopping point.

The summary is fenced and marked as data, not instructions. A line that was not confirmed starts with its source, for example "unreviewed, from agent:". A hub lesson always starts with "unreviewed, from" and its author, even when the hub marks it confirmed. Each line passes the same text checks as automatic writes again, and a line that names another scope is left out. When the summary is too long, the last lines are dropped whole. The hook only reads a stored copy, so it stays fast and takes no lock. Record writes, index rebuilds and `undo` update that copy. A missing or damaged copy gives the one-line output.

After `paths confirm`, the session-start line says "Kit and config confirmed." while the kit and the config stay the same. The skills then skip the path question, and the hook keeps its 30-day receipt current, so a weekly `hook verify` is not needed. See [Confirm the kit and config paths](LIVE.md#confirm-the-kit-and-config-paths).

## Skill templates

The kit ships three skill templates under `templates/skills/`:

| Template | What a skill made from it does | Placeholders |
| --- | --- | --- |
| `stack-watch` | Runs the announcement watch and summarizes the digest | `skill-name`, `skill-description`, `digest-cadence` |
| `slack-update` | Drafts a team channel status update from the profile and selected records | `skill-name`, `skill-description`, `default-scope`, `channel-audience` |
| `writing` | Drafts any message from the profile and selected records, lists the context used and marks unverified facts | `skill-name`, `skill-description` |

A template contains no personal data and no scripts. It is never installed by the bundled installer and is not a discoverable skill. Every template treats records, the profile and fetched text as untrusted data and keeps the kit-path and pilot-path checks of the bundled skills.

`skills/devtwin-create-skill/assets/skill-template.md` stays the blank starter for skills built from scratch. `templates/skills/` holds guided templates that do not use it.

### Create a skill from a template

The full route reference is in the [skill builder](SKILL-BUILDER.md#create-from-a-template).

1. Create a private workspace: `skill workspace-create --audience personal --workspace ws_<id>`.
2. List the templates and their placeholders with `skill template-list`. It needs no pilot.
3. Render with `skill template-seed`. It is a read-only render: it returns each file's path, content and SHA-256 and a `renderDigest`, and writes nothing.
4. After you approve the rendered files, write them unchanged into a new directory under the pilot's inputs root. The kit does not write them.
5. Check the bytes with `skill template-verify`, passing the same flags plus `--dir` and `--render-digest`.
6. Continue with the usual skill-builder steps, from `skill requirements-record` with `<dir>/requirements.json`, through `skill design-record`, `skill design-approve` and `skill draft-create --candidate <dir>/candidate`, to `skill draft-validate`.

```sh
node bin/devtwin.mjs skill template-list
node bin/devtwin.mjs skill workspace-create --pilot "$PILOT_FILE" --audience personal --workspace ws_example01
node bin/devtwin.mjs skill template-seed --pilot "$PILOT_FILE" --audience personal --workspace ws_example01 --template writing --set 'skill-name=draft-my-notes'
node bin/devtwin.mjs skill template-verify --pilot "$PILOT_FILE" --audience personal --workspace ws_example01 --template writing --set 'skill-name=draft-my-notes' --dir "$SEEDED_DIR" --render-digest "$RENDER_DIGEST"
```

Templates with scope-value placeholders (`slack-update`'s `default-scope` and `channel-audience`) need a company-audience workspace in that scope: `--audience company --scope <scope>`. Each such value must be the scope itself or a `<scope>.<name>` inside it.

Installing a template-made skill into a real agent home is not available in this stage. A personal revision can still be installed into a disposable pilot agent home through the skill builder's existing install routes.

## The announcement watch

You run the watch by hand, or the weekly radar job runs it for you (see [Schedules](#schedules)). It reads `stackCurrent` from the profile and resolves each entry against the bundled catalog `catalog/stack-sources.json`, plus any overrides you give.

```sh
node bin/devtwin.mjs stack plan --pilot "$PILOT_FILE"
node bin/devtwin.mjs stack approve --pilot "$PILOT_FILE" --plan-fingerprint "$FINGERPRINT"
node bin/devtwin.mjs stack check --pilot "$PILOT_FILE"
node bin/devtwin.mjs stack digest --pilot "$PILOT_FILE" --scope acme
node bin/devtwin.mjs stack digest --pilot "$PILOT_FILE" --scope acme --apply --plan-fingerprint "$DIGEST_FINGERPRINT"
```

- `stack plan` makes no request and writes nothing. It lists every item, the sources found for it, and items that are not watched with the reason. It also lists each host with the exact feed URLs, identifiers and versions it would receive.
- `stack approve` stores the approval at `stateRoot/stack/approval.json`. The approval binds the item names and versions, feed URLs, identifiers, source groups, hosts, authentication mode and run mode. A plan with no source cannot be approved.
- `stack check` fetches from the approved hosts only and writes nothing. Any difference from the stored approval fails with `APPROVAL_REQUIRED` before a request is made. A change in care level alone keeps the approval.
- `stack digest` without `--apply` runs the watch, renders the digest and writes only a pending file under `stateRoot/stack/pending/`. The digest is Markdown, or HTML with `--format html` or with the profile's radar format set to `html`. With `--apply` and that fingerprint it makes no request. It writes the dated digest and records the reported entries in that scope's seen state, so the next digest lists them as previously reported.

Pass `--scope` only for the scope you mean. With a scope, the watch reads that scope's current accepted records to find project links, and the digest goes under `dataRoot/scopes/<scope>/digests/stack/`. Without one, it goes under `dataRoot/digests/stack/`.

### Relevance and source groups

Each fetched entry gets one relevance level, from local whole-word term matching only:

- **project:** it matches a term that also appears in a current record of the named scope. The digest cites the record IDs.
- **stack:** it matches one of your declared items or its catalog terms.
- **background:** it matched nothing.

The default source group, `announcements`, is vendor changelog feeds and GitHub releases. Three more groups are off by default and are enabled per plan with `--with`:

- `--with advisories`: OSV advisories for items with a package identifier. Only an exact version is sent.
- `--with lifecycle`: endoflife.date release cycles.
- `--with versions`: the latest version from the npm, PyPI or crates.io registry.

- `--with radar`: the radar sources in the catalog. See [The radar](#the-radar).

`--feed '<name>=https://…'` adds a feed for a declared item, and `--map '<name>=<kind>:<id>'` adds a GitHub, endoflife.date or package identifier. Overrides given once carry forward to the next plan until you give new ones or `--clear-overrides`.

### The radar

The radar adds three kinds of item to the releases of your stack: new agent tools and skills, approaches and design ideas, and adjacent tech to try. Its sources are the `radar` list in `catalog/stack-sources.json`. Turn it on with `--with radar` in `stack plan` and `stack approve`, so its hosts are part of the approval you review.

Set your interests in the profile. Each interest is a term, optionally with `:weak` or `:strong`:

```sh
node bin/devtwin.mjs profile plan --pilot "$PILOT_FILE" --interest 'Rust:strong' --interest 'event sourcing' --radar-format html
```

Radar items are ranked locally. A match with a project in the digest's scope scores 100 and a match with your stack scores 60. A strong interest adds 30, an interest adds 15 and a weak interest adds 5. An item below 15 is counted, not listed, so an item that matches only a weak interest is left out. The digest lists at most 30 radar items, grouped by kind, with the highest score first.

The radar also reports model retirements. Two catalog sources of kind `deprecations` name fixed vendor pages: the Anthropic model deprecations page and the OpenAI deprecations page. A fixed extractor reads only table rows under a header that names a model column and a retirement or shutdown column. From each row it keeps only a model ID and a date (ISO or "Month D, YYYY"). No other page text reaches the digest, so an instruction on the page cannot reach you or an agent. The digest lists the models that retire within 180 days under "Model retirements" in the radar section. The page URLs are part of the approval like feed URLs, and in live mode their hosts must be in the `stackWatch` exception.

Each applied digest records how many rows each page had. If a page that had rows before has none now, the run reports a source failure (`UPSTREAM_INVALID`, reason `rows-missing`), not "no retirements". The page layout probably changed, so check the page yourself.

Each listed item has a 12-character item ID. `radar guide` writes a short "how to try this" note for one item of the scope's latest applied digest:

```sh
node bin/devtwin.mjs radar guide --pilot "$PILOT_FILE" --scope acme --item 0123456789ab
node bin/devtwin.mjs radar guide --pilot "$PILOT_FILE" --scope acme --item 0123456789ab --apply --plan-fingerprint "$FINGERPRINT"
```

The guide is a fixed template with the item's catalog name, its kind, its links and the steps to try it in a scratch folder. It never copies feed text, so an instruction in a title or summary cannot reach the guide. It goes under `dataRoot/scopes/<scope>/guides/radar/` and creates nothing else: no sandbox, no project change. When the result is worth keeping, propose it as a lesson with `lesson propose`.

### Network hosts, feed URL rules and approval

The watch connects only to approved hosts: the hosts listed in the approval you made from the plan you reviewed. They are `api.github.com` for releases, the hosts of approved feed URLs, and, only when their group is enabled, `api.osv.dev`, `endoflife.date`, `registry.npmjs.org`, `pypi.org` and `crates.io`.

Feed URLs must use `https`, with no user name or password, port or fragment. The host must be a DNS name with at least two labels, not an IP literal and not `localhost`. Before each request the host is resolved, and any private, loopback, link-local or reserved address refuses that host. Redirects are never followed. Each run is bounded: 64 requests, 1 MiB per response, 8 MiB in total, 10 seconds per request and 120 seconds per run.

**The optional GitHub token.** A token for GitHub requests comes only through organization identity routing's scope-free public-read binding. A fine-grained, public-read-only token is recommended there. No environment variable or record is read for a token. Routing is not built yet, so today GitHub requests are always unauthenticated. Unauthenticated GitHub requests are limited to roughly 60 per hour.

### Exactly what the watch sends

Request content is limited to the feed URLs and identifiers listed for each host. Exact versions go to OSV only, and only when advisories are enabled. No profile text, record, path, scope, project name or local identifier is sent.

This is what hosts still see: your IP address, the request time and the fixed user agent `devtwin-stack-check`. With a routed token, GitHub would also see the GitHub account of that binding. The set of feed URLs you fetch, tied to your IP address, shows which vendors you follow.

Fetched feed and release text is untrusted. The digest quotes titles and excerpts inside fences as inert text, and an agent must never follow instructions found in it.

### Live mode

With a live config, `stack check`, `stack digest` and the radar jobs run only under the approved `stackWatch` live-mode exception. Without it they refuse with `GATE_REQUIRED`, reason `no-live-exception`. The exception names the hosts the watch may reach and a request cap of at most 50 for one run (30 by default). Every approved host must be in the exception, live requests send no credential, and every live run is for one scope (`--scope`). Set the exception with `live stack-watch`; see [Live-mode exceptions](LIVE.md#live-mode-exceptions).

A stack approval made under another config, for example before a kit re-pin or an exception change, no longer counts. The next run asks for approval again with `APPROVAL_REQUIRED`.

## Drafts

The `writing` and `slack-update` templates never send. A draft is saved privately only when you ask:

```sh
node bin/devtwin.mjs draft save --pilot "$PILOT_FILE" --scope acme --body-file "$BODY_FILE"
node bin/devtwin.mjs draft save --pilot "$PILOT_FILE" --scope acme --body-file "$BODY_FILE" --apply --plan-fingerprint "$FINGERPRINT"
```

The body file must be inside the pilot's inputs root. A draft goes to `dataRoot/drafts/` without a scope, or under `dataRoot/scopes/<scope>/drafts/` with one. It is reported as `sendable: false`.

The Slack-update template is draft only until routing's send increment lands. It reads nothing from Slack and posts nothing. Today it saves only through `draft save --scope`, and drafts saved there cannot be sent later. A path through routing's `connect draft`, for scopes with a bound Slack account, arrives with routing; this stage does not provide it.

## Agents and approval

Agents apply only after explicit approval from the user in the session. That covers `profile apply`, `stack approve`, `stack digest --apply`, `radar guide --apply`, `draft save --apply` and writing seeded template files. Agents never run `schedule apply`, `schedule off --apply` or `live stack-watch --apply`: the devtwin hook denies them. An agent shows the preview, waits for the user to approve that exact preview, and then passes the fingerprint. A fingerprint the agent passes back is not consent. Agents never run `record publish --apply`.

## Keep the clone generic

Personal state lives under the pilot's private roots, outside the clone:

| Data | Location |
| --- | --- |
| Personal profile and revisions | `configRoot/profile/` |
| Stack approval, pending digests and seen state | `stateRoot/stack/` |
| Digests | `dataRoot/digests/stack/` or `dataRoot/scopes/<scope>/digests/stack/` |
| Radar guides | `dataRoot/guides/radar/` or `dataRoot/scopes/<scope>/guides/radar/` |
| Items of the latest digest and advisory alert memory | `stateRoot/radar/` |
| Job flags and last-run receipts | `stateRoot/schedule/` |
| Drafts | `dataRoot/drafts/` or `dataRoot/scopes/<scope>/drafts/` |
| Seeded template files | a directory under `inputsRoot` |
| Skill workspaces | the skill builder's private workspace root |

`npm run check:package` applies a private-state pattern to every tracked or unignored file and to the package dry run. It fails on `profile/`, `digests/`, `drafts/`, `stack/` and `skill-templates/` paths, and on the existing records, operations, proposals, staging, runs and locks paths. These fail at the repository root or under `data/`, `state/`, `config/`, `inputs/` or `private/`, including below `scopes/<scope>/`. `templates/skills/` and kit source such as `src/profile/` are allowed. Home-directory paths, non-example emails and terms from a denylist you keep outside the repository (`--denylist <file>`) also fail.

**Versioning your private instance.** The kit does not sync anything. To keep history of your profile, digests or template-made skills, copy them or export them (for example `profile export`) into a separate private repository or dotfiles manager. The private roots themselves must stay outside Git, so never `git init` in them: the profile routes refuse to write inside a Git worktree.

## Schedules

These jobs run in the background for you. Each job is disabled by default. Each one is a user LaunchAgent with its own consent and its own off switch:

| Job | Runs | What it does |
| --- | --- | --- |
| `radar-weekly` | Once a week | Writes one digest for each scope and shows a short notification |
| `advisory-hourly` | Once an hour | Checks security advisories for your stack. An urgent (critical or high) advisory shows a notification at once: one for each advisory, at most three a day |
| `review-monthly` | Once a month | Reminds you that a [setup review](#setup-review) is available, with the count of its open lines. With no open line, it shows no reminder |
| `activity-weekly` | Once a week | Shows one notification with counts of what devtwin learned, holds for sending and has waiting for you. It names `activity review` when items wait for it. It does nothing else and makes no request |
| `backup-daily` | Once a day | Writes one encrypted backup of the store into the first approved `backupTargets` folder and keeps the newest archive of each of the newest 14 days. It makes no request and no model call |
| `import-daily` | Once a day | Runs `import run`: it imports new and changed Claude memory and `docs/solutions` files of your bound repositories as unreviewed project knowledge, at most 100 items a day. It makes no request and no model call |

```sh
node bin/devtwin.mjs schedule plan --pilot "$PILOT_FILE" --job radar-weekly
node bin/devtwin.mjs schedule apply --pilot "$PILOT_FILE" --job radar-weekly --plan-fingerprint "$FINGERPRINT"
node bin/devtwin.mjs schedule status --pilot "$PILOT_FILE"
node bin/devtwin.mjs schedule off --pilot "$PILOT_FILE" --job radar-weekly
node bin/devtwin.mjs schedule off --pilot "$PILOT_FILE" --job radar-weekly --apply --plan-fingerprint "$FINGERPRINT"
```

- `schedule plan` writes nothing. It shows the LaunchAgent path, the command it runs and the off switch. The plist must be an approved `launchAgents` path named `devtwin.<job>.plist`.
- The command starts with a Node path that stays the same when Homebrew upgrades Node. When Node runs from a versioned `<prefix>/Cellar/<formula>/<version>` folder, the plist names the Homebrew link of the same prefix and formula: `<prefix>/bin/node` for `node`, `<prefix>/opt/node@NN/bin/node` for `node@NN`. It uses the link only if the link leads to a Node in `<prefix>/Cellar/<formula>/`. A link to another prefix, formula or install is never used. Otherwise the plist names the Node that ran the command.
- `schedule apply` shows the owner dialog, writes the plist and loads it. The radar and advisory jobs need a stack approval first, and the advisory job needs the radar job on and the `advisories` group in the approval.
- `schedule off` unloads the job and removes its plist. Turning off the radar also turns off the advisory job.
- `schedule status` reports, for each job, whether it is on, installed and loaded, and its last run. It makes no request.
- `schedule run --job <job>` is what the LaunchAgent runs. It checks the live gate, the job's flag and its last-run receipt before any request. A job that is off makes no request and writes nothing. A run inside the job's period is skipped, so missed runs collapse into one run and two runs in one week write one digest. A run whose live gate fails writes a failed receipt and makes no request.

Notifications use `osascript`. The script is fixed, and the title and message reach it only as arguments, with control characters, quotes and backslashes removed and the length capped.

## Activity and undo

devtwin records each automatic knowledge write in its audit log (see [Storage](STORAGE.md#audit-log)). Two routes read and reverse it:

```sh
node bin/devtwin.mjs activity --pilot "$PILOT_FILE" --since 2026-10-01T00:00:00Z
node bin/devtwin.mjs undo --pilot "$PILOT_FILE" --id "$ENTRY"
node bin/devtwin.mjs undo --pilot "$PILOT_FILE" --id "$ENTRY" --apply --plan-fingerprint "$FINGERPRINT"
node bin/devtwin.mjs undo --pilot "$PILOT_FILE" --since 2026-10-20T00:00:00Z
```

- `activity` is read-only. It lists what devtwin learned in the last seven days, or since `--since`: the entry ID, time, route, target, record IDs, the caller and whether the write landed. It also lists held items and items that wait for you. `--held` shows only the held items, with their full text.
- `undo --id` reverses one entry. A record gets a retraction, so the next session no longer sees it. When the record was replaced later, the retraction covers the newest version. When the entry itself replaced an earlier record, the earlier version comes back as a new record.
- `undo --since` reverses every entry after a time, newest first.
- Every undo shows the owner dialog, and the hook denies `undo --apply` from agent shells. `--session` is shown in the plan only.
- An undo that stopped between its retraction and its restores resumes on the next run. A `hub-lesson` entry is not undone: remove the lesson with `published delete`.
- Each undo adds its own entry to the log and rebuilds the lesson indexes. An undo of an undo is refused. An entry whose write never landed is reported, and undo leaves it alone.
- The `activity-weekly` job sends the weekly counts as one notification. It is the one weekly prompt for `activity review`.

### Weekly review

```sh
node bin/devtwin.mjs activity review --pilot "$PILOT_FILE" --home "$AGENT_HOME"
node bin/devtwin.mjs activity review --pilot "$PILOT_FILE" --home "$AGENT_HOME" --reject "$ITEM" --apply --plan-fingerprint "$FINGERPRINT"
```

- `activity review` lists every item that waits for you, with its full text. These are global preference candidates (from an agent or a `user` memory) and the general part of a `lesson accept`. They also include writes refused by the session or day cap, and items from a fetched or synced source. `activity` lists the same items by title.
- `--apply` shows the owner dialog, up to ten items in one dialog while their full text fits. Approve saves every item in that dialog; deny leaves them waiting. An item too long for any dialog stays waiting until you reject it.
- `--reject <id>` removes an item, after its own dialog.
- Accepted preferences go into the instruction block for `--home` and `--agent`, the targets that `instructions plan` takes. In live mode the live home is the default. The review writes the block only when it holds every earlier preference already; otherwise run `instructions plan` and `instructions apply`.
- The hook denies `activity review --apply` from agent shells.
- The digest warns while no backup folder is approved, and until `backup key export` has run once.

## Setup review

The setup review suggests changes to your setup. It reads what devtwin already keeps and changes nothing on its own. The `review-monthly` job reminds you once a month when it has suggestions.

```sh
node bin/devtwin.mjs review plan --pilot "$PILOT_FILE"
node bin/devtwin.mjs review apply --pilot "$PILOT_FILE" --accept "$LINE" --reject "$OTHER_LINE"
node bin/devtwin.mjs review apply --pilot "$PILOT_FILE" --accept "$LINE" --reject "$OTHER_LINE" --apply --plan-fingerprint "$FINGERPRINT"
```

`review plan` is read-only. Each line has an ID, a kind, a target, the evidence and the proposed change. The evidence holds IDs, counts, hashes, dates and paths, never the text of a record or preference. The kinds are:

| Kind | When | Proposed change |
| --- | --- | --- |
| `preference-overridden` | A saved preference got a later correction on the same topic | `pref retire` |
| `preference-declined` | You declined two or more proposals on a topic that has no saved preference | None. Write the rule yourself, or leave it |
| `sandbox-setting` | The latest project scan recommends other sandbox settings than the ones you saved | `setup apply --step sandbox` for a new setting. A changed or dropped setting is for you to check |
| `radar-interest` | You wrote a try-it guide for a radar item that is not one of your radar interests. There are never more lines than the 30-interest limit leaves room for | `profile apply` adding it |
| `promoted-source-changed` | The source of an imported record changed since the import | None. The next import updates an unreviewed record. A reviewed one is yours to compare |
| `promoted-source-removed` | The source file of an imported record is gone | `undo` of the import entry, when that entry replaced nothing |
| `promoted-source-skipped` | The source of an imported record is still there, but the import skips it now, for example because it cannot read it. The line gives the reason | None. Fix the file, or retract the record yourself |
| `lesson-unused` | No session got a lesson in 30 days, from the hook budget log. A lesson shown as an "ask before" line of the session summary counts as delivered | `undo` of the entry that wrote it, when there is one |
| `memory-delivered-twice` | An imported Claude memory file still exists, so sessions read it twice | None. devtwin never edits memory. The line names the file, and you decide whether to delete it |
| `consent-unused` | Nothing ran under a consent in the 30 days or more since you granted it | `consent revoke` |
| `learning-branch-stale` | A learning branch stayed local for more than 14 days | None. Delete the branch yourself, or send it with `learning send` |

The review does not suggest unused skills or templates. The hook log keeps error codes only, not which skill or template ran. It checks for unused lessons only when the budget log goes back at least 30 days. Until then, `notCollected` in the plan lists `lesson-unused` with the reason.

- `review apply` takes a decision for each line you want to decide: `--accept <id>` or `--reject <id>`. It refuses when no decision is given or when a line has both. A line with no decision stays open, and nothing changes for it.
- Without `--apply` it previews the decisions. `--apply` with the plan fingerprint shows the owner dialog. The dialog lists each accepted line with the command it runs, and gives the rejected lines as a count. When the accepted lines do not fit one dialog, it refuses: accept fewer at once.
- When you only reject lines, there is no dialog. A reject changes nothing but the list of decided lines.
- Each accepted change runs through its own command, as you would run it: plan first, then apply. That command keeps its own checks and its own owner dialog, so `consent revoke` and `undo` ask you again.
- Accepting a line with no proposed change records your decision only.
- Each decision gets an audit entry. Each decision is saved as soon as its change is done. A decided line stays hidden until its evidence changes. A change that fails is reported, and its line comes back in the next review. `undo --since` skips these audit entries; the change a decision ran has its own entry.
- The hook denies `review apply --apply` from agent shells. An agent may run `review plan` and the preview.

## Daily import

`import run` turns what your agents already remember into devtwin knowledge. The `import-daily` job runs it once a day, and you or an agent can run it at any time. It is automatic: it needs no approval, and each record it writes is in the audit log. Only the job writes as the job. An `import run` from a shell writes as its caller, like `record add`, and the caller's session and day limits count its writes.

```sh
node bin/devtwin.mjs import run --pilot "$PILOT_FILE"
```

It reads two sources for each onboarded project:

- The Claude Code memory of the repository: `~/.claude/projects/<folder>/memory/*.md`. The folder name is the repository's real path with every character other than a letter or a digit changed to `-`. `MEMORY.md` is an index, so it is skipped. A linked file is skipped.
- The `docs/solutions/**/*.md` files of the project's learnings base commit. The base is the remote default branch that `refs/remotes/origin/HEAD` names, or the remote-tracking ref that `project set` records. devtwin reads the files from that commit with Git plumbing, never from the working copy, and with replace refs off. A feature branch that you checked out does not feed the import. With no remote default branch, the project reports `no-learnings-base`.

devtwin reads a memory folder only when it can prove that the folder belongs to the repository. Two repositories can give the same folder name. So each session transcript in the folder must record a working directory in the repository, in a folder below it, or in one of its linked worktrees. Otherwise the project reports `ambiguous` and nothing is read. The check reads at most 200 transcripts of at most 8 MB each. A folder with more, or a longer transcript, reports `ambiguous` with the reason `proof-capped`, because some lines went unchecked. A linked worktree has its own Claude Code folder, and the import does not read it yet. Folders that belong to no bound repository are only counted, as `unmapped`.

Each item becomes one record:

| Source | Record |
| --- | --- |
| `feedback` memory | A project lesson. Habit words in the rule give the lesson its commands, from `catalog/habit-commands.json`. "Always ask before pushing" gets `git push`. |
| `project` memory | A project constraint when the text says "must", "never" or "always". Otherwise a project fact. |
| `reference` memory | An environment record with locations when the text names a place, such as `.env`. Otherwise a project fact. |
| `user` memory | A preference proposal for your weekly review. devtwin never accepts it. |
| `docs/solutions` file | A project lesson that names the file and the commit. |

- Every record is `observed`. Sessions get it at once, marked as unreviewed. Confirm it later if you want.
- Each record passes the same checks as `record add`: plain text, no secret and no other scope's name. A refused item is reported by its source and the error code, never by its text. It is not tried again until its text changes.
- A file that did not change adds nothing. A change only to `modified` or `originSessionId` adds nothing. A body change replaces the earlier record. When you confirmed that record, the change is skipped and reported, because only you change a confirmed record.
- One run writes at most 100 items, and all runs of one UTC day write at most 100. Preference proposals count as items. The rest wait for the next run. The agent session limits do not count the job's writes.
- A shell `import run` stops at its caller's limit. The write that hits the limit waits in `activity review`, and the result names it in `parked`. The items after it wait for a later run.
- `undo --since` with the time before a run removes every record that the run wrote. The next run does not bring them back while the source stays the same.
- The import writes only in the store: the records, the audit log and its seen file at `stateRoot/import/seen.json`. It never writes memory, transcripts or a repository.

## Backups

```sh
node bin/devtwin.mjs backup create --pilot "$PILOT_FILE"
node bin/devtwin.mjs backup create --pilot "$PILOT_FILE" --apply --plan-fingerprint "$FINGERPRINT"
node bin/devtwin.mjs backup status --pilot "$PILOT_FILE"
node bin/devtwin.mjs backup restore --pilot "$PILOT_FILE" --from "$ARCHIVE" --to "$BACKUPS/restored"
```

- The `backup-daily` job needs an approved `backupTargets` folder and its own `launchAgents` plist. A held store lock skips the run with `BUSY`; the receipt keeps the last good run, so the next run tries again.
- `backup restore` writes only a new folder inside an approved backup folder. See [Backup and restore](LIVE.md#backup-and-restore) for the key, the restore steps and a restore on another machine.

## Optional companions

These are optional companions. The kit does not bundle, install or detect them:

- Engineering-process skill packs such as Superpowers and compound-engineering.
- ruler or rulesync to fan agent rules out to several agents.
- Writing skill packs such as Anthropic's `internal-comms` and `doc-coauthoring` for message formats. The `writing` and `slack-update` templates use a companion only when you name one or it is already loaded. Companions supply format only; the template's rules (never send, list the context used, mark unverified facts) always apply.

## What this stage does not do

- No fresh-session discovery claim: whether a new agent session finds and uses `devtwin-setup` or a template-made skill is not verified.
- No install of template-made skills into real agent homes, and `devtwin-setup` is not yet in the bundled installer.
- No enabled schedules, no Slack reading or sending, and no authenticated GitHub requests until routing lands.
- No Linux or Windows support claim. See [Limitations](LIMITATIONS.md) and the [security model](SECURITY-MODEL.md#personal-harness-layer).

## Real-agent scenarios

The owner checks the behavior above with real Claude Code and Codex sessions in visible terminals, not headless runs. The runbook is [`scripts/agent-scenarios/README.md`](../scripts/agent-scenarios/README.md). `setup.mjs` there builds a disposable fixture home with its own live config, and refuses the real home. `judge.mjs` reads the fixture's hook, budget and audit logs, the held queue and the summary cache, and prints a pass, fail or needs-review row for each scenario. Acceptance lists the suite as the deferred check `real-agent-scenarios`.
