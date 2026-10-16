import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, symlink, readdir, lstat, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { hostname } from "node:os";
import { lockFile, sleep, makePilot, onboardFixture, now, runCli } from "./helpers.mjs";
import { sha256 } from "../src/storage/canonical.mjs";
import { planRecovery, applyRecovery } from "../src/agents/install.mjs";
import { withLock, withPilotLock, describeLock } from "../src/storage/lock.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { readRegistry } from "../src/config/registry.mjs";
import { finalizePlan, assertFingerprint, onboardRequest, requestHashFor, deterministicRequestId } from "../src/storage/plan.mjs";
test("root-bound lock rejects missing pilot before creating lock parent", async (t) => {
  const p = await makePilot(t);
  const lock = join(p.stateRoot, "locks", "registry.lock");
  const roots = { configRoot: p.configRoot, dataRoot: p.dataRoot, stateRoot: p.stateRoot };
  let called = false;
  await assert.rejects(withPilotLock(roots, lock, {}, async () => { called = true; }, { destinations: [p.dataRoot] }), { code: "DEVCTX_GATE_REQUIRED" });
  assert.equal(called, false);
  await assert.rejects(lstat(join(p.stateRoot, "locks")), { code: "ENOENT" });
});
test("root-bound lock refuses escaped state root before touching outside", async (t) => {
  const p = await makePilot(t);
  const outside = join(p.sandbox, "lock-escape");
  await mkdir(outside);
  await symlink(outside, p.stateRoot);
  let called = false;
  await assert.rejects(withPilotLock(p.roots, join(p.stateRoot, "locks", "registry.lock"), {}, async () => { called = true; }, { destinations: [p.dataRoot] }), (e) => ["DEVCTX_GATE_REQUIRED", "DEVCTX_PATH_UNSAFE"].includes(e.code));
  assert.equal(called, false);
  assert.deepEqual(await readdir(outside), []);
});
test("concurrent writers serialize; a foreign lock is never broken", async (t) => {
  const lock = await lockFile(t); const order = [];
  const work = (n) => async () => { order.push(n); await sleep(30); order.push(n); };
  await Promise.all([withLock(lock, {}, work("a")), withLock(lock, {}, work("b"))]);
  assert.ok(order.join("") === "aabb" || order.join("") === "bbaa");
  await writeFile(lock, JSON.stringify({ pid: 999999, host: "elsewhere" }), { mode: 0o600 });
  await assert.rejects(withLock(lock, {}, async () => 1, { waitMs: 100 }), { code: "DEVCTX_BUSY" });
  assert.equal((await describeLock(lock)).pid, 999999);
});
test("fingerprint mismatch is refused", () => {
  const plan = finalizePlan({ kind: "x", writes: [1] });
  assert.throws(() => assertFingerprint(plan, "sha256:00"), { code: "DEVCTX_PLAN_MISMATCH" });
  assert.throws(() => assertFingerprint(plan, undefined), { code: "DEVCTX_PLAN_REQUIRED" });
  assert.doesNotThrow(() => assertFingerprint(plan, plan.fingerprint));
});
test("request hash ignores order and non-request fields; deterministic id is stable and payload-bound", () => {
  const base = { scope: "acme", project: "acme.atlas", repo: "/p/repos/atlas", approvedDocs: ["b.md", "a.md"], expectedRemotes: [], environments: ["staging", "prod"], actorRefs: [], accept: "all" };
  const a = onboardRequest(base);
  const b = onboardRequest({ ...base, approvedDocs: ["a.md", "b.md"], environments: ["prod", "staging"], requestId: "req_ignored01", registryGeneration: 7, now: "x" });
  assert.equal(requestHashFor(a), requestHashFor(b));
  assert.match(deterministicRequestId("onboard", a), /^req_[a-f0-9]{24}$/);
  assert.equal(deterministicRequestId("onboard", a), deterministicRequestId("onboard", b));
  assert.notEqual(requestHashFor(onboardRequest({ ...base, environments: ["staging"] })), requestHashFor(a));
});
test("U4 withLock closes its handle, removes its lock and surfaces the action error when cleanup fails", async (t) => {
  const lock = await lockFile(t); let handle;
  await assert.rejects(withLock(lock, {}, async () => { throw new Error("action failed"); }, { faults: { beforeRelease: (fd) => { handle = fd; throw new Error("stat failed"); } } }), /action failed/);
  assert.equal(handle?.fd, -1);
  await assert.rejects(lstat(lock), { code: "ENOENT" });
  await assert.rejects(withLock(lock, {}, async () => 7, { faults: { beforeRelease: () => { throw new Error("stat failed"); } } }), /stat failed/);
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});
test("U4 describeLock does not follow a symlinked lock file and a foreign symlink lock stays", async (t) => {
  const lock = await lockFile(t), target = lock + ".target";
  await writeFile(target, JSON.stringify({ pid: process.pid, host: "elsewhere" }), { mode: 0o600 });
  await symlink(target, lock);
  assert.deepEqual(await describeLock(lock), { unreadable: true, alive: false });
  await assert.rejects(withLock(lock, {}, async () => 1, { waitMs: 50 }), { code: "DEVCTX_BUSY" });
  assert.ok((await lstat(lock)).isSymbolicLink());
});
test("U4 onboarding replay writes a run receipt lost after registry publish", async (t) => {
  const s = await onboardFixture(t);
  const opts = { fingerprint: s.plan.fingerprint, now };
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { ...opts, faults: { afterRegistry: () => { throw new Error("crash"); } } }), /crash/);
  const op = (await readRegistry(s.roots)).value.operations[0];
  const receiptPath = join(s.roots.stateRoot, "runs", "run_" + op.operationId.slice(3), "receipt.json");
  await assert.rejects(lstat(receiptPath), { code: "ENOENT" });
  const replay = await applyOnboard(s.roots, s.pilot, s.input, opts);
  assert.equal(replay.replayed, true);
  const { replayed, ...receipt } = replay;
  assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
  assert.deepEqual(await applyOnboard(s.roots, s.pilot, s.input, opts), replay);
  await writeFile(receiptPath, JSON.stringify({ ...receipt, committedGeneration: 99 }) + "\n", { mode: 0o600 });
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, opts), { code: "DEVCTX_RECOVERY_REQUIRED" });
});
test("U4 onboarding replay restores an empty or truncated run receipt left by a hard kill", async (t) => {
  const s = await onboardFixture(t);
  const opts = { fingerprint: s.plan.fingerprint, now };
  const first = await applyOnboard(s.roots, s.pilot, s.input, opts);
  const receiptPath = join(s.roots.stateRoot, "runs", "run_" + first.operationId.slice(3), "receipt.json");
  const { replayed, ...receipt } = first;
  for (const torn of ["", JSON.stringify(receipt).slice(0, 40)]) {
    await writeFile(receiptPath, torn, { mode: 0o600 });
    const replay = await applyOnboard(s.roots, s.pilot, s.input, opts);
    assert.equal(replay.replayed, true);
    assert.deepEqual(JSON.parse(await readFile(receiptPath, "utf8")), receipt);
    assert.equal((await lstat(receiptPath)).mode & 0o777, 0o600);
  }
});
// A pid that was alive a moment ago and has been reaped, as a killed devctx process leaves behind.
const deadPid = () => { const r = spawnSync(process.execPath, ["-e", ""]); assert.equal(r.status, 0); return r.pid; };
const lockRecord = (pid, host = hostname()) => JSON.stringify({ pid, host, owner: { kind: "install", runId: "run_killed0001" }, startedAt: "2026-10-07T00:00:00.000Z" });
async function plantLock(p, name, record) {
  await mkdir(join(p.stateRoot, "locks"), { recursive: true, mode: 0o700 });
  const path = join(p.stateRoot, "locks", name + ".lock");
  await writeFile(path, record, { flag: "wx", mode: 0o600 });
  return path;
}
const release = (p, lock, extra = []) => runCli(["locks", "release", "--pilot", p.path, "--lock", lock, ...extra]);
test("locks release: a stale install lock blocks recover until an approved release removes it", async (t) => {
  const p = await makePilot(t), record = lockRecord(deadPid()), path = await plantLock(p, "install", record);
  const recovery = await planRecovery(p.roots, p.pilot);
  await assert.rejects(applyRecovery(p.roots, p.pilot, { fingerprint: recovery.fingerprint }), { code: "DEVCTX_BUSY" });
  const preview = await release(p, "install");
  assert.equal(preview.code, 0, JSON.stringify(preview.json));
  const plan = preview.json.result;
  assert.equal(plan.kind, "lock-release");
  assert.equal(plan.lock, "install");
  assert.equal(plan.release, true);
  assert.equal(plan.reason, "owner-not-running");
  assert.deepEqual([plan.holder.pid, plan.holder.alive, plan.holder.owner.runId], [JSON.parse(record).pid, false, "run_killed0001"]);
  assert.equal(plan.lockHash, sha256(Buffer.from(record)));
  assert.equal(await readFile(path, "utf8"), record);
  const missing = await release(p, "install", ["--apply"]);
  assert.equal(missing.json.error.code, "DEVCTX_PLAN_REQUIRED");
  const applied = await release(p, "install", ["--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.deepEqual([applied.json.result.released, applied.json.result.lock], [true, "install"]);
  await assert.rejects(lstat(path), { code: "ENOENT" });
  assert.equal((await applyRecovery(p.roots, p.pilot, { fingerprint: recovery.fingerprint })).applied, true);
  const none = await release(p, "install");
  assert.deepEqual([none.json.result.release, none.json.result.reason, none.json.result.holder], [false, "no-lock", null]);
  assert.equal((await release(p, "install", ["--apply", "--plan-fingerprint", none.json.result.fingerprint])).json.error.code, "DEVCTX_NOT_FOUND");
});
test("locks release refuses a running owner, another host and a lock changed after preview", async (t) => {
  const p = await makePilot(t);
  const live = await plantLock(p, "live", lockRecord(process.pid));
  const alive = (await release(p, "live")).json.result;
  assert.deepEqual([alive.release, alive.reason, alive.holder.alive], [false, "owner-running", true]);
  assert.equal((await release(p, "live", ["--apply", "--plan-fingerprint", alive.fingerprint])).json.error.code, "DEVCTX_BUSY");
  assert.equal(await readFile(live, "utf8"), lockRecord(process.pid));
  await rm(live);
  const other = await plantLock(p, "live", lockRecord(deadPid(), "another-host.invalid"));
  const foreign = (await release(p, "live")).json.result;
  assert.deepEqual([foreign.release, foreign.reason], [false, "other-host"]);
  assert.equal((await release(p, "live", ["--apply", "--plan-fingerprint", foreign.fingerprint])).json.error.code, "DEVCTX_GATE_REQUIRED");
  assert.ok((await lstat(other)).isFile());
  await rm(other);
  const stale = await plantLock(p, "install", lockRecord(deadPid()));
  const before = (await release(p, "install")).json.result;
  assert.equal(before.release, true);
  await writeFile(stale, lockRecord(deadPid()).replace("2026-10-07", "2026-10-08"), { mode: 0o600 });
  const changed = await release(p, "install", ["--apply", "--plan-fingerprint", before.fingerprint]);
  assert.equal(changed.json.error.code, "DEVCTX_PLAN_MISMATCH");
  assert.ok((await lstat(stale)).isFile());
  assert.equal((await release(p, "nope")).json.error.code, "DEVCTX_INVALID_INPUT");
  assert.ok((await runCli(["help"])).json.result.commands.includes("locks release"));
});
