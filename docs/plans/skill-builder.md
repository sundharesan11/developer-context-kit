# Skill builder: proposed follow-on capability

Status: draft design for user review, 2026-10-08. Not implemented, installed or published. This is an addition to the toolkit roadmap, not a change to the current synthetic pilot's execution contract.

## Outcome

A developer can describe a repeated workflow in ordinary language. The builder asks relevant questions, presents a skill design, and waits for approval before creating the skill. It then validates the result and reports which behavioral tests actually ran. Local installation and public release are separate, explicit choices. The first release supports private drafts, disposable-home installation and clean local export preparation; automatic network publishing is a separately approved follow-on.

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
src/skill-builder/
  validate.mjs                            # package/format checks
  workspace.mjs                           # private draft/revision bookkeeping
  release-plan.mjs                        # explicit export selection and receipts
test/skills/                              # deterministic and fixture tests
test/scenarios/skill-builder/              # generic behavioral evaluation cases
```

These are proposed files, not claims about existing modules. Create supporting files only when the approved implementation needs them. Reuse `src/agents/` for installation and `src/hubs/` for company proposals, plus the private filesystem primitives and sensitivity checks, rather than duplicating them. Core implementation and independent review must finish before those components are treated as usable dependencies. Adding this fourth bundled skill requires an explicit change to the pinned three-skill installer inventory and package allowlist; it is not silently included in the current pilot.

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

Track evidence on each immutable revision instead of a single ambiguous approved flag:

| State or receipt | Required evidence | Invalidation or next action |
| --- | --- | --- |
| Requirements draft | User answers and explicit unknowns | Revise until material questions are resolved |
| Design approved | Explicit user response tied to the design digest | A changed design needs new approval |
| Skill draft at revision | Exact files and package manifest/hash | Never silently replace an approved revision |
| Validated at hash | Required deterministic checks pass | Any package change requires revalidation |
| Evaluated at hash | Actual scenario/provider results | Missing authorization remains deferred, not passed |
| Content approved at hash | User accepts the exact reviewed package | Any changed hash invalidates content/install/export approval |
| Installed at hash and target | Specific installation approval plus installer receipt | Modified or conflicting target is preserved and reported |
| Export prepared at hash | Selected files, privacy/provenance review | Still private; no publication claimed |
| Publish attempted/failed/unknown | Later adapter's operation evidence | Unknown outcome needs reconciliation, not blind retry |
| Published and verified | Exact destination plus verified provider receipt | Not reachable through the initial export-only implementation |

Failed validation or evaluation leaves the revision a draft with its failure evidence; a revision corrects it and runs new checks. Rejected design returns to requirements, and rejected content remains a draft. Approval capture requires an explicit current user response referencing the shown revision/hash and intended action, recorded with its interaction reference. Agents cannot infer an approval from silence, mark their own draft approved, or transfer approval between actions. The receipt is a workflow record, not authenticated identity or broader tool authority.

### 1. Discover and ask

First check bundled skills and user-approved source directories, read-only, for an adequate existing skill. The synthetic pilot uses only bundled or fixture sources, not real agent homes. Recommend reuse or a narrow update when it satisfies the need; do not clone competing workflows by default. Updates to foreign or third-party skills are private forks or patch proposals, never in-place edits without ownership and specific approval. Inspect third-party content as untrusted input, record its origin, and do not execute its scripts merely to evaluate it.

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

After design approval, create a versioned draft in an explicit private workspace. Preserve earlier approved versions. Any package hash change invalidates prior content, installation and export approval.

Validate frontmatter, names, references, package contents and dependency declarations. Generated helpers are untrusted code: static inspection does not authorize execution. Executing them needs an approved isolated test with explicit filesystem/network permissions; a temporary directory alone is not a sandbox. Unsupported or untested helpers remain unverified.

Use three distinct test tiers:

- Deterministic tests exercise validators, private revisions, approvals, exports and disposable installation without live accounts.
- Scripted/fake scenarios exercise tool-level gates and state transitions. They do not prove that a language model asks good questions or follows the skill.
- Live-model evaluations test routing, clarification and output quality. They require separate approval naming provider/account, fixtures and permitted egress. Use synthetic content unless private content is specifically approved. Without that approval, report them deferred. A fresh agent-home discovery test additionally needs the real-home activation gate; presenting skill text to an already authorized evaluator is not proof of installed discovery.

Observe baseline behavior without the new skill before authoring guidance. Where an existing skill already handles the need, prefer reuse over manufacturing a failure. For nontrivial guidance, compare independent runs with and without it, record the actual outputs and correct demonstrated weaknesses. Re-test after changes. Tests involving external side effects require an isolated fake or separate authorization.

An independent reviewer evaluates the skill and the resulting artifacts, not just its headings. Store the tested provider/version, scenarios, verdicts and limitations in private evaluation evidence. An untested provider remains unverified.

### 4. Offer local installation

Present exact skill version/hash, selected agent homes, file additions, conflicts and expected behavior. Apply only after approval. Install pinned copies with ownership receipts; never overwrite foreign or user-modified skills, silently update all workspaces, or symlink every agent to a mutable development checkout.

Use the existing installer contract and extend it for approved user skill packages. Test the change in disposable homes first. Real-home installation remains blocked until the separate activation gate is implemented and approved. A fresh-session smoke test verifies discovery and correct behavior for each selected agent; a copied file alone is not evidence of readiness.

Recommended initial installation scope: only personal/generic, non-confidential packages in selected user-level agent homes. Company/project-specific packages remain private drafts until a separate scoped-discovery adapter or explicit repository-change design is approved; the builder must refuse their global installation. No client repository files are changed by this first version. A generic skill may resolve permitted project facts through the context API, but its name, description and body cannot contain confidential scope-specific material. This scope restriction awaits user confirmation as part of the design.

### 5. Offer company or public distribution

Local installation does not authorize a company-hub send, Git push, repository creation or public upload. Those are separate destinations and separate approvals.

For public release, build a clean export candidate from an explicit file allowlist. Private workspaces are versioned file bundles, not Git repositories. Never export the workspace container, requirements, receipts, raw evaluations, private fixtures, account configuration, context records, or history from an imported source repository. Inspect instructions, scripts, references, assets and dependencies for sensitive content, provenance and redistribution rights. Automated scanning is a tripwire, not clearance. Company contributions reuse the existing private hub-proposal flow and still need separate send approval.

Ask the owner to choose/confirm the license and approve the exact content hash, destination, account and visibility. Verify the publisher's identity at use time. A content change requires new approval. No configured provider means a ready-to-review local export, not an automatic connection or a claim of publication. Do not retry an ambiguous publish blindly; inspect provider evidence and avoid duplicate releases.

Actual publishing remains a later adapter capability behind the existing release/account gates. The initial builder can prepare a release candidate and guide the user without implementing network publication.

## Private state and public separation

Proposed future private layout:

```text
dataRoot/personal/skill-workspaces/<workspace-id>/
  requirements.json                       # audience, scope, goals; potentially private
  drafts/<revision>/<skill-name>/         # candidate package
  evaluations/<revision>/                # private behavioral evidence
  exports/<revision>/<skill-name>/        # only explicitly selected release files
  decisions/<decision-id>.json            # immutable approval/evidence record
