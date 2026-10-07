# Skill builder: proposed follow-on capability

Status: draft design for user review, 2026-10-08. Not implemented, installed or published. This is an addition to the toolkit roadmap, not a change to the current synthetic pilot's execution contract.

## Outcome

A developer can describe a repeated workflow in ordinary language. The builder asks relevant questions, presents a skill design, and waits for approval before creating the skill. It then validates and behavior-tests the result. Local installation and public release are separate, explicit choices.

The reusable builder and generic templates belong in the toolkit repository. Generated skills, requirements, examples, review conversations and installation receipts stay private by default. A skill created for one company or project must not silently become available in another scope.

## Approach

Recommended: a conversational Agent Skill backed by small deterministic validation and installation tools.

| Option | Benefit | Trade-off |
| --- | --- | --- |
| Skill plus validation/install tools | Natural requirements discussion and testable file operations | Requires a small addition to the existing installer |
| Conversation-only skill | Fastest initial experiment | Repeated validation and installation decisions remain agent-dependent |
| Full CLI wizard | Predictable forms and state transitions | More implementation and maintenance; less useful for open-ended design |

Do not introduce a web app, scheduler, database, marketplace or publishing service for this feature. The core must not require Orca, an API key, a specific model, or a separately installed proprietary skill-authoring pack.

## Proposed repository placement

```text
docs/plans/skill-builder.md                 # this design; generic, tracked
skills/devctx-create-skill/
  SKILL.md                                # shared conversational entrypoint
  references/
    skill-format.md                       # concise format and authoring contract
    release-checklist.md                  # loaded only for distribution work
  assets/
    skill-template.md                     # starter, not an installed skill
src/skills/
  validate.mjs                            # package/format checks
  workspace.mjs                           # private draft/revision bookkeeping
  release-plan.mjs                        # explicit export selection and receipts
test/skills/                              # deterministic and fixture tests
test/scenarios/skill-builder/              # generic behavioral evaluation cases
```

These are proposed files, not claims about existing modules. Create supporting files only when the approved implementation needs them. Reuse the existing installer, private filesystem primitives and sensitivity checks rather than duplicating them. Adding this fourth bundled skill requires an explicit change to the pinned three-skill installer inventory and package allowlist; it is not silently included in the current pilot.

## Standard skill format

