# Research: starter skills for stack-update monitoring and general writing

Research date: 2026-10-16. Public web sources only; no local code or files were sent to any web tool.
Labels: **[verified]** means the claim was read on the cited page (official docs where possible). **[secondary]** means it comes from a third-party summary or directory. **[unverified]** means it was not confirmed.

---

## Part A: Stack-update monitoring, entries

Columns used for each entry: what it tracks / data source / needs a repo? / auth / rate limits / privacy (does your stack leave the machine?) / strengths / gap.

### A1. endoflife.date (API v1): reuse as a data source
- **Tracks:** Lifecycle data per product and release cycle (`isEol`/`eolFrom`, `isLts`/`ltsFrom`, `latest` {name, date, link}, `isMaintained`, plus optional active-support, extended-support and discontinued phases). Endpoints include `/products`, `/products/{product}`, `/products/{product}/releases/latest`, `/categories`, `/tags`, and `/identifiers/{type}` (purl mapping). [verified] https://endoflife.date/docs/api/v1/openapi.yml
- **Coverage:** Runtimes, frameworks, databases and cloud services (Node, Python, Postgres, Kubernetes and others). The site cites roughly 418 products [secondary, snapshot] https://www.endoflife.date
- **Repo needed:** No. You query by product name, which fits a declared stack.
- **Auth / limits:** No auth in the spec. Clients over the limit get 429 with Retry-After, and conditional 304s are supported. No numeric limit is published. [verified] same OpenAPI URL
- **Caveats:** The API is in Beta and "breaking changes can happen". Data is MIT-licensed and maintained by the community. [verified] https://github.com/endoflife-date/endoflife.date
- **Privacy:** Per-product GET requests show the host which products you look up. Fetching `/products/full` once and filtering locally avoids that. [inference]
- **Gap:** It covers lifecycle and latest version only. It has no changelogs and no CVEs.

### A2. OSV.dev API: reuse as the vulnerability source
- **Tracks:** Vulnerabilities by package and version or by commit. Endpoints: `POST /v1/query`, `POST /v1/querybatch`, `GET /v1/vulns/{id}`. [verified] https://google.github.io/osv.dev/api/
- **Sources:** Aggregates the GitHub Advisory DB, PyPI advisories, the Go vuln DB, RustSec, OpenSSF Malicious Packages, Ubuntu, Debian, Alpine, NVD-converted CVEs and others. [verified] https://google.github.io/osv.dev/data/
- **Repo needed:** No. Queries take an ecosystem, a name and a version.
- **Auth / limits:** The docs say "currently no limits on the API" [verified] https://google.github.io/osv.dev/api/. Batch queries are reportedly capped at 1000 [secondary] https://docs.gradle.com/develocity/provenance-governor/1.8/app-config-external-apis/
- **Privacy:** Live queries reveal package and version to Google. For full privacy, download `gs://osv-vulnerabilities/<ECOSYSTEM>/all.zip` and use `modified_id.csv` for incremental updates. [verified] https://google.github.io/osv.dev/data/
- **Gap:** Package-level only, with no reachability. A declared stack often has no exact version ("Next.js" rather than "next@15.2.1"), so the skill needs the user to supply versions or it has to report ranges.

### A3. GitHub Advisory Database (REST global advisories / GraphQL)
- **Tracks:** Reviewed advisories, with malware advisories only when `type=malware` is passed. The `ecosystem` filter accepts rubygems, npm, pip, maven, nuget, composer, go, rust, erlang, actions, pub, swift and other. Results can be sorted by published or updated date or by EPSS. [secondary summary of official docs] https://docs.github.com/en/rest/security-advisories/global-advisories
- **Auth:** Works unauthenticated for public data. [secondary, same page]. Unauthenticated REST calls are limited to 60 requests/hour per IP; a token raises this to 5,000/hour. [verified] https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
- **GraphQL:** New filters (`severities`, `isWithdrawn`) were added in October 2026. [secondary] https://github.blog/changelog/2026-10-02-new-fields-for-securityadvisory-graphql-api
- **Note:** OSV already ingests GHSA, so querying both mostly duplicates data. Use GHSA directly only for its EPSS or severity fields.

