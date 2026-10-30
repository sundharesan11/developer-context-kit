---
title: Setup wizard
description: Walk through devtwin's setup steps one at a time, in a terminal or through an agent, with the what, why and undo of each step before you apply it.
sidebar:
  label: Setup wizard
---

`devtwin setup` walks through every setup step in order. For each step it shows what the step changes, why, how to undo it and the preview of the command it runs. Then it asks. Only `y` or `yes` applies a step.

Each step wraps an existing command and its preview, so the wizard adds no new write. You can also run the steps one at a time, and an agent can run them through the bundled `devtwin-setup` skill.

## Approve the owner steps at once

The owner steps need your approval. A batch puts them behind one owner dialog. Run the apply in your own terminal:

```sh
node "$KIT/bin/devtwin.mjs" setup plan --pilot "$LIVE_CONFIG" --all-pending --backup-target "$HOME/devtwin-backups"
node "$KIT/bin/devtwin.mjs" setup apply --pilot "$LIVE_CONFIG" --all-pending --backup-target "$HOME/devtwin-backups" --apply --plan-fingerprint '<fingerprint>'
```

The dialog lists each change on its own line, in the order the changes run. On a first setup it looks like this:

```text
Approve 12 setup changes
1. Approve hook settings file ~/.claude/settings.json
2. Approve hook settings file ~/.codex/hooks.json
3. Approve backup folder ~/devtwin-backups
4. Approve launch agent ~/Library/LaunchAgents/devtwin.review-monthly.plist
5. Approve launch agent ~/Library/LaunchAgents/devtwin.backup-daily.plist
6. Install skills in ~/.claude/skills: devtwin-onboard, devtwin-resume, devtwin-record, devtwin-capture
7. Install skills in ~/.agents/skills: devtwin-onboard, devtwin-resume, devtwin-record, devtwin-capture
8. Install job review-monthly (monthly) at ~/Library/LaunchAgents/devtwin.review-monthly.plist
9. Install job backup-daily (daily) at ~/Library/LaunchAgents/devtwin.backup-daily.plist
10. Confirm kit ~/.devtwin/kit at <commit> and config ~/.devtwin/live.json
11. Add devtwin hook entries to ~/.claude/settings.json: SessionStart, UserPromptSubmit, PreToolUse, PreCompact, Stop
12. Add devtwin hook entries to ~/.codex/hooks.json: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PreCompact, Stop. Then trust them in Codex with /hooks
```

- `--all-pending` selects every owner step that is available, not done and not skipped. `--steps <id,id,...>` selects only the steps you name. Both take the step inputs, such as `--backup-target` and `--push-repo`.
- `setup plan` writes nothing. It shows each step's own preview and fingerprint, the dialog text, the steps it leaves out (`excluded`, with a reason) and the steps with nothing to do (`skipped`).
- Approve runs each step through its own apply with its own fingerprint. The step's own dialog does not show again. Deny changes nothing.
- The order is fixed. One live config change runs first. It adds every hook target, launch agent and backup folder that the steps need, and keeps every path you approved before. Then come the skills, the consents, the jobs and `paths-confirm`. The hooks run last.
- Before each step, the batch previews it again. A step that changed after your approval stops the batch with `DEVTWIN_STALE_VERSION`. The error lists the steps in `done` and `notRun`.
- A consent shows its full rules in the dialog. When they do not fit with the other lines, the consent leaves the batch and the plan says why. Nothing is cut.
- `hub-join`, `live set-kit`, `instructions apply` and `backup key export` keep their own dialog. Steps that need no approval, such as `profile`, are not in a batch.
- Each step that runs adds one audit entry with the batch ID. After the batch, devtwin rebuilds the lesson index and session summaries of every scope.

## Run the wizard

```sh
node "$KIT/bin/devtwin.mjs" setup --pilot "$LIVE_CONFIG" --scope example --project example.atlas --repo "$REPO"
```

The wizard needs a terminal. Without one it refuses with `DEVTWIN_GATE_REQUIRED` and points to the `devtwin-setup` skill. It takes the same flags as `setup plan`; each step reads only its own flags. It ends with a count of applied and failed steps.

## Run one step

```sh
node "$KIT/bin/devtwin.mjs" setup status --pilot "$LIVE_CONFIG"
node "$KIT/bin/devtwin.mjs" setup plan --pilot "$LIVE_CONFIG" --step hook-verify
node "$KIT/bin/devtwin.mjs" setup apply --pilot "$LIVE_CONFIG" --step hook-verify --plan-fingerprint '<fingerprint>'
```

- `setup status` lists the steps with `id`, `title`, `available`, `owner`, `what`, `why`, `undo` and `done`, plus `skipped` or `problem` when they apply, and the `next` step.
- `setup plan --step <id>` shows one step's preview and its fingerprint. It writes nothing.
- `setup apply --step <id> --plan-fingerprint <fp>` applies that preview.

## The steps

