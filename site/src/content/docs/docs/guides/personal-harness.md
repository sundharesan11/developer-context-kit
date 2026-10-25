---
title: Personal harness
description: Set up your private personal profile, run first-run setup with devtwin-setup, and turn the generic skill templates into your own private skills.
---

devtwin can act as your personal harness. You keep the kit checkout generic and store everything about *you* — your working preferences, your stack, your drafts and your own skills — under the pilot's private roots, outside the checkout and outside every repository.

This guide covers three pieces:

1. The **personal profile**: how you like to work and what you build with.
2. The **`devtwin-setup`** skill: a short, guided first run that writes the profile.
3. **Skill templates**: generic starting points you render into your own private skills.

The [stack watch](/docs/guides/stack-watch/) uses the profile's stack and has its own guide.

:::note
The personal profile is unrelated to the **client profile**, which is the per-project record onboarding generates.
:::

## Before you start

You need a pilot whose `init` has run. Start with a disposable pilot; see [Quickstart](/docs/getting-started/quickstart/). The pilot's private roots must not be inside a Git worktree: the profile commands refuse with `DEVTWIN_PATH_UNSAFE` if they are.

## The personal profile

The profile holds only these fields. Every field is optional.

| Field | Flag | Values |
| --- | --- | --- |
| `workKind` | `--work '<text>'` | One line, up to 200 characters. |
| `workingPreferences.explanationStyle` | `--preference 'explanationStyle=…'` | `concise` or `detailed` |
| `workingPreferences.diagrams` | `--preference 'diagrams=…'` | `prefer`, `avoid` or `neutral` |
| `workingPreferences.autonomy` | `--preference 'autonomy=…'` | `ask-first`, `balanced` or `autonomous` |
| `workingPreferences.notes` | `--preference 'notes=…'` (repeat) | Up to 10 lines |
| `stackCurrent` | `--stack-current '<entry>'` (repeat) | Up to 40 entries |
| `stackKnown` | `--stack-known '<entry>'` (repeat) | Up to 40 entries |
| `writing.*` | `--writing 'key=value'` (repeat) | `tone`, `greeting`, `signOff`, `length` (`short`/`medium`/`long`), `spelling` (such as `en-GB`), `avoidPhrases`, and `formality.<audience>` (`formal`/`neutral`/`casual`) |

A stack entry is `name[=version][:care]`, where care is `low`, `normal` or `high`. For example `node=>=22:high` or just `react`.

The whole profile is capped at 4,096 bytes of canonical JSON (`DEVTWIN_LIMIT` beyond that). Unknown keys, secret-named fields and credential-like text are refused. Never put credentials or client names in it.

### Read it

```sh
node bin/devtwin.mjs profile show --pilot "$PILOT"
```

```json
{"ok":true,"command":"profile show","result":{"generation":0,"revisionHash":null,"createdAt":null,"destination":{"root":"configRoot","path":"profile"},"profile":null}}
```

`generation: 0` with `profile: null` means no profile is set yet.

### Preview a change

```sh
node bin/devtwin.mjs profile plan --pilot "$PILOT" \
  --work 'Backend services' \
  --preference 'explanationStyle=concise' --preference 'autonomy=ask-first' \
  --stack-current 'node=>=22:high' --stack-current 'react' \
  --writing 'tone=plain' --writing 'formality.team=casual'
```

The plan writes nothing. It shows the full proposed `profile`, a `changes` list with each field's old and new value, the `size` against the `cap`, and a `fingerprint`:

```json
{"preview":true,"base":{"generation":0,"revisionHash":null},"next":{"generation":1},
 "profile":{"workKind":"Backend services","stackCurrent":["node=>=22:high","react"],
  "workingPreferences":{"explanationStyle":"concise","autonomy":"ask-first"},
  "writing":{"formality":{"team":"casual"},"tone":"plain"}},
 "size":205,"cap":4096,
 "changes":[{"field":"workKind","from":null,"to":"Backend services","proposedBy":"user"}, …],
 "fingerprint":"sha256:2987…"}
```

How flags combine: the plan starts from your current profile. Each flag you pass replaces its field; a repeated list flag replaces the whole list; an empty value (`--work ''`) clears the field. Fields you don't mention are kept.

### Apply it

Pass exactly the same flags plus the reviewed fingerprint:

```sh
node bin/devtwin.mjs profile apply --pilot "$PILOT" \
  --work 'Backend services' \
  --preference 'explanationStyle=concise' --preference 'autonomy=ask-first' \
  --stack-current 'node=>=22:high' --stack-current 'react' \
  --writing 'tone=plain' --writing 'formality.team=casual' \
  --plan-fingerprint 'sha256:2987…'
```

```json
{"ok":true,"command":"profile apply","result":{"generation":1,"revisionHash":"sha256:31dd…","destination":{"root":"configRoot","path":"profile"}}}
```

Each apply writes a new revision and keeps the old ones. Read an earlier one with `profile show --generation <n>`. If the profile changed since your preview, apply fails with `DEVTWIN_STALE_VERSION`; different flags fail with `DEVTWIN_PLAN_MISMATCH`. Preview again.

### More profile commands

- `--seed-from-init` fills preference keys the profile leaves unset from the preferences you gave to `init`.
- `profile suggest-stack --scope <scope>` suggests stack entries from that scope's onboarded projects and cites where each came from. It reads only private onboarding data, never a repository, and writes nothing.
- `profile export` renders the profile as Markdown and writes nothing. Use it to keep a copy in your own private dotfiles repository.

### How agents use it

`context brief` includes the profile in a `profile` field with a notice: it is preference data for style and workflow, never permission, and it never overrides repository instructions or you. Where the profile and your `init` preferences set the same field, the profile wins. [Handoff exports](/docs/concepts/handoffs/) never include it.