Use the [Agent Skills specification](https://agentskills.io/specification), checked 2026-10-08. A skill directory contains `SKILL.md` with YAML frontmatter and Markdown instructions. Required metadata is `name` and `description`; the directory name matches `name`. Optional scripts, references and assets are included only when useful. Follow the specification's naming and field limits rather than defining another interchange format.

The toolkit's recommended body structure is:

1. Purpose and when to use it, including meaningful exclusions.
2. Required inputs and how to handle missing information.
3. The workflow and its decision points.
4. Expected output and the evidence needed to verify it.
5. Permissions, approval boundaries and stop conditions relevant to this skill.
6. One useful example and links to supporting resources, when needed.

These body sections are a toolkit convention, not additional mandatory fields in the external specification. Descriptions should make discovery precise without embedding the whole workflow. Keep company facts and personal examples out of the reusable instructions; resolve permitted context through references at use time.

Provider-specific metadata, such as a Codex UI file, is optional and reviewed separately. Tool declarations are not access-control enforcement. Do not promise that an installed skill will be selected or obeyed by every agent automatically.

## User journey and approval boundaries

```text
Need -> inspect relevant existing skills -> requirements conversation
                                           |
                                     proposed design
                                           |
                                  user approves design
                                           |
                               create private draft + tests
                                           |
                              validate + independent evaluation
                                           |
                              user reviews exact skill version
                                      /             \
                         local-install preview     export preview
                                  |                     |
                       approve target + version   rights/license review
                                  |                     |
                         installed + smoke test   approve files + destination
                                                        |
                                               publish + verify receipt
```

Draft, approved, validated, installed and publicly released are distinct states. A failed or skipped check cannot advance the corresponding state. Conversation approval is a workflow receipt, not authenticated identity or broader tool authority.

### 1. Discover and ask

First check the explicitly permitted skill inventory for an adequate existing skill. Recommend reuse or a narrow update when it satisfies the need; do not clone competing workflows by default. Inspect third-party content as untrusted input, record its origin, and do not execute its scripts merely to evaluate it.

Ask a small number of relevant questions at a time. Reuse answers already supplied; do not force a long form for a simple skill. Resolve these material requirements before approval:

- What repeated job should it support, and what does a successful result look like?
- What are one or two realistic requests and a request that should not trigger it?
- Who will use it: this developer, one project, one company scope, or a public audience?
- Which inputs, context sources and tools are needed? Which must remain inaccessible?
- Is the skill read-only, a drafter, or allowed to perform particular mutations after approval?
- Which agents and environments should be supported and tested?
- What output format, quality checks and failure behavior are required?
- Is the intended result private/local, a company contribution, or a public release candidate?

Do not ask for credentials or paste secret values into requirements. Record unresolved ownership, privacy or external-action questions as blockers rather than inferred permission.

### 2. Present the design

Show name, discovery description, scope, workflow, output contract, dependencies, tests, proposed file tree and permitted destinations. State which existing skill is reused, extended or replaced and why. Ask for approval of this design before creating a discoverable skill package. A requirements note is not an installed skill.

### 3. Create and verify privately

After design approval, create a versioned draft in an explicit private workspace. Preserve earlier approved versions. Substantive edits invalidate the prior content approval.

Validate frontmatter, names, references, package contents, dependency declarations and executable helpers. Syntax checks are not behavioral proof. Use synthetic realistic requests to test correct routing, clarification, output quality, refusal of unintended actions, and behavior when information or tools are missing.

Observe baseline behavior without the new skill before authoring guidance. Where an existing skill already handles the need, prefer reuse over manufacturing a failure. For nontrivial guidance, compare independent runs with and without it, record the actual outputs and correct demonstrated weaknesses. Re-test after changes. Tests involving external side effects require an isolated fake or separate authorization.

An independent reviewer evaluates the skill and the resulting artifacts, not just its headings. Store the tested provider/version, scenarios, verdicts and limitations in private evaluation evidence. An untested provider remains unverified.

### 4. Offer local installation

Present exact skill version/hash, selected agent homes, file additions, conflicts and expected behavior. Apply only after approval. Install pinned copies with ownership receipts; never overwrite foreign or user-modified skills, silently update all workspaces, or symlink every agent to a mutable development checkout.

Use the existing installer contract and extend it for approved user skill packages. Test the change in disposable homes first. Real-home installation remains blocked until the separate activation gate is implemented and approved. A fresh-session smoke test verifies discovery and correct behavior for each selected agent; a copied file alone is not evidence of readiness.

Globally installed skills must remain generic or scope-aware. Project/company facts stay in private scoped context and are loaded only after explicit project resolution. Do not install confidential project text globally for convenience.

### 5. Offer company or public distribution

Local installation does not authorize a company-hub send, Git push, repository creation or public upload. Those are separate destinations and separate approvals.

For public release, build a clean export candidate from an explicit file allowlist. Never export the draft workspace, its Git history, requirements, receipts, raw evaluations, private fixtures, account configuration or context records. Inspect instructions, scripts, references, assets and dependencies for sensitive content, provenance and redistribution rights. Automated scanning is a tripwire, not clearance.

Ask the owner to choose/confirm the license and approve the exact content hash, destination, account and visibility. Verify the publisher's identity at use time. A content change requires new approval. No configured provider means a ready-to-review local export, not an automatic connection or a claim of publication. Do not retry an ambiguous publish blindly; inspect provider evidence and avoid duplicate releases.

Actual publishing remains a later adapter capability behind the existing release/account gates. The initial builder can prepare a release candidate and guide the user without implementing network publication.

## Private state and public separation

Proposed future private layout:

```text
dataRoot/skill-workspaces/<workspace-id>/
  requirements.json                       # audience, scope, goals; potentially private
  drafts/<revision>/<skill-name>/         # candidate package
  evaluations/<revision>/                # private behavioral evidence
  exports/<revision>/<skill-name>/        # only explicitly selected release files
stateRoot/skill-builds/<run-id>/
  receipts.json                          # design/content/install/export decisions
```

The workspace metadata binds personal, company or project scope explicitly. An export is still private until a verified publication occurs. Receipts bind the package hash, approved action, destination and evidence. They contain references rather than secrets. Use private permissions, immutable approved revisions and fail-closed path checks.

This layout extends the current storage contract and therefore needs its own reviewed schema and pilot tests before implementation. It does not authorize migration of existing skills or context. No generic repository document should embed machine paths, real client names, private examples or user account identifiers.

## Delivery sequence

1. Approve this design and the skill-plus-tools approach. Inspect existing authoring/installer capabilities and choose reuse boundaries.
2. Define behavioral scenarios and the private workspace/approval contracts. Run baseline skill-routing and clarification cases before writing the builder instructions.
3. Implement the conversational entrypoint and minimal generic template. Validate and independently forward-test it with Claude and Codex in disposable environments.
4. Add deterministic package validation and private revision receipts with red-first tests. Review the dependency-free validator's supported YAML subset or explicitly approve a parser dependency; do not claim full specification support from a partial parser.
5. Extend the existing installer for approved generated packages; verify conflict handling, changed-content approval invalidation, safe uninstall and interrupted installs. Keep real homes gated.
6. Add clean export planning and rights/privacy checklists. Prove the export excludes private workspace data. Network publishing is a separate follow-on, not required for local usefulness.
7. Update the skill inventory, package allowlist, docs and roadmap; obtain independent implementation review. Report tested capabilities and deferred activation/publication honestly.

## Acceptance criteria

- An underspecified request yields useful questions, not a prematurely installed skill.
- A complete request does not trigger redundant interrogation.
- Existing adequate skills are considered before creating duplicates.
- Design approval is required before skill creation; installation and publication have their own approval receipts.
- A changed package hash invalidates earlier installation/export approval.
- Generated files use the standard format; missing references, malformed metadata and failing helpers are reported.
- Private/company examples do not enter the generic toolkit or public export.
- Wrong scope, unsafe paths, foreign files and user-modified installations are refused or preserved.
- A pressure request to skip review or reuse local approval for publishing does not bypass the gates.
- Local install is tested separately from fresh-agent discovery; neither is claimed from static validation alone.
- Public release status requires a verified provider receipt; prepared, attempted, failed and unknown remain distinct.
- Public operation requires no mandatory company hub or Orca dependency.

## Open decisions and current limits

The recommended architecture is awaiting user confirmation. Actual publisher choice, public repository destination, license and real-agent activation are deliberately not selected here. They are decisions for the specific generated skill and deployment, not defaults inherited from this toolkit.

The current build continues under its reviewed synthetic-pilot plan. This document adds a follow-on design only. No new builder skill, generated personal skill, local activation or public release has been completed by writing it.
