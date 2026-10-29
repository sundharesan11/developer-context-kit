# Agent instructions

devtwin is a zero-dependency Node.js CLI (Node 22.13 or later, ESM). It ships on npm as `devtwin`. Read [CONTRIBUTING.md](CONTRIBUTING.md) first; this file adds the rules agents most often miss.

## Docs follow code

A change to what users can run or see ships with its docs in the same commit. Use this table.

| You changed | Also update |
| --- | --- |
| A command, flag, output field or error code | `site/src/content/docs/docs/reference/cli.md` (and `errors.md` for error codes), plus the guide in `docs/` that uses it |
| Live mode, setup, hooks, jobs or the kit | `docs/LIVE.md`, `docs/UPGRADING.md` when upgrade or rollback changes, and `site/src/content/docs/docs/guides/live-mode.md` |
| Install, package contents or the release | `README.md`, `docs/GETTING-STARTED.md`, `docs/RELEASING.md`, `site/src/content/docs/docs/getting-started/installation.md` and the landing page install snippet (`site/src/site.ts`) |
| A bundled skill's behavior | `skills/<name>/SKILL.md`, and the matching template under `templates/skills/` when one exists |
| Security or trust boundaries | `docs/SECURITY-MODEL.md` and `site/src/content/docs/docs/security/` |
| Anything a user of the package would notice | A line under the next version in `CHANGELOG.md` |

`test/docs.test.mjs` checks that every CLI route appears in the site CLI reference and that docs and skills name only routes that exist. It cannot check prose, so read the guide you touched.

## Checks before a commit

- `npm test` runs the full suite (more than 10 minutes). Run it with `set -o pipefail`. For a quick loop, run the touched files with `node --test`, normally and under `env -i HOME="$HOME" PATH="$PATH"`.
- `npm run check:package` and `npm run check:writing`.
- A new test that must stay goes in `test/required-tests.json`. A new tracked file goes in `scripts/package-allowlist.json`, next to its siblings.
- Tests never use `skip`, `todo`, `only` or an empty callback.
- Edit a workflow, then run `actionlint`.

## Writing

Docs in `README.md`, `docs/` and `skills/` follow the STE-based rules in `scripts/check-writing.mjs`: short sentences, one instruction per sentence, no vague words. The landing page uses a product-launch tone with no status labels or caveats.

## Never

- Never write real client, repository or account names, absolute home paths or private email addresses into tracked files. Fixtures use `example` or `sample`. Split strings that look like credentials with concatenation.
- Never publish, tag, push or change npm or GitHub settings without the owner's approval for that action. Only the release workflow publishes to npm, and it never moves the `latest` dist-tag.
- Never run owner-only devtwin actions from an agent shell; the hook denies them. Ask the owner to run them.
