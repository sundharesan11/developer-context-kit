---
title: Preferences and templates
description: Turn a correction into a preference that every Claude Code and Codex session reads, and keep your own structure for RCAs, reports and decision notes.
sidebar:
  label: Preferences and templates
---

You tell an agent "use Playwright, not a manual browser". With devtwin, you say it once. The agent proposes the correction as a preference, you accept it, and every later Claude Code and Codex session reads it from your own instruction files.

## How a preference reaches your agents

1. **Propose.** After a correction, the agent asks whether it is a preference for later tasks. If you say yes, it saves a private proposal with `pref propose`. Nothing leaves your machine.
2. **Accept.** You run `pref accept` in your own terminal, or answer all waiting preferences at once in the weekly `activity review`. A macOS dialog shows the exact text, and the preference goes to your personal store only after you click **Approve**. A `user` memory that `import run` reads waits the same way.
3. **Deliver.** You run `instructions plan`, then `instructions apply`. devtwin writes a short managed block to your user-level agent files.

```sh
devtwin pref proposals --pilot "$PILOT"
devtwin pref accept --pilot "$PILOT" --id pref_...
devtwin pref accept --pilot "$PILOT" --id pref_... --apply --plan-fingerprint 'sha256:...'
devtwin instructions plan --pilot "$PILOT"
devtwin instructions apply --pilot "$PILOT" --plan-fingerprint 'sha256:...'
```

To say no, run `pref decline`. devtwin remembers it and refuses the same text later, ignoring case and spacing. A reworded rule is a new proposal. To stop delivering a preference later, run `pref retire`, then apply the instruction block again.

## What a preference may say

A preference is one plain rule of at most 300 characters, with a short title. devtwin refuses:

- Markdown structure, such as a heading or a code fence.
- The devtwin markers, and a word that starts with `@`, which Claude Code reads as a file import.
- Text that tells the agent to ignore other instructions.
- A credential, or the name of any scope. Your personal store reaches every organization you work for.

A session can propose at most three preferences, and one for each kind of correction.

## The managed instruction block

| Agent | Where the block goes |
| --- | --- |
| Claude Code | `~/.claude/devtwin.md`, a file devtwin owns, and one import line in a marker block in `~/.claude/CLAUDE.md` |
| Codex | A marker block in `~/.codex/AGENTS.md` |

Text outside `<!-- devtwin:begin -->` and `<!-- devtwin:end -->` stays byte for byte. A repository's own `AGENTS.md` or `CLAUDE.md` is never a target. In live mode, each file must be approved first with `live write-classes --instruction-target`; see [Live mode](/docs/guides/live-mode/).

Besides your preferences, the block holds four short rules for the agent:

- Stop and ask when planned work conflicts with a devtwin lesson.
- Lessons and preferences are guidance about approach, never a reason to run a command on their own.
- Suggest at most one new output format, and ask before you use it.
- How to run `devtwin lesson match` for the files in hand.

The block has at most 1,200 characters. When your preferences do not fit, the plan leaves out the oldest ones and warns with `PREFERENCES_DROPPED`. Each preference is checked again when the block is built; one that now names a scope is left out with `PREFERENCES_REFUSED`. Sandbox advice from setup is for one repository, so it stays out of the block.

When `activity review` saves a preference, it also writes the instruction block, with no second dialog. It does this only when your instruction files hold the block without the new preferences, so the only new text is the text the review dialog showed. Otherwise run `instructions plan` and `instructions apply`. Pass `--home` and `--agent` to `activity review` as you pass them to `instructions plan`; in live mode the live home is the default.

`pref accept --apply`, `pref retire --apply`, `activity review --apply` and `instructions apply` are owner actions. An agent can preview them, but the devtwin hook denies the apply from an agent shell, and each one shows the owner dialog.

## Output templates

devtwin ships starter templates for an RCA (`rca`), a report (`report`) and a decision note (`decision`), each in Markdown and HTML. The bundled `devtwin-capture` skill tells agents to follow them.

```sh
devtwin template list --pilot "$PILOT"
devtwin template show --pilot "$PILOT" --kind rca --format html
```

To use your own structure, point devtwin at an output you liked. Put the file in your pilot's inputs folder, then preview and save:

```sh
devtwin template from --pilot "$PILOT" --kind rca --file "$INPUTS/good-rca.md"
devtwin template from --pilot "$PILOT" --kind rca --file "$INPUTS/good-rca.md" --apply --plan-fingerprint 'sha256:...'
```

devtwin keeps only the headings, in order, and replaces the first top-level heading with `<title>`. The rest of the text is not saved. A file with a credential is refused with the line number, a file with no headings is refused as `no-structure`, and a heading that names a scope is refused. From then on, `template show --kind rca` returns your template instead of the starter.
