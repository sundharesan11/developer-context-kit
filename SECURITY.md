# Security reporting

devtwin is an experimental local pilot. There is no stable supported release or response-time commitment yet.

## Report privately

For a public repository with private vulnerability reporting enabled, use GitHub's **Security → Advisories → Report a vulnerability** option. GitHub documents this as a [public-repository feature](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository). Its activation and verification are part of the [approved public-release transition](docs/RELEASING.md).

While this repository is private, invited collaborators must use an agreed private contact route. No dedicated reporting inbox is published here yet.

If GitHub's private reporting option is unavailable, ask the repository maintainer for a private reporting channel without including vulnerability details. Do not post exploit steps, credentials, client data, private context or raw session logs in a public issue.

A useful private report includes the affected commit, environment, expected boundary, observed behavior and a minimal synthetic reproduction. Share only the information needed to reproduce the issue.

## Know the boundary

The pilot fence restricts CLI destinations to explicit disposable roots. It is not operating-system isolation and does not restrict other tools running as the same user.

Never put credentials in records, proposals, plans or command arguments. Private file modes are not encryption. Redaction checks and package allowlists are incomplete defenses, not permission to publish unchecked material.

Read the [security model](docs/SECURITY-MODEL.md), [limitations](docs/LIMITATIONS.md) and [storage contracts](docs/STORAGE.md) before evaluating the pilot. If a check fails, preserve evidence; do not bypass the gate or delete recovery journals blindly.
