---
title: Personal Harness Template - Plan
type: feat
date: 2026-10-16
topic: personal-harness-template
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# Personal Harness Template - Plan

## Goal Capsule

- **Objective:** Make Developer Context Kit (DCK) usable as a clonable, generic personal-harness template: a short first-run setup that captures a small private profile, plus two instruction-only starter skills (general writing and stack-update check) that read it.
- **Product authority:** This Product Contract. The owner confirmed the scope, the sequencing (a new stage after roadmap priority 2 and before priority 3), the delivery model, the network-approval model and the naming decision in the brainstorm on 2026-10-16.
- **Open blockers:** None for planning. Implementation of anything that touches agent homes or the installer waits for roadmap priority 2 to merge (see Dependencies / Assumptions).

---

## Product Contract

### Summary

A first-run setup asks three to five skippable questions and writes a capped, private profile: how the developer likes to work with agents, the stack they know, the stack they use now, and the kind of work they do.
Every profile change is previewed and approved, keeps history, and lives outside the clone.
Two instruction-only starter skills ship with the template: a writing skill that drafts any kind of message from the profile and selected project context without sending, and a manually run stack-update check that turns the declared stack into a sourced digest of releases, breaking changes, deprecations, end-of-life dates and advisories.

### Problem Frame

DCK today keeps source-linked project facts, decisions and handoffs outside project repositories so that the next session can resume.
It knows almost nothing about the developer: the existing `init` preferences hold only an explanation style, a diagram preference and up to ten short notes, and that file cannot be changed after it is written.
When a developer switches project, machine, session or agent, the agent loses how this person works and what stack they live in, so the developer repeats it in every new session or in every agent's separate personal instruction file.

The owner already runs a private setup that solves this for one person: canonical cross-agent skills, a startup pointer in each agent's global instruction file, private project registration and optional local notes.
That setup is personal and cannot be shared.
Public harnesses that people do clone (gstack, Superpowers, SuperClaude, PAI/LifeOS) either have no personalization step or are heavy and tied to one agent.
Anyone cloning such a template today forks someone else's preferences and edits them by hand, and the instance and the template mix in one tree, which is how personal files end up committed.

### Prior Art

Research date 2026-10-16, public sources only. Citations point at the source; items marked unverified could not be confirmed against a primary source.