### A4. GitHub Releases API / releases.atom feeds: reuse for changelogs
- **Tracks:** Release tags and release-note bodies per repo.
- **Limits:** The REST limits above apply, and conditional requests answered with 304 don't count against them. [secondary] https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api. Whether `github.com/{owner}/{repo}/releases.atom` falls under the REST quota or a separate web limit is **[unverified]**.
- **Gap:** Many projects keep notes in CHANGELOG.md or on a blog rather than in GitHub releases (Postgres, for example). The skill needs a per-product "where to read release notes" map.

### A5. deps.dev API (Google Open Source Insights)
- **Tracks:** Versions per package, including `isDeprecated` with a reason, and per-version licenses and advisories. Supports GO, RUBYGEMS, NPM, CARGO, MAVEN, PYPI and NUGET. [secondary summary of official docs] https://docs.deps.dev/api/v3/
- **Repo needed:** No. Auth: none documented for v3 **[unverified]**. Launch post: https://blog.deps.dev/api/
- **Use:** "Is my version deprecated, and what is the latest?" for library-level items. It overlaps with OSV and the registry APIs.

### A6. Package registry APIs (npm, PyPI, crates.io)
- **npm:** Public registry. The crawler policy asks for 1 request per second or less and reserves the right to ban by IP or user-agent. [secondary summary] https://docs.npmjs.com/policies/crawlers
- **PyPI / crates.io:** Official limits were not retrieved **[unverified]**. crates.io is known to require a descriptive User-Agent **[unverified, page did not render]** https://crates.io/data-access
- **Use:** The cheapest way to get "latest version and publish date" per library, plus the npm `deprecated` field. No auth is needed.

### A7. libraries.io API
- An `api_key` is required (free with an account). Limit is 60 requests/minute per key. Covers about 31+ platforms. [verified] https://libraries.io/api
- **Privacy:** Requires an account and sends the package list to a third party (Tidelift-backed). It adds little beyond the registry APIs and deps.dev.

### A8. NewReleases.io (and Sibbell-style notifiers)
- **Tracks:** GitHub, GitLab, Codeberg and other repos, plus registries including PyPI, npm, Maven, RubyGems, Packagist, NuGet and Cargo. Alerts go out within about 30 minutes, or as hourly, daily or weekly digests. Supports regex and pre-release filters. Delivers to email, Slack, Telegram, Discord, Teams and webhooks. [secondary/vendor] https://newreleases.io, https://newreleases.io/slack, https://freetier.co/directory/products/newreleasesio
- **Repo needed:** No. You subscribe to projects, which is the closest existing match to a declared stack.
- **Privacy:** Your stack lives in their account. Their API limits are reportedly very low (1 GET/hour) **[secondary, unverified]** https://jentic.com/apis/newreleasesio/newreleases
- **Gap:** Release notifications only, with no EOL, CVE or "does this affect me" step. Good model for digest cadence and filters.

### A9. Dependabot
- **Needs a repo:** Yes. Version updates run on repositories that contain a supported manifest or lockfile, configured in `dependabot.yml`. [verified via docs summary] https://docs.github.com/enterprise-server@3.15/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories
- **Privacy:** GitHub-hosted, so the dependency graph lives with GitHub.
- **Noise:** GitHub added auto-dismiss rules because of alert fatigue, starting with npm devDependencies (about 15% fewer alerts). [verified via summary] https://github.blog/security/supply-chain-security/dependabot-relieves-alert-fatigue-from-npm-devdependencies. In February 2026, Filippo Valsorda called it a "noise machine" that should be turned off. It opened PRs in thousands of unaffected repos and showed a made-up CVSS v4 score; he recommends reachability tools such as `govulncheck`. [verified] https://www.devclass.com/security/2026/02/26/github-dependabot-is-a-noise-machine-and-should-be-turned-off-says-go-library-maintainer/4091858
- **Research:** A study found Dependabot reduces technical lag, but developers distrust bot updates and are tired of the notifications. [secondary] https://arxiv.org/abs/2206.07230v2
- **Verdict:** Right for repos. Wrong shape for a declared stack.

