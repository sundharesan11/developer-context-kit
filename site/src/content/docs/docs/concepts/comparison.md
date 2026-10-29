---
title: How devtwin compares
description: Repository instruction files such as AGENTS.md and CLAUDE.md, the memory built into agent products, and devtwin, side by side, and how they fit together.
sidebar:
  label: Comparison
---

There are three common places to keep context for a coding agent. They solve different problems, and most people end up using more than one.

- **Repository instruction files**, such as `AGENTS.md` and `CLAUDE.md`, committed to the repository.
- **Built-in agent memory**: the memory features of an agent product, kept by that product, either in its hosted service or in its own local folders.
- **devtwin**: private, source-linked records kept on your disk, outside both the repository and any one agent.

## At a glance

| | Repository instruction files | Built-in agent memory | devtwin |
| --- | --- | --- | --- |
| **Where it lives** | In the repository, under version control | Wherever the product keeps it: its service or its own config folders | A private store on your disk, outside every repository and the kit |
| **Who can see it** | Everyone with access to the repository | You, within that product | You. Others only get a [handoff packet](/docs/concepts/handoffs/) you choose to send, or lessons you send to a hub or repository under your consent |
| **How it reaches a session** | The agent loads it automatically | The product loads it automatically | The hook adds a short summary at session start and lesson lines as the agent works; a skill fetches the full [brief](/docs/concepts/briefs/) |
| **How it is written** | Edited by hand and reviewed like code | Often captured automatically by the product | Agents and daily jobs write project knowledge, audited and undoable; anything global or outbound asks you |
| **Evidence and freshness** | None built in; it says what it says | Depends on the product | Every record can cite sources, and briefs flag records whose source files changed |
| **History** | Git history | Depends on the product | Records are immutable; replacing one keeps the old one on disk |
| **Across agents** | Only agents that read that file name | Tied to one product | Claude Code and Codex through the same CLI |
| **Separation between organizations** | One repository at a time | Depends on the product | Explicit [scopes](/docs/concepts/scopes-and-projects/), one per organization or client |
| **Best for** | Team conventions: how to build, test and contribute | Personal convenience inside one tool | Private, per-developer project knowledge you want to carry between sessions and agents |

"Depends on the product" is deliberate: agent products differ in what they store, where, and how you can review it. Check your agent's own documentation.

## Repository instruction files

`AGENTS.md`, `CLAUDE.md` and similar files are the right place for anything the whole team should follow: build and test commands, code style, review rules. They are versioned with the code and loaded automatically, which is hard to beat.

They are a poor fit for context that is private to you or to one client engagement, because everything in them is shared with everyone who can read the repository. They also have no built-in notion of where a statement came from or whether it is still true.

devtwin does not replace them. Onboarding reads `AGENTS.md` and `CLAUDE.md` when they exist and records that the repository's own instructions govern. When a stored record and a repository instruction disagree, the repository wins. devtwin never writes to these files.

## Built-in agent memory

Many agent products can remember things between sessions. That is convenient: there is nothing to set up, and the product decides what to keep.

The trade-offs follow from the same design. The memory belongs to one product, so switching agents means starting again. What gets remembered, and why, is up to the product rather than a step you review. And if you work for several organizations, keeping their context apart depends on how that product separates it.

devtwin works with it. A daily job reads Claude memory and promotes new items into scoped, source-linked project records. It never writes memory: memory captures, devtwin promotes. Agents also write project knowledge on their own. Every write is audited, counted in a weekly notification and reversible with `undo`. Anything that reaches every session or leaves the machine still asks you.

## devtwin

devtwin is built for one developer carrying private knowledge across sessions, agents and organizations:

- Context is private by default and lives outside the repository, so it can't be committed or pushed by accident.
- Records are immutable, cite their sources, and carry a freshness label in every brief.
- Scopes keep one client's context out of another client's brief.
- The same brief works for Claude Code and Codex.

What it does not do: it does not verify that a record is true, does not write agent memory, and does not sync your store between machines. The daily backup is an encrypted archive on your own disk. See [Limitations](/docs/security/limitations/).

## Using them together

A setup that works well:

1. Keep team conventions in `AGENTS.md` or `CLAUDE.md`, in the repository.
2. Keep your private decisions, open questions and handoff notes in devtwin.
3. Let Claude memory capture as you work. devtwin promotes it into project records each day.

At the start of a session, the agent reads the repository's instructions as usual, and the devtwin hook adds the project summary. Repository instructions and you still have the final say.
