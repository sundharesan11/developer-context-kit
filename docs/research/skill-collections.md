# Third-party skill collections: source audit and proposed delivery

Research snapshot: 2026-10-09. Status: **proposal, not an installation manifest**. The repository URLs, default-branch trees and latest published release metadata below were retrieved from GitHub. No source was installed or executed during this audit. Release availability does not prove compatibility or safety.

## Verified sources

The requested preset contains these twelve sources. It is not twelve individual skills. Tree counts include duplicate host builds, maintainer-only skills and optional extensions; they are not install counts.

| Source | Latest published release observed | Source shape and adapter concern |
| --- | --- | --- |
| [PM Skills](https://github.com/phuryn/pm-skills) | `v2.1.0` | Skills nested inside nine domain plugins; preserve supporting references and distinguish plugin commands from portable skills. |
| [OpenSpec](https://github.com/Fission-AI/OpenSpec) | `v1.14.1` | CLI and generated project integrations. Installing the CLI is separate from initializing a project. Exclude upstream maintainer-only `.agents/skills`. |
| [last30days](https://github.com/mvanhorn/last30days-skill) | `v3.27.1` | Skill plus research engine and optional provider setup. Do not acquire browser sessions, configure keys or install optional CLIs implicitly. |
| [UI/UX Pro Max](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill) | `v2.15.0` | Host-specific skill/assets and CLI distribution. The current documented npm package is `ui-ux-pro-max-cli`; generated copies are not interchangeable without inspection. |
| [Taste Skill](https://github.com/Leonxlnx/taste-skill) | No latest GitHub release returned (`404`) | Several skills under `skills/`; installation names come from frontmatter, not folder names. Current default taste variant is described as experimental. No-release tracking needs an explicit policy. |
| [Impeccable](https://github.com/pbakaus/impeccable) | `skill-v4.5.1` | Per-host builds, engine launcher and optional native hooks. Installing a skill does not grant hook trust. |
| [Superpowers](https://github.com/obra/superpowers) | `v6.4.2` | Engineering workflow framework with host-specific plugin/startup integration. Avoid installing a duplicate portable copy alongside a native plugin. |
| [Matt Pocock's Skills](https://github.com/mattpocock/skills) | `v1.3.1` | Nested skill collection. Generic names can collide with other collections; references and invocation names require an explicit mapping. |
| [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) | `v2.9.0` | Plugin skills plus supporting runtime/dashboard packages. Its upstream installer has broader effects than copying skill text. Do not enable per-project Git hooks implicitly. |
| [Marketing Skills](https://github.com/coreyhaines31/marketingskills) | `v2.11.24` | Portable skills and plugin metadata. Some names overlap other requested collections, including `seo-audit`. |
| [Humanizer](https://github.com/blader/humanizer) | `v3.1.0` | Root-level `SKILL.md`; needs an explicit package root rather than a `skills/*` glob. |
| [Claude SEO](https://github.com/AgriciDaniel/claude-seo) | `v2.4.2` | Claude-oriented plugin, subagents, isolated Python/browser setup and optional extensions. Other-host equivalence is unverified. Extensions must not silently enable paid APIs. |

GitHub repository metadata reports MIT for eleven sources and Apache-2.0 for Impeccable. This is a discovery result, not a complete redistribution review. Preserve source licenses and notices and inspect bundled dependencies before redistribution. Prefer source recipes over vendoring upstream code into this toolkit.

### Snapshot identity

These are observed **default-branch commit IDs**, not resolved release commits and not approved installation pins. Release tags and distributed assets must be resolved and verified separately before installation.

| Repository | Observed default-branch commit |
| --- | --- |
| `phuryn/pm-skills` | `8607e3b077817f89bf4a9b623246219734ac3be0` |
| `Fission-AI/OpenSpec` | `9111a7654d7800391459431fff4eaf66e33a3d2e` |
| `mvanhorn/last30days-skill` | `a3b73fc5f3fb3a464d6dfb7660eec7ef1dc6d366` |
| `nextlevelbuilder/ui-ux-pro-max-skill` | `1a2c459b35f26116fd165b0a0f30597f252749ff` |
| `Leonxlnx/taste-skill` | `b482f7a970abb98c4108d4a9f761e458c64cefc8` |
| `pbakaus/impeccable` | `9dad388a41944a0d2b8d1fb547c8556d2ecb49e7` |
| `obra/superpowers` | `8ca22dba9a94f28898bbce59f2537ff4d87c747d` |
| `mattpocock/skills` | `b0618bc436ad893b3c5e84e55fba86586d34a404` |
| `Egonex-AI/Understand-Anything` | `790b157028637b626c8666fa7fa28248944b900c` |
| `coreyhaines31/marketingskills` | `aa4b1853f477ab0fc4efa9415f96c387355b90b5` |
| `blader/humanizer` | `225a6f39ac85f76ee48dbad772ea4abe4ed6c9d8` |
| `AgriciDaniel/claude-seo` | `4b99de2f7de7e7d5247042e5fb5b4ea9368ef734` |

## Design choice awaiting approval

### Host discovery evidence

Official documentation was checked alongside the independent Claude review. These are documented local discovery paths, not proof that any requested collection works on an installed host version.

| Host | Documented user-level paths | Installation implication |
| --- | --- | --- |
| [Claude Code](https://code.claude.com/docs/en/skills) | `~/.claude/skills` and enabled plugin skills | Plugin namespacing differs from plain skill names. Local skills do not automatically reach Cowork/cloud sessions. |
| [Codex](https://learn.chatgpt.com/docs/build-skills) | `~/.agents/skills` | Duplicate names can both appear. Current documentation does not by itself establish whether older `.codex/skills` installations should be migrated; inspect the actual host before changing them. |
| [Gemini CLI](https://geminicli.com/docs/cli/skills/) | `~/.gemini/skills` and `~/.agents/skills` | The shared path wins within the same tier. Check the actual product/version rather than assuming every Google agent uses these paths. |
| [Cursor](https://cursor.com/docs/skills) | `~/.agents/skills`, `~/.cursor/skills`, plus Claude/Codex compatibility directories | Inventory all effective roots before adding copies. Local discovery does not establish cloud/remote worker availability. |
| [Command Code](https://commandcode.ai/docs/skills) | `~/.commandcode/skills` and `~/.agents/skills` | Its native path wins same-scope name conflicts. Verify that this is the intended fifth host. |

Review decisions: use one effective-name map per host, record any renamed skill and rewritten references as a managed overlay, and reject unresolved collisions. Do not infer safety from Markdown-only changes. Do not assume an atomic rename can replace a nonempty directory on every platform; specify and fault-test the activation/recovery protocol before implementing it. Stage incoming files outside all discovered skill roots.

Host probes also need a side-effect policy: a CLI may self-update even when asked for its version. Prefer passive package metadata, or a documented no-update flag. Do not probe an unknown CLI as part of an unattended update run.

### Approaches

1. **Recommended: managed catalog with per-host adapters.** One source/version inventory and private installation receipts. Use a reviewed native package route where a plain skill copy is insufficient. More adapter work, but predictable ownership and update reporting.
2. **Native installers only.** Less custom installation code, but fragmented version state, auto-update behavior and rollback. Some installers modify project files or trust settings.
3. **Copy all discovered skills everywhere.** Simple initial operation, but not a valid compatibility guarantee. It can include maintainer skills, omit runtime dependencies and introduce name collisions. Not recommended.

The proposed managed approach has three separately verifiable slices:

Proposed repository placement (none of these new runtime files exists yet):

```text
catalog/skill-sources.json                # reviewed source recipes and preset
src/skill-sources/                        # inventory, fetch, policy, update receipts
src/agents/catalog-adapters/              # versioned host-specific render/discovery
src/automations/orca.mjs                  # first scheduler adapter
skills/devctx-manage-skill-sources/        # setup, inspect and update workflow
skills/devctx-setup-automation/            # approved schedule creation and testing
test/                                    # synthetic source/host/scheduler fixtures
```

Each skill would use the standard `SKILL.md` plus only needed references/scripts. The automation skill should orchestrate tested CLI operations, not embed a second updater implementation. Existing skill-builder A/B tools remain about private user-authored packages; do not loosen their disposable-home fence to add third-party installation.

### 1. Catalog and setup

- Put generic source recipes, license/provenance metadata, host compatibility declarations and the twelve-source onboarding preset in the reusable repository.
- Keep checked-out source packages, exact version locks, per-host targets, receipts, customizations, schedules and reports in private local state. Never include user accounts or project facts in the public catalog.
- Discover actual installed host versions and overridden homes. Do not infer a supported host from a directory name alone.
- Resolve immutable source commits and asset hashes, inspect all selected package files, enumerate dependencies/hooks, and present exact file effects before activation.
- Include all twelve sources in setup coverage. Mark individual source/host pairs ready, conflict, pending prerequisite or unsupported. Do not mark unsupported pairs installed or silently skip them.
- Select distributed skills explicitly; exclude source-maintenance skills, duplicate builds, historical variants and paid optional extensions unless selected. Preserve requested capabilities without loading competing mandatory workflows indiscriminately.
- Resolve same-name collisions and plugin-versus-copy duplicates before writes. Preserve foreign and edited files. Adoption into managed ownership requires an explicit plan, even when bytes match an upstream revision.
- OpenSpec project initialization, graph generation, hook activation and provider authentication are separate actions from global installation. Do not initialize every discovered client repository.

### 2. Weekly guarded automatic updates

- Track the source's configured stable release channel. Resolve tags to immutable commits/assets; handle moved tags, missing releases, prereleases, source moves and rate limits explicitly.
- For no-release sources, ask whether to watch reviewed branch commits. Never call a new commit a release or silently change channels.
- Fetch candidates into a non-discoverable staging area with bounded sizes, timeouts and extraction checks. Never execute fetched installers or hooks just to inspect an update.
- Compare against the private installed-version lock, ownership receipt and reviewed capability profile. File extension alone cannot establish safety: changed instructions can broaden behavior too.
- Automatically apply only the changes allowed by the approved per-source update policy, to managed and unmodified targets. New executables, hooks, dependencies, permissions, behavior outside the approved scope, major/experimental upgrades, source identity changes and conflicts require review.
- Back up owned files, lock installation state, recheck inputs, journal each host result and verify hashes. Never overwrite local edits or let a second native updater race the managed updater.
- Multi-host writes are not one filesystem transaction. Report partial completion and preserve recovery evidence. Roll back only when the current files still match the updater's own failed-write receipt; otherwise stop for review.
- Emit a private digest: checked versions, installed updates, held changes, failures, target coverage and next actions. A fetch failure is not 'up to date'. Never prune histories or send Slack/email automatically.

### 3. Automation setup skill and activation

- Add a reusable automation-setup skill after requirements, design approval and synthetic behavior tests. No dedicated automation-creation skill has been found in this toolkit; do not claim one already exists.
- The skill captures scheduler, host, provider, schedule/timezone, allowed actions, report destination and failure policy. It previews and deduplicates schedules, verifies the resulting record and explains how to disable it.
- Orca is the first proposed scheduler adapter, not a requirement for every open-source user. Its supported CLI exposes weekly/day/time/timezone, disabled creation, manual runs and run history. Alternative schedulers remain separately scoped.
- Create the schedule disabled first. Test fixture-only updates and a harmless manual automation run before enabling the live weekly job. Verify the next run time and retain the automation ID locally.
- Document the host-online requirement, missed-run grace, network/API limits, provider login and failure reporting. A laptop-backed schedule is not an always-on service. Do not create duplicate catch-up runs after sleep or retry an uncertain installation without checking its journal.
- The automation invokes a deterministic bounded updater. It must not use an unconstrained instruction to 'install anything new'. No tool updates, connector authentication, client data or unrelated repository changes are in scope.

## Exit evidence before claiming setup works

1. Source recipe tests cover root skills, nested skills, generated host bundles, optional assets and CLI/plugin dependencies.
2. Tests cover name collisions, foreign/modified installs, symlinks, traversal, oversized downloads, moved tags, prereleases, absent feeds, offline/rate-limited checks, interrupted updates, rollback and concurrent runs.
3. A disposable host matrix proves install → update → conflict hold → removal without changing foreign files.
4. Each supported real host finds the intended skill in a fresh session. Installation and discovery are distinct evidence; one successful host does not prove the others.
5. Workflow selection tests catch competing always-on instructions and cross-collection references. Availability does not mean every skill is activated for every task.
6. The weekly schedule has a verified timezone/next-run record and a completed harmless local test. A created schedule alone is not execution proof.

Unresolved: final design approval; per-source package selections and update policies; supported installed-host versions; Command Code identity/contract; weekly day/time; live behavior-test provider approval; how to adopt existing copies without taking ownership implicitly. This document updates planning only. It does not authorize or claim installation, live activation, scheduling or publication.
