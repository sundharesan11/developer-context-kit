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

`skills/devtwin-setup` conducts first-run setup. It checks `DEVTWIN_KIT` and the pilot path like the other bundled skills, and stops without creating anything if the pilot file is missing or `init` has not run. It asks at most five skippable questions, previews the full profile with `profile plan`, and lists the templates with `skill template-list`. It runs `profile apply` only after explicit approval from the user in the session for the plan just shown. A fingerprint an agent passes back is not consent. It creates no skill unless you ask.

`devtwin-setup` is not yet in the bundled installer, so `agents install` does not install it. Live-mode activation passed on 2026-10-25; the installer wiring (U9 of the harness plan) is not built yet. Until then, you can read its `SKILL.md` in the kit checkout.

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

The watch is manual. Nothing runs on a schedule. It reads `stackCurrent` from the profile and resolves each entry against the bundled catalog `catalog/stack-sources.json`, plus any overrides you give.

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
- `stack digest` without `--apply` runs the watch, renders the Markdown digest and writes only a pending file under `stateRoot/stack/pending/`. With `--apply` and that fingerprint it makes no request. It writes the dated digest and records the reported entries in that scope's seen state, so the next digest lists them as previously reported.

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

`--feed '<name>=https://…'` adds a feed for a declared item, and `--map '<name>=<kind>:<id>'` adds a GitHub, endoflife.date or package identifier. Overrides given once carry forward to the next plan until you give new ones or `--clear-overrides`.

### Network hosts, feed URL rules and approval

The watch connects only to approved hosts: the hosts listed in the approval you made from the plan you reviewed. They are `api.github.com` for releases, the hosts of approved feed URLs, and, only when their group is enabled, `api.osv.dev`, `endoflife.date`, `registry.npmjs.org`, `pypi.org` and `crates.io`.

Feed URLs must use `https`, with no user name or password, port or fragment. The host must be a DNS name with at least two labels, not an IP literal and not `localhost`. Before each request the host is resolved, and any private, loopback, link-local or reserved address refuses that host. Redirects are never followed. Each run is bounded: 64 requests, 1 MiB per response, 8 MiB in total, 10 seconds per request and 120 seconds per run.

**The optional GitHub token.** A token for GitHub requests comes only through organization identity routing's scope-free public-read binding. A fine-grained, public-read-only token is recommended there. No environment variable or record is read for a token. Routing is not built yet, so today GitHub requests are always unauthenticated. Unauthenticated GitHub requests are limited to roughly 60 per hour.

### Exactly what the watch sends

Request content is limited to the feed URLs and identifiers listed for each host. Exact versions go to OSV only, and only when advisories are enabled. No profile text, record, path, scope, project name or local identifier is sent.

This is what hosts still see: your IP address, the request time and the fixed user agent `devtwin-stack-check`. With a routed token, GitHub would also see the GitHub account of that binding. The set of feed URLs you fetch, tied to your IP address, shows which vendors you follow.

Fetched feed and release text is untrusted. The digest quotes titles and excerpts inside fences as inert text, and an agent must never follow instructions found in it.

### Live mode

`stack check` and `stack digest` refuse a live config with `GATE_REQUIRED`. They work only with a disposable pilot until the watch's live-mode exception lands together with organization identity routing.

## Drafts

The `writing` and `slack-update` templates never send. A draft is saved privately only when you ask:

```sh
node bin/devtwin.mjs draft save --pilot "$PILOT_FILE" --scope acme --body-file "$BODY_FILE"
node bin/devtwin.mjs draft save --pilot "$PILOT_FILE" --scope acme --body-file "$BODY_FILE" --apply --plan-fingerprint "$FINGERPRINT"
```

The body file must be inside the pilot's inputs root. A draft goes to `dataRoot/drafts/` without a scope, or under `dataRoot/scopes/<scope>/drafts/` with one. It is reported as `sendable: false`.

The Slack-update template is draft only until routing's send increment lands. It reads nothing from Slack and posts nothing. Today it saves only through `draft save --scope`, and drafts saved there cannot be sent later. A path through routing's `connect draft`, for scopes with a bound Slack account, arrives with routing; this stage does not provide it.

## Agents and approval

Agents apply only after explicit approval from the user in the session. That covers `profile apply`, `stack approve`, `stack digest --apply`, `draft save --apply` and writing seeded template files. An agent shows the preview, waits for the user to approve that exact preview, and then passes the fingerprint. A fingerprint the agent passes back is not consent. Agents never run `record publish --apply`.

## Keep the clone generic

Personal state lives under the pilot's private roots, outside the clone:

| Data | Location |
| --- | --- |
| Personal profile and revisions | `configRoot/profile/` |
| Stack approval, pending digests and seen state | `stateRoot/stack/` |
| Digests | `dataRoot/digests/stack/` or `dataRoot/scopes/<scope>/digests/stack/` |
| Drafts | `dataRoot/drafts/` or `dataRoot/scopes/<scope>/drafts/` |
| Seeded template files | a directory under `inputsRoot` |
| Skill workspaces | the skill builder's private workspace root |

`npm run check:package` applies a private-state pattern to every tracked or unignored file and to the package dry run. It fails on `profile/`, `digests/`, `drafts/`, `stack/` and `skill-templates/` paths (and the existing records, operations, proposals, staging, runs and locks paths) at the repository root or under `data/`, `state/`, `config/`, `inputs/` or `private/`, including below `scopes/<scope>/`. `templates/skills/` and kit source such as `src/profile/` are allowed. Home-directory paths, non-example emails and terms from a denylist you keep outside the repository (`--denylist <file>`) also fail.

**Versioning your private instance.** The kit does not sync anything. To keep history of your profile, digests or template-made skills, copy them or export them (for example `profile export`) into a separate private repository or dotfiles manager. The private roots themselves must stay outside Git, so never `git init` in them: the profile routes refuse to write inside a Git worktree.

## Scheduling recipe

Schedules are disabled by default, and enabling one is outside this stage. The recipe below ships commented out. It previews a digest for a disposable pilot; the preview writes only a pending file, and applying it still needs your approval. It cannot run against the live config today, which refuses with `GATE_REQUIRED`.

```sh
# Scheduling recipe (commented out; enabling a schedule is outside this stage).
# cron, Mondays at 09:00, disposable pilot only:
# 0 9 * * 1 cd "$DEVTWIN_KIT" && node bin/devtwin.mjs stack digest --pilot "$PILOT_FILE" >> "$PILOT_LOG" 2>&1
# launchd: a user agent with ProgramArguments node, bin/devtwin.mjs, stack, digest, --pilot and the pilot path,
# and StartCalendarInterval Weekday 1, Hour 9. Do not load it in this stage.
```

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
