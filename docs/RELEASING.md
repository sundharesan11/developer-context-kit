# Public-alpha release checklist

Documentation and a license do not make this a finished product. devtwin is an alpha: the npm release goes to the `alpha` dist-tag, and daily use still has open items. This checklist separates a public source preview, an npm release and a daily-use release.

Nothing here authorizes changing repository visibility, pushing branches or tags, publishing a package, moving a dist-tag or sending private context. Each of those is a separate owner approval. Only the [release workflow](#package-release) publishes, after the owner pushes a tag and approves the `npm-release` environment.

## Before making the repository public

- [ ] **Rights and attribution:** confirm authority to license all included work under Apache-2.0; review the copyright holder in NOTICE; inventory copied or derived third-party material and retain its terms.
- [ ] **History and privacy:** review all history and refs that will become public, not only the current tree. Inspect issues, pull requests, attachments, artifacts and screenshots too. If a credential was exposed, revoke or rotate it; removing a file is not sufficient.
- [ ] **Candidate selection:** review and merge the intended commits into the release branch. Verify that the GitHub default branch contains the documented commands and guides.
- [ ] **Fresh checks:** run the full suite, package audit, acceptance harness and documented onboarding from the selected commit. Record platform, Node version and exact commit with the results.
- [ ] **Private security channel:** choose a verified private contact while the repository is private. GitHub private vulnerability reporting is a public-repository feature: enable and verify it as part of an approved visibility change, before announcing the public alpha.
- [ ] **CI execution:** [Pilot CI](CI.md) is configured. Verify all job conclusions for the intended release commit. Keep version/platform support claims separate from configured evaluation lanes.
- [ ] **Owner approval:** separately approve the push, visibility change and any tagged release. Check which GitHub account and repository are being changed.
- [ ] **Publication scope:** ship generic code/docs only. Do not publish pilot state, generated skills, reports or handoff packets.

The package audit is a useful gate, not a complete secret scanner or legal clearance. Apache-2.0 text does not relicense third-party skill collections. The full license text comes from the [Apache Software Foundation](https://www.apache.org/licenses/LICENSE-2.0.txt); see its [application guidance](https://www.apache.org/licenses/).

## Rights, history and privacy review

These are distinct checks. A successful secret scan cannot establish ownership.

1. Confirm who owns the original code and documentation. Check employment, client and collaboration obligations; obtain permission for material owned by someone else. Confirm the copyright holder in NOTICE.
2. Inventory copied or derived code, templates, prose and assets. Record source, license and required attribution. References to upstream skill repositories do not transfer their licensing rights to this toolkit.
3. Fetch the refs intended for publication and scan reachable history as well as the current tree. For example, use `gitleaks git . --log-opts=--all --redact=100` with the scanner installed, and retain detailed findings outside the checkout.
4. Review commit messages, author/committer identities, filenames, client references, private URLs and documents manually. Secret scanners can miss these. Review issues, pull requests, release assets and Actions artifacts too.
5. Record the commit/refs, tools, date, findings and unresolved decisions privately. If you find sensitive history, stop publication and agree on remediation. Do not rewrite shared history or force-push without approval.

An empty scanner report means no matches under that scanner's rules, not “safe to publish.” If an actual secret is found, rotate it before planning history cleanup.

## Private vulnerability reporting

While the repository is private, agree on a real private contact route with invited collaborators. Do not invent an inbox in SECURITY.md or make the repository public merely to unlock a reporting feature.

Once a visibility change is approved, an administrator can open **Settings → Advanced Security → Private vulnerability reporting → Enable**. Verify that **Security → Advisories** exposes **Report a vulnerability**, confirm maintainer notification settings, then update SECURITY.md. Do not submit a fake vulnerability report to test the form.

GitHub documents this feature for public repositories in its [configuration guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). This checklist does not enable it.

## Reproduce verification

From the selected checkout:

```sh
node --version
git rev-parse HEAD
npm test
npm run check:package
npm run check:writing
git diff --check
```

Then run the [Getting started demo](GETTING-STARTED.md) and [Guided onboarding](ONBOARDING.md) in separate fresh temporary roots. Inspect the diagram and relative documentation links.

Keep raw reports private until reviewed. A release note may summarize counts, environment and deferred checks without including local paths or client context.

## Describe the public alpha accurately

Suggested factual description:

> devtwin is an experimental local CLI for scoped project context, decisions and handoffs. Its pilot uses disposable directories and synthetic tests. A live mode for one real machine is implemented and has passed one owner activation. Live connectors and automatic skill updates are still under development.

Do not claim “works with every agent,” “automatically remembers everything,” “secure sandbox,” or “weekly updates are enabled.” Do not present a previous milestone's test count as evidence for a different commit.

## Before calling it ready for daily use

Items follow the [roadmap](ROADMAP.md) order.

- [x] Private-state backup and restore. Daily encrypted backups and the owner-run restore are implemented; see [Backup and restore](LIVE.md#backup-and-restore).
- [ ] Upgrade compatibility. [Upgrading](UPGRADING.md) documents the package upgrade and rollback; the roadmap still lists upgrade compatibility as open.
- [x] Controlled real-project and real-home activation with reviewed targets and rollback. The owner's first [live activation](LIVE.md) passed on 2026-10-25 at `b95ff72`.
- [ ] Fresh Claude and Codex sessions finding and using the intended skills. Fresh non-interactive sessions passed on 2026-10-25; interactive sessions remain.
- [ ] Session start and end hooks that carry context into and out of a session. Partly implemented: the agent hook gives the session summary and lessons, and the stop stub asks for a handoff. The resume and handoff adapters remain.
- [ ] Reviewed selective migration from an existing personal setup.
- [ ] Recovery tests for interrupted writes and documented operator actions.
- [ ] Separate compatibility evidence for each additional agent host.

Live connectors, company-hub distribution, skill export and a weekly skill updater require their own authorization and verification. They need not ship before an offline daily-use release, but they must not be implied. The open-source release comes after them in the roadmap.

## License and publishing settings

`package.json` declares `Apache-2.0`. It has no `private` flag, because the release workflow publishes the package. Two controls stop an accidental publish:

- A `prepublishOnly` guard (`scripts/publish-guard.mjs`) refuses `npm publish` from a folder outside GitHub Actions. Set `DEVTWIN_ALLOW_LOCAL_PUBLISH=1` only for a deliberate local publish.
- `publishConfig.provenance` is `true`. A local publish has no CI identity for provenance, so npm refuses it.

The guard only stops accidents. The real control is the npm setting that disallows tokens, together with a trusted publisher that names only the release workflow.

GitHub repository visibility is a separate setting. A local license change neither makes the repository public nor pushes these files.

## Package release

`.github/workflows/release.yml` publishes devtwin to npm. Only a pushed tag that starts with `v` starts it. It has no manual or pull-request trigger.

The workflow has three jobs:

1. The gate job runs on macOS 15 with Node 22.13.0 and 26.4.0. It checks that the tag equals `v` plus the `package.json` version. Next, it runs the package audit, the writing check, the full suite and the pack smoke test. Last, it computes the kit digest of the packed tarball with `scripts/kit-digest.mjs`.
2. The publish job waits for the owner's approval in the `npm-release` environment. It installs npm 11.21.1, packs the package and compares the kit digest with the gate's digest. It publishes that tarball with provenance under the `alpha` dist-tag, or `next` for a version without a prerelease part.
3. The release job runs after the publish job. It creates a draft GitHub release with the version, the source commit and the kit digest. When a release for the tag exists, it does nothing.

Only the publish job has the `id-token: write` permission, which trusted publishing needs. Only the release job has `contents: write`. The publish job uses Node 26.4.0, because trusted publishing needs Node 22.14.0 or later and npm 11.5.1 or later. The workflow never writes the default dist-tag, `latest`.

### Owner one-time steps

The owner does these steps once, before the first release. An agent does none of them.

1. On npmjs.com, add a trusted publisher to the `devtwin` package. Use GitHub Actions, repository `sundharesan11/devtwin`, workflow `release.yml` and environment `npm-release`. The fields are case-sensitive.
2. In the GitHub repository settings, create the `npm-release` environment. Add the owner as the required reviewer.
3. In the same environment, limit deployments to tags that match `v*`.
4. Add a tag ruleset for `v*`. Allow only the owner to create, update or delete these tags.
5. On npmjs.com, open the package's publishing access settings. Select "Require two-factor authentication and disallow tokens".

### First release

The owner does each step and approves each change on npm or GitHub.

1. Merge the release branch into `main`.
2. Do the owner one-time steps.
3. Push the tag `v0.1.0-alpha.1` from the merged commit.
4. Approve the `npm-release` environment run when the gate job passes.
5. Open the draft GitHub release. Check the version, the source commit and the kit digest. Publish the release.
6. Deprecate the placeholder versions with `npm deprecate devtwin@"<0.1.0-alpha.1" "Use devtwin@alpha"`. This range covers `0.0.1` and `0.0.0-stage`.
7. Run `npm view devtwin dist-tags`. Check that `alpha` names `0.1.0-alpha.1`. Check the provenance badge on the npm package page.

A deprecated version still installs when its dist-tag names it. Until `latest` moves, `npm i devtwin` installs the placeholder and shows the deprecation message. Install with `npm i -g devtwin@alpha`.

A failed publish changes nothing on npm. Run the failed jobs again from the same tag. If the publish passed but the release job failed, run the release job again alone. It does not publish again. If it still fails, create the draft by hand with the digest from the gate job's log.

### Moving latest

`latest` moves only after the real-agent scenarios pass on the published version. The owner approves this step separately and runs one command:

```sh
npm dist-tag add devtwin@<version> latest
```

The release workflow never runs this command.

### Compare the kit digest

The draft release lists the kit ID, `npm:<version>+sha256:<digest>`. `devtwin kit install` prints the same digest for the installed package. The set-kit dialog shows it too. Compare them before you approve the dialog. A different digest means that the installed package is not the published tarball. [Upgrading](UPGRADING.md) gives the owner's steps.