**Instruction files and built-in memory: interoperate, do not replace.**
- AGENTS.md is the shared repository instruction file, now stewarded by the Linux Foundation's Agentic AI Foundation and read by Codex, Cursor, Copilot, Gemini CLI, Windsurf and others ([agents.md](https://agents.md/), [OpenAI announcement](https://openai.com/blog/agentic-ai-foundation)). It is repository-committed and has no agreed user-level location; users have asked for one ([Cursor forum](https://forum.cursor.com/t/support-global-agents-md/150406), [pi issue](https://github.com/earendil-works/pi/issues/5002)).
- Claude Code loads `~/.claude/CLAUDE.md` for all projects, supports `@path` imports and advises under 200 lines per file. Its auto memory is per repository, per machine, written without per-item approval ([Claude Code memory docs](https://code.claude.com/docs/en/memory)).
- Codex reads `~/.codex/AGENTS.md` with a 32 KiB cap; its memories are off by default and documented as "a recall aid, not a rulebook" ([AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [Codex memories](https://learn.chatgpt.com/docs/customization/memories?surface=app)).
- Cursor removed its Memories feature and told users to export them to rules; its User Rules are a settings box, not a file ([forum](https://forum.cursor.com/t/are-my-memories-gone/144057), [file-backed user rules request](https://forum.cursor.com/t/file-backed-agent-editable-user-rules-parity-with-project-cursor-rules/166055)).
- GitHub Copilot Memory validates a memory against current code before use and expires it after 28 days unused; it is cloud and Copilot-only ([GitHub docs](https://docs.github.com/en/copilot/concepts/agents/copilot-memory)).
- **DCK position:** every agent has a personal slot and none share a source. DCK keeps one approved profile and lets agents pull it; it does not compete with AGENTS.md or vendor memory.

**Instruction sync: solved, do not build.**
- ruler writes one rule source into about 31 agents' native files with dry-run, managed blocks, backups and revert ([ruler](https://github.com/intellectronica/ruler)); rulesync targets about 60 ([rulesync](https://github.com/dyoshikawa/rulesync)); vibe-rules keeps a personal rule library ([vibe-rules README](https://cdn.jsdelivr.net/npm/vibe-rules@0.3.91/README.md)).
- **DCK position:** point users at these for fan-out. Borrow ruler's dry-run and managed-marker conventions for the single opt-in pointer.

**Memory products: crowded, mostly automatic and often cloud-bound.**
- mem0/OpenMemory needs an OpenAI key in its easy setup and has a reported telemetry opt-out bug ([OpenMemory](https://mem0.ai/blog/introducing-openmemory-mcp), [issue 2062](https://github.com/mem0ai/mem0/issues/2062)); Supermemory pools agent memories in a cloud workspace and disclosed a recall bug that let a crafted Bash command run without confirmation ([changelog](https://supermemory.ai/changelog/plugins/claude)); claude-mem compresses observations through the model provider ([architecture](https://docs.claude-mem.ai/architecture/overview)); Basic Memory is local Markdown under AGPL-3.0 ([repository](https://github.com/basicmachines-co/basic-memory)).
- Almost none preview a write before storing it or re-check a source before using a fact.
- **DCK position:** keep the reviewed, source-linked, plain-file layer. Do not add automatic capture or vector retrieval.

**Session transfer: covered elsewhere.**
- SpecStory and continues/casr archive and convert native session transcripts between agents ([SpecStory](https://docs.specstory.com/integrations/terminal-coding-agents), [write-up](https://codex.danielvaughan.com/2026/06/01/codex-cli-cross-agent-session-portability-continues-casr-handoff/)). Guides recommend handing over compact working state, not transcripts ([Superset](https://superset.sh/blog/switching-between-ai-coding-agents)).
- **DCK position:** out of scope, as the owner noted. DCK's handoff stays a compact reviewed note.

**Personal harness templates: demand exists, the personalization step is missing.**
- Agent Skills (`SKILL.md` folders) is an open format read by Claude Code, Codex, Gemini CLI, Cursor, Copilot and many others ([agentskills.io](https://agentskills.io/home)). Starter skills should use it unchanged.
- PAI/LifeOS keeps a `USER/` tree its installer never touches and generates the public repository from a private one; it is heavy and Claude Code-centric ([repository](https://github.com/danielmiessler/Personal_AI_Infrastructure)).
- OpenClaw's first run is three or four beats and its template says not to turn it into a questionnaire; its `USER.md` grows later through dated active or superseded entries under a 4,000-character budget ([bootstrap template](https://docs.openclaw.ai/reference/templates/BOOTSTRAP), [workspace](https://docs.openclaw.ai/concepts/agent-workspace)). Hermes caps its user profile at about 1,375 characters (secondary source: [overview](https://parallel.ai/articles/what-is-hermes-agent)).
- gstack, Superpowers, compound-engineering and SuperClaude publish someone's workflow with no personalization step ([gstack summary](https://augmentcode.com/learn/garry-tan-gstack-claude-code), [Superpowers](https://github.com/obra/superpowers), [compound-engineering](https://github.com/EveryInc/compound-engineering-plugin), [SuperClaude](https://github.com/SuperClaude-Org/SuperClaude_Framework)).
- Survey completion falls with every added question up to about 15 ([SurveyMonkey](https://www.surveymonkey.com/curiosity/survey_questions_and_completion_rates/)); no developer-tool onboarding study was found.
- **DCK position:** own the small personalization layer. Recommend process-skill packs as companions instead of rebuilding them.

**Template and instance separation: leaks are real.**
- `.claude/settings.local.json` files with secrets were pushed to public repositories and shipped inside npm packages ([issue mirror](https://claudeissues.com/issue/13106-bug-sensitive-tokens-stored-in-claude-settings-local-json-and-not-ignored-by-git), [Check Point report](https://securitybrief.news/story/claude-code-can-leak-secrets-in-public-npm-packages)).
- A study of about 42,000 marketplace skills found 26% with at least one vulnerability, with script-bearing skills about twice as risky ([arXiv 2601.10338](https://arxiv.org/html/2601.10338v1)); OWASP lists skill-borne exfiltration ([Agentic Skills Top 10](https://owasp.org/www-project-agentic-skills-top-10/ast01.html)).
- **DCK position:** the instance lives outside the clone by construction, and starter skills are instruction-only.

**Stack-update data: reuse public sources, build only the thin layer.**
- endoflife.date gives lifecycle and latest version per product without auth; its API is beta ([OpenAPI](https://endoflife.date/docs/api/v1/openapi.yml)). OSV.dev aggregates GitHub, PyPI, Go, RustSec and malicious-package advisories with no documented rate limit and offers bulk downloads ([API](https://google.github.io/osv.dev/api/), [data](https://google.github.io/osv.dev/data/)). Unauthenticated GitHub REST is limited to 60 requests per hour ([rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)).
- Dependabot, Renovate and Snyk assume a repository manifest; a declared stack does not fit them ([Dependabot ecosystems](https://docs.github.com/enterprise-server@3.15/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories), [Renovate local platform](https://docs.renovatebot.com/modules/platform/local)). NewReleases.io watches declared projects but stores the stack in its account and covers releases only ([NewReleases](https://newreleases.io)).
- Update noise is the main complaint: Dependabot was called a "noise machine" in February 2026 and GitHub added auto-dismiss rules for alert fatigue ([devclass](https://www.devclass.com/security/2026/02/26/github-dependabot-is-a-noise-machine-and-should-be-turned-off-says-go-library-maintainer/4091858), [GitHub blog](https://github.blog/security/supply-chain-security/dependabot-relieves-alert-fatigue-from-npm-devdependencies)).
- Hallucinated changelog claims are a described failure mode; no measurement of the rate was found ([example](https://dev.to/nazar-boyko/ai-agents-for-release-notes-and-changelog-automation-kia)).
- Cloud routines run without a permission picker and cannot see local files; local schedulers can ([Routines](https://code.claude.com/docs/en/routines), [Desktop scheduled tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)).
- **DCK position:** no mature open-source "watch my declared stack" skill was found. Build the skill, not the data.

**Writing assistance: patterns to copy, harms to design against.**
- Anthropic's `internal-comms` skill keeps one short guideline per message type and asks when the type is unclear; `doc-coauthoring` adds a reader test ([internal-comms](https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md), [doc-coauthoring](https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md)).
- Gmail's "Help me write" shows which emails and files a draft used ([Google help](https://support.google.com/mail/answer/13955415)).
- Heavy AI assistance lowered perceived sincerity of manager emails from 83% to 40–52% ([University of Florida](https://news.ufl.edu/2025/08/writing-ai-work/)); assistants have invented email threads and stale facts ([example](https://aipressroom.beehiiv.com/p/googles-new-gmail-tool-is-hallucinating-emails-that-dont-exist)).
- **DCK position:** draft only, show the context used, mark unverified facts, ask when audience or purpose is unclear.

### Key Decisions

- **New stage between roadmap priorities 2 and 3.** The profile and starter skills run offline and need no hooks or migration, so they can follow real-home activation without waiting for session hooks. Priorities 3 to 9 shift down one place. (session-settled: user-directed — chosen over waiting for priorities 1–4, a parallel track now, or folding into the open-source release: it lets the template shape stabilize before hooks and migration build on it.)
- **Agents pull the profile; an optional pointer comes later.** The profile lives in the private config root. Skills and the brief read it on demand. An opt-in, previewed one-line pointer in each agent's personal instruction file is added only through the priority 2 installer gate, after priority 2 merges. UI-only slots get paste-ready text. (session-settled: user-directed — chosen over never touching agent files and over rendering the full profile into each agent file: it keeps one source and the fewest agent-home writes while still allowing an always-on effect.)
- **Stack checks use a source plan approved once.** The user approves the exact hosts and item list once. Later runs reuse that approval until the stack or source list changes. No account or token is needed; an optional GitHub token comes from the environment or keychain, never from records. (session-settled: user-directed — chosen over approving every run and over offline-only bulk data: it honours "nothing sent outward without approval" while keeping later unattended runs possible.)
- **Keep the DCK name and add a harness layer.** The repository, package and CLI keep their names; docs describe a personal-harness template built on DCK. Release naming stays with priority 9. (session-settled: user-directed — chosen over renaming now or a separate template repository: it avoids churn while priority 2 activation is in flight.)
- **Versioned profile, not a write-once preference file.** Every profile edit is a previewed, hash-bound revision; earlier revisions stay readable. (session-settled: user-approved — chosen over extending the existing write-once preferences and over generating a private instance repository: it reuses DCK's preview, approval and immutability rules without taking on backup or migration work.)
- **Two starter skills, instruction-only.** No bundled scripts. Engineering-process skills are recommended companions, not rebuilt. Research shows script-bearing skills carry more risk and large skill packs bloat context.
- **Scheduling stays at roadmap priority 8.** This stage delivers manual runs and a documented, disabled scheduling recipe. Enabling a schedule needs the priority 8 gate.

### Actors

- A1. Developer: clones the template, answers setup, approves profile and stack changes, runs the skills.
- A2. Coding agent (Claude Code, Codex, or another Agent Skills host): reads the profile and runs a starter skill on the developer's request.
- A3. Public data sources: lifecycle, advisory, registry and release-note hosts that the stack check queries under the approved source plan.

### Key Flows

- F1. First-run setup
  - **Trigger:** A1 runs setup in a fresh clone with no profile.
  - **Actors:** A1, A2 optional.
  - **Steps:** Show what will be asked and where it will be stored. Ask up to five questions; each accepts skip or free text. Offer stack suggestions drawn from already-onboarded projects as a preview the developer can accept, edit or reject. Show the complete profile and its destination. Write only on approval.
  - **Outcome:** A capped private profile outside the clone, or nothing if A1 declines.
  - **Covered by:** R1–R7, R9.
- F2. Profile change
  - **Trigger:** A1 or A2 proposes an edit, for example after a stack change.
  - **Steps:** Show the old and new values and the resulting size. Apply only with approval bound to that exact change. Keep the earlier revision readable.
  - **Covered by:** R8–R10.
- F3. Draft a message
  - **Trigger:** A1 asks A2 to draft an email, status update, PR description, announcement or similar.
  - **Steps:** Identify message type, audience and purpose, asking if any is unclear. Read the profile and only the project context A1 selects. Produce a draft with a list of context used and every unverified name, date, number or commitment marked.
  - **Outcome:** A draft in the session. Nothing is sent. Saving it is a separate approved write.
  - **Covered by:** R13–R19.
- F4. Stack-update check
  - **Trigger:** A1 runs the check manually.
  - **Steps:** If no approved source plan exists, or the stack or source list changed, show the hosts and items that will be queried and wait for approval. Fetch from approved sources. Classify and summarize only fetched text. Produce a dated digest grouped by severity, with a source link for every claim. Write the digest only with approval.
  - **Covered by:** R20–R29.

### Requirements

**Template and instance separation**
- R1. A fresh clone contains no personal data: no profile, stack, digest, draft, account or path belonging to any person.
- R2. Setup writes the profile and stack only to private roots outside the clone. A destination inside any Git worktree is refused.
- R3. A repository check fails when a tracked file contains instance data or a disallowed personal identifier, and the packaging allowlist excludes instance files.
- R4. Docs explain how to keep the private instance in a separate private repository or dotfiles manager without DCK building sync.

**First-run setup**
- R5. Setup asks at most five questions covering agent-working preferences, the stack known, the stack in current use and the kind of work; each can be skipped.
- R6. Setup can suggest current-stack entries from projects already onboarded in DCK, shown as a preview that the developer accepts, edits or rejects. It never scans repositories that are not onboarded.
- R7. Setup shows the full proposed profile and destination and writes nothing without approval.

**Profile**
- R8. The profile has a hard size cap that keeps it suitable for always-loaded context; an edit that would exceed it is refused with the current size.
- R9. Profile text is checked by the existing sensitive-content rules; secret-like content is refused, not redacted.
- R10. Each profile change is a new revision bound to an approval of that exact change; earlier revisions remain readable and the current one is unambiguous.
- R11. The profile is readable on demand by skills and is included in the project brief within the brief's existing budget.
- R12. The profile can be exported as paste-ready text for agents whose personal slot is not a file. Export writes nothing outside the private roots.

**Writing skill**
- R13. The writing skill drafts any message type for any role, not only email or sales.
- R14. It asks one question when the message type, audience or purpose is unclear instead of guessing.
- R15. It uses the profile's writing preferences when present: tone, formality by audience, greeting and sign-off, length, formatting, spelling variant and phrases to avoid.
- R16. It reads only the profile and project context the developer selects, never the whole store.
- R17. Every draft lists the context it used and marks any name, date, number or commitment not found in that context as unverified.
- R18. The skill never sends, posts or schedules a message and never calls a connector.
- R19. Saving a draft is a previewed write into the private data root; drafts are never written into the clone or a project repository.

**Stack-update check**
- R20. The developer declares the stack as named items with an optional version or major line and a care level.
- R21. Before the first run, and whenever the stack or source list changes, the check shows the hosts and items it will query and waits for approval.
- R22. The check uses no account by default. An optional token is read from the environment or keychain and never stored in records or digests.
- R23. The check reports new releases, breaking changes, deprecations, end-of-life dates and security advisories that affect declared items.
- R24. Every reported claim cites its fetched source; a claim without fetched source text is labelled unverified, and breaking changes are never inferred from version numbers alone.
- R25. The digest groups findings by severity, hides patch-level noise by default and does not repeat findings already reported unless they change.
- R26. A source failure or rate limit is reported per item and does not fail the whole run.
- R27. The digest is dated and written to the private data root only with approval.
- R28. The check never changes a project, lockfile, manifest or installed tool.
- R29. A documented scheduling recipe ships disabled. Enabling a schedule is outside this stage.

**Starter skill packaging**
- R30. Both starter skills are instruction-only Agent Skills folders with no bundled scripts and follow the existing bundled-skill rules (kit path check, pilot path from the user, explicit scope, stop rules).
- R31. Docs recommend engineering-process skill packs as optional companions without bundling them.

**Agent pointer (after priority 2)**
- R32. An opt-in pointer from each supported agent's personal instruction file to the profile is offered only after priority 2 merges, through its installer gate, with preview, approval, preserved foreign content and verified removal.

**Roadmap and docs**
- R33. The roadmap shows this stage between priorities 2 and 3, renumbers later priorities, and keeps the freeze on skill-builder and skill-source feature work.
- R34. Docs describe DCK as a personal-harness template built on DCK without claiming fresh-session discovery, platforms or schedules that are not verified.

### Acceptance Examples

- AE1. **Covers R5, R7.** **Given** a fresh clone and no profile, **when** the developer skips every question, **then** setup shows an empty profile and its destination, and with approval writes it; without approval writes nothing.
- AE2. **Covers R6.** **Given** two onboarded projects, **when** setup suggests their declared runtimes as current stack, **then** the developer can drop one suggestion and only the accepted entry is written.
- AE3. **Covers R8.** **Given** a profile near the cap, **when** an edit would exceed it, **then** the edit is refused and the current size and cap are shown.
- AE4. **Covers R9.** **Given** a note that looks like an API key, **when** it is added to the profile, **then** the write is refused and nothing is stored.
- AE5. **Covers R10.** **Given** profile revision 2, **when** the developer approves a change computed against revision 1, **then** the approval is refused as stale.
- AE6. **Covers R14, R17.** **Given** a request to "tell the client it ships Friday", **when** no context confirms the date, **then** the draft marks the date unverified and names the context it used.
- AE7. **Covers R21.** **Given** an approved source plan, **when** the developer adds a stack item, **then** the next run stops for approval before any query.
- AE8. **Covers R24.** **Given** a release whose notes could not be fetched, **when** the digest is built, **then** the item appears as unverified with no breaking-change claim.
- AE9. **Covers R25.** **Given** a finding reported last week and unchanged, **when** the check runs again, **then** the finding is not repeated.
- AE10. **Covers R26.** **Given** one host returns a rate limit, **when** the check runs, **then** other items still report and the limited items say why.

### Success Criteria

- A new user with no prior DCK knowledge completes setup in under five minutes and can say what was stored and where.
- A grep of the published package and tracked files finds no personal identifiers, paths or instance data.
- Each digest claim can be traced to a fetched source in one step.
- A draft reviewer can tell which statements came from context and which need checking.

### Scope Boundaries

**Deferred for later**
- Enabling scheduled stack checks (roadmap priority 8 scheduler gate).
- The opt-in agent pointer before priority 2 merges.
- Importing from existing memories or personal setups (priority 4).
- Connectors that read mail or send drafts (priority 5).
- Learning voice from sent mail or style samples beyond profile fields.
- Windows and Linux support claims.

**Outside this product's identity**
- Rules fan-out to many agents (use ruler or rulesync).
- Automatic memory capture, vector search or a general knowledge base.
- Session transcript archive or transfer.
- Dependency update pull requests (use Dependabot or Renovate).
- A skill marketplace or a large skill pack.

### Dependencies / Assumptions

- Roadmap priority 2 (real-home activation) is in progress in another worktree. This stage does not change install code, `src/agents/install.mjs` or agent homes until it merges. Adding the starter skills to the installer's skill list is a post-merge change.
- The primary user is an individual developer on macOS with Node who uses Claude Code or Codex. Other Agent Skills hosts may work but are not claimed.
- Public data sources stay reachable without accounts; endoflife.date's API is beta and may change.
- Priority 1 (backup and restore) is not required for this stage; the profile and digests are covered by it once it ships.

### Outstanding Questions

**Deferred to Planning**
- Exact profile cap, and whether it is measured in bytes or characters.
- How profile revisions are stored relative to the existing write-once preferences, and how existing preferences migrate.
- How the stack names map to each data source, and which sources are in the default plan.
- Where the "already reported" state lives and how long it is kept.
- How the profile is placed in the brief without crowding out records.
