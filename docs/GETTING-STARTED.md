# Getting started

Start with the offline demo. It exercises the current pilot without changing your real agent installation.

This is not a production installer. You do not need Claude, Codex, Orca, a company hub, an API key or a database server for this demo.

## 1. Get the source

Clone the repository into a development directory:

```sh
git clone https://github.com/sundharesan11/devtwin.git
cd devtwin
```

If the repository is still private, you need access. Use the reviewed checkout or release that contains this guide; do not assume an older default branch has the same commands. There is no published npm installation path.

Check prerequisites:

```sh
node --version
npm --version
git --version
node bin/devtwin.mjs help
```

The reference environment is macOS with Node v26.4.0. The manifest declares Node `>=22.13.0`. [CI](CI.md) run 38154524118 at commit `8f1133a` (2026-10-11) passed on macOS and Ubuntu with Node 26.4.0 and 22.13.0. Those are evaluation lanes for that commit, not a support claim. Support for the Node floor and for Linux is not claimed. Windows is unsupported.

There are no third-party runtime dependencies. Do not run `npm install -g`, `npm link` or an unrelated package with the same name. Run the CLI from this checkout.

## 2. Run the disposable demo

Run these commands in the same shell, from the repository root:

```sh
DEMO_PARENT="$(mktemp -d /tmp/devtwin-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

The pilot path and report file must not already exist. The canonical path from `pwd -P` avoids the macOS `/tmp` symlink.

The harness creates two synthetic Git repositories, isolated configuration/data/state roots and fake agent homes. It runs local checks for onboarding, scope isolation, record history, handoffs, installation conflicts and fake identity checks. It also checks the personal profile, the announcement watch against offline fixtures, skill-template render and verify, and packaging. It does not send network requests or execute acquired skills.

Expected result: `ok: true`, 32 checks marked `passed`, and `fresh-agent-smoke` marked `deferred`. A deferred check is not a pass. The harness deliberately leaves failure fixtures, modified sources and a lock case for testing. Do not use this fixture tree as your normal workspace.

The report is private. Do not paste its paths or contents into a public issue without reviewing them.

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

Live mode is implemented, and [Live activation](LIVE.md) is its runbook. Its first activation on one real machine passed on 2026-10-25, including fresh non-interactive Claude and Codex discovery; interactive sessions remain. Backup and restore, session hooks and selective migration from an existing personal setup remain [roadmap work](ROADMAP.md). A live setup made under the old devctx name moves with [Migrating from devctx](MIGRATING.md). A globally installed skill from another setup is not evidence that it uses this kit.

The kit does not delete demo directories. Temporary directories can disappear after a reboot or system cleanup. Keep only synthetic data in them. Inspect the exact directory before manually disposing of it.

## 5. Set up devtwin for real use

After the live config exists and `init` has run ([Live activation](LIVE.md), steps 1 to 8), setup takes you through the rest. You can start it in two ways, and both show the same steps and the same consent screens:

- Ask an agent in the kit checkout to set you up. The agent uses the `devtwin-setup` skill.
- Run the terminal loop yourself, in your own terminal:

```sh
node bin/devtwin.mjs setup --pilot ~/.devtwin/live.json
```

For each step, setup shows what the step changes, why, how to undo it and the preview of the command that the step runs. Then it asks. Only `y` applies the step. A step that is done shows `done` and is not asked again. Without a terminal, the loop refuses and points to the skill.

The same steps are available one at a time:

```sh
node bin/devtwin.mjs setup status --pilot ~/.devtwin/live.json
node bin/devtwin.mjs setup plan --pilot ~/.devtwin/live.json --step profile --work 'Backend services'
node bin/devtwin.mjs setup apply --pilot ~/.devtwin/live.json --step profile --work 'Backend services' --plan-fingerprint '<fingerprint>'
```

Give `setup apply` the same flags as the plan that you approved, and that plan's fingerprint.

| Step | What it does |
| --- | --- |
| `live-folder` | Checks the live config and `init`. It only reads. |
| `skills-claude`, `skills-codex` | Installs the bundled skills (`agents install`). |
| `write-classes-hooks` | Approves the two hook settings files (`live write-classes`). |
| `hooks-claude`, `hooks-codex` | Installs the hook entries (`agents install --hooks`). For Codex, trust each entry in `/hooks` after the install. |
| `hook-verify` | Writes the kit receipt that the hook trusts (`hook verify`). |
| `profile` | Writes your personal profile (`profile apply`). |
| `starter-preferences` | Stores the starter preferences that you select (`--starter <id>`) in the personal store. |
| `scope`, `first-project` | Adds a scope and onboards one repository (`scope add`, `project onboard`). |
| `sandbox` | Recommends agent sandbox settings and a container setup for `--repo`. It writes no agent setting. Accepted recommendations (`--recommendation <id>`) become personal preferences. |

The starter templates, the hub join and the scheduled jobs show as "not available yet". Without a hub, devtwin runs in solo mode.

The skill, hook and write class steps are owner actions. The devtwin hook denies their `setup apply` from an agent shell, so the agent shows you the plan and you run the apply in your own terminal.

## If something fails

| Symptom | What to check |
| --- | --- |
| `DEVTWIN_GATE_REQUIRED` | Use the generated pilot file and canonical paths. Do not weaken the fence. |
| `PILOT_ROOT_REQUIRED_AND_ABSENT` | Start a fresh demo; the harness will not reuse an existing pilot root. |
| Package allowlist failure | Untracked files in the checkout can fail the package gate. Use a clean checkout or inspect the finding; do not broadly allowlist private files. |
| `DEVTWIN_PLAN_MISMATCH` | Sources or state changed after preview. Review a fresh plan before applying it. |
| `DEVTWIN_BUSY` or recovery warning | Do not remove locks or journals blindly. Preserve the evidence and read [Storage](STORAGE.md). |
| Permission, symlink or hard-link error | Use a fresh canonical local directory and a filesystem with required link support. Read [Limitations](LIMITATIONS.md). |

For a reproducible bug, use synthetic inputs and the commands in [Contributing](../CONTRIBUTING.md). For a suspected vulnerability, follow [Security reporting](../SECURITY.md).
