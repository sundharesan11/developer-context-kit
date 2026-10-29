# Getting started

Start with the offline demo. It exercises devtwin on synthetic data without changing your real agent installation.

You do not need Claude, Codex, Orca, a company hub, an API key or a database server for this demo.

## 1. Install devtwin

Check the prerequisites:

```sh
node --version
npm --version
```

The manifest declares Node `>=22.13.0`. The reference environment is macOS with Node v26.4.0. [CI](CI.md) runs on macOS and Ubuntu with Node 26.4.0 and 22.13.0. Those are evaluation lanes, not a support claim. Support for the Node floor and for Linux is not claimed. Windows is unsupported.

Install the alpha release from npm:

```sh
npm i -g devtwin@alpha
devtwin --version
```

Always name the `alpha` dist-tag. Until `latest` moves, `npm i -g devtwin` installs a deprecated placeholder. devtwin has no third-party runtime dependencies.

Create the private folder for live mode now, if you plan to use it. devtwin never creates it:

```sh
mkdir -m 700 ~/.devtwin
```

The demo does not need this folder. `devtwin kit install` and live mode do; see [Live activation](LIVE.md).

## 2. Run the disposable demo

```sh
devtwin demo
```

The demo makes a fresh private temporary folder for the pilot and the report. To choose them, pass `--pilot-root <path>` and `--report <path>`. Neither path may exist yet.

The demo creates two synthetic Git repositories, isolated configuration, data and state roots, and fake agent homes. It runs local checks for onboarding, scope isolation, record history, handoffs, installation conflicts and fake identity checks. It also checks the personal profile, the announcement watch against offline fixtures, and skill-template render and verify. It does not send network requests or execute acquired skills.

Expected result: `"ok": true`. Most checks show `passed`. The checks that need a Git clone of the kit show `skipped`: the package audit, `npm-install` and the live-mode checks. `fresh-agent-smoke` and `real-agent-scenarios` show `deferred`. A deferred or skipped check is not a pass. The demo deliberately leaves failure fixtures, modified sources and a lock case for testing. Do not use this fixture tree as your normal workspace.

The report is private. Do not paste its paths or contents into a public issue without reviewing them.

### From a Git clone

Contributors run devtwin from a clone. A clone also runs the checks that the package skips. You need Git too:

```sh
git clone https://github.com/sundharesan11/devtwin.git
cd devtwin
node bin/devtwin.mjs help
```

Run these commands in the same shell, from the repository root:

```sh
DEMO_PARENT="$(mktemp -d /tmp/devtwin-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

The pilot path and report file must not already exist. The canonical path from `pwd -P` avoids the macOS `/tmp` symlink.

Expected result: `ok: true`, 33 checks marked `passed`, and `fresh-agent-smoke` and `real-agent-scenarios` marked `deferred`. The `npm-install` check packs the kit, installs the tarball offline into a temporary folder and runs `devtwin demo` from that install. It needs `npm` on `PATH`.

## 3. Understand the workflow

Follow [Guided onboarding](ONBOARDING.md) to create a separate, minimal synthetic project and perform each step yourself:

1. Define a disposable pilot and scope.
2. Preview onboarding.
3. Inspect the candidates and approve the exact fingerprint.
4. Resolve the project and read its brief.
5. Record a decision and inspect the new brief.

No files are added to the project by onboarding. Private context is stored outside the project, under the pilot's data root.

## 4. Evaluate, then stop at the boundary

You can inspect briefs, exercise the [skill builder](SKILL-BUILDER.md) and review a [private handoff export](HANDOFF.md). Do not point a disposable pilot at a real client checkout or edit the guards to reach your normal agent homes. Real use goes through a live config instead; see [Live activation](LIVE.md).

Live mode is implemented, and [Live activation](LIVE.md) is its runbook. [Upgrading](UPGRADING.md) moves live mode to a new release and back. Its first activation on one real machine passed on 2026-10-25, including fresh non-interactive Claude and Codex discovery; interactive sessions remain. Daily encrypted backups with restore, and the session hooks, are implemented. Selective migration from an existing personal setup remains [roadmap work](ROADMAP.md). A live setup made under the old devctx name moves with [Migrating from devctx](MIGRATING.md). A globally installed skill from another setup is not evidence that it uses this kit.

The kit does not delete demo directories. Temporary directories can disappear after a reboot or system cleanup. Keep only synthetic data in them. Inspect the exact directory before manually disposing of it.

## 5. Set up devtwin for real use

After the live config exists and `init` has run ([Live activation](LIVE.md), steps 1 to 8), setup takes you through the rest. You can start it in two ways, and both show the same steps and the same consent screens:

- Ask an agent to set you up. The agent uses the `devtwin-setup` skill.
- Run the terminal loop yourself, in your own terminal:

```sh
devtwin setup --pilot ~/.devtwin/live.json
```

From a Git clone, run `node bin/devtwin.mjs` in place of `devtwin`. The global `devtwin` command runs live commands in the kit that your live config pins; see [How the global command forwards](LIVE.md#how-the-global-command-forwards).

For each step, setup shows what the step changes, why, how to undo it and the preview of the command that the step runs. Then it asks. Only `y` applies the step. A step that is done shows `done` and is not asked again. Without a terminal, the loop refuses and points to the skill.

The same steps are available one at a time:

```sh
devtwin setup status --pilot ~/.devtwin/live.json
devtwin setup plan --pilot ~/.devtwin/live.json --step profile --work 'Backend services'
devtwin setup apply --pilot ~/.devtwin/live.json --step profile --work 'Backend services' --plan-fingerprint '<fingerprint>'
```

Give `setup apply` the same flags as the plan that you approved, and that plan's fingerprint.

| Step | What it does |
| --- | --- |
| `live-folder` | Checks the live config and `init`. It only reads. |
| `skills-claude`, `skills-codex` | Installs the bundled skills (`agents install`). |
| `write-classes-hooks` | Approves the two hook settings files (`live write-classes`). |
| `hooks-claude`, `hooks-codex` | Installs the hook entries (`agents install --hooks`). For Codex, trust each entry in `/hooks` after the install. |
| `hook-verify` | Writes the kit receipt that the hook trusts (`hook verify`). |
| `paths-confirm` | Records the kit and config paths, so skills stop asking for them (`paths confirm`). An owner step. |
| `profile` | Writes your personal profile (`profile apply`). |
| `starter-preferences` | Stores the starter preferences that you select (`--starter <id>`) in the personal store. |
| `scope`, `first-project` | Adds a scope and onboards one repository (`scope add`, `project onboard`). |
| `hub-join`, `job-hub-sync` | Joins an organization hub and turns on its sync job. Optional. |
| `consent-hub`, `consent-repo` | Grants the one-time consent that lets agents and jobs send lessons to the hub, or push learning branches to one repository. Each item still waits in the held queue, 24 hours by default. Owner steps. |
| `sandbox` | Recommends agent sandbox settings and a container setup for `--repo`. It writes no agent setting. Accepted recommendations (`--recommendation <id>`) become personal preferences. |

The starter templates step shows as "not available yet". The scheduled radar, advisory and review steps are skipped until you approve their plist paths with `live write-classes --launch-agent`. Without a hub, devtwin runs in solo mode.

After setup, devtwin works in the background. Agents write project lessons, constraints, facts, locations and handoffs on their own, as `observed` records. `activity` lists what it did, and `undo` reverses one write. The daily import, the daily backup and the weekly activity notification are scheduled jobs that you turn on with `schedule plan` and `schedule apply`; see [Schedules](HARNESS.md#schedules).

The skill, hook and write class steps are owner actions. The devtwin hook denies their `setup apply` from an agent shell, so the agent shows you the plan and you run the apply in your own terminal. `setup plan --all-pending` puts all the owner steps in one batch, and `setup apply --all-pending --apply` asks once for all of them. See [One approval for the owner steps](HARNESS.md#one-approval-for-the-owner-steps).

## If something fails

| Symptom | What to check |
| --- | --- |
| `DEVTWIN_GATE_REQUIRED` | Use the generated pilot file and canonical paths. Do not weaken the fence. |
| `PILOT_ROOT_REQUIRED_AND_ABSENT` | Start a fresh demo; the harness will not reuse an existing pilot root. |
| Package allowlist failure | Untracked files in a clone can fail the package gate. Use a clean checkout or inspect the finding; do not broadly allowlist private files. |
| `npm-install` failed | The pack smoke test keeps its temporary folder on failure and prints its path. Check that `npm` is on `PATH`. |
| `DEVTWIN_PLAN_MISMATCH` | Sources or state changed after preview. Review a fresh plan before applying it. |
| `DEVTWIN_BUSY` or recovery warning | Do not remove locks or journals blindly. Preserve the evidence and read [Storage](STORAGE.md). |
| Permission, symlink or hard-link error | Use a fresh canonical local directory and a filesystem with required link support. Read [Limitations](LIMITATIONS.md). |

For a reproducible bug, use synthetic inputs and the commands in [Contributing](../CONTRIBUTING.md). For a suspected vulnerability, follow [Security reporting](../SECURITY.md).
