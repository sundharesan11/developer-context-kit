---
title: Records
description: What a devctx record is, the kinds and statuses it can have, where its evidence comes from, and how to replace one without losing history.
---

A record is one piece of project knowledge: a decision, a fact, a command, an open question. Records are what a [brief](/docs/concepts/briefs/) is made of. Each one belongs to exactly one project and is stored privately on your disk.

## Anatomy of a record

```sh
devctx record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind decision \
  --title "Use server-side search" \
  --body "Filter on the server because the list can grow." \
  --source file:README.md \
  --request-id req_atlas_search_01 --apply
```

| Part | What it is | Limits |
| --- | --- | --- |
| Kind | What sort of knowledge this is. See [kinds](#kinds). | One of ten values |
| Status | How much weight it carries. See [statuses](#statuses). | Defaults to `observed` |
| Title | A one-line summary. | 1 to 200 characters, no line breaks |
| Body | The detail, as plain text or Markdown. | Up to 32,768 bytes |
| Sources | Evidence the record is based on. See [sources](#sources). | Up to 20 |
| Request ID | Your name for this write, used to make it repeatable. | `req_` plus 8 to 64 of `a-z`, `0-9`, `_`, `-` |

`devctx` adds the rest: a record ID derived from the scope, project and request ID, hashes of the record and body, a creation time, and who recorded it.

:::tip[Keep long or sensitive text out of your shell history]
Instead of `--body`, put the text in a file under your pilot's `inputsRoot` folder and pass `--body-file <path>`. The file must be 32 KiB or less.
:::

## Kinds

| Kind | Use it for |
| --- | --- |
| `brief` | A short description of the project. Onboarding writes these from the README. |
| `constraint` | Something that must stay true, such as "the repository's own `AGENTS.md` governs". |
| `decision` | A choice that was made, and why. |
| `map` | Where things live in the codebase. |
| `command` | How to build, test or run something. |
| `environment` | A named environment, such as `staging`. Names only, never credentials. |
| `fact` | Something observed to be true. |
| `experiment` | Something tried, and what happened. |
| `handoff` | Where a session stopped and what comes next. See [Handoffs](/docs/concepts/handoffs/). |
| `unknown` | An open question that someone still needs to answer. |

Briefs list records in this order of kind, so constraints and decisions come before commands and facts, and open questions come last.

## Statuses

| Status | Meaning | In the brief? |
| --- | --- | --- |
| `observed` | Someone saw or decided this. The default. | Yes |
| `confirmed` | The owner reviewed and confirmed it. Needs `--reviewer`. | Yes, ahead of other records of the same kind |
| `disputed` | Someone disagrees; treat with care. | Yes, and listed in `disputedIds` |
| `proposed` | A draft awaiting review. | No, only its ID and title under `review` |

To confirm a record, pass a reviewer reference:

```sh
devctx record add --pilot "$PILOT" --scope example --project example.atlas \
  --kind constraint --status confirmed --reviewer github:your-handle \
  --title "Node 22 or later" --body "The service runs on Node 22 LTS." \
  --request-id req_atlas_node_01 --apply
```

Without `--reviewer`, the command fails with `DEVCTX_APPROVAL_REQUIRED`. Reviewer references take the form `email:`, `github:`, `slack:`, `linear:` or `handle:` followed by an identifier.

:::note
`confirmed` records that the owner signed off through the CLI. It is not proof of who ran the command: every record written through the CLI shows its recorder as `human`, even when an agent ran it.
:::

## Sources

Sources say where a record's evidence came from. Pass `--source` once per source.

| Form | Example |
| --- | --- |
| `file:<path>` | `file:README.md`, a path relative to the repository root |
| `commit:<sha>` | `commit:1791ed0` (7 to 64 hex characters) |
| `record:<id>` | `record:rec_94315938d3e27ab174b5665d` |
| `issue:<KEY-123>` | `issue:ATLAS-42` |
| `user:<ref>` | `user:github:your-handle` |
| `url:<https URL>` | `url:https://example.com/adr/12`, with no query string, fragment or credentials |

File sources drive the freshness label in a brief. Files that onboarding read are stored with a hash, so the brief can say `current` while the file is unchanged and `needs-revalidation` once it changes. A `file:` source you add by hand carries no hash, so the brief marks it `needs-revalidation`. A file that onboarding did not read shows as `unbound-source`. See [freshness](/docs/concepts/briefs/#freshness).

## Records are immutable

Once written, a record never changes. When something changes, write a successor that supersedes it. You need the old record's ID and its current hash, both of which appear in the brief:

```sh
devctx record supersede --pilot "$PILOT" --scope example --project example.atlas \
  --target rec_94315938d3e27ab174b5665d \
  --expect-hash sha256:b411bd1f8c215be10b51c23b52ecac6614a9c3a1d627502e237f5f78e5988423 \
  --kind decision --title "Use server-side search with paging" \
  --body "Filter on the server and page results at 50 items." \
  --request-id req_atlas_search_02 --apply
```

The old record drops out of briefs; the new one takes its place. Both stay on disk, so the history is never lost. The hash check makes sure you are replacing the version you think you are: if someone already superseded it, the command fails with `DEVCTX_STALE_VERSION`.

You can pass `--target` and `--expect-hash` more than once to replace several records with one.

## Request IDs make writes safe to repeat

The record ID comes from the scope, project and request ID. That means:

- Running the same command twice returns the existing record with `"created": false`.
- Reusing a request ID with different content fails with `DEVCTX_CONFLICT`.

So pick a new request ID for each new record, and reuse it only to retry.

## Propose now, publish later

Sometimes you want a record reviewed before it counts, for example when an agent drafts it. `record propose` writes a private proposal file instead of a record:

```sh
devctx record propose --pilot "$PILOT" --scope example --project example.atlas \
  --kind fact --title "Tests use node:test" \
  --body "package.json declares node --test." --source file:package.json \
  --request-id req_atlas_tests_01 --apply
```

```json
{"ok":true,"command":"record propose","result":{"proposalId":"prop_ff03889979eda8c380fdaea8","path":"/private/tmp/devctx-onboard.vgS21y/data/scopes/example/projects/example.atlas/proposals/prop_ff03889979eda8c380fdaea8.json"}}
```

A proposal does not appear in briefs. When you have reviewed it, publish it:

```sh
devctx record publish --pilot "$PILOT" --scope example --project example.atlas \
  --proposal prop_ff03889979eda8c380fdaea8 --reviewer github:your-handle --apply
```

Publishing turns the proposal into an `observed` record. The bundled `devctx-record` skill works this way: the agent proposes and you publish. See [Capture decisions](/docs/guides/capture-decisions/).

## What records refuse

`devctx` scans every title and body for text that looks like a secret, such as private keys, authorization headers, key-and-token assignments, JWTs, and GitHub, AWS or Slack tokens. A match fails with `DEVCTX_SENSITIVE_CONTENT` and nothing is written:

```json
{"ok":false,"command":"record add","error":{"code":"DEVCTX_SENSITIVE_CONTENT","message":"Sensitive content refused","details":{"types":["credential-assignment"]}}}
```

This check is a tripwire, not a guarantee. Never store credentials in records; keep them in your password manager or credential store.