### A10. Renovate
- **Needs a repo:** Mostly. `renovate --platform=local` dry-runs against the current directory, works on plain non-git directories, defaults to `dryRun=lookup`, and doesn't resolve `local>` presets. [secondary summary of official docs] https://docs.renovatebot.com/modules/platform/local. A no-git example: https://git.hamburg.ccc.de/ViMaSter/selfhosting-renovate-demo/src/branch/main/2-dockerfile-dry-run
- **Changelog fetching:** Pulls changelogs from GitHub, GitLab and Bitbucket. Self-hosted runs need a github.com token, or release notes are skipped. [secondary] https://git.cqre.net/cqrenet/mxids/pulls/100
- **Merge Confidence:** Badges for Age, Adoption, Passing and Confidence, built from Mend Renovate App adoption and test data. The algorithm is private. Self-hosters can enable it via `mergeConfidence:all-badges`. The docs don't say what data a self-hosted instance sends to Mend. [verified] https://docs.renovatebot.com/merge-confidence/
- **Noise controls:** Grouping, schedules (hourly granularity at most), automerge and the dependency dashboard. [verified via summary] https://docs.renovatebot.com/noise-reduction/. A user complaint about PR spam: https://forgejo.ellis.link/continuwuation/continuwuity/issues/1517
- **Idea worth borrowing:** Age as a signal: don't recommend a release until it is N days old.

### A11. Snyk
- `snyk monitor` uploads a dependency snapshot to Snyk for continuous scanning. The free plan has a monthly test cap. [secondary summary of docs] https://docs.snyk.io/snyk-cli/getting-started-with-the-snyk-cli
- **Privacy:** Sends the dependency manifest to a third party, and an account is required. Needs a manifest, not a declared stack.

### A12. Socket.dev
- Behavioral supply-chain analysis: network, filesystem, shell and env access, typosquatting, compromised maintainers. Package scores. The CLI and API need `SOCKET_CLI_API_TOKEN`. [secondary] https://badge.socket.dev/features/cli, https://appsecsanta.com/socket
- **Privacy:** Package names go to Socket. Free-tier details are inconsistent across sources. **[unverified]**
- **Use:** An optional "is this new release malicious?" check. Overkill for a digest. OSV already includes the OpenSSF Malicious Packages feed.

### A13. Agent-driven scheduling options
| Option | Runs where | Local files | Approval model | Min interval | Source |
|---|---|---|---|---|---|
| Claude Code **Routines** (cloud) | Anthropic cloud (or self-hosted env) | No (fresh clone of GitHub repos) | Runs autonomously, no permission picker; connectors can write without asking | 1 hour | [verified] https://code.claude.com/docs/en/routines |
| Claude Code **Desktop scheduled tasks** | Your machine; app open and awake | Yes | Per-task permission mode; Manual mode stalls until you approve | 1 min | [verified] https://code.claude.com/docs/en/desktop-scheduled-tasks |
| `/loop` | Open CLI session | Yes | Inherits session | 1 min | [verified] same page |
| cron + `claude -p` | Your machine | Yes | `--allowedTools`, `--permission-mode dontAsk`, `--permission-prompts none`; `--bare` for reproducibility; `--json-schema` for structured output | cron | [verified] https://code.claude.com/docs/en/headless |
| cron + `codex exec` | Your machine | Yes | `--sandbox read-only` and similar; final message on stdout, JSONL option | cron | [verified partly] https://developers.openai.com/codex/noninteractive.md; sandbox modes [secondary] https://www.mintlify.com/openai/codex/architecture/sandboxing |
| Codex app **Automations** | Local app (works best while the laptop is awake) or cloud | Local: yes | Results come back for review | cron | [secondary] https://openai.com/academy/codex-automations (403 on fetch), https://codex.danielvaughan.com/2026/03/27/codex-cli-automations-scheduled-tasks/ |
| GitHub **Agentic Workflows** (gh-aw) | GitHub Actions container | Repo only | Read-only by default; writes only via declared "safe outputs" with per-op caps | Actions cron | [verified via summary] https://github.github.com/gh-aw/reference/safe-outputs/; research demonstrator https://pkg.go.dev/github.com/githubnext/gh-aw |
| Cursor **cloud agents + Automations** | Cursor VM | No | Triggers from schedules or Slack, Linear, GitHub, PagerDuty and webhooks; has memory across runs | ? | [secondary] https://cursor.com/changelog/03-05-26, https://cursor.com/help/ai-features/background-agents.md |

Notes:
- Desktop catch-up behavior: after the machine sleeps, only one catch-up run happens, for the most recent missed time. The docs advise building time guardrails into the prompt. [verified] https://code.claude.com/docs/en/desktop-scheduled-tasks
- A green routine status only means the session exited without an infrastructure error, not that the task succeeded. [verified] https://code.claude.com/docs/en/routines
- `claude -p` without `--bare` runs project hooks and `.mcp.json` servers, even in untrusted folders. [verified] https://code.claude.com/docs/en/headless

