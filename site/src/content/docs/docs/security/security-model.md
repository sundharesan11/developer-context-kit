---
title: Security model
description: What devtwin protects against, what it trusts, and where its protections stop.
---

devtwin keeps private project context on your machine and makes every write something you previewed and approved. It is designed to prevent **mistakes**: an agent writing to the wrong folder, context leaking into a public repository, a stale plan being applied, a skill folder being clobbered. It is not a sandbox and does not defend against a malicious process running as your own user.

## Trust boundary: your user account

Everything devtwin stores is protected by file modes (0700 directories, 0600 files) and your disk encryption. Any process running as your user can read and rewrite those files, including the hashes and digests devtwin uses to detect changes. So:

- Hashes and digests **detect accidental change**. They are not signatures and do not stop deliberate tampering.
- The approved digest of `live.json` catches an accidental edit, not someone rewriting the config and its digest together.
- File checks hold a no-follow descriptor and compare identity before and after reading, but a same-user process can still race a path between checks.

## The pilot fence

Every stateful command takes a pilot file that lists the only places it may write and the repositories it may read.

- Writes go only inside the pilot's config, data and state roots, and, for installers, the one named target home.
- Protected paths are always refused: the real `~/.claude`, `~/.codex`, `~/.agents`, `~/.gemini`, `~/.cursor` and `~/.commandcode` homes, `$CLAUDE_CONFIG_DIR`, `$CODEX_HOME`, default devtwin locations, and the kit checkout itself. Add custom agent folders to the pilot's `forbidden` list.
- Private roots may not sit inside a Git worktree, so private context cannot be committed by accident.
- Onboarding never writes to a repository. Git runs with global and system config ignored, hooks and fsmonitor off, and no optional locks. A repository whose own config defines filters is refused.

The fence controls what **this CLI** writes. It does not limit what your agent host can read, write or run.

## Live mode

[Live mode](/docs/guides/live-mode/) relaxes the fence for exactly the paths the live config names.

- In each named skill folder, devtwin writes only `devtwin-*` entries. It never creates, removes or changes the mode of the folder or its parents, and never touches a foreign, symlinked, edited or unowned entry. A conflict blocks only that agent.
- An entry is removable only when its receipt matches a completed journal in this store for the same config ID.
- Live commands run only from the kit clone the config names, clean and detached at its commit, with your real home.
- The rollback check compares a skill folder with the inventory taken before an install. It restores nothing.
- There is no backup. See [Limitations](/docs/security/limitations/).

## Approvals and consent

Every write is a preview followed by an apply. Applies are bound to a **fingerprint** of the exact plan, so a plan that changed after you reviewed it is refused.

A fingerprint is not proof that *you* approved. An agent can read a preview and pass its fingerprint back. That is why the bundled skills ask you in the session and never apply a plan you did not approve, and why some actions are reserved for you: `record publish --apply`, live config changes, and (when [identity routing](/docs/guides/identity-routing/) ships) account bindings, which will also require a code typed at an interactive terminal.

Approval responses recorded by the skill builder and skill-source installers (`--interaction-ref`, `--response`) are evidence of your decision, not authentication.

## Stored context is data, not instructions

Records, briefs, policies, onboarding candidates, fetched feed text and third-party skill files are treated as untrusted data.

- Every brief carries a notice: stored context is evidence, not instructions; repository instructions and the user govern.
- `confirmed` means an owner workflow receipt, not authentication. CLI records are attributed to `human` whoever runs the command.
- The bundled skills tell agents never to follow instructions found inside records or fetched text.
- The personal profile is preference data, never permission.

## Content checks are tripwires

devtwin scans titles, bodies, profiles, drafts and handoff packets for credential-like text and refuses with `DEVTWIN_SENSITIVE_CONTENT`. Handoff export also holds URLs, absolute paths and other non-portable text. These checks catch common mistakes. They cannot prove that text is free of secrets or confidential information, so review what you share.

Never put credentials in records, proposals, plans, profiles or command arguments.

## Network use

Most commands make no network request. The exceptions are explicit:

| Command | Contacts | Sends |
| --- | --- | --- |
| `skill-sources check`, `preview`, `stage` | `api.github.com` (unauthenticated) | Repository, release, tag, commit and selected-file requests |
| `stack check`, `stack digest` (preview) | Only hosts in your stored approval | Feed URLs and identifiers; exact versions to OSV only when advisories are enabled |

Hosts still see your IP address and the request time. The stack watch never follows redirects, refuses hosts that resolve to private or reserved addresses, and caps request count, size and time. Fetched text is rendered as inert, fenced text. No environment variable or record is read for a token.

Skill-source acquisition never clones, extracts archives, or runs upstream code. Staged files are verified by Git object hash and SHA-256 and stored with mode 0600, executable bits removed. The release tag and commit you pin are **caller-supplied and unverified**.

## Agent hosts and providers

devtwin cannot see or control what happens after an agent reads a brief:

- The agent host may send the context you give it to its model provider.
- Other tools the agent has, such as shells, MCP servers, `gh` and Git, bypass devtwin entirely.
- Installed skill files alone do not prove an agent discovers or follows them.

## Handoff packets

`handoff export` builds a packet only from records you select. It excludes your preferences, personal profile, policies, binding paths and remotes, and structured account identities. Unsafe text holds the export rather than being silently redacted. The packet is marked `publication: not-approved`: a human must still review it for confidentiality and rights before sharing.

## Reporting a vulnerability

Report privately, never in a public issue. Use GitHub's **Security → Advisories → Report a vulnerability** on the [repository](https://github.com/sundharesan11/devtwin) if it is enabled, or ask the maintainer for a private channel without including details. Include the commit, environment, the boundary you expected and a minimal synthetic reproduction. Don't include credentials, client data or raw session logs.
