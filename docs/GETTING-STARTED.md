# Getting started

Start with the offline demo. It exercises the current pilot without changing your real agent installation.

This is not a production installer. You do not need Claude, Codex, Orca, a company hub, an API key or a database server for this demo.

## 1. Get the source

Clone the repository into a development directory:

```sh
git clone https://github.com/sundharesan11/developer-context-kit.git
cd developer-context-kit
```

If the repository is still private, you need access. Use the reviewed checkout or release that contains this guide; do not assume an older default branch has the same commands. There is no published npm installation path.

Check prerequisites:

```sh
node --version
npm --version
git --version
node bin/devctx.mjs help
```

The verified environment is macOS with Node v26.4.0. The manifest declares Node `>=22.13.0`; that floor still needs validation. Linux support is not claimed. Windows is unsupported.

There are no third-party runtime dependencies. Do not run `npm install -g`, `npm link` or an unrelated package with the same name. Run the CLI from this checkout.

## 2. Run the disposable demo

Run these commands in the same shell, from the repository root:

```sh
DEMO_PARENT="$(mktemp -d /tmp/devctx-demo.XXXXXX)"
DEMO_PARENT="$(cd "$DEMO_PARENT" && pwd -P)"
node scripts/acceptance.mjs \
  --pilot-root "$DEMO_PARENT/pilot" \
  --report "$DEMO_PARENT/acceptance.json"
```

The pilot path and report file must not already exist. The canonical path from `pwd -P` avoids the macOS `/tmp` symlink.

The harness creates two synthetic Git repositories, isolated configuration/data/state roots and fake agent homes. It runs local checks for onboarding, scope isolation, record history, handoffs, installation conflicts, fake identity checks and packaging. It does not send network requests or execute acquired skills.

Expected result: `ok: true`, 24 checks marked `passed`, and `fresh-agent-smoke` marked `deferred`. A deferred check is not a pass. The harness deliberately leaves failure fixtures, modified sources and a lock case for testing. Do not use this fixture tree as your normal workspace.

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

You can inspect briefs, exercise the [skill builder](SKILL-BUILDER.md) and review a [private handoff export](HANDOFF.md). Do not point the pilot at a real client checkout or edit the guards to reach your normal agent homes.

Fresh native-agent discovery, real-project activation, migration and backup/restore remain [roadmap work](ROADMAP.md). A globally installed skill from another setup is not evidence that it uses this kit.

The kit does not delete demo directories. Temporary directories can disappear after a reboot or system cleanup. Keep only synthetic data in them. Inspect the exact directory before manually disposing of it.

## If something fails

| Symptom | What to check |
| --- | --- |
| `DEVCTX_GATE_REQUIRED` | Use the generated pilot file and canonical paths. Do not weaken the fence. |
| `PILOT_ROOT_REQUIRED_AND_ABSENT` | Start a fresh demo; the harness will not reuse an existing pilot root. |
| Package allowlist failure | Untracked files in the checkout can fail the package gate. Use a clean checkout or inspect the finding; do not broadly allowlist private files. |
| `DEVCTX_PLAN_MISMATCH` | Sources or state changed after preview. Review a fresh plan before applying it. |
| `DEVCTX_BUSY` or recovery warning | Do not remove locks or journals blindly. Preserve the evidence and read [Storage](STORAGE.md). |
| Permission, symlink or hard-link error | Use a fresh canonical local directory and a filesystem with required link support. Read [Limitations](LIMITATIONS.md). |

For a reproducible bug, use synthetic inputs and the commands in [Contributing](../CONTRIBUTING.md). For a suspected vulnerability, follow [Security reporting](../SECURITY.md).