### A14. Public "radar / digest" agent projects
- **agents-radar** (duanyytop): a GitHub Actions workflow that reads GitHub releases for 17 repos plus sites, and produces daily, weekly and monthly digests over a web UI and RSS. [secondary] https://gittrend.io/repo/duanyytop/agents-radar
- **Weekly AI news digest on gh-aw:** the agent researches and curates, then opens a PR that a human approves. [secondary] https://elbruno.com/2026/07/10/i-built-a-weekly-ai-news-digest-with-github-agentic-workflows-here-is-how-it-works/
- **Change8 MCP:** a vendor tool that supplies structured breaking-change data to LLMs. [vendor] https://mcpservers.org/en/servers/scotty-cam/change8
- No mature open-source "declared stack watch" skill turned up. **[search-limited]**

## Part A: takeaways

1. **Reuse the data, build only the thin layer.** Deterministic fetchers: endoflife.date for runtimes, DBs and cloud lifecycle; OSV (bulk zip for privacy, or querybatch) for CVEs and malware; registry APIs or deps.dev for latest version and deprecation; GitHub releases (or a per-product notes URL) for changelogs. The LLM only classifies and summarizes the fetched text. It never decides from memory what changed.
2. **The declared stack is the main difference.** Dependabot, Renovate and Snyk all assume a manifest. Ask for a `stack.yaml` with product ids (endoflife slug, purl, GitHub repo, notes URL), the current version or major, and a "pinned / care level" setting. Optionally import it from a repo manifest, previewed and approved first.
3. **Privacy tiers.** (a) Offline: OSV bulk zip plus endoflife `/products/full`, then filter locally, so nothing reveals the stack. (b) Per-item GETs to public, unauthenticated APIs (low leak). (c) Third-party accounts (NewReleases, Snyk, Socket, libraries.io) store your stack, so keep them opt-in only. No tokens are needed for MVP. A GitHub token is optional to raise the 60/hour limit; keep it in the OS keychain or env, never in records.
4. **Scheduling.** Use local cron, Desktop tasks or `codex exec`/`claude -p` with read-only tools. Cloud routines lose local files and run autonomously with connector writes allowed, so they fit poorly with an "every write approved" harness. The run should write only a local report file, or a draft that waits for approval.
5. **Anti-noise by design.** Weekly digest by default. Group by severity (EOL within 90 days, CVE affecting your version, major release, minor or patch hidden by default). Use a Renovate-style age gate. Remember what has already been reported (a state file of seen release ids). Escalate immediately only for a CVE affecting the declared version or for imminent EOL.
6. **LLM reliability.** Require every "breaking change" claim to quote the source line and URL. Mark items "unverified" when no source text was fetched. Never infer breaking changes from version numbers alone. Evidence that this is a real failure mode: hallucinated changelog entries are described here https://dev.to/nazar-boyko/ai-agents-for-release-notes-and-changelog-automation-kia, and a user report of a model claiming a field changed without checking the diff is here https://claudeissues.com/issue/34731-bug-fix-your-fucking-llm-to-actually-do-the-work-people-ask-it-to-do. No systematic measurement of LLM changelog-summary error rates was found **[gap]**. Related research shows LLMs fully fix only about 27% of builds broken by dependency updates https://arxiv.org/html/2505.07522v1, which supports "report, don't auto-upgrade".

---

## Part B: General writing skill, entries

### B1. Anthropic `internal-comms` skill
- Description: "help me write all kinds of internal communications, using the formats that my company likes to use… (status reports, leadership updates, 3P updates, company newsletters, FAQs, incident reports, project updates…)". The structure is a short SKILL.md plus `examples/` with one guideline file per type (3p-updates, company-newsletter, faq-answers, general-comms). Flow: identify the type, load its guideline, follow it. If no type matches, ask for clarification instead of guessing. [verified] https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md
- **Takeaway:** Per-type format files are the right shape (email, status update, PR description, announcement, incident note).

### B2. Anthropic `doc-coauthoring` skill
- Three stages. **Context gathering** (5–10 numbered clarifying questions based on real gaps; ask before searching connected tools). **Refinement** section by section. **Reader testing** by a fresh, context-free Claude that predicts reader questions and flags false assumptions. Also: a final user check of facts and links, and an anti-"slop" check that every sentence carries weight. [verified] https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md
- **Takeaway:** A lightweight "reader test" (could someone without your context act on this?) is a cheap quality gate.

