---
title: Skill sources and the skill builder
description: Browse the catalog of third-party skill collections, stage a pinned selection of files, review it and install it into a disposable pilot, or build your own skill from scratch.
sidebar:
  label: Skill sources
---

devtwin has two ways to get skills beyond the bundled ones:

- **Skill sources**: third-party skill collections from GitHub. You pick exact files at a pinned commit, devtwin verifies the bytes, you review the package, and it installs into a disposable pilot's agent home.
- **Skill builder**: your own skill, built from recorded requirements and an approved design, validated, then installed the same way.

Both install only into a **disposable pilot's** agent homes today. Neither runs any script it copies. See [Limitations](/docs/security/limitations/).

## The catalog

```sh
node bin/devtwin.mjs skill-sources catalog
```

The catalog lists twelve public collections, each with its repository, license, and an installation status of `unverified`. It needs no pilot and makes no network request.

| ID | Repository |
| --- | --- |
| `pm-skills` | phuryn/pm-skills |
| `openspec` | Fission-AI/OpenSpec |
| `last30days` | mvanhorn/last30days-skill |
| `ui-ux-pro-max` | nextlevelbuilder/ui-ux-pro-max-skill |
| `taste-skill` | Leonxlnx/taste-skill |
| `impeccable` | pbakaus/impeccable |
| `superpowers` | obra/superpowers |
| `mattpocock-skills` | mattpocock/skills |
| `understand-anything` | Egonex-AI/Understand-Anything |
| `marketing-skills` | coreyhaines31/marketingskills |
| `humanizer` | blader/humanizer |
| `claude-seo` | AgriciDaniel/claude-seo |

A catalog entry references an upstream project. It is not a reviewed installation or a license grant; each collection keeps its own license and notices.

## Check a source's latest release

```sh
node bin/devtwin.mjs skill-sources check --source humanizer
```

`check` reads public GitHub release and commit metadata and resolves the latest stable release to a commit. It writes nothing and installs nothing. Pass `--prior-lock-json '<json>'` to compare against a release you recorded earlier.

:::caution[GitHub rate limit]
These requests are unauthenticated, so GitHub sees your IP and allows roughly 60 per hour. One check can use up to eight requests; checking all twelve sources can exceed the limit.
:::

## Stage a pinned selection

Copy `sourceId`, `channel`, `tag` and `commit` from your own `check` result into a pin, and list the exact repository files you want, including licenses and notices:

```sh
PIN_JSON='{"sourceId":"humanizer","channel":"stable-release","tag":"<tag>","commit":"<commit>"}'
FILES_JSON='["SKILL.md","LICENSE"]'

node bin/devtwin.mjs skill-sources preview --source humanizer --pin-json "$PIN_JSON" --files-json "$FILES_JSON"
```

Preview makes two metadata requests and writes nothing. It refuses a missing file instead of picking a substitute. Then stage with the preview's `fingerprint`:

```sh
node bin/devtwin.mjs skill-sources stage --pilot "$PILOT" --source humanizer \
  --pin-json "$PIN_JSON" --files-json "$FILES_JSON" --preview-hash '<preview fingerprint>'
node bin/devtwin.mjs skill-sources inspect --pilot "$PILOT" --run '<stage runId>'
```

`stage` downloads only the selected files, verifies each one's Git object hash and SHA-256, and writes them to a fresh private directory under the pilot's `dataRoot/skill-sources/staging/`. `inspect` is offline and re-verifies the receipt and files.

- The pin is **caller-supplied and unverified**: devtwin does not prove the tag points at that commit or that the commit is in upstream history.
- Limits: 24 files, 128 KiB per file, 1 MiB total.
- `staged` never means installed or reviewed. Content, dependencies, compatibility and safety are still yours to review.

## Review and install a staged package

Installation has two separate approvals: one for the **content** and one for the **action**.

### 1. Map and review the package

Write a mapping that names every staged file exactly once, plus license and notice paths, dependencies and compatibility:

```json
{
  "schemaVersion": 1,
  "name": "example-skill",
  "skillRoot": "",
  "files": [{"source": "LICENSE", "target": "LICENSE"}, {"source": "SKILL.md", "target": "SKILL.md"}],
  "requiredPaths": ["LICENSE", "SKILL.md"],
  "licensePaths": ["LICENSE"],
  "noticePaths": [],
  "dependencies": [],
  "compatibility": {"claude": "unreviewed", "codex": "unreviewed"},
  "review": {"fileCompleteness": "unreviewed", "licensesAndNotices": "unreviewed", "dependencies": "unreviewed"}
}
```

This example intentionally cannot be approved: after you have inspected the content and upstream requirements, set the review fields to `user-reviewed` and each compatibility value to `user-reviewed-sandbox` (or `unsupported`).