| Step | What it does | Owner |
| --- | --- | --- |
| `live-folder` | Checks that the live config exists and that `init` has run. Only reads. | |
| `skills-claude`, `skills-codex`, `skills-gemini` | Installs the bundled skills for that agent (`agents install`). Codex and Gemini CLI share one folder. A step for an agent that the live config leaves out is skipped. | Yes |
| `write-classes-hooks` | Approves the hook settings file of each agent in the live config (`~/.claude/settings.json`, `~/.codex/hooks.json`, `~/.gemini/settings.json`) as hook targets (`live write-classes --hook-target`). | Yes |
| `hooks-claude`, `hooks-codex`, `hooks-gemini` | Adds devtwin's hook entries for that agent (`agents install --hooks`). | Yes |
| `hook-verify` | Writes the kit receipt that the hook trusts (`hook verify`). | |
| `paths-confirm` | Records the kit and config paths, so the skills stop asking for them and the hook renews its receipt (`paths confirm`). | Yes |
| `profile` | Writes your personal profile (`profile plan` and `profile apply`). | |
| `starter-preferences` | Stores the starter preferences you select as personal preference records. | |
| `scope` | Adds the scope you name with `--scope` (`scope add`). | |
| `first-project` | Onboards one repository into the scope (`project onboard`). The live config must list it first. | |
| `hub-join` | Joins an [organization hub](/docs/guides/organization-hub/) (`hub join`). Skipped without `--hub-remote`. | Yes |
| `job-hub-sync` | Installs the hub sync job (`hub schedule`). Skipped when the scope has no hub. | Yes |
| `consent-hub` | Grants the `hub-publish` consent for the scope, so `lesson accept --target hub` holds a lesson with no dialog and sends it after the hold (`consent grant`). Skipped when the scope has no hub. | Yes |
| `consent-repo` | Grants the `repo-push` consent for the bound repository at `--push-repo` (`consent grant`). No command uses this consent yet. Skipped without `--push-repo`. | Yes |
| `backup-folder` | Approves the folder you name with `--backup-target` for backups (`live write-classes --backup-target`). Folders approved before stay. Skipped without `--backup-target`. | Yes |
| `job-backup` | Installs the daily backup job (`schedule apply --job backup-daily`). Skipped until a backup folder is approved. | Yes |
| `sandbox` | Recommends agent sandbox settings, and a container setup when the scan finds services. Writes no agent setting. | |

The starter output templates step is listed as "not available yet" and writes nothing. The scheduled radar, advisory and review reminder steps run `schedule apply` after the owner dialog. Each one is skipped, with the command to run, until its plist path is approved with `live write-classes --launch-agent`. The radar step also needs a stack approval, and the advisory step needs the radar job on.

### Starter preferences

`starter-preferences` offers four preferences: `tests-first`, `ask-destructive`, `small-changes` and `explain-why`. Pass `--starter <id>` for each one you want; with no `--starter`, all are selected.

### Sandbox recommendations

`sandbox` reads the project scan of `--repo`. It looks for compose files, container files and the package and env key names of common services. It never reads an env value. Apply stores the recommendations you accept (`--recommendation <id>`; with none, all) as personal preference records.

## Setup flags

| Flag | Used by |
| --- | --- |
| `--step <id>` | `setup plan` and `setup apply` for one step. |
| `--steps <id,id,...>`, `--all-pending` | `setup plan` and `setup apply` for a batch of owner steps. `--steps` is repeatable. |
| `--apply` | `setup apply` for a batch. Without it, the apply shows the preview. |
| `--backup-target <folder>` | `backup-folder`. Repeatable. |
| `--home <path>`, `--run-id <id>` | Skill and hook steps with a disposable pilot. |
| `--work`, `--preference`, `--stack-current`, `--stack-known`, `--writing`, `--seed-from-init`, `--proposed-by` | `profile`. Same values as [`profile plan`](/docs/reference/cli/#profile-plan). |
| `--starter <id>` | `starter-preferences`. Repeatable. |
| `--scope`, `--display-name` | `scope`, and the hub steps. |
| `--project`, `--repo`, `--doc`, `--expect-remote`, `--environment`, `--actor`, `--accept`, `--request-id`, `--keep-previous` | `first-project`. Same values as [`project onboard`](/docs/reference/cli/#project-onboard). `--repo` is also used by `sandbox`. |
| `--recommendation <id>` | `sandbox`. Repeatable. |
| `--hub-remote`, `--hub-handle`, `--hub-email`, `--ssh-command`, `--hub-root` | `hub-join`. |
| `--push-repo <path>` | `consent-repo`. |
| `--hold-hours <n>` | `consent-hub` and `consent-repo`. The hold time, from 1 to 168. Default 24. |

## Owner steps

The steps marked **Owner** run an owner action. The scheduled radar, advisory and review reminder steps are owner steps too. The devtwin hook denies `setup apply` for these steps from an agent shell. It also denies every batch apply (`--steps` or `--all-pending`) and the `devtwin setup` terminal loop. An agent that uses the `devtwin-setup` skill proposes the owner steps as one batch. It shows you the dialog lines and gives you the exact `setup apply` command to run in your own terminal.

A terminal prompt protects against accidents. It is not proof that you are at the keyboard.