### B3. Anthropic `brand-guidelines` skill
- Anthropic-specific colors and fonts. Useful only as the pattern of a separate brand or style profile file. [verified] https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md

### B4. Other open skills
- **email-drafter** (github/awesome-copilot): learns tone, greeting, structure and sign-off from sent mail and prior correspondence with the recipient (via WorkIQ). Falls back to professional defaults and notes that the tone was inferred. [secondary] https://mcpservers.org/agent-skills/github/email-drafter
- **humanizer** (blader): applies Wikipedia's "Signs of AI writing" patterns as an editing pass. Reviews warn that meaning can drift and the output must be compared with the source. [secondary] https://github.com/c-b-g-m/blader-humanizer, https://agentpedia.codes/blog/humanizer-claude-code-skill-guide
- **"Email Like Me"**: a personal voice skill template that tells others to build their own from their own sent mail, with permission. [secondary] https://claudskills.com/skills/email-like-me/
- **teach-your-voice**: interviews the user about style, optionally analyzes samples, and saves a profile. [secondary] https://sharedcontext.ai/skills/external/EAIconsulting/teach-your-voice

### B5. Commercial "write in my voice" features
- **Superhuman:** analyzes a sample of recent sent emails for tone, and adapts to past tone with each recipient. Settings for style, tone, length and role are on Business/Enterprise plans. [verified via help center summary] https://help.superhuman.com/article/549-write-with-ai. Auto Drafts write replies unprompted [secondary] https://fast.io/resources/superhuman-ai-review-2026/
- **Grammarly:** a continuously updated voice profile with separate profiles for documents and messages. Users can edit their role and dialect and remove style elements. [verified via summary] https://support.grammarly.com/hc/en-us/articles/23153676821773-Introducing-voice-features. TechCrunch raised impersonation and phishing misuse risks https://techcrunch.com/2023/10/25/grammarlys-new-generative-ai-feature-learns-your-style-and-applies-it-to-any-text
- **Gmail "Help me write":** pulls details from other emails and Drive files, matches tone, and shows a **Sources** button listing the emails and files used. [secondary summary of Google help] https://support.google.com/mail/answer/13955415, https://chromeunboxed.com/google-adds-drive-context-and-tone-matching-to-help-me-write-in-gmail/
- **Lex:** "style guides" built from dropped-in writing samples, knowledge bases for context, and line-level checks for clichés and wordiness. [secondary/vendor] https://buttondown.com/lex/archive/lex-v2-knowledge-bases-style-guides/, https://aigoestocollege.substack.com/p/quick-review-of-lexpage

### B6. DIY voice-profile practice
- Typical guidance: 3–10 samples (or 10–15 sent emails). Use separate profiles for email and long-form writing. Ask the model to describe your style back to you for checking. Keep a banned-phrase list (for example "please don't hesitate to reach out"). Prefer samples written before AI tools. [secondary] https://ai-retreat.umd.edu/email-style-exercise.html, https://www.promptoptimizer.tools/prompts/humanize-ai-text/rewrite-in-your-own-voice

## Part B: takeaways

1. **Minimal profile fields** (enough to beat generic output without a heavy voice model):
   - `name`, `role/title`, `org` (optional)
   - `default_tone` (for example direct, warm, formal) and `formality_by_audience` (team / leadership / customer / public)
   - `greeting` and `sign_off` (exact strings)
   - `length_preference` (short by default)
   - `formatting` (bullets ok? headers in email? emoji: never)
   - `banned_phrases` (anti-AI tells) and `preferred_terms`
   - `dialect` (US/UK spelling)
   - Optional `style_samples` (2–5 short, user-chosen, redacted) and a generated `style_summary` the user approves
   - Per-type templates (email, status/3P update, PR description, announcement, incident note), following the internal-comms pattern
   This mirrors what Superhuman and Grammarly expose (role, tone, length, dialect, editable style elements), as cited in B5.
