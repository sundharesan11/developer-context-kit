---
title: FAQ
description: Short answers to the questions people ask first about devtwin, with links to the details.
---

## What is devtwin, in one sentence?

A local CLI that keeps private, source-linked project context (decisions, facts, open questions, handoff notes) outside your repositories and gives your coding agent a short brief of it at the start of each session.

## How is it different from `AGENTS.md`, `CLAUDE.md` or my agent's built-in memory?

Repository instruction files are shared with everyone who can read the repository. Built-in memory belongs to one agent product. devtwin is private to you, works across Claude Code and Codex, and keeps each organization's context in its own scope. They work well together. See [How devtwin compares](/docs/concepts/comparison/).

## Does it send my code or context anywhere?

No. devtwin has no hosted service, and most commands make no network request at all. The exceptions are commands and jobs you turn on yourself. `stack check`, `stack digest` and the radar jobs contact only the hosts you approved. `skill-sources check`, `preview` and `stage` read public GitHub data. If you join an [organization hub](/docs/guides/organization-hub/), `hub sync` and the hub sync job talk to your organization's own Git remote over SSH. See [Network use](/docs/security/security-model/#network-use).

Your agent is a different matter: whatever you paste into a session, including a brief, may go to that agent's model provider.

## Does it write to my repository?

Never. Onboarding reads a few files and stores what it learns in your private store. The onboarding preview shows `"repoWrites": []` to prove it.

## Which agents does it work with?

Claude Code and Codex, through the [bundled skills](/docs/guides/coding-agents/). You can also use it with any agent by running `devtwin context brief` and pasting the result.

## Do I need an API key, an account or a database?

No. You need Git and Node.js 22.13 or later. Everything else is files on your disk.

## Is it on npm?

Not yet. You run it from a Git checkout with `node bin/devtwin.mjs`, or a `devtwin` alias. The `devtwin` name on npm currently holds only a placeholder, so don't install it. See [Installation](/docs/getting-started/installation/).

## Does it run on Linux or Windows?

macOS is the reference platform. The test suite also runs on Linux, but Linux is not officially supported yet. Windows is not supported.

## Does it remember things automatically?

Partly. No record is written unless you, or an agent through a bundled skill, run a record or lesson command. An agent can save a lesson for the current project on its own, with no prompt. You review those writes afterwards with `activity` and the weekly notification, and reverse one with `undo`. A brief reaches a session only when you or a skill fetch it. With the [agent hook](/docs/guides/lessons-and-hooks/) installed, matching lesson lines arrive on their own while the agent works.

## Why does every command need `--pilot`?

The pilot file lists the only folders devtwin may write to and the repositories it may read. Requiring it on every call means the CLI never guesses where your data goes. For daily use, the live config at `~/.devtwin/live.json` plays the same role. See [Where your data lives](/docs/concepts/where-data-lives/).

## Why do some commands ask for a fingerprint?

The fingerprint identifies the exact plan you previewed. Applying with it means devtwin applies that plan and nothing newer: if a file or the store changed in between, the apply is refused and you preview again. See [How it works](/docs/concepts/how-it-works/#preview-first-then-apply).

## How do I change or delete a record?

You don't edit records in place. Write a successor with `record supersede`; the old record drops out of briefs and stays on disk as history. There is no delete command. See [Records](/docs/concepts/records/#records-are-immutable).

## Can my team share context?

Not through a shared store: devtwin keeps one private store per machine, with no sync. Your team can share **lessons** through an [organization hub](/docs/guides/organization-hub/), a Git repository your organization owns. To pass project context on, export selected records as a [handoff packet](/docs/concepts/handoffs/) that anyone can read without devtwin. Team conventions belong in the repository's own instruction files.

## Do my lessons leave my machine?

Only under a consent you gave. Proposals and `project` lessons stay on your machine. A lesson goes to a hub in two ways. First, `lesson accept --target hub` publishes it with no dialog, but only while you hold a `hub-publish` consent for that scope. You grant that consent once with `consent grant` and end it with `consent revoke`. Second, `lesson copy` in your own terminal shows the dialog with the exact text. "Working on" notes post under the consent you give at `hub join`, and you can stop them with `note revoke`.

## What do my colleagues see?

Your accepted hub lessons, labelled as claimed by your handle, and your "working on" notes: one line with your handle, the branch name and the folder areas you edit. Never your records, your prompts or your store. Their agents get a lesson only when they touch a matching file, package or topic. `published list` shows everything devtwin published in your name.

## Can an agent publish for me?

Only under a consent you gave. An agent can propose up to three lessons per session and accept them for the current project. It can publish one to the hub only while your `hub-publish` consent for that scope is valid; without it, the accept fails with "Needs consent". `consent grant`, `lesson copy`, `published delete` and `hub join` are owner actions. The devtwin hook denies them from an agent shell, and each one shows a macOS dialog that only you can approve. See [Tiers](/docs/security/security-model/#tiers).

## Is my data backed up?

Once you turn it on. In live mode, approve a backup folder and the `backup-daily` job writes an encrypted archive of the store there each day, and keeps the newest 14. The key stays in your macOS Keychain; export it once with `backup key export` so that you can restore on another machine. There is no sync. See [Backup and restore](/docs/guides/live-mode/#backup-and-restore).

## Can I store credentials in it?

No, and devtwin tries to stop you: titles and bodies that look like secrets are refused with `DEVTWIN_SENSITIVE_CONTENT`. The check is a tripwire, not a guarantee. Keep credentials in your password manager or keychain.

## Does it pick the right GitHub or Slack account for each organization?

That is identity routing. It is designed but not shipped yet; no `account` or `connect` command exists today. See [Identity routing](/docs/guides/identity-routing/).

## I used devtwin when it was called devctx. What do I do?

Move your live setup with `devtwin live migrate`, which copies your store and leaves the old one untouched. See [Migrate from devctx](/docs/guides/migrate-from-devctx/).

## What license is it under?

Apache-2.0. See [Contributing](/docs/project/contributing/) if you want to help.
