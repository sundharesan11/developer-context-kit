---
title: Capture decisions
description: Record decisions, facts and unknowns for a project, replace outdated ones, and review agent proposals before they enter the brief.
---

Records are how a project remembers. A decision you record today appears in the brief your next agent session reads. This guide covers writing records directly, replacing them, and the propose-then-publish flow for agent-written records.

All examples assume an onboarded project. See [Onboard a repository](/docs/guides/onboard-a-repository/).

```sh
PILOT=/absolute/path/to/pilot.json
```

## Record kinds and statuses

Every record has a **kind**:

`brief`, `map`, `command`, `environment`, `constraint`, `fact`, `decision`, `experiment`, `unknown`, `handoff`

and a **status**:

| Status | Meaning |
| --- | --- |
| `observed` | The default. Recorded, not independently checked. |
| `confirmed` | The owner confirmed it. Requires `--reviewer`. This is a workflow receipt, not authentication. |
| `disputed` | Someone disagrees. Raise it before acting. |
| `proposed` | Waiting for review. Not part of the brief. |

See [Records](/docs/concepts/records/) for the full model.

## Add a record

Preview first. Without `--apply`, nothing is written:

```sh
devtwin record add --pilot "$PILOT" \
  --scope example --project example.atlas \
  --kind decision --title "Use server-side search" \
  --body "Filter on the server because the list can grow." \
  --request-id req_atlas_decision_01
```

```json
{"ok":true,"command":"record add","result":{"preview":true,"recordId":"rec_94315938d3e27ab174b5665d","scope":"example","project":"example.atlas"}}
```

Then write it with the same flags plus `--apply`:

```sh
devtwin record add --pilot "$PILOT" \
  --scope example --project example.atlas \
  --kind decision --title "Use server-side search" \
  --body "Filter on the server because the list can grow." \
  --request-id req_atlas_decision_01 --apply
```

```json
{"ok":true,"command":"record add","result":{"recordId":"rec_94315938d3e27ab174b5665d","recordHash":"sha256:4baf…","created":true,"bodyHash":"sha256:f658…"}}
```

Keep the `recordId` and `recordHash`. You need both to replace the record later.

### Rules worth knowing

- `--request-id` is required to apply. It has the form `req_` plus 8–64 lowercase letters, digits, `_` or `-`. The record ID is derived from the scope, project and request ID, so repeating the same request is safe and returns the existing record.
- `--title` is one line, up to 200 characters. The body is up to 32,768 bytes.
- Text that looks like a credential is refused with `DEVTWIN_SENSITIVE_CONTENT`.
- `--status confirmed` without `--reviewer` fails with `DEVTWIN_APPROVAL_REQUIRED`.

### Keep the body out of shell history

`--body` lands in your shell history. For anything longer or more sensitive, write the body to a file under the pilot's `inputsRoot` and pass `--body-file`:

```sh
devtwin record add --pilot "$PILOT" \
  --scope example --project example.atlas \
  --kind constraint --title "No direct database access from the UI" \
  --body-file /absolute/path/to/pilot/inputs/constraint.md \
  --request-id req_atlas_constraint_01 --apply
```

A body file outside `inputsRoot` is refused with `DEVTWIN_GATE_REQUIRED`.

### Cite your evidence

Add `--source` (repeatable, up to 20) so later readers can check the claim. Accepted forms:

| Form | Example |
| --- | --- |
| `file:<repo-relative path>` | `file:docs/search.md` |
| `commit:<sha>` | `commit:409dcf1` |
| `record:<record id>` | `record:rec_94315938d3e27ab174b5665d` |
| `issue:<KEY-123>` | `issue:ATL-42` |
| `user:<actor>` | `user:email:owner@example.com` |
| `url:<https URL>` | `url:https://example.com/adr/7` (no query, fragment or credentials) |

### Confirm a record

```sh
devtwin record add --pilot "$PILOT" \
  --scope example --project example.atlas \
  --kind decision --title "Use server-side search" \
  --body "Filter on the server." \
  --status confirmed --reviewer email:owner@example.com \
  --request-id req_atlas_decision_02 --apply
```

The reviewer must be an actor reference: `email:`, `github:`, `slack:`, `linear:` or `handle:` followed by the identifier.

## Replace an outdated record

Records are immutable. To change one, write a successor that **supersedes** it. Pass the target's ID and its current hash, so a concurrent change is caught:

```sh
devtwin record supersede --pilot "$PILOT" \
  --scope example --project example.atlas \
  --kind decision --title "Use client-side search for now" \
  --body "Small lists; revisit at 10k rows." \
  --target rec_94315938d3e27ab174b5665d \
  --expect-hash sha256:4bafd4aa… \
  --request-id req_atlas_decision_03 --apply
```

The brief now shows the successor and leaves the superseded record out. History keeps both. If the target was already superseded or its hash changed, you get `DEVTWIN_STALE_VERSION` with the message `Target changed`. Read the brief again and supersede the current record instead.

`--target` and `--expect-hash` are repeatable and pair up in order, so one successor can replace several records.

## Agent proposals: propose, then publish

When an agent records something, it should not write straight into the brief. It **proposes**; you **publish**.

1. The agent (usually through the [`devtwin-record` skill](/docs/reference/bundled-skills/)) writes a private proposal:

   ```sh
   devtwin record propose --pilot "$PILOT" \
     --scope example --project example.atlas \
     --kind unknown --title "Search threshold" \
     --body-file /absolute/path/to/pilot/inputs/note.md \
     --source file:README.md --request-id req_atlas_prop_01 --apply
   ```

   ```json
   {"ok":true,"command":"record propose","result":{"proposalId":"prop_d4b10a44abfac39728707954","path":"…/data/scopes/example/projects/example.atlas/proposals/prop_d4b10a44abfac39728707954.json"}}
   ```

   A proposal is a file, not a record. It does not appear in the brief.

2. You read the proposal file and decide. To publish it:

   ```sh
   devtwin record publish --pilot "$PILOT" \
     --scope example --project example.atlas \
     --proposal prop_d4b10a44abfac39728707954 --apply
   ```

   Publishing creates an `observed` record with the original recorder's provenance. Add `--reviewer <actor>` to set the review field. Without `--apply`, `record publish` only echoes the proposal ID.

:::caution[Publishing is your decision]
The bundled skills never run `record publish --apply`. Keep it that way: an agent that publishes its own proposals defeats the review step.
:::

## Share a learning with a company hub

If a scope lists a local hub (see `--hub` in the [configuration reference](/docs/reference/configuration/#scope-configuration)), you can prepare a learning proposal from **confirmed** records:

```sh
devtwin hub propose --pilot "$PILOT" \
  --scope example --project example.atlas \
  --record rec_640c02d0eeba927643c3d5cf --hub team-notes
```

Add `--apply` to write a private proposal file under the project's `proposals/` directory. devtwin never writes to the hub itself. Text that names the scope, project, bound paths or remote hosts is refused with `DEVTWIN_SENSITIVE_CONTENT`.

## Who recorded what

Records written through the CLI are attributed to `recordedBy: {actor: "human", runId: "run_cli00001"}`, whoever runs the command. Treat that label as a placeholder, not an identity. See [Limitations](/docs/security/limitations/).
