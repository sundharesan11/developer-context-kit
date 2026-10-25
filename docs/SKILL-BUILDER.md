# Private skill-builder tooling

Milestone A supplies a deterministic private workspace and validator. Milestone B adds installation of explicitly approved personal, generic packages in disposable pilot agent homes. It does not include a conversational builder skill, live-model evaluation, real-home activation or export. The bundled installer still contains three skills. `skills/devtwin-create-skill/assets/skill-template.md` is a generic starter, not discoverable skill guidance.

All commands require an explicit disposable `--pilot <pilot.json>` fence. Set `--audience personal|company|project`, `--workspace ws_<id>`, and for company/project set `--scope <scope>`; project also needs `--project <scope.project>`. Company scope must exist in the pilot; project must be in its registry. IDs use prefixes `ws_`, `rq_`, `ds_`, `dc_`, `rv_` followed by 8–64 lowercase letters, digits, underscores or hyphens. Each new ID is an exclusive create. There is no mutable current version.

Use these routes in order, adding the same selection flags each time:

1. `skill discover` lists the three bundled skills. `--fixture <directory>` may inspect a synthetic skill under the pilot's inputs root. It does not inspect agent homes or run scripts.
2. `skill workspace-create` creates one private workspace.
3. `skill requirements-record --requirements rq_example01 --input <requirements.json>` stores immutable requirements. JSON must provide `goal`, `success`, `examples` (at least one request), `negativeExample`, `inputs`, `permittedTools`, `forbiddenTools`, `permittedContext`, `forbiddenContext`, `supportedAgents`, `output`, `failure`, `destination` and `unknowns`.
4. `skill design-record --requirements rq_example01 --design ds_example01 --input <design.json>` stores a design bound to that requirements digest. JSON must provide `name`, `description`, `workflow`, `outputs`, `dependencies`, `tests`, `tree` (including `SKILL.md`), `destinations` and `reuse`.
5. Present the returned full design digest to the user. Record an explicit response using `skill design-approve --design ds_example01 --decision dc_example01 --interaction-ref user:<reference> --response 'Approved sha256:<full digest>'`. The response must match this exact canonical wording. This is self-reported interaction evidence, not identity authentication or natural-language interpretation. Changed named requirements or design make the receipt stale.
6. Put candidate files under a directory in the pilot inputs root. `skill draft-create --requirements rq_example01 --design ds_example01 --decision dc_example01 --revision rv_example01 --candidate <directory>` copies them into an immutable private revision. The command refuses an unapproved design. Run `skill draft-validate --revision rv_example01`, then inspect `skill workspace-show` for IDs and statuses. A correction uses a new revision ID; no command overwrites a revision.

The validator accepts a **strict documented subset** of Agent Skills frontmatter. That subset is UTF-8 text with LF or CRLF, opening and closing `---`, exactly `name` and `description` as one-line strings, then nonempty Markdown. A value may be a JSON double-quoted string (also valid YAML) or a conservative unquoted ASCII scalar. Unquoted values cannot begin with a digit, be a YAML boolean/null token (including `y`, `n`, `Y`, `N`), or contain YAML-significant punctuation such as a colon. Quote natural descriptions when in doubt. It rejects BOM, YAML collections, aliases, multiline or single-quoted scalars, and duplicate/unknown keys. Markdown thematic breaks (`---`) in the body are allowed. The name matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is at most 64 characters and matches the approved design; digit-leading or YAML-keyword names require double quotes. Description is at most 1024 characters. This subset is not a general YAML parser or full specification validator.

Packages allow `SKILL.md` and UTF-8 text files under `references/`, `scripts/`, or `assets/` only. Binary assets are unsupported in A. Intake rejects symlinks, hard links, nonregular entries, denied names and unsafe paths; limits are 24 files, 131072 bytes per file, 262144 total bytes, four directory levels and 32 directories. Inline Markdown relative links outside backtick fences are checked for existing package files; contained `../` links are resolved from their containing file. URL and anchor links are ignored; reference-style and HTML links are reported unchecked. This is an advisory link check, not a full Markdown parser. It does not recognize tilde fences, which may produce false missing-link reports. An unterminated backtick fence may hide later missing links. It treats link titles such as `[x](a.md "title")` as part of the target and may report them missing. Also, `unchecked` may list a file more than once. Helpers are never executed by these commands, so their behavior remains unverified. Sensitive-content scanning is a tripwire, not clearance. A failed validator records a failed result for that exact revision and validator version; package tampering blocks validation entirely.

