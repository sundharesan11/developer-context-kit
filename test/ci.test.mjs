import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const workflowPath = join(import.meta.dirname, "../.github/workflows/ci.yml");
const acceptancePath = join(import.meta.dirname, "../scripts/acceptance.mjs");
function canonicalTemp(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function runAcceptance(parts) {
  const r = spawnSync(process.execPath, [acceptancePath, ...parts], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { status: r.status, out: JSON.parse(r.stdout.trim().split("\n").at(-1)) };
}

test("CI uses read-only pinned actions without privileged triggers or persistent credentials", async () => {
  const text = await readFile(workflowPath, "utf8");
  assert.match(text, /\n  push:\n  pull_request:\n  workflow_dispatch:/);
  assert.match(text, /permissions:\n  contents: read/);
  assert.equal([...text.matchAll(/^\s*permissions:/gm)].length, 1, "no job-level permission override");
  assert.match(text, /persist-credentials: false/);
  assert.match(text, /package-manager-cache: false/);
  assert.match(text, /timeout-minutes: 20/);
  assert.match(text, /cancel-in-progress: true/);
  const uses = [...text.matchAll(/uses: ([^\s]+)/g)].map(match => match[1]);
  assert.equal(uses.length, 2);
  for (const action of uses) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
  assert.doesNotMatch(text, /pull_request_target|workflow_run|self-hosted|continue-on-error|secrets\.|upload-artifact|npm (?:publish|install|ci)|write-all/);
});

test("CI evaluates both Node versions without claiming Linux support and checks private acceptance results", async () => {
  const text = await readFile(workflowPath, "utf8");
  for (const value of ["macos-15", "ubuntu-24.04", "'22.13.0'", "'26.4.0'",
    "Linux evaluation (unsupported)", "Linux minimum evaluation (unsupported)",
    "npm test", "npm run check:package", "scripts/acceptance.mjs",
    "$RUNNER_TEMP/devtwin-ci.XXXXXX", "pwd -P", "fresh-agent-smoke", "deferred",
    "git status --porcelain --untracked-files=all",
    "git diff --check 4b825dc642cb6eb9a060e54bf8d69288fbee4904 HEAD"]) {
    assert.ok(text.includes(value), value);
  }
  assert.ok(text.indexOf("run: npm run check:package") < text.indexOf("run: npm test"));
  assert.match(text, /report\.checks\.length, 33/);
  assert.match(text, /status === 'passed'\)\.length, 32/);
});

test("acceptance forbidden path overlapping the pilot fails preflight without fixture writes", async (t) => {
  const parent = canonicalTemp(t, "devtwin-acc-overlap-"), pilotRoot = join(parent, "pilot"), report = join(parent, "report.json");
  const r = runAcceptance(["--pilot-root", pilotRoot, "--report", report, "--forbidden", parent]);
  assert.notEqual(r.status, 0);
  assert.equal(r.out.ok, false);
  assert.equal(r.out.error, "PILOT_PREFLIGHT_REFUSED");
  assert.equal(existsSync(pilotRoot), false);
  assert.equal(existsSync(report), false);
});

test("acceptance forbidden option rejects relative non-canonical and missing values", async (t) => {
  const parent = canonicalTemp(t, "devtwin-acc-usage-"), other = canonicalTemp(t, "devtwin-acc-other-");
  for (const value of ["relative/dir", other + "/../" + other.split("/").at(-1), other + "/", join(other, "missing"), "--report"]) {
    const pilotRoot = join(parent, "pilot"), report = join(parent, "report.json");
    const r = runAcceptance(["--pilot-root", pilotRoot, "--report", report, "--forbidden", value]);
    assert.equal(r.status, 1, value);
    assert.deepEqual(r.out, { ok: false, error: "FORBIDDEN_PATH_INVALID" }, value);
    assert.equal(existsSync(pilotRoot), false, value);
  }
  const r = runAcceptance(["--pilot-root", join(parent, "pilot"), "--report", join(parent, "report.json"), "--forbidden"]);
  assert.deepEqual(r.out, { ok: false, error: "FORBIDDEN_PATH_INVALID" });
});

test("acceptance records every extra forbidden path in its report", async (t) => {
  const parent = canonicalTemp(t, "devtwin-acc-report-"), first = canonicalTemp(t, "devtwin-acc-forbid1-"), second = canonicalTemp(t, "devtwin-acc-forbid2-");
  const report = join(parent, "report.json");
  const r = runAcceptance(["--pilot-root", join(parent, "pilot"), "--report", report, "--forbidden", first, "--forbidden", second]);
  assert.equal(r.status, 0);
  const saved = JSON.parse(await readFile(report, "utf8"));
  assert.equal(saved.ok, true);
  assert.equal(saved.checks.length, 33);
  for (const id of ["live-init-preview-apply", "live-install-foreign-conflict-blocks-one-agent", "live-uninstall-from-receipts", "live-rollback-check-after-uninstall",
    "profile-plan-apply", "profile-and-stack-stale-approval-refused", "stack-watch-offline-fixtures", "skill-template-render-verify"]) {
    assert.equal(saved.checks.find((check) => check.id === id)?.status, "passed", id);
  }
  assert.deepEqual(saved.forbidden, [resolve(import.meta.dirname, ".."), first, second]);
});
