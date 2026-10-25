# Security model

The pilot fence and private file modes reduce accidental writes and reading. Source reads hold a no-follow descriptor, compare its identity before and after reading, and recheck ancestor identity. A residual race remains: a malicious same-user process can swap an ancestor between path checks or before later use. This is not a sandbox.

The core has no automatic private-to-public synchronization. A chosen agent host may transmit selected context to its provider, and direct tools can bypass this CLI's routing and fake connector checks. G-REPO and G-HOME are narrow metadata tripwires, not byte identity.

The root-free `skill-sources catalog` route reads only the bundled public catalog. `skill-sources check` makes unauthenticated, read-only requests to the GitHub API for repository, release, tag and commit metadata. GitHub sees the caller's IP; its unauthenticated limit is roughly 60 requests per hour, and each check can use up to eight requests. These routes write no local files and make no installation or safety claim. Redirects, response sizes and time are bounded; no upstream code is downloaded or executed.

Acquisition preview is also root-free and reads only pinned commit/tree metadata. Stage requests selected blob JSON, validates strict base64, and verifies Git SHA-1 object hashes and SHA-256 bytes before private pilot writes. It never clones, extracts archives, follows redirects, reads authentication, invokes upstream code or probes a host binary. Commit/tree identity relies on GitHub HTTPS metadata; commit/tree objects and signatures are not reconstructed or verified. The caller's tag/commit observation remains explicitly unverified, including membership in upstream history rather than a fork network.

Acquisition adds a dataRoot-only guard to the existing pilot gate. Ancestors above pilotRoot must be real directories owned by root or the caller; shared writable ancestors must be sticky. PilotRoot and any intermediates to dataRoot must already exist, be caller-owned and not group/other-writable; their device/inode identities are pinned. dataRoot and acquisition directories must be caller-owned 0700 nodes. No existing directory is chmodded, no run is adopted, and no stage targets agentHomes. Known `.gemini`, `.cursor` and `.commandcode` homes are now protected alongside existing homes for every pilot route. Unknown custom discovery roots must be supplied in `pilot.forbidden`.

Receipt publication uses exclusive hardlink creation rather than replacement. Its pending-link removal rechecks invocation-owned inode and parents, but Node has no inode-conditional unlink: a same-user replacement between the check and unlink remains possible. The final receipt is never rolled back. Receipt hashes detect changes relative to the receipt; they are not signatures and cannot detect malicious replacement of both payloads and receipt. CLI acquisition errors suppress absolute filesystem paths and raw errno/response bodies while preserving bounded rate-limit hints.

Independent acquisition plan and actual-diff reviews passed, with no material implementation findings. Local fixture tests and a separate two-file public-source smoke verified preview, private disposable staging, byte hashes, inert file modes and offline inspection. This evidence does not establish source safety, host compatibility or installation readiness, and does not remove the documented same-user races.

Source installation adds separate content-bound and target-plan-bound user evidence. Supplied interaction references are not identity authentication; record hashes are not signatures against malicious same-user rewriting. Missing declarations/requirements block installation, and reviewed dependency/compatibility declarations remain user assertions. The exact content response retains `caller-supplied-unverified` pin acceptance. No acquired helper or host process is executed.

The source adapter preserves raw metadata/legal bytes and rejects ambiguous metadata envelopes; name-only checks are not full YAML validation. It shares B's executor/lock but keeps independent decisions/ownership. Source inventory requires exact 0600/0700 modes, hashes and directories; outputs are verified before marker publication. Matching foreign bytes are never adopted. Personal Codex planning adds a read-only competing shared-root conflict; source checks cover three explicit sandbox roots, not plugins or arbitrary host overrides.

Updates/restoration revalidate staging and ownership. Removal requires the exact current content decision and intact stored receipt/bytes/modes, but deliberately does not require intact staging or current catalog metadata. This permits removal after staging loss while preserving edits. Writes remain in place with partial journals, without atomic rollback or a multi-host transaction. Node path-based operations retain the documented same-user residual race.

## Record, Git and agent-home trust

These rules reduce accidental damage and make tampering visible. They are not a defense against a malicious same-user process, which can rewrite records, manifests and the registry together. The residual race described above is unchanged.

- Operation IDs are stamped only by onboarding. Public record APIs refuse them. Request IDs remain caller-chosen idempotency keys.
- A record is trusted only when three conditions hold. Its ID matches its scope, project and request ID. Any operation it claims lists it in a published manifest with the same hash. Its supersession list is well formed and acyclic. Otherwise `readSnapshot` reports it as corrupt. See the manual review step in [Storage](STORAGE.md).
- The secret tripwire refuses or skips credential-like text. It covers private key blocks (including PGP), `Authorization` headers, bearer tokens, `x-api-key` and other credential assignments, and JWTs. It also covers classic and fine-grained GitHub tokens, AWS access and temporary keys, Slack tokens, LLM provider, Stripe, Google and npm keys, and URL user info. Field names `password`, `token`, `secret`, `api_key`, `private_key`, `access_key` and `credential` are refused, and so are names ending in `_token`, `_secret` or `_password` or in camelCase `Token`, `Secret` or `Password`. It is a tripwire, not clearance: other formats pass.
- SHA-256 of the exact bytes is the source identity authority. Stored `mtimeMs` values are informational. Hashes detect change; they are not signatures.
- Git queries fail closed. Only exit 128 with "not a git repository" counts as "not a repository". Any other failure, including a timeout or a refused repository, is `GIT_QUERY_FAILED`. Git output, remote count and remote URL length are bounded with `LIMIT`.
- Agent-home writes require the installer's one named target home, which must be listed in `pilot.agentHomes`. Other mutators cannot write any agent home. In live mode `agentHomes` is empty, and the bundled installer instead writes only `devtwin-*` entries directly inside the live config's named skill folders; see below.