```sh
node bin/devtwin.mjs skill-sources package-review --pilot "$PILOT" --run '<stage runId>' --mapping-json "$MAPPING_JSON"
```

The review separates blocking `holds` from `disclosures`. Missing dependencies, unreviewed selected hosts, binary content and unsupported paths are held.

### 2. Approve the content

```sh
node bin/devtwin.mjs skill-sources content-approve --pilot "$PILOT" --run '<stage runId>' \
  --mapping-json "$MAPPING_JSON" --package-digest '<package digest>' \
  --decision dc_content01 --interaction-ref 'user:<reference>' \
  --response 'Approved source content <package digest> with caller-supplied-unverified pin'
```

### 3. Plan, approve and apply the install

```sh
node bin/devtwin.mjs skill-sources local-plan --pilot "$PILOT" --content-decision dc_content01 \
  --home "$AGENT_HOME" --agent-json '["claude","codex"]' --mode install
node bin/devtwin.mjs skill-sources local-approve --pilot "$PILOT" --content-decision dc_content01 \
  --home "$AGENT_HOME" --agent-json '["claude","codex"]' --mode install \
  --decision dc_install01 --plan-fingerprint '<fingerprint>' \
  --interaction-ref 'user:<reference>' --response 'Approved source install <fingerprint>'
node bin/devtwin.mjs skill-sources local-apply --pilot "$PILOT" --content-decision dc_content01 \
  --home "$AGENT_HOME" --agent-json '["claude","codex"]' --mode install \
  --decision dc_install01 --plan-fingerprint '<fingerprint>'
node bin/devtwin.mjs skill-sources local-status --pilot "$PILOT" --content-decision dc_content01 \
  --home "$AGENT_HOME" --agent-json '["claude","codex"]' --mode install
```

Content decisions are reusable; action decisions are single-use. To remove, use `--mode uninstall` throughout and the response `Approved source uninstall <fingerprint>`. Edited files, foreign files and competing same-name copies are preserved, never overwritten.

Decision IDs are `dc_` followed by 8–64 lowercase letters, digits, `_` or `-`. The response text is recorded as evidence of your decision; the CLI does not authenticate who typed it.

## Build your own skill

The skill builder records each step as an immutable file in a private workspace. All commands take the same selection flags: `--audience personal|company|project`, `--workspace ws_<id>`, plus `--scope` for company and project, and `--project` for project.

1. `skill workspace-create` creates the workspace.
2. `skill requirements-record --requirements rq_<id> --input <requirements.json>` stores what the skill must do.
3. `skill design-record --requirements rq_<id> --design ds_<id> --input <design.json>` stores a design bound to those requirements.
4. `skill design-approve --design ds_<id> --decision dc_<id> --interaction-ref user:<reference> --response 'Approved <design digest>'` records your approval. Digests and fingerprints are the full `sha256:…` values the previous command returned.
5. `skill draft-create … --revision rv_<id> --candidate <dir under inputsRoot>` copies your candidate files into an immutable revision.
6. `skill draft-validate --revision rv_<id>` checks the format. `skill workspace-show` lists IDs and statuses.

To start from a guided template instead of a blank page, see [Turn a template into your own skill](/docs/guides/personal-harness/#turn-a-template-into-your-own-skill). The blank starter is `skills/devtwin-create-skill/assets/skill-template.md`.

### What the validator accepts

- `SKILL.md` with `---` frontmatter holding exactly `name` and `description` as one-line strings, then non-empty Markdown.
- `name` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is at most 64 characters, and matches the approved design. `description` is at most 1,024 characters. Quote natural descriptions with double quotes when in doubt.
- Other files only under `references/`, `scripts/` or `assets/`, as UTF-8 text. Up to 24 files, 128 KiB each, 256 KiB total.

This is a strict subset, not a full YAML parser. Helpers in `scripts/` are never run.

### Install a personal revision into a pilot home

Only an intact `personal` revision with a passing validation can be installed, and only into one of the pilot's `agentHomes`. Names starting with `devtwin-` are reserved.

```sh
node bin/devtwin.mjs skill content-approve --pilot "$PILOT" --audience personal --workspace ws_example01 \
  --revision rv_example01 --decision dc_content01 --interaction-ref 'user:<reference>' \
  --response 'Approved content <package digest> as personal generic non-confidential'
node bin/devtwin.mjs skill local-plan --pilot "$PILOT" --mode install --audience personal --workspace ws_example01 \
  --revision rv_example01 --content-decision dc_content01 --home "$AGENT_HOME" --agent claude --agent codex
```

Then `skill local-approve` (response `Approved install <plan fingerprint>`) and `skill local-apply` with the same selection, `--decision` and `--plan-fingerprint`. `skill local-status` reports what is installed. Uninstall uses `--mode uninstall` and the response `Approved uninstall <plan fingerprint>`.
