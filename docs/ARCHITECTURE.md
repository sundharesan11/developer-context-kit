# Architecture

Developer Context Kit stores scoped evidence outside the project repository and builds bounded context from it. The current implementation uses local files, not SQLite, a vector database or a hosted service.

![Pilot architecture: bounded sources, explicit CLI operations, private stores, and manually supplied context.](assets/architecture.svg)

## Read the diagram

| Part | Responsibility |
| --- | --- |
| Project sources | Read bounded files and Git metadata. Preserve repository instructions and files. |
| CLI and approval steps | Select scope/project, preview onboarding, verify fingerprints and perform explicit record operations. |
| Private stores | Keep configuration, immutable records, manifests, approvals and operation receipts outside the toolkit checkout. |
| Briefs and handoffs | Produce bounded views of selected evidence. Report freshness, unknowns and omissions. |
| Person or agent session | Receive context explicitly. Propose or record new observations through the relevant CLI workflow. |

These are logical responsibilities, not isolated services. The CLI's pilot fence does not constrain other tools used by the same agent.

## From source to context

1. **Identify.** Bind an exact worktree to a scope and project. A Git remote is supporting evidence, not identity.
2. **Inspect.** Read bounded source files. Onboarding automatically considers README, agent instruction files and supported manifests. Extra approved documents can be read and hashed; arbitrary documents are not automatically summarized into facts.
3. **Preview.** Present candidates, unknowns, conflicts, intended record bundles and source hashes.
4. **Apply.** Require the reviewed fingerprint for onboarding. Publish the registry reference after record bundles and manifests are written.
5. **Read.** Resolve the project and build a deterministic brief. A brief can contain at most 12 items and 24,576 body bytes, including selected policies.
6. **Learn.** Add a record, supersede it with expected hashes, or use the proposal workflow. These operations have distinct approval contracts; not every command uses an onboarding fingerprint.

This is source-linked context, not a verified model of the entire codebase. A freshness check can detect changed evidence; it cannot establish that a claim is true.

## Where data lives

All current roots are explicitly configured inside a pilot. In live mode the pilot is `~/.devctx/store`, and the profile also names the real skill folders and read-only repositories; see [Live activation](LIVE.md).

| Root | Contents | Belongs in the reusable repository? |
| --- | --- | --- |
| `configRoot` | User preferences, scopes, project bindings and registry | No |
| `dataRoot` | Record bodies/metadata, private skill drafts, staged source files and handoff exports | No |
| `stateRoot` | Locks, run receipts, journals and consumed approvals | No |
| `inputsRoot` | Explicitly supplied pilot inputs and optional local hub fixtures | No |
| Toolkit checkout | CLI code, schemas, generic skills/templates, tests and docs | Yes, after privacy and rights review |

New private files use mode 0600; directories use 0700. The stores are not encrypted by this kit. File permissions do not protect against a malicious process running as the same user.

Records are immutable. Supersession records a successor instead of rewriting an earlier fact. Briefs exclude superseded records and report omissions. Read [Storage](STORAGE.md) for publication, journal and interrupted-write semantics.

## Agents and the personal layer

The kit does not require a particular personal assistant setup, editor or orchestration product. You can use a brief as input to a person or an agent session without installing a skill.

The three bundled skills (`devctx-onboard`, `devctx-resume` and `devctx-record`) route onboard, resume and record actions to this CLI. They locate the kit through the `DEVCTX_KIT` environment variable and call `node "$DEVCTX_KIT/bin/devctx.mjs"`. Before the first call in a session, each skill checks that `DEVCTX_KIT` is an absolute path whose real path is not inside the current repository or worktree, that it contains `bin/devctx.mjs` and a `package.json` named `developer-context-kit`, and that the user confirms the path. The skills offer the live profile `~/.devctx/live.json` as the pilot path, or take a disposable pilot path from the user, and the user confirms it once per session. They refuse one inside the current repository or the kit checkout, because the pilot fence protects pilot roots, not the pilot file. They warn when an installed skill's receipt names a different kit commit from the one at `DEVCTX_KIT`. The skills never run `record publish --apply`. Tests check that skills use only real command routes; they do not check each command's flags. Copies into disposable agent-home layouts are testable. Live mode installs into the real skill folders ([Live activation](LIVE.md)); fresh-session discovery there is not yet verified. An agent envelope is an advisory task contract, not an enforced permission system.

A separate personal setup can eventually provide preferences, scheduling and approved integrations around this kit. It is not automatically migrated, installed or synchronized. See [Agent protocol](AGENT-PROTOCOL.md).

## Optional company knowledge

A company hub is optional and replaceable. The pilot can read explicitly configured local policy fixtures and write a private learning proposal. It does not publish that proposal to a company repository or service.

A record being confirmed locally is not approval to send it elsewhere. Sharing needs destination, privacy and rights review. [Handoff export](HANDOFF.md) is also a private preview, not a send operation.

## Skills and connectors

The [skill-source pipeline](SKILL-SOURCES.md) separates metadata checks, acquisition, content review and disposable installation. It never executes acquired scripts. Presence in a shared folder does not prove compatibility with every agent.

The [auth boundary](AUTH.md) has fake-provider tests for exact actor/account/workspace matching. There is no live credential resolution, OAuth adapter or send implementation.

## Repository map

```text
bin/            CLI entry point
src/            Identity, onboarding, records, context, skills and storage
schemas/        Data contracts
templates/      Generic context and handoff templates
skills/         Bundled skills and skill-creation template
catalog/        Public skill-source metadata
test/           Synthetic behavior and boundary checks
scripts/        Acceptance harness, test runner and package audit
docs/           User guides, implementation contracts and design history
```

For failure modes, read [Limitations](LIMITATIONS.md) and [Security model](SECURITY-MODEL.md). For unfinished capabilities, read the [Roadmap](ROADMAP.md).