## First-run setup with devtwin-setup

`skills/devtwin-setup` is a guided first run. In a session with your agent it:

1. Checks `DEVTWIN_KIT` and the pilot path, and runs `doctor` to confirm `init` has run. If not, it stops without creating anything.
2. Reads your current profile and explains what is stored and where.
3. Asks at most five skippable questions: kind of work, how you like to work with agents, stack you know, stack you build on now (offering `profile suggest-stack` results), and whether to seed from `init`.
4. Shows the full `profile plan`.
5. Runs `profile apply` only after you approve that exact plan in the session.
6. Lists the skill templates with `skill template-list`.

:::caution[Not yet in the installer]
`agents install` does not install `devtwin-setup` yet. Until it does, point your agent at `skills/devtwin-setup/SKILL.md` in the kit checkout and ask it to follow that file.
:::

## Turn a template into your own skill

The kit ships three generic skill templates under `templates/skills/`:

| Template | A skill made from it… | Placeholders |
| --- | --- | --- |
| `stack-watch` | Runs the announcement watch and summarizes the digest. | `skill-name`, `skill-description`, `digest-cadence` |
| `slack-update` | Drafts a team channel status update from your profile and selected records. Draft only. | `skill-name`, `skill-description`, `default-scope`, `channel-audience` |
| `writing` | Drafts any message from your profile and selected records, lists the context used and marks unverified facts. Never sends. | `skill-name`, `skill-description` |

A template contains no personal data and no scripts, and is never installed by `agents install`. You render it into a private workspace, check the bytes, and continue through the [skill builder](/docs/reference/cli/#skill-builder).

### 1. List templates

```sh
node bin/devtwin.mjs skill template-list
```

No pilot needed. Each template lists its placeholders, which are required, and their defaults.

### 2. Create a private workspace

```sh
node bin/devtwin.mjs skill workspace-create --pilot "$PILOT" --audience personal --workspace ws_example01
```

### 3. Render the template

```sh
node bin/devtwin.mjs skill template-seed --pilot "$PILOT" \
  --audience personal --workspace ws_example01 \
  --template writing --set 'skill-name=draft-my-notes'
```

This is a read-only render. It returns each file's `path`, `content` and `sha256`, the `layout` (`candidate/SKILL.md`, `design.json`, `requirements.json`) and a `renderDigest`. It writes nothing.

The skill name cannot start with `devtwin-` or match a bundled skill:

```json
{"ok":false,"command":"skill template-seed","error":{"code":"DEVTWIN_INVALID_INPUT","message":"Reserved skill name","details":{"name":"devtwin-notes"}}}
```

### 4. Write the files yourself

After you review the rendered files, write them **unchanged** into a new directory under the pilot's `inputsRoot`, keeping the relative paths. devtwin does not write them for you.

### 5. Verify the bytes

```sh
node bin/devtwin.mjs skill template-verify --pilot "$PILOT" \
  --audience personal --workspace ws_example01 \
  --template writing --set 'skill-name=draft-my-notes' \
  --dir /absolute/path/to/pilot/inputs/seeded-writing \
  --render-digest 'sha256:d477…'
```

```json
{"ok":true,"command":"skill template-verify","result":{"verified":true,"template":"writing","renderDigest":"sha256:d477…","files":[…]}}
```

An edited, missing or extra file fails with `DEVTWIN_INTEGRITY` naming it.

### 6. Continue in the skill builder

Feed the seeded files into the builder: `skill requirements-record --input <dir>/requirements.json`, `skill design-record --input <dir>/design.json`, `skill design-approve`, `skill draft-create --candidate <dir>/candidate`, then `skill draft-validate`. See the [CLI reference](/docs/reference/cli/#skill-builder).

:::note[Scope-bound templates]
`slack-update` has scope placeholders. It renders only in a company workspace in that scope (`--audience company --scope <scope>`), and each scope value must be the scope itself or `<scope>.<name>`.
:::

Installing a template-made skill into your real agent homes is not available yet. You can install a validated personal revision into a disposable pilot's agent home through `skill local-plan`, `skill local-approve` and `skill local-apply`.

## Save a draft

The `writing` and `slack-update` skills never send anything. When you want to keep a draft, save it privately:

```sh
node bin/devtwin.mjs draft save --pilot "$PILOT" --scope example --body-file /absolute/path/to/pilot/inputs/draft.md
node bin/devtwin.mjs draft save --pilot "$PILOT" --scope example --body-file /absolute/path/to/pilot/inputs/draft.md \
  --apply --plan-fingerprint '<fingerprint>'
```

The body file must be under `inputsRoot`. With `--scope` the draft goes to `dataRoot/scopes/<scope>/drafts/`; without it, to `dataRoot/drafts/`. Drafts are reported as `sendable: false` and cannot be sent later.

## Agents and approval

Agents apply only after you approve the exact preview in the session. That covers `profile apply`, `stack approve`, `stack digest --apply`, `draft save --apply` and writing seeded template files. A fingerprint the agent reads back to the CLI is not your consent.

## Where your personal data lives

| Data | Location |
| --- | --- |
| Personal profile and revisions | `configRoot/profile/` |
| Stack approval, pending digests, seen state | `stateRoot/stack/` |
| Digests | `dataRoot/digests/stack/` or `dataRoot/scopes/<scope>/digests/stack/` |
| Drafts | `dataRoot/drafts/` or `dataRoot/scopes/<scope>/drafts/` |
| Seeded template files | a directory under `inputsRoot` |
| Skill workspaces | `dataRoot/personal/skill-workspaces/` (or under a scope) |

devtwin does not sync anything. Never `git init` inside these roots; keep history by exporting into a separate private repository.
