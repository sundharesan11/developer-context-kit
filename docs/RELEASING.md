# Public-alpha release checklist

Documentation and a license do not make this a finished product. The current release candidate is a disposable pilot. This checklist separates a public source preview from a daily-use release.

Nothing here authorizes changing repository visibility, pushing branches, publishing a package or sending private context.

## Before making the repository public

- [ ] **Rights and attribution:** confirm authority to license all included work under Apache-2.0; review the copyright holder in NOTICE; inventory copied or derived third-party material and retain its terms.
- [ ] **History and privacy:** review all history and refs that will become public, not just the current tree. Inspect issues, pull requests, attachments, artifacts and screenshots too. If a credential was exposed, revoke or rotate it; removing a file is not sufficient.
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
5. Record the commit/refs, tools, date, findings and unresolved decisions privately. If sensitive history is found, stop publication and agree on remediation. Do not rewrite shared history or force-push without approval.

An empty scanner report means no matches under that scanner's rules, not “safe to publish.” If an actual secret is found, rotate it before planning history cleanup.

## Private vulnerability reporting

While the repository is private, agree on a real private contact route with invited collaborators. Do not invent an inbox in SECURITY.md or make the repository public merely to unlock a reporting feature.

Once a visibility change is approved, an administrator can open **Settings → Advanced Security → Private vulnerability reporting → Enable**. Verify that **Security → Advisories** exposes **Report a vulnerability**, confirm maintainer notification settings, then update SECURITY.md. Do not submit a fake vulnerability report just to test the form.

GitHub documents this feature for public repositories in its [configuration guide](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). This checklist does not enable it.

## Reproduce verification

From the selected checkout:

```sh
node --version
git rev-parse HEAD
npm test
npm run check:package
git diff --check
```

Then run the [Getting started demo](GETTING-STARTED.md) and [Guided onboarding](ONBOARDING.md) in separate fresh temporary roots. Inspect the diagram and relative documentation links.

Keep raw reports private until reviewed. A release note may summarize counts, environment and deferred checks without including local paths or client context.

## Describe the public alpha accurately

Suggested factual description:

> Developer Context Kit is an experimental local CLI for scoped project context, decisions and handoffs. Its current pilot uses disposable directories and synthetic tests. Real-agent activation, live connectors and automatic skill updates are still under development.

Do not claim “works with every agent,” “automatically remembers everything,” “secure sandbox,” or “weekly updates are enabled.” Do not present a previous milestone's test count as evidence for a different commit.

## Before calling it ready for daily use

Items follow the [roadmap](ROADMAP.md) order.

- [ ] Private-state backup/restore and upgrade compatibility.
- [ ] Controlled real-project and real-home activation with reviewed targets and rollback.
- [ ] Fresh Claude and Codex sessions finding and using the intended skills.
- [ ] Session start and end hooks that carry context into and out of a session.
- [ ] Reviewed selective migration from an existing personal setup.
- [ ] Recovery tests for interrupted writes and documented operator actions.
- [ ] Separate compatibility evidence for each additional agent host.

Live connectors, company-hub distribution, skill export and a weekly skill updater require their own authorization and verification. They need not ship before an offline daily-use release, but they must not be implied. The open-source release comes after them in the roadmap.

## License and publishing settings

`package.json` declares `Apache-2.0`. Its `private: true` flag deliberately blocks npm publication; leave that guard in place until a separate package-release workflow is reviewed.

GitHub repository visibility is a separate setting. A local license change neither makes the repository public nor pushes these files.