Private draft staging that survives an interrupted write requires manual review. Do not remove it automatically or reuse its revision ID. `workspace-show` reports staged revision IDs, incomplete or tampered revisions, and validation status without returning requirements, design or package bodies. Live behavior, routing quality, fresh-agent discovery, real-home activation and publication remain untested or unavailable.

## Create from a template

Skill-builder feature work is frozen with one recorded exception (see the [roadmap](ROADMAP.md)). The create-from-template path (`skill template-list`, `skill template-seed`, `skill template-verify` and the templates under `templates/skills/`) may be built as part of the personal harness layer; it adds no install, export, validation or pilot-fence behavior; all other skill-builder and skill-source feature work stays frozen. `skills/devtwin-create-skill/assets/skill-template.md` stays the blank starter for skills built from scratch; `templates/skills/` holds guided templates that do not use it.

A template folder holds exactly `template.json`, `requirements.json`, `design.json` and `candidate/SKILL.md`. `template.json` has `schemaVersion` 1, `name` (the folder name), `description` and `placeholders`. Each placeholder has `key` (matching `^[a-z][a-z0-9-]{0,31}$`), `description`, `kind` (`generic` or `scope`), `required` and `default` (`null` when required, a string otherwise). The other files write placeholders as `{{dck:<key>}}` (the marker keeps the prefix from the product's earlier name); every marker must be declared and every declared key used. Symlinks and other files are refused.

1. `skill template-list` needs no pilot. It returns each template's name, description and placeholders, and an empty list when the kit has no templates.
2. `skill workspace-create` creates the workspace as usual (`personal` or `company`).
3. `skill template-seed --template <name> --audience personal|company [--scope <scope>] --workspace ws_<id> --set <key>=<value> … --pilot <pilot.json>` is a read-only render. It requires the workspace to exist (`NOT_FOUND`). It refuses an unknown or missing required placeholder (`INVALID_INPUT` naming the key). It also refuses a value with a control character or the `{{dck:` marker, and sensitive content. The rendered design name cannot start with `devtwin-`, match a bundled skill or fail the name rule. A template with a `scope` placeholder renders only for `--audience company --scope <scope>`, and each such value must be the scope or a `<scope>.<name>` inside it. It returns each file's relative path, content and SHA-256, the layout and a `renderDigest`, and writes nothing.
4. After explicit user approval, the developer writes the returned files unchanged into a new directory under the pilot inputs root. devtwin does not write them.
5. `skill template-verify` takes the same flags plus `--dir <directory under inputsRoot>` and `--render-digest <digest>`. It re-renders and compares bytes. It refuses a directory outside the inputs root with `GATE_REQUIRED` and links with `PATH_UNSAFE`. It refuses a changed render digest with `PLAN_MISMATCH`, and an edited, missing or extra file with `INTEGRITY` naming it. It writes nothing.
6. Continue with steps 3–6 above unchanged, passing `<dir>/requirements.json`, `<dir>/design.json` and `--candidate <dir>/candidate`.

## Disposable local installation

Only an intact `personal` revision with a passing `v1` validation may be installed. Package names starting `devtwin-` or matching a bundled skill are reserved. The selected home must be one of the pilot's `agentHomes`; company and project workspaces, real agent homes and unsafe paths are refused. Helpers in a package are copied as inert text and remain unverified.

First show the exact package digest and obtain a user response `Approved content sha256:<full digest> as personal generic non-confidential`. Record it with `skill content-approve --audience personal --workspace ws_example01 --revision rv_example01 --decision dc_content01 --interaction-ref user:<reference> --response '<exact response>' --pilot <pilot.json>`. This is a self-reported attestation that the content is suitable for generic personal homes. The scanner and workspace audience do not establish that fact.

Preview with `skill local-plan --mode install --audience personal --workspace ws_example01 --revision rv_example01 --content-decision dc_content01 --home <pilot-agent-home> --agent claude --agent codex --pilot <pilot.json>`. The plan returns the exact package and validation digests, target paths, file hashes, action statuses and fingerprint. A plan containing `conflict` or `modified`, or no mutation, cannot be approved. The user must then respond `Approved install sha256:<full plan fingerprint>`. Record this separately with `skill local-approve` using the same selection flags plus `--decision dc_install01 --plan-fingerprint <fingerprint> --interaction-ref user:<reference> --response '<exact response>'`. Apply with `skill local-apply`, the same selection, `--decision dc_install01`, `--plan-fingerprint <fingerprint>`, and optionally a unique `--run-id run_<id>`. Without `--run-id`, the tool makes a fresh random one. Approval is consumed once. A changed package, validation, target or status requires a new plan and decision.

Uninstall uses `--mode uninstall` and the installed receipt's exact `--revision`, omitting `--content-decision`. It needs its own `local-plan`, `local-approve` response `Approved uninstall <full plan fingerprint>`, and `local-apply`. It refuses the whole package if any owned file, directory or receipt was changed. Updating a revision also needs fresh content and install approval. `skill local-status` reports observed target states, consumed decisions, and incomplete/reviewed journals without requiring approval; in install mode an optional `--content-decision` validates that named decision.

Plans also include a digest of the prior ownership receipt for each target. An intervening intact install changes that digest and invalidates an approved update or removal plan, even if its action status remains the same.

Installed ownership checks hash the exact file bytes. A changed or invalid UTF-8 byte sequence is treated as a modification and is preserved. An update that would turn an owned file into a directory, a directory into a file, or change only a file path's letter case is a conflict at preview. Uninstall the old revision with its own approval, then plan a separate install. This case check is conservative on case-sensitive filesystems too.

The tool writes a private journal before target mutation. `RECOVERY_REQUIRED` means a run stopped with incomplete actions; package apply refuses that home until it is reviewed. Inspect the journal and target. Then preserve a partial package by moving it within the pilot to `stateRoot/skill-installs/quarantine/<run-id>/<agent>/<skill>` (or copy, verify and remove for a cross-volume move), or restore exact verified prior files. Move `runs/<run-id>/journal.json` to `runs/<run-id>/reviewed/journal.json` only after that review. Then plan again and obtain a new decision. No command automatically deletes or repairs a partial target. Bundled `agents install` keeps its existing recovery behavior, while each apply now requires a new run directory and its CLI generates a fresh run ID by default.

## Third-party source packages

Source packages have separate decisions and schema-3 ownership receipts. They reuse B's filesystem executor and install lock, without creating personal workspaces or generic-content attestations. All operations below require a disposable `--pilot` and make no network requests. None runs helpers, native installers, hooks, host binaries or provider setup.

Stage one package's exact required files, including licenses and notices. Review with `skill-sources package-review --pilot "$PILOT_FILE" --run "$STAGE_ID" --mapping-json "$MAPPING_JSON"`. A minimal repository-root mapping is:

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

This example intentionally cannot be approved. Inspect all content and upstream requirements first. Review fields accept `user-reviewed`. A dependency has `name` and `status`, where status is `missing`, `unreviewed` or `user-confirmed-present`; the CLI installs none. Each compatibility value is `unreviewed`, `unsupported` or `user-reviewed-sandbox`. Empty dependency/notice lists are reviewed completeness claims, not automatic scans. Missing dependencies and unreviewed selected hosts remain blocking.

Map every staged path exactly once. All required/legal paths must be mapped, `licensePaths` must be nonempty, and the selected root's `SKILL.md` is mandatory. Within a nested `skillRoot`, retain relative paths exactly. Only declared legal files can come from outside that root; they map to their original basename and appear as explicit relocations. Legal targets are root `LICENSE`, `NOTICE` or `COPYING`, optionally suffixed `.md` or `.txt`. Two legal files targeting the same name produce `LEGAL_TARGET_COLLISION`; nothing is dropped or renamed. Correct the selection and review again.

The supported layout is root `SKILL.md`, legal files and text below `references/`, `scripts/` or `assets/`: 24 files, 128 KiB each, 256 KiB total, depth four. Binary content, unsupported paths, missing inline local links and unchecked reference-style links are held. Raw metadata stays byte-identical. A narrow envelope requires unique bare top-level keys and one scalar name; block descriptions and plain-key nested metadata are retained. The name must end on its own line: indented continuations or comments governed by `name`, including across blank lines, are held. Quoted/complex keys, aliases, anchors, tags, directives and flow collections are unsupported. `name-only-unverified` is not full YAML/schema validation. `devtwin-` names, `synced` and `anthropic-skills` are reserved.

Review output separates blocking `holds` from digest-bound `disclosures`: caller-unverified pins, name-only metadata checks, inert helpers, upstream executable modes copied as 0600, legal relocations and the unchanged `acquisitionAssessment`. Installed state comes from actual target inspection. Approval does not turn those disclosures into verified provenance or runtime compatibility.

After explicit user review, record content approval and plan installation:

```sh
node bin/devtwin.mjs skill-sources content-approve --pilot "$PILOT_FILE" --run "$STAGE_ID" --mapping-json "$MAPPING_JSON" --package-digest "$PACKAGE_DIGEST" --decision "$CONTENT_DECISION" --interaction-ref "$USER_INTERACTION" --response "Approved source content $PACKAGE_DIGEST with caller-supplied-unverified pin"
node bin/devtwin.mjs skill-sources local-plan --pilot "$PILOT_FILE" --content-decision "$CONTENT_DECISION" --home "$PILOT_HOME" --agent-json '["claude","codex"]' --mode install
```

Use the reviewed digest, a fresh `dc_` ID with 8–64 lowercase letters/digits/underscores/hyphens after its prefix, and the actual `user:` interaction reference. The response records evidence; the CLI does not authenticate the person. Changed content or declarations require a new content decision. All implementation approvals are synthetic fixtures.

Present the exact plan to the user, then record and apply a separate action decision:

```sh
node bin/devtwin.mjs skill-sources local-approve --pilot "$PILOT_FILE" --content-decision "$CONTENT_DECISION" --home "$PILOT_HOME" --agent-json '["claude","codex"]' --mode install --decision "$ACTION_DECISION" --plan-fingerprint "$PLAN_FINGERPRINT" --interaction-ref "$USER_INTERACTION" --response "Approved source install $PLAN_FINGERPRINT"
node bin/devtwin.mjs skill-sources local-apply --pilot "$PILOT_FILE" --content-decision "$CONTENT_DECISION" --home "$PILOT_HOME" --agent-json '["claude","codex"]' --mode install --decision "$ACTION_DECISION" --plan-fingerprint "$PLAN_FINGERPRINT"
node bin/devtwin.mjs skill-sources local-status --pilot "$PILOT_FILE" --content-decision "$CONTENT_DECISION" --home "$PILOT_HOME" --agent-json '["claude","codex"]' --mode install
```

Content decisions are reusable; action decisions are single-use. Update using a newly approved stage. Restore an older version by planning `install` with its retained content decision and obtaining a fresh action approval. This is intentional reapplication after a clean install, not automatic failure rollback. A changed source or package root requires separately approved removal and a new install.

For removal use `--mode uninstall` throughout and response `Approved source uninstall <fingerprint>`. Its content decision must exactly match the current ownership receipt. Removal checks the stored decision, receipt, installed hashes and modes, without needing staging or the current catalog. Missing/corrupt staging blocks update/restoration but not removal of an intact owned package. Corrupt decisions or edited targets still block removal.

Source sandbox layouts are `.claude/skills/<name>` and `.agents/skills/<name>` below the canonical pilot home. Personal B writes Codex skills to `.agents/skills`, where a foreign same-name entry is a conflict; earlier `.codex/skills` copies are left untouched. Source operations check competing names in all three roots outside the selected targets. A dual-host source installation therefore requires both hosts selected for update/removal. There is no adoption, force, overlay, migration or host discovery mode. Foreign files, user edits, extra directories, links and added owner-execute bits are preserved.

Writes are in place and journaled per host, not an atomic multi-host transaction. `local-status` reports consumed approvals and incomplete/reviewed runs. Incomplete shared journals block both package adapters; no command automatically rolls back or deletes partial targets. Retain staging/decisions for restoration and see [storage](STORAGE.md) for recovery boundaries.
