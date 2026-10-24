---
title: Contributing
description: Set up a development checkout, run the tests and package audit, and keep your changes public-safe.
---

Contributions are welcome. devctx keeps reusable code separate from private working data, so the main things to get right are tests, approval boundaries and keeping private information out of the repository.

Before you implement a change that weakens the pilot fence, adds a live connector or alters an approval contract, open an issue to discuss it.

## Set up

```sh
git clone https://github.com/sundharesan11/developer-context-kit.git
cd developer-context-kit
node --version   # 22.13 or later
node bin/devctx.mjs help
```

There are no third-party runtime dependencies and no install step.

## Run the checks

From the repository root:

```sh
npm test
npm run check:package
git diff --check
```

- `npm test` runs the suite. The runner fails on missing required tests and rejects skipped, focused or placeholder tests. Add new required test names to `test/required-tests.json`.
- `npm run check:package` audits every tracked or unignored file and the package dry run. It fails on private-state paths (profiles, digests, drafts, records, staging and similar under `data/`, `state/`, `config/`, `inputs/` or `private/`), home-directory paths and non-example email addresses. Pass `--denylist <file>` to also check terms you keep outside the repository.
- If you edit `.github/workflows/ci.yml`, validate it with `actionlint` when available.

### End-to-end acceptance run

The acceptance harness builds synthetic repositories, isolated roots and fake agent homes, then exercises onboarding, records, handoffs, installs, the personal profile, the stack watch (against offline fixtures), templates and packaging. It makes no network requests.

```sh
ACCEPTANCE_PARENT="$(mktemp -d /tmp/devctx-acceptance.XXXXXX)"
ACCEPTANCE_PARENT="$(cd "$ACCEPTANCE_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$ACCEPTANCE_PARENT/pilot" \
  --report "$ACCEPTANCE_PARENT/report.json"
```

Expect `ok: true`, every check `passed` except `fresh-agent-smoke`, which is `deferred`. A deferred check is not a pass. The pilot root and report path must not already exist. The report is private; review it before sharing any part of it.

## Make a change

1. Describe the user problem, the scope and the invariants you must keep.
2. Add a failing test for the changed behavior.
3. Implement the smallest change that preserves privacy and approval boundaries.
4. Run focused tests, then the full suite and the package audit.
5. Update the relevant docs. Run any changed commands in a fresh disposable pilot.
6. In the pull request, include test results, your environment and any remaining limitations.

Skill-builder and skill-source feature work is frozen: send bug and safety fixes there, not new features. See the [roadmap](/docs/project/roadmap/).

## Keep examples public-safe

- Use fictional projects and reserved example domains (`example.com`, `example.invalid`).
- Never commit client names, account identifiers, home paths, session exports, generated handoff packets, credentials or local context stores. Check screenshots, logs and Git history too.
- `scripts/package-allowlist.json` lists release files explicitly. Add only intentional source, test or documentation files. Don't allowlist a file just to silence the audit.

## Third-party content

A catalog entry references an upstream project; it is not a reviewed installation or a license grant. Include provenance and preserve license and notice files for any third-party material you propose. Don't copy whole collections into the repository.

## License

devctx is licensed under [Apache-2.0](https://github.com/sundharesan11/developer-context-kit/blob/main/LICENSE). Submit only material you have the right to contribute. Contributions you intentionally submit are covered by the license's contribution terms unless stated otherwise.

## Security issues

Don't open a public issue for a vulnerability. See [Reporting a vulnerability](/docs/security/security-model/#reporting-a-vulnerability).