dataRoot/scopes/<scope>/skill-workspaces/<workspace-id>/
  ...                                    # same structure, company-scoped only
dataRoot/scopes/<scope>/projects/<project>/skill-workspaces/<workspace-id>/
  ...                                    # same structure, project-scoped only
stateRoot/runs/<run-id>/
  journal.json                           # existing installer journal, when applicable
```

Paths and metadata both bind personal, company or project scope explicitly. Resolve that scope before listing workspaces or reading their bodies; no cross-scope fallback. An export is still private until a verified publication occurs. Immutable decision files bind the package hash, approved action, destination and evidence and outlive the creating agent run. They reference the existing installer's ownership receipt/journal rather than replacing it. They contain references rather than secrets. Use private permissions, immutable approved revisions and fail-closed path checks.

This layout extends the current storage contract and therefore needs its own reviewed schema and pilot tests before implementation. It does not authorize migration of existing skills or context. No generic repository document should embed machine paths, real client names, private examples or user account identifiers.

## Delivery sequence

Entry criteria: user approves this design; the core pilot's storage, installer and package audit have passed independent review; synthetic execution boundaries are retained. Until then, this remains planning work.

1. Define scenarios and the private workspace/approval contracts. Obtain evaluation permission and observe baseline routing/clarification behavior before authoring new guidance. If approval is unavailable, prepare deterministic fixtures but defer live behavior claims.
2. **Milestone A — smallest useful slice:** implement private requirements/design receipts, a minimal template and validator with red-first tests, then the conversational skill. Deliver requirements → design approval → private draft → validation, with independent synthetic evaluation when authorized. No installation. The current core has no YAML parser; default to a documented dependency-free generated-frontmatter subset that rejects unsupported constructs. Do not claim a partial validator implements the whole specification; a general parser dependency requires a separate reviewed choice.
3. **Milestone B — disposable local installation:** extend `src/agents/` for approved generic/personal packages. Verify conflict handling, hash-bound approvals, preserved user edits, safe uninstall and interrupted journals. Real homes remain gated. Obtain independent review before moving on.
4. **Milestone C — clean export preparation:** add allowlisted exports and rights/privacy checklists. Prove private workspace data is excluded and that the tool cannot mark an export published. Obtain independent review. Network publishing and confidential scoped discovery are separate follow-ons.
5. At each milestone, update the inventory, package allowlist, docs and roadmap and run regression gates. Report tested capabilities and deferred live evaluation, activation and publication honestly.

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
- No operation records published without a verified provider receipt; the first version can reach at most export-prepared. Prepared, attempted, failed and unknown remain distinct.
- Public operation requires no mandatory company hub or Orca dependency.

Deterministic tests prove file format, path, scope, approval, installer and export invariants. Scripted scenarios prove only the corresponding state/tool guards. Claims about useful questions, routing and response quality require live-model evaluation evidence; claims about discovery require fresh-session tests. Deferred live evaluation is an explicit usability limitation, not a silent acceptance pass.

## Open decisions and current limits

The recommended architecture is awaiting user confirmation, including generic/personal-only installation and export-only initial publishing support. Actual publisher choice, public repository destination, license and real-agent activation are deliberately not selected here. They are decisions for the specific generated skill and deployment, not defaults inherited from this toolkit.

The current build continues under its reviewed synthetic-pilot plan. This document adds a follow-on design only. No new builder skill, generated personal skill, local activation or public release has been completed by writing it.
