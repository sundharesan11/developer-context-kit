---
title: Setup wizard
description: Walk through devtwin's setup steps one at a time, in a terminal or through an agent, with the what, why and undo of each step before you apply it.
sidebar:
  label: Setup wizard
---

`devtwin setup` walks through every setup step in order. For each step it shows what the step changes, why, how to undo it and the preview of the command it runs. Then it asks. Only `y` or `yes` applies a step.

Each step wraps an existing command and its preview, so the wizard adds no new write. You can also run the steps one at a time, and an agent can run them through the bundled `devtwin-setup` skill.

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
| `skills-claude`, `skills-codex` | Installs the bundled skills for that agent (`agents install`). | Yes |
| `write-classes-hooks` | Approves `~/.claude/settings.json` and `~/.codex/hooks.json` as hook targets (`live write-classes --hook-target`). | Yes |
| `hooks-claude`, `hooks-codex` | Adds devtwin's hook entries for that agent (`agents install --hooks`). | Yes |
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
| `sandbox` | Recommends agent sandbox settings, and a container setup when the scan finds services. Writes no agent setting. | |

The starter output templates step is listed as "not available yet" and writes nothing. The scheduled radar, advisory and review reminder steps run `schedule apply` after the owner dialog. Each one is skipped, with the command to run, until its plist path is approved with `live write-classes --launch-agent`. The radar step also needs a stack approval, and the advisory step needs the radar job on.

### Starter preferences

`starter-preferences` offers four preferences: `tests-first`, `ask-destructive`, `small-changes` and `explain-why`. Pass `--starter <id>` for each one you want; with no `--starter`, all are selected.

### Sandbox recommendations

`sandbox` reads the project scan of `--repo`. It looks for compose files, container files and the package and env key names of common services. It never reads an env value. Apply stores the recommendations you accept (`--recommendation <id>`; with none, all) as personal preference records.

## Setup flags

| Flag | Used by |
| --- | --- |
| `--step <id>` | `setup plan` and `setup apply`. Required there. |
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

The steps marked **Owner** run an owner action. The scheduled radar, advisory and review reminder steps are owner steps too. The devtwin hook denies `setup apply` for these steps from an agent shell, and denies the `devtwin setup` terminal loop. An agent that uses the `devtwin-setup` skill shows you the plan and gives you the exact `setup apply` command to run in your own terminal.

A terminal prompt protects against accidents. It is not proof that you are at the keyboard.