## Live mode

Live mode ([Live activation](LIVE.md)) relaxes the fence for exactly the paths a live config names. It does not make the kit a sandbox.

- Only the named skill folders and repositories are exempt from the "inside pilotRoot and not protected" rules. A skill folder must be exactly `<home>/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) or `<home>/.agents/skills`, must already exist and must have no symlinked ancestor below the home. The rest of each protected home stays protected.
- In a skill folder the installer writes only `devtwin-*` entries. It never creates, removes or chmods the folder or its parents, and never touches a foreign, symlinked, edited or unowned entry. A conflict blocks only that agent.
- An entry is removable only when its receipt matches a completed journal in this store for the same config ID.
- Live commands run only from the kit the live config names, clean and detached at its commit. The home is the process home, and a different home is refused.
- The approved config digest in the store catches accidental edits to `live.json`. It does not stop deliberate same-user tampering: the same user can rewrite the live config and the digest together.
- The rollback check compares a skill folder with the inventory taken before an install run. It fails on `devtwin-*` differences and lists foreign changes for the owner. It restores nothing.
- Cursor also reads `~/.agents/skills` and sees the installed skills. The skills keep every confirmation for any caller.
- There is no backup. Onboarding copies some client repository text into the store, protected by mode 0700 and disk encryption only.

## Live-mode exceptions

The approved write classes in a live config ([Live-mode exceptions](LIVE.md#live-mode-exceptions)) are the only writes outside the store and the named skill folders. They widen the fence by exact paths only.

- The four classes are `hubRoot`, `instructionTargets`, `hookTargets` and `launchAgents`. Each path has a fixed shape. A hub root is a folder inside the home. An instruction target is `CLAUDE.md`, `AGENTS.md` or a `devtwin*.md` file in the Claude or Codex folder. A hook target is `settings.json` or `hooks.json` in those folders. A launch agent is a `devtwin.<name>.plist` file in `~/Library/LaunchAgents`. Every other path stays refused.
- The classes are covered by the approved config digest, so an accidental change is refused with `GATE_REQUIRED`. As for the rest of the live config, this does not stop deliberate same-user tampering.
- The fence accepts a class path only when the caller names that class. A record, draft or onboarding write cannot reach a class path.
- A disposable pilot can list classes too. Its file targets must have the same shapes inside a listed fake agent home, and its hub folders must be inside `pilotRoot`.
- No command edits a class file yet. The shared edit step limits edits to developer-owned files to the devtwin marker block or devtwin's own JSON entries. The prior bytes are backed up byte for byte in the run folder first. The file is read without following links and checked again immediately before the replace, but the same-user residual race between that check and the rename remains.

## Portable handoff boundary

Handoff export uses a selected-project projection, not the personal brief. It excludes preferences, policies, binding paths/remotes and structured account identities; unsafe selected text holds instead of being redacted. Strict final byte bounds and dataRoot-only exclusive writes preserve the pilot fence. Bodies are inert fenced text. Pattern checks cannot establish confidentiality or rights, and hashes do not authenticate evidence. Present observations are checked twice, but path-based non-atomic writes retain the same-user residual race. Invalid-footer artifacts must not be consumed or shared. See [HANDOFF.md](HANDOFF.md).

## Personal harness layer

The [personal harness layer](HARNESS.md) adds a personal profile, an announcement watch, private drafts and skill templates. It keeps the same trust limits.

- **Personal profile.** The profile is stored under `configRoot/profile/` with mode 0600, and its revision hashes catch accidental edits only. A same-user process can rewrite the revisions and the pointer together, so the profile is trusted only as far as the same-user boundary. The brief marks it as preference data, never permission, and never an override of repository instructions or the user. Handoff export excludes it. Validation refuses secret-named fields and credential-like text; that is a tripwire, not clearance.
- **Fetched text.** Fetched feed and release text is untrusted data, never instructions. The parser bounds depth, element count, entry count and field sizes, reduces HTML to plain text in linear time, and the digest quotes titles and excerpts inside fences. A link is rendered live only when it is `https` on the source's own host (the feed's host, or `github.com` for releases); other links are shown inactive. Matching is local, deterministic term matching; a match is not a safety or compatibility claim.
- **Feed URLs.** Under the feed URL rules, a feed URL must be `https`, with no user name, password, port or fragment. Its host must be a DNS name with at least two labels that is not an IP literal or `localhost`. Each request goes only to a host in the stored approval. The host is resolved first and refused if any answer is a private, loopback, link-local or reserved address, and the connection uses exactly the checked address. Redirects are not followed. Response size, total transfer, request count and time are bounded.
- **Requests.** Request content is limited to feed URLs and identifiers, plus exact versions to OSV only when advisories are enabled. Hosts still see the caller's IP address, the request time and the fixed user agent. A GitHub token can come only from organization identity routing's public-read binding, which is not built yet, so GitHub requests are unauthenticated today. No environment variable or record is read for a token.
- **Approvals.** The stack approval and pending digests are stored in `stateRoot` with record hashes that detect accidental change, not same-user tampering. `stack check` and `stack digest` refuse a live config with `GATE_REQUIRED` until the watch's live-mode exception lands with routing.
- **Drafts and templates.** `draft save` reads its body only from the inputs root, refuses sensitive content and writes a private file that is never sent. `skill template-seed` and `skill template-verify` write nothing; seeded files are written by the user and checked byte for byte.
