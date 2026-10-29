import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, lstat, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { sandbox } from "./helpers.mjs";
import { listRuntimeFiles } from "../src/kit/runtime-files.mjs";
import { CLONE_ONLY, DEFERRED } from "../src/demo/run.mjs";
const repoRoot = join(import.meta.dirname, "..");
const devtwin = (kit, parts) => {
  const r = spawnSync(process.execPath, [join(kit, "bin/devtwin.mjs"), ...parts], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 300000 });
  return { status: r.status, json: JSON.parse(r.stdout.trim().split("\n").at(-1)) };
};
const statuses = (checks) => Object.fromEntries(checks.map((c) => [c.id, c.status]));

test("devtwin demo passes from the Git clone with every check run", async (t) => {
  const parent = await sandbox(t), report = join(parent, "report.json");
  const r = devtwin(repoRoot, ["demo", "--pilot-root", join(parent, "pilot"), "--report", report]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.command, "demo");
  assert.equal(r.json.result.ok, true);
  for (const [id, status] of Object.entries(statuses(r.json.result.checks))) assert.equal(status, DEFERRED.includes(id) ? "deferred" : "passed", id);
  assert.equal(r.json.result.checks.length, 34);
  assert.equal(JSON.parse(await readFile(report, "utf8")).ok, true);
});

test("devtwin demo from a copy of the runtime set skips only the clone-only checks", async (t) => {
  const parent = await sandbox(t), kit = join(parent, "kit");
  for (const file of listRuntimeFiles(repoRoot)) {
    await mkdir(dirname(join(kit, file)), { recursive: true });
    await copyFile(join(repoRoot, file), join(kit, file));
    await chmod(join(kit, file), (await lstat(join(repoRoot, file))).mode & 0o777);
  }
  const version = devtwin(kit, ["--version"]);
  assert.equal(version.status, 0);
  assert.deepEqual(version.json.result, { name: "devtwin", version: JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")).version });
  const r = devtwin(kit, ["demo", "--pilot-root", join(parent, "pilot"), "--report", join(parent, "report.json")]);
  assert.equal(r.status, 0, JSON.stringify(r.json));
  assert.equal(r.json.result.ok, true);
  assert.ok(CLONE_ONLY.includes("package-allowlist"));
  for (const [id, status] of Object.entries(statuses(r.json.result.checks))) {
    assert.equal(status, CLONE_ONLY.includes(id) ? "skipped" : DEFERRED.includes(id) ? "deferred" : "passed", id);
  }
  for (const id of ["stack-watch-offline-fixtures", "skill-template-render-verify", "install-preview-apply-idempotent-conflict-uninstall"]) assert.equal(statuses(r.json.result.checks)[id], "passed", id);
});

test("devtwin demo refuses an existing pilot root or a relative forbidden path", async (t) => {
  const parent = await sandbox(t);
  const refused = devtwin(repoRoot, ["demo", "--pilot-root", parent, "--report", join(parent, "report.json")]);
  assert.equal(refused.status, 1);
  assert.equal(refused.json.error.details.reason, "PILOT_ROOT_REQUIRED_AND_ABSENT");
  const bad = devtwin(repoRoot, ["demo", "--pilot-root", join(parent, "pilot"), "--report", join(parent, "report.json"), "--forbidden", "relative/dir"]);
  assert.equal(bad.json.error.details.reason, "FORBIDDEN_PATH_INVALID");
});
