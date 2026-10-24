# Continuous integration

[Pilot CI](../.github/workflows/ci.yml) runs on pushes, pull requests and manual dispatch. A manual dispatch becomes available when the workflow exists on the default branch. It validates the disposable pilot; it does not install into real agent homes or deploy anything.

## Jobs and meaning

| Job lane | Runner | Node | Meaning |
| --- | --- | --- | --- |
| macOS pilot | `macos-15` | `26.4.0` | Regression check closest to the existing local baseline |
| macOS minimum evaluation | `macos-15` | `22.13.0` | Evaluate the declared version floor |
| Linux evaluation (unsupported) | `ubuntu-24.04` | `26.4.0` | Gather Linux compatibility evidence |
| Linux minimum evaluation (unsupported) | `ubuntu-24.04` | `22.13.0` | Evaluate both Linux and the declared floor |

Each matrix job has a distinct name and a 20-minute timeout. Failures remain visible; the workflow does not turn them into success with `continue-on-error`. A failing evaluation is not a reason to weaken the pilot guards. Do not make the Linux evaluation a required support gate until support is deliberately adopted.

A green job establishes synthetic behavior on that runner and commit. It does not prove native agent discovery, real-client onboarding, backup/restore or a supported operating-system release. Keep the [limitations](LIMITATIONS.md) until compatibility evidence has been reviewed. No branch protection or required checks are configured by this file.

## Last verified run

Last verified run: run 38154524118 on `main` at commit `8f1133a`, 2026-10-11. All four jobs passed: 234 of 234 tests, and 24 acceptance checks passed with one `fresh-agent-smoke` deferred in every lane. The workflow then expected 24 passed checks; it now expects 32 (step 6). This result applies to `8f1133a` only. The Linux and Node 22.13.0 lanes passing does not make either a supported configuration.

A CI run for `aa8de74` is pending. The local run at `aa8de74` (macOS, Node 26.12.1) passed 498 of 498 tests across 44 files and the package audit, and acceptance reported 33 checks: 32 passed and one `fresh-agent-smoke` deferred. That is local evidence, not a CI result. Later commits, including branch work, need their own run before anyone cites their counts.

## What each job does

1. Check out the event revision without leaving Git credentials in repository configuration.
2. Set up the selected Node version and report the environment.
3. Audit the exact source/package allowlist before running tests.
4. Run the full required-test suite.
5. Create a fresh canonical pilot under the runner's temporary directory, outside the checkout.
6. Run acceptance and verify 33 checks: 32 passed plus exactly one deferred `fresh-agent-smoke`. The harness also checks the required IDs.
7. Check the whole committed tree for whitespace errors and require a clean checkout, including untracked files.

The workflow's GitHub token has only `contents: read`. It uses no repository secrets, package-manager cache or artifact upload. It never runs untrusted pull-request code through `pull_request_target` or on a self-hosted runner. Source acquisition and live connectors are not exercised.

## Action pins

The workflow pins official actions to immutable commits:

- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1): `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0): `949feb2413d6458794dcd2491c4babbbce0c15c1`.

The pins were resolved from the upstream tag refs on 2026-10-11. Updating them requires reviewing the upstream changes and replacing the full commit hash. A version comment alone does not pin an action.

## Check a run

Open the repository's **Actions → Pilot CI** page. Confirm the branch and commit, then inspect every matrix job and its conclusion. A push receipt proves only that Git accepted the commit, not that CI passed.

For local checks, run `npm test`, `npm run check:package`, and the [acceptance demo](GETTING-STARTED.md). If `actionlint` is installed, also run `actionlint .github/workflows/ci.yml`; it is a development validator, not a runtime dependency. Static contract tests do not replace GitHub's workflow execution.

GitHub-hosted jobs can consume the account's Actions allowance for a private repository. This workflow does not change billing or repository settings. New pushes cancel older runs for the same workflow/ref; pull-request merge refs are separate.

A push to a same-repository pull-request branch can trigger both events, producing eight jobs. macOS runners consume more of a private account's allowance than Linux runners. Review usage before enabling frequent automated pushes; this workflow does not impose a spending cap.

## Failure handling

Read the failing job and step before rerunning. Keep generated reports outside the checkout and do not upload unreviewed context. If GitHub blocks execution because of Actions policy, billing or permissions, report that separately from a test failure. Do not change those account settings implicitly.

The [release checklist](RELEASING.md) still governs publication. This workflow does not perform a complete history/privacy audit or establish copyright ownership.
