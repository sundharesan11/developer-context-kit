# Writing rules

devtwin's documentation follows STE-based writing rules. The rules come from ASD-STE100 Simplified Technical English, but devtwin uses only a small subset of them. There is no approved-word dictionary, so the docs are STE-based, not STE-compliant.

A check in CI enforces the subset. The same rules apply to lessons, digests, guides and reports that agents write through devtwin.

## The rules

| Rule | What it checks | Where |
| --- | --- | --- |
| `sentence-length` | At most 25 words in a sentence | Procedures |
| `sentence-length` | At most 30 words in a sentence | All other prose |
| `one-instruction` | No step joins two instructions with `and then` or `; then` | Procedures |
| `banned-word` | None of the words in the list below | All prose and table cells |
| `passive-voice` | No form of "to be" followed by a past participle | Procedures |
| `future-tense` | No `will`, `shall`, `won't` or `'ll` | Procedures |

A procedure is a numbered list item, with its continuation lines. Bulleted lists and paragraphs are other prose.

The banned words have a shorter or plainer form, or add nothing:

| Word | Write instead |
| --- | --- |
| `utilize` | use |
| `leverage` | use |
| `in order to` | to |
| `simply`, `easily`, `obviously` | omit the word |
| `just` | omit the word, or use "only" or "exactly" |
| `please note` | omit the phrase, or use a Note label |
| `etc.` | name each item, or use "such as" |

## What the check counts

- A word is a run of characters with at least one letter or digit. Inline code counts as one word, so a long command does not make a sentence too long.
- A sentence ends at `.`, `!` or `?` before a space or the end of the paragraph. The abbreviations `e.g.`, `i.e.`, `etc.`, `vs.`, `cf.`, `approx.` and `incl.` do not end a sentence.
- The passive-voice check is a heuristic. It ignores words that describe a state, such as `deprecated`, `supported`, `enabled` and `disabled`.

## What the check skips

The check skips YAML frontmatter, fenced code blocks, inline code, HTML comments, headings, horizontal rules, link definitions and link URLs. Link text is checked.

Table cells get only the banned-word check. Cells are short labels and values, not sentences, so the length and procedure rules do not apply to them.

## Scope

The check reads `README.md`, every Markdown file under `docs/` and every `SKILL.md` under `skills/`. It does not read `docs/plans/` or `docs/research/`, because those files are dated design history. It does not read the landing site.

## Run the check

From the repository root:

```sh
npm run check:writing
```

The command prints one JSON line, `{"ok": ..., "files": ..., "findings": [...]}`, and exits with a non-zero status when there is a finding. Each finding gives the `file`, `rule`, `line`, `message` and `excerpt`. CI runs the check after the package audit.

## Allowlist policy

Fix a finding by rewriting the sentence, and keep its meaning. Add an exception only when a rewrite makes the text less accurate, or when a test pins the exact sentence.

Exceptions go in `scripts/writing-allowlist.json`. Each entry has four fields:

- `file`: the path from the repository root.
- `rule`: the rule that the sentence breaks.
- `excerpt`: the exact excerpt from the finding.
- `reason`: why a rewrite is not correct. Every entry needs a reason that a reviewer can check.

An entry suppresses a finding only when all of `file`, `rule` and `excerpt` match. When an entry no longer matches a finding, the check reports it as `stale-allowlist`. Remove a stale entry, or update it in the same change that edits the sentence. Review every new entry the same way as a code change.

## Use the rules in a renderer

`src/writing/ste.mjs` has no dependencies and no side effects. Code that writes Markdown for a person can call it:

- `checkMarkdown(text)` returns the findings for the text, in line order.
- `passesWriting(text)` returns `true` when the text has no findings.
- `applyAllowlist(findings, entries)` returns the findings that remain and the stale entries.
- `RULES`, `LIMITS` and `BANNED` give the rule names, the length limits and the banned-word list.
