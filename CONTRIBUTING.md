# Contributing

Help make project context reviewable and portable without mixing reusable code with private working data.

devtwin is pre-release: see the [roadmap](docs/ROADMAP.md) for what is built and what is planned. Discuss changes that weaken the fence, introduce live connectors or alter approval contracts before implementing them.

## Development setup

Use a reviewed checkout and the prerequisites in [Getting started](docs/GETTING-STARTED.md). There are no third-party runtime dependencies or install steps.

From the repository root:

```sh
npm test
npm run check:package
npm run check:writing
git diff --check
```

The test runner checks for missing required tests and rejects skipped, focused or placeholder tests. New required test names belong in `test/required-tests.json`.

[Pilot CI](docs/CI.md) runs these checks on macOS and explicit Linux evaluation lanes. Validate workflow edits with `actionlint .github/workflows/ci.yml` when the validator is available. Do not treat a configured workflow as a successful remote run.

For synthetic end-to-end checks:

```sh
ACCEPTANCE_PARENT="$(mktemp -d /tmp/devtwin-acceptance.XXXXXX)"
ACCEPTANCE_PARENT="$(cd "$ACCEPTANCE_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$ACCEPTANCE_PARENT/pilot" \
  --report "$ACCEPTANCE_PARENT/report.json"
```

Expected: 32 passed checks and one explicitly deferred fresh-agent smoke check. This is not evidence of real-agent discovery or production readiness.

## Keep changes reviewable

1. Describe the user problem, scope and invariants.
2. Add a failing test for changed behavior.
3. Implement the smallest change that preserves privacy and approval boundaries.
4. Run focused tests, then the full suite and package audit.
5. Update the relevant guide or contract. Execute changed onboarding commands in a fresh disposable directory.
6. Include test results, environment and remaining limitations in the pull request.

The [roadmap](docs/ROADMAP.md) orders the next capability gaps. Skill-builder and skill-source feature work is frozen: send bug fixes there, not new features. Do not infer support from a design document or a filesystem fixture alone.

## Keep examples public-safe

Use fictional projects and reserved example domains. Do not commit client names, account identifiers, home paths, session exports, generated handoff packets, credentials or local context stores. Review screenshots, logs and Git history as well as files.

`scripts/package-allowlist.json` explicitly lists release files. Add only intentional source, test or documentation files. Do not allowlist a file merely to silence the audit. The audit checks current files and dry-run packaging; it does not clear Git history or all possible sensitive content.

## Skills and third-party content

A catalog entry references an upstream project; it is not a reviewed installation or a license grant. Include source provenance and preserve applicable license/notice files for any proposed third-party material. Do not copy an entire collection into this repository as part of ordinary documentation work.

## Contribution terms

The toolkit uses [Apache-2.0](LICENSE). Submit only material you have the right to contribute. Contributions intentionally submitted for inclusion are subject to the license's contribution terms unless explicitly stated otherwise or covered by a separate agreement. Preserve third-party attribution and identify any separate terms for review.

For vulnerabilities, use [Security reporting](SECURITY.md), not a public issue containing exploit details or private data.