2. **Guardrails:**
   - **Draft-only. Never send or post.** Output goes to a local file or the clipboard. Sending is a separate action the user approves.
   - **Cite the context used:** list the sources (files, notes, commits) the draft drew on, like Gmail's "Sources" button.
   - **Mark unverified facts:** wrap any name, date, number, commitment or claim not found in the supplied context as `[VERIFY: …]`. Never invent commitments ("I've forwarded this to engineering") that the user didn't state; see the Robylon guide https://www.robylon.ai/blog/prevent-ai-hallucinations-customer-email
   - **Ask instead of guess** when audience, purpose or type is unclear (internal-comms and doc-coauthoring both do this).
   - **Minimal context:** include only what the draft needs; strip secrets and tokens; warn before putting third-party personal data into a prompt. Provider data policies vary; for example, Anthropic's consumer plans keep data 5 years if the user opts into training, 30 days otherwise, and commercial and API terms are excluded https://www.anthropic.com/news/updates-to-our-consumer-terms
   - **Relationship-sensitive messages** (praise, condolence, feedback): suggest the user writes these, or keep AI help light. Evidence below.
   - **Optional reader test:** "could the recipient act on this without extra context?"
   - **Voice profile is user-owned and editable.** It holds no recipient personal data by default. Samples are stored locally and redacted.

---

## Public complaints and evidence

**Update noise / alert fatigue**
- Dependabot called a "noise machine": PRs in thousands of unaffected repos, a made-up CVSS score, alert fatigue that reduces security. https://www.devclass.com/security/2026/02/26/github-dependabot-is-a-noise-machine-and-should-be-turned-off-says-go-library-maintainer/4091858
- GitHub itself built auto-dismiss rules to reduce alert fatigue. https://github.blog/security/supply-chain-security/dependabot-relieves-alert-fatigue-from-npm-devdependencies
- Academic study: developers are suspicious of and tired from bot notifications. https://arxiv.org/abs/2206.07230v2
- Renovate users report PR spam and lint breakage from frequent commits. https://forgejo.ellis.link/continuwuation/continuwuity/issues/1517. Renovate keeps a dedicated noise-reduction guide. https://docs.renovatebot.com/noise-reduction/

**LLM-summarized changelogs**
- Hallucinated entries described as "hallucination wearing a changelog costume" (vendor-adjacent blog). https://dev.to/nazar-boyko/ai-agents-for-release-notes-and-changelog-automation-kia
- A user bug report of a model asserting changes without checking the diff. https://claudeissues.com/issue/34731-bug-fix-your-fucking-llm-to-actually-do-the-work-people-ask-it-to-do
- No large-scale evaluation was found **[gap]**. Treat frequency as unverified, but the mitigation (quote the source line) is cheap.

**AI-written email and work content**
- University of Florida study (n > 1,000): managers who used heavy AI assistance were rated sincere by 40–52% of employees, versus 83% for low assistance. Messages were still seen as professional. The largest drop was for congratulatory or motivational notes. https://news.ufl.edu/2025/08/writing-ai-work/, https://www.psypost.org/managers-who-use-ai-to-write-emails-seen-as-less-sincere-caring-and-confident/
- "Workslop" (HBR, Stanford Social Media Lab and BetterUp, September 2025): 40% of 1,150 desk workers received some in the last month, and recipients see senders as less capable and less trustworthy. https://www.axios.com/2025/09/24/ai-workslop-workplace-efficiency-study (primary: hbr.org/2025/09/ai-generated-workslop-is-destroying-productivity, not opened)
- Generic tone: stock openers, over-formality, emoji and hype. https://gmelius.com/blog/can-customers-tell-an-email-is-written-using-generative-ai. Reader complaints: https://mkbaio.substack.com/p/please-stop-sending-me-emails-written/comments
- Hallucinated facts: a Bard-in-Gmail test invented whole email threads (2023). https://aipressroom.beehiiv.com/p/googles-new-gmail-tool-is-hallucinating-emails-that-dont-exist. An AI sales email congratulated a prospect on an APAC expansion right after they had closed their Singapore office. https://dev.to/ashutosh-veriprajna/your-ai-sales-rep-is-lying-to-your-customers-and-youre-paying-it-to-do-so-235p
- Privacy backlash over Anthropic's 2025 consumer-terms change (training opt-in with 5-year retention). https://www.gigazine.net/gsc_news/en/20250901-anthropic-claude-updates-consumer-terms-privacy-policy. Official post: https://www.anthropic.com/news/updates-to-our-consumer-terms
- Voice-cloning misuse concern (impersonation and phishing). https://techcrunch.com/2023/10/25/grammarlys-new-generative-ai-feature-learns-your-style-and-applies-it-to-any-text
