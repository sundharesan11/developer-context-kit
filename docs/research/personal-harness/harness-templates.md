# Personal harness template: landscape research (as of 2026-10-16)

Scope: a clonable, local, approval-gated, cross-agent personal developer harness with a short first-run setup (agent-working preferences, stack known vs stack in use, kind of work) and starter skills (general writing; scheduled stack-update research).

Method: public web search and fetches only. No local code or private content was sent anywhere. Many facts come from secondary aggregators; those are marked **[secondary]**. Items I could not confirm are marked **[unverified]**. Star counts and version numbers move quickly. Treat them as snapshots.

---

## 1. Per-item entries

### 1.1 Agent Skills open standard (SKILL.md, agentskills.io)
- **What it is:** a folder holding `SKILL.md`: YAML frontmatter (`name` and `description` at minimum) plus instructions, with optional `scripts/`, `references/` and `assets/`. Agents load it by progressive disclosure: discovery (name and description only), then activation, then execution. Anthropic developed it and released it as an open standard. https://agentskills.io/home
- **Who supports it:** the agentskills.io client showcase lists Claude Code, Claude, ChatGPT & Codex, Gemini CLI, Cursor, GitHub Copilot, VS Code, OpenCode, Goose, Amp, Junie, Roo Code, Kiro, Factory, OpenHands, Letta, Tabnine, Hermes Agent and OpenClaw, among many others. Each entry links to that product's own skills docs. https://agentskills.io/home
- **Install locations:**
  - Claude Code reads `~/.claude/skills/`.
  - Codex reads `$CODEX_HOME/skills` and, according to community sources, a vendor-neutral `~/.agents/skills/` **[secondary; not confirmed on the official page excerpt]**. https://developers.openai.com/codex/skills , https://codex.danielvaughan.com/2026/04/25/cross-agent-skill-portability-codex-cli-skillshare-skillport-skills-sync/
  - A Claude Code feature request asked for user-level `~/.agents/skills/` discovery. It is marked closed, and the resolution is not clear **[unverified]**. https://claudeissues.com/issue/66352-feature-support-user-level-agents-skills-discovery-for-cross-agent-single-source
  - Common practice is one canonical copy, symlinked into each agent's folder. `skman` is one tool that does this. https://pypi.org/project/skman
- **Distribution tooling:** Vercel's `npx skills add owner/repo` installs skills into dozens of agents. It installs at project scope by default, `-g` installs for the user, and `-a` picks the agent. Telemetry is on by default; `DISABLE_TELEMETRY=1` turns it off. https://vercel.com/changelog/introducing-skills-the-open-agent-skills-ecosystem , https://skills.sh/docs/cli
- **Gap and verdict:** **Reuse. Do not invent a format.** Ship both starter skills as plain Agent Skills folders. That makes them installable by `npx skills`, by a Claude Code plugin, or by copying.

### 1.2 Claude Code plugins and marketplaces
- **What they are:**
  - A plugin is a directory with `.claude-plugin/plugin.json`, plus `skills/`, `commands/`, `agents/` and hooks at the plugin root.
  - A marketplace is any git repo or folder with `.claude-plugin/marketplace.json`.
  - Plugins install at user scope by default; project and local scopes also exist.
  - Installed plugins are stored under `~/.claude/plugins/`.
  - The official marketplace, `claude-plugins-official`, is available automatically. https://code.claude.com/docs/en/discover-plugins , https://code.claude.com/docs/en/plugins/overview **[field details secondary]**
- **Privacy:** plugins can ship hooks and MCP servers, so they execute code. See the supply-chain risks in section 4.
- **Verdict:** **Interoperate.** The template repo can also be a single-plugin marketplace, so `/plugin marketplace add <repo>` works. Keep the Claude plugin as one packaging of the same SKILL.md folders, not the only one.

### 1.3 Claude Code memory files (where personal context lives natively)
- **Load order:**
  - Managed policy file.
  - `~/.claude/CLAUDE.md`: "personal preferences for all projects".
  - Project `CLAUDE.md`.
  - `./CLAUDE.local.md`: personal project-specific notes; the docs say "add to `.gitignore`".
  - `~/.claude/rules/*.md`: personal rules.
- **Imports:** `@path` imports, up to four hops. An import that resolves outside the project triggers an approval dialog. Imports in user-scope files load without that dialog.
- **Size guidance:** keep each file under about 200 lines. "Longer files consume more context and reduce adherence."
- **Auto memory:** Claude writes it itself, and it is per repository.
- **AGENTS.md:** Claude Code now reads `AGENTS.md` when no `CLAUDE.md` is present.
- Source for all of the above: https://code.claude.com/docs/en/memory
- **Verdict:** **Interoperate.** The harness should not invent a new always-loaded channel. Generate or import a short user profile from `~/.claude/CLAUDE.md` (and the equivalents in section 1.4), ideally through one `@~/<harness>/profile.md` import line.

### 1.4 Other agents' global personal-instruction slots
| Agent | Personal or global slot | Notes |
|---|---|---|
| Codex | `~/.codex/AGENTS.md` (or `AGENTS.override.md`) under `CODEX_HOME` | Uses the first non-empty file at that level. 32 KiB combined cap by default. https://developers.openai.com/codex/guides/agents-md (now redirects to https://learn.chatgpt.com/docs/agent-configuration/agents-md) |
| Gemini CLI | `~/.gemini/GEMINI.md` | `context.fileName` can point it at `AGENTS.md`. https://codex.danielvaughan.com/2026/05/27/agent-instruction-files-agents-md-claude-md-cross-tool-portability-codex-cli/ **[secondary]** |
| Cursor | "User Rules" in Settings → Rules | Stored in the UI or account, not a file. A forum request asks for a file-backed, agent-editable version. `~/.cursor/rules` works only partially. https://forum.cursor.com/t/file-backed-agent-editable-user-rules-parity-with-project-cursor-rules/166055 , https://forum.cursor.com/t/user-based-cursor-rules/119894 **[forum]** |
| Claude.ai | Settings → "What personal preferences should Claude consider in responses?" | Free text, applied to all chats. https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features |
| ChatGPT | Custom Instructions: nickname, occupation, "more about you", traits | Historically 1,500 characters per field. Reportedly 5,000 on paid plans from July 2026. https://community.openai.com/t/feature-request-extend-character-limit-and-add-subsections-for-chatgpt-custom-instructions/439161 , https://findskill.ai/blog/chatgpt-custom-instructions-5000-characters/ **[secondary]** |

**Gap:** there is no single, file-backed, cross-agent "about me" with a sync/render step. Cursor's slot is not even a file. A harness that keeps one canonical `profile.md` and renders it into each slot (or emits paste-ready text for Cursor and Claude.ai) fills a real, small gap, as long as every write is shown and approved.

### 1.5 Daniel Miessler: PAI (now "LifeOS") and Fabric
- **PAI / LifeOS:** an opinionated personal AI stack running on Claude Code, which it calls "the engine". https://github.com/danielmiessler/Personal_AI_Infrastructure
  - **Install:** paste "install LifeOS for me" into a harness, or run `curl | bash`. It needs bun.
  - **First run:** the installer runs a setup interview. Earlier `/interview` versions captured the assistant's name, its voice, and TELOS, Miessler's goals/mission framework. Optional capabilities each get a now/later/never prompt.
  - **Storage:** user data goes in a `USER/` tree, "a blank template you populate", which the installer and upgrades never touch.
  - **Privacy:** it claims "nothing personal ships". The public repo is generated from a private source tree, and community PRs are ported in by hand.
  - **Scale:** memory is split by purpose (WORK, KNOWLEDGE, LEARNING, RELATIONSHIP, ...). Version numbers reach 7.x.
  - Details are from the README fetch; the versions on that page were inconsistent.
- **Does well:** a clean USER (private) / SYSTEM (shipped) split, and an upgrade path that does not clobber the user tree.
- **Gap:** it is heavy (bun, voice, dashboards, many hooks, an 11-directory memory structure per its v2.1 notes: https://newreleases.io/project/github/danielmiessler/LifeOS/release/v2.1.0), Claude Code-centric, and life-wide rather than developer-scoped. I found no public complaints about complexity; absence is not evidence either way.
- **Fabric:** an MIT CLI of task "Patterns" (prompts), such as summarize or extract wisdom, piped through `fabric --pattern`. https://github.com/danielmiessler/fabric
  - **Verdict:** adjacent and not competing. Its patterns are prompts, not SKILL.md files. No need to integrate.
- **Verdict:** **Borrow the USER/SYSTEM separation and the "public repo generated from private source" discipline. Do not compete on breadth.** Position as the minimal, developer-only, cross-agent alternative.

### 1.6 OpenClaw (workspace files plus a bootstrap ritual)
- **First run:** on a fresh workspace (`~/.openclaw/workspace`) it seeds `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md` and `BOOTSTRAP.md`. `BOOTSTRAP.md` is a one-time ritual. It is deleted once the files diverge from their templates, and `--skip-bootstrap` skips it. https://docs.openclaw.ai/start/bootstrapping/index.html
- **The ritual itself:** about three or four beats: name the assistant, accept a vibe and emoji, optionally pick an avatar, and pick minimal vs. maximum app recommendations. It explicitly says to keep it "short and make it yours" and **not to turn it into a questionnaire or long biography**. Notably, it does *not* fill `USER.md`; that file grows over time. https://docs.openclaw.ai/reference/templates/BOOTSTRAP
- **USER.md:**
  - No fixed schema. It holds stable preferences, communication style, relationships and active-project context.
  - Entries are written as dated directives marked active or superseded.
  - It has a 4,000-character budget.
  - Source: https://docs.openclaw.ai/concepts/agent-workspace
- **Privacy guidance:**
  - Back the workspace up to a **private** git repo.
  - Never put keys in it; keep `~/.openclaw/` config, credentials and sessions out of the repo.
  - Do not store raw chat dumps.
  - It ships a starter `.gitignore`.
  - Same page as above.
- **Verdict:** the best public precedent for a "short first run, then grow" onboarding and for dated, supersedable profile entries. **Copy the pattern.**

### 1.7 Hermes Agent (Nous Research)
- **Storage:** `~/.hermes/memories/USER.md` (the user profile, capped at about 1,375 characters) and `MEMORY.md` (agent notes, capped at about 2,200 characters). Both are injected as a frozen snapshot at session start. The agent edits them through a memory tool, and the hard caps force consolidation. https://parallel.ai/articles/what-is-hermes-agent , https://pasqualepillitteri.it/en/news/3864/hermes-agent-review-community-opinions **[secondary]**
- **Verdict:** strong evidence that **a deliberately tiny, capped profile** is a working design. Adopt a character budget.

### 1.8 obra/superpowers
- **What it is:** an MIT skills library plus methodology (brainstorm → plan → execute, TDD, debugging), distributed as a Claude Code plugin through `obra/superpowers-marketplace`. A session-start hook injects the bootstrap instructions. https://github.com/obra/superpowers , https://trevorlasn.com/blog/superpowers-claude-code-skills
- **Status:** the community-editable `superpowers-skills` repo was archived in October 2025 **[secondary]**.
- **Personal data:** no user profile, no onboarding.
- **Verdict:** **Do not rebuild engineering-process skills.** Recommend Superpowers or compound-engineering as optional companions. The harness's value is the *personal* layer they lack.

### 1.9 EveryInc compound-engineering plugin
- **What it is:** a Plan → Work → Review → Compound loop, with dozens of agents, commands and skills. It ships as a Claude Code marketplace plugin and now as a native Codex plugin; an older `bunx @every-env/compound-plugin` converter targets other agents. https://github.com/EveryInc/compound-engineering-plugin
- **Storage:** learnings go into the *repo* (`docs/solutions/`), not a personal profile.
- **Verdict:** same as Superpowers. Complementary; interoperate, don't duplicate. Its multi-agent converter is a useful precedent for cross-agent packaging.

### 1.10 SuperClaude Framework
- **What it is:** a pip/uvx installer that writes commands, personas and modes into `~/.claude/`. It has around 20–30 commands and around 16 agents; counts vary by source. A v5 plugin system was in progress (issue #419). https://github.com/SuperClaude-Org/SuperClaude_Framework , https://www.sourcepulse.org/projects/6535346 **[secondary]**
- **Weak spot:** it writes directly into `~/.claude` with no user/template split.
- **Verdict:** a cautionary example of global-config sprawl. Not a model for personal data.

### 1.11 davila7/claude-code-templates (aitmpl.com)
- **What it is:** an `npx` CLI and web catalog of 100–400+ agents, commands, hooks, MCPs, settings and skills, plus analytics, a conversation monitor and a health check. MIT, about 27k stars. https://github.com/davila7/claude-code-templates , https://dev.to/dani_avila7/complete-guide-to-claude-code-templates-1pnp
- **Personal data:** it is a component installer with no personal profile.
- **Verdict:** a possible *distribution channel*: the two starter skills could be listed there. Not a template for the personal layer.

### 1.12 Garry Tan's gstack
- **What it is:** a personal Claude Code setup published as a skill pack. Install is `git clone` into `~/.claude/skills/gstack` and `./setup`, then add a section to `CLAUDE.md`. MIT, with very high star counts. https://augmentcode.com/learn/garry-tan-gstack-claude-code , https://codex.danielvaughan.com/2026/03/30/gstack-garry-tan-production-skills-toolkit/ **[secondary]**
- **Telling detail:** a reviewer notes that teams with different workflows should fork and adapt it. This is the "someone's personal harness, published" pattern, without a personalization step.
- **Verdict:** shows strong demand for personal setups as templates, and that the missing piece is the *make it yours* step.

### 1.13 Awesome lists
- **hesreallyhim/awesome-claude-code:** curated; submissions go through issue forms; the licence is reported as CC BY-NC-ND (check it). https://github.com/hesreallyhim/awesome-claude-code
- **Others:** VoltAgent/awesome-claude-code-subagents, jqueryscript/awesome-claude-code. https://claudefa.st/blog/tools/resources/awesome-claude-code
- **Verdict:** a listing channel after launch.

### 1.14 Dotfiles managers (chezmoi and others) for agent configs
- **chezmoi:** documents keeping a public repo while secrets live in a password manager, encrypted files or local config. It uses templating per OS and host. https://chezmoi.io/user-guide/setup
- **Community practice:** a `home/.claude/` tree containing `CLAUDE.md`, a secret-free `settings.json`, `skills/` and `hooks/`, alongside `.codex/` and `.cursor/` trees. https://developertoolkit.ai/pl/developer-scorecard-guide/dotfiles-portability/ **[secondary]**
- **Verdict:** **Interoperate, don't replace.** Users who run chezmoi should be able to point it at the harness's private instance directory. Document this; don't build sync.

### 1.15 Basic Memory (basicmachines-co)
- **What it is:** a local-first MCP server over a Markdown folder, with a WikiLink knowledge graph and a SQLite index. Obsidian-compatible. AGPL-3.0. https://github.com/basicmachines-co/basic-memory , https://docs.basicmemory.com/technical/technical-information
- **Verdict:** it solves "agent-writable notes/knowledge" well. The harness should *not* become a knowledge base. Optional interop: the profile and notes live as plain Markdown, so a user can point Basic Memory or Obsidian at the same folder. The AGPL licence argues against vendoring it into an Apache-2.0 project.

---

## 2. Onboarding / first-run patterns

| Project | First-run behaviour | What it captures | Where it is stored |
|---|---|---|---|
| OpenClaw | 3–4-beat ritual. Explicitly "not a questionnaire". | Assistant name, vibe, emoji, avatar, recommendation level | `IDENTITY.md`, `SOUL.md`; `USER.md` grows later |
| PAI / LifeOS | Installer-driven interview, plus now/later/never per capability | Assistant name, voice, TELOS (goals, mission) | `USER/` tree |
| Hermes | No interview; the agent writes memory as it learns | Preferences, communication style | `~/.hermes/memories/USER.md` (capped at ~1.4k characters) |
| ChatGPT | Settings form | Nickname, occupation, "more about you", traits | Server-side account |
| Claude.ai | One free-text box | Preferences | Server-side account |
| Cursor | Settings text box | Global rules | UI or account sync, not a file |
| Claude Code `/init` | Repo-scoped. `CLAUDE_CODE_NEW_INIT=1` reportedly offers a "personal" option that writes a gitignored `CLAUDE.local.md`. | Repo facts | `CLAUDE.md`, `CLAUDE.local.md` |
| gstack, superpowers, SuperClaude, compound-engineering | No personal onboarding | — | — |

Sources: https://docs.openclaw.ai/reference/templates/BOOTSTRAP ; https://github.com/danielmiessler/Personal_AI_Infrastructure ; https://code.claude.com/docs/en/memory ; https://wmedia.es/es/tips/claude-code-init-flujo-interactivo **[secondary]**. A common blog tip is "after /init, ask Claude to interview you about your coding style": https://www.codecademy.com/learn/ai-assisted-development-with-claude-code/modules/introduction-to-claude-code-and-ai-assisted-development/cheatsheet

**The minimum useful fields.** Across ChatGPT, OpenClaw, Hermes and the blog "about-me" guides, the recurring core is:
1. What to call you, and your role or kind of work. ChatGPT's "occupation" maps to the owner's "kind of work".
2. Communication and working preferences: verbosity, autonomy and approval level, explanation depth, banned styles. This maps to "preferences for working with agents".
3. The stack in daily use now, plus the stack you know. These map to "currently working in" and "know". The proposed three-area setup lines up with the cross-product consensus.
4. Optional: timezone/locale and writing conventions (spelling, tone). These feed the writing skill. Guides recommend a separate voice/style file: https://mikareyes.com/ai/how-to-setup-global-context-claude

**Size discipline is consistent everywhere:**
- Hermes caps the profile at about 1,375 characters.
- OpenClaw gives `USER.md` a 4,000-character budget.
- Claude Code advises under 200 lines per `CLAUDE.md`.
- ChatGPT allows 1,500 (or 5,000) characters per field.

**Questionnaire fatigue evidence:**
- SurveyMonkey's study of about 100k surveys found the steepest drop-off per added question within the first 15 questions, and abandonment rising past 7–8 minutes. https://www.surveymonkey.com/curiosity/survey_questions_and_completion_rates/
- Survicate reports about 83% completion at 1–3 questions, 65% at 4–8, 56% at 9–14 and 42% at 15 or more **[vendor data]**. https://survicate.com/survey-completion-rate
- I found no onboarding-specific study for developer tools **[gap]**.
- OpenClaw's explicit "don't turn it into a questionnaire" is the closest product-design evidence.

**Implication:** three to five prompts, each skippable, with free text allowed. Offer "infer from my machine" (detect languages from recent repos) as a proposal for the user to confirm, never as a silent write. Let the profile grow later through approved, dated, supersedable entries in the OpenClaw style.

---

## 3. Template vs instance separation patterns

1. **USER/SYSTEM tree in one repo (PAI / LifeOS):** the shipped system code sits beside a `USER/` tree that the installer never touches. Upgrades replace only system files. Risk: one repo means one `git add -A` away from a leak, unless `USER/` is gitignored or lives outside the clone. https://github.com/danielmiessler/Personal_AI_Infrastructure
2. **Public generated from private (PAI):** the maintainer develops in a private tree and *generates* the public release, with security gates. This is good for the maintainer's own dogfooding. Same source.
3. **Template repo, private instance repo (OpenClaw guidance):** the workspace is backed up to a **private** git repo, with config, credentials and sessions excluded and a starter `.gitignore`. https://docs.openclaw.ai/concepts/agent-workspace
4. **GitHub template repositories:** "Use this template" creates a fresh repo with no shared history. The user should choose private visibility. https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository
5. **Dotfiles `.local` overlay:** tracked configs include a gitignored `*.local` file, and a `*.example` template is committed. Claude Code's own `CLAUDE.local.md` follows the same idea. https://blog.openreplay.com/dotfiles-commit-ignore/ , https://skeptric.com/portable-custom-config , https://code.claude.com/docs/en/memory
6. **chezmoi:** public source state, with secrets in a password manager, encrypted files or a per-machine config. https://chezmoi.io/user-guide/setup
7. **Instance outside the clone entirely (recommended for this project):** the template (code and generic skills) is cloned anywhere. The personal instance lives in a separate directory, such as `~/.config/<harness>/` or a user-chosen private repo. Agent slot files get a one-line `@import` or a rendered block. This makes it hard to leak by construction, and upgrading is just `git pull` on the template.

**Privacy leaks and incidents people have had:**
- **`.claude/settings.local.json` committed:**
  - It held approved commands with inline secrets, and `.claude/` is not gitignored by default. It was pushed to a public repo and a secret-scanning alert fired. https://claudeissues.com/issue/13106-bug-sensitive-tokens-stored-in-claude-settings-local-json-and-not-ignored-by-git , https://ironpeak.be/blog/leaking-secrets-from-the-claud/
  - Check Point found the same file shipped inside published **npm packages**. https://securitybrief.news/story/claude-code-can-leak-secrets-in-public-npm-packages
  - **Directly relevant to a Node CLI:** use `files` allowlists in `package.json`.
- **Repo-controlled config used as an attack vector:** CVE-2025-59536 and CVE-2026-21852 let repo config files trigger command execution or API-key exfiltration before user interaction. https://labs.cloudsecurityalliance.org/research/briefing-csa-research-note-skill-md-agent-context-poisoning/ , https://urandom.io/blog/2026-02-27-git-clone-and-youre-pwned-claude-code-vulns
- **Skill supply chain:**
  - An arXiv study of about 42k marketplace skills found 26% had at least one vulnerability and about 5% showed high-severity, malicious-looking patterns. Skills that bundle scripts were about twice as risky. https://arxiv.org/html/2601.10338v1
  - Snyk's audit of ClawHub found 76 confirmed malicious payloads.
  - OWASP's Agentic Skills Top 10 notes that three lines of `SKILL.md` were enough to exfiltrate SSH keys. https://owasp.org/www-project-agentic-skills-top-10/ast01.html
  - **Implication:** ship starter skills as instruction-only, with no scripts, or only small, auditable ones. Pin skill hashes. Never auto-run "prerequisites".

---

## 4. Public complaints and requests

- **CLAUDE.md read but not obeyed:** many issues report this, including #17530, #27750, #34774 (committed despite a "never commit" rule), #2544 and #2737. A recurring mitigation is shorter files, with hard rules moved into hooks or permission settings. https://github.com/anthropics/claude-code/issues/17530 , https://claudeissues.com/issue/34774-model-claude-code-max-plan-ignores-claude-md-instructions-committed-changes-with , https://claudeissues.com/issue/2544-bug-claude-md-mandatory-rules-consistently-ignored-across-multiple-repositories
  - **Implication:** the profile should be short preferences. Anything that must be enforced belongs in agent permission config, not prose.
- **Context bloat from plugins and skills:**
  - The skill-description budget is about 1% of context, and descriptions get truncated when too many skills are installed.
  - Unused plugins still cost context.
  - There are duplicate-registration bugs.
  - Sources: https://www.mindstudio.ai/blog/context-rot-claude-code-skills-bloated-files , https://claudeissues.com/issue/29971-bug-claude-code-context-bloat-bug-report-community-issue-tracker , https://wmedia.es/en/tips/claude-code-unused-plugins-cost
  - "Most Claude Code skills are garbage": https://www.roborhythms.com/best-claude-code-skills-2026/
  - **Implication:** ship two skills, not forty.
- **Cursor user rules are not file-backed or agent-editable, and there are no rule profiles or toggles.** https://forum.cursor.com/t/file-backed-agent-editable-user-rules-parity-with-project-cursor-rules/166055 , https://forum.cursor.com/t/rule-profiles-and-global-rule-toggling/149898
- **Request for one cross-agent user-level skills directory** (`~/.agents/skills`) in Claude Code. https://claudeissues.com/issue/66352-feature-support-user-level-agents-skills-discovery-for-cross-agent-single-source
- **ChatGPT custom-instruction limits:** users asked for longer fields and subsections. https://community.openai.com/t/feature-request-extend-character-limit-and-add-subsections-for-chatgpt-custom-instructions/439161
- **Stale personal context:** blog guides propose a weekly routine that reviews recent sessions and suggests profile edits for the user to approve. https://mikareyes.com/ai/how-to-keep-claude-md-from-going-stale-context-updater
  - This validates an approval-gated "propose profile update" flow.
- **HN:** a commenter argues that a few hundred lines of flat Markdown (MEMORY.md, SOUL.md) cover most personal-assistant needs better than a vector database, and that tools should write files Claude Code already reads rather than run a daemon. https://news.ycombinator.com/threads?id=daxaur **[single comment; thread not inspected]**
- **Second-brain products folding:** Meta acquired Limitless (formerly Rewind). Rewind capture was disabled on 2025-12-19, and some regions lost service. https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/
  - This is an argument for local plain files the user owns.

## 5. Adjacent "second brain" tools (brief)
- **Obsidian + Claude Code:** the common setup is to run `claude` inside a vault with PARA folders and a "Meta" folder the agent reads first. Most guides are blogs or courses. https://okhlopkov.com/second-brain-obsidian-claude-code/ , https://www.mindstudio.ai/blog/build-ai-second-brain-claude-code-obsidian
  - Relevant only as a place users may want the instance directory to live. Keep the format plain Markdown with frontmatter.
- **Pieces (LTM-2.7):** on-device capture of copied code, screens and audio, with up to 9 months' retention. It is exposed via MCP, and LLM calls go to the cloud with scoped context. https://docs.pieces.app/products/core-dependencies/pieces-os/long-term-memory
  - Passive capture is the opposite of approval-gated. Do not compete.
- **Mem 2.0** (relaunched October 2025, agentic chat): https://alternativeto.net/news/2025/10/mem-2-0-relaunches-with-smarter-note-taking-tools-offline-support-and-a-new-agentic-chat
- **Reflect:** a notes app; no developer-agent angle found.
- Neither Mem nor Reflect is relevant beyond confirming that cloud note apps don't solve the cross-agent developer profile.
- **Scheduled research skill hosting:**
  - Claude Code has session `/loop` and cron tools, plus cloud "routines" (`/schedule`, research preview from April 2026, with daily caps per plan **[secondary]**). https://code.claude.com/docs/en/scheduled-tasks , https://claude.com/blog/introducing-routines-in-claude-code
  - Codex app "Automations" exist, but I found little official documentation **[unverified]**.
  - **Implication:** the stack-update skill should be agent-agnostic instructions. Scheduling should be an adapter: local cron/launchd running the user's chosen agent CLI, or the agent's own scheduler. Output is a proposed digest the user approves, never auto-applied edits.

---

## Top 5 takeaways

1. **Don't build a skills format, a marketplace, or engineering-process skills.**
   - Agent Skills (SKILL.md) is supported by Claude Code, Codex, Gemini CLI, Cursor, Copilot/VS Code and about 40 more.
   - Ship the two starter skills as plain, instruction-only SKILL.md folders, packaged three ways: a raw folder, a Claude Code plugin/marketplace manifest, and an `npx skills add` source.
   - Point users to Superpowers or compound-engineering for process; don't duplicate them.
2. **The real gap is a small, file-backed, cross-agent personal profile with approval-gated rendering.**
   - Every agent has a personal slot: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, Cursor User Rules, and the Claude.ai and ChatGPT preference boxes. None of them share a source.
   - PAI is heavy and Claude-centric. OpenClaw and Hermes are personal-assistant runtimes, not developer harnesses. gstack and superpowers have no personalization step.
   - One canonical `profile.md` plus a diff-and-approve render (or an `@import` line, or paste-ready text for Cursor and the web apps) is a defensible, minimal niche.
3. **Keep onboarding to three to five skippable prompts and cap the profile.**
   - The owner's three areas (agent-working preferences, stack known vs in use, kind of work) match the consensus fields of ChatGPT, OpenClaw and Hermes.
   - Use a hard budget: roughly 1.5–4k characters, or under about 50 lines.
   - Let the profile grow through approved, dated, supersedable entries.
   - Survey data shows completion falls steeply with each question up to about 15.
4. **Separate template from instance by construction.**
   - The instance lives outside the clone (or in a user-created private repo).
   - Ship a `.gitignore`, a `package.json` `files` allowlist and a pre-publish check.
   - Never write secrets into the profile. Treat hard rules as permission config, not prose.
   - The real leaks so far are `.claude/settings.local.json` in public repos and npm tarballs, plus CVEs from repo-controlled agent config.
5. **Make the scheduled stack-update research skill a proposer, not an actor.**
   - It reads the "currently using" stack from the profile and produces a dated digest with sources.
   - Scheduling is a thin adapter: cron or launchd, Claude routines, or Codex automations.
   - Keep skills script-free, because skill-marketplace audits show 26% of skills vulnerable and confirmed malicious payloads. That trust story, minimal and auditable, is the template's differentiator.
