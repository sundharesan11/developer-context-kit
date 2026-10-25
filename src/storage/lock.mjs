import { constants } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath } from "./fsx.mjs";
import { sha256 } from "./canonical.mjs";
import { finalizePlan, assertFingerprint } from "./plan.mjs";
export const registryLockPath = (roots) => join(roots.stateRoot, "locks", "registry.lock");
export const scopeLockPath = (roots, scope) => join(roots.stateRoot, "locks", scope + ".lock");
const LOCK_LIMIT = 4096;
async function readLock(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new DevtwinError("PATH_UNSAFE", "Lock is not a regular file");
    const buf = Buffer.alloc(LOCK_LIMIT); const { bytesRead } = await handle.read(buf, 0, LOCK_LIMIT, 0);
    return { bytes: buf.subarray(0, bytesRead), dev: st.dev, ino: st.ino };
  } finally { await handle.close(); }
}
function holderOf(bytes) {
  const value = JSON.parse(bytes.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("Lock record is not an object");
  let alive = false;
  if (value.host === hostname() && Number.isInteger(value.pid) && value.pid > 0) {
    try { process.kill(value.pid, 0); alive = true; } catch (error) { alive = error.code === "EPERM"; }
  }
  return { ...value, alive };
}
// Describes the holder for BUSY errors and release previews; a lock is never broken automatically.
export async function describeLock(path) {
  try { return holderOf((await readLock(path)).bytes); }
  catch (error) { if (error.code === "ENOENT") return null; return { unreadable: true, alive: false }; }
}
// faults.beforeRelease is a test seam that fails the start of cleanup; release must still complete.
export async function withLock(lockPath, owner, action, { waitMs = 2000, faults = {} } = {}) {
  const until = Date.now() + waitMs;
  let fd, own;
  for (;;) {
    try { fd = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new DevtwinError("BUSY", "Lock busy", { holder: await describeLock(lockPath) });
      await sleep(50);
    }
  }
  // Capture identity before anything else can fail; without it the lock is still ours, created exclusively an instant ago.
  try { own = await fd.stat(); }
  catch (error) { await fd.close().catch(() => undefined); await unlink(lockPath).catch(() => undefined); throw error; }
  let failed = false, result;
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), owner, startedAt: new Date().toISOString() }));
    await fd.sync();
    result = await action();
  } catch (error) { failed = true; throw error; }
  finally {
    // Each release step runs regardless of the others; a cleanup error never masks the action's error.
    const errors = [];
    try { if (faults.beforeRelease) await faults.beforeRelease(fd); } catch (error) { errors.push(error); }
    try { await fd.close(); } catch (error) { errors.push(error); }
    try { const current = await lstat(lockPath); if (current.dev === own.dev && current.ino === own.ino) await unlink(lockPath); } catch (error) { if (error.code !== "ENOENT") errors.push(error); }
    if (!failed && errors.length) throw errors[0];
  }
  return result;
}
export async function withPilotLock(roots, lockPath, owner, action, { destinations, waitMs = 2000, targetHome } = {}) {
  if (!Array.isArray(destinations) || !destinations.length) throw new DevtwinError("INVALID_INPUT", "Lock destinations required");
  assertWritable(roots, [lockPath, ...destinations], { targetHome });
  const rel = relative(roots.stateRoot, dirname(lockPath));
  if (rel !== "locks") throw new DevtwinError("PATH_UNSAFE", "Lock path outside lock directory");
  ensurePrivatePath(roots.stateRoot, ["locks"]);
  return withLock(lockPath, owner, async () => { assertWritable(roots, [lockPath, ...destinations], { targetHome }); return action(); }, { waitMs });
}
// Locks an owner may release by hand after a crash. Each lives at stateRoot/locks/<name>.lock.
export const RELEASABLE_LOCKS = ["install", "live", "hub-sync"];
async function releaseState(roots, lock) {
  if (typeof lock !== "string" || !RELEASABLE_LOCKS.includes(lock)) throw new DevtwinError("INVALID_INPUT", "Unknown lock", { field: "lock", allowed: RELEASABLE_LOCKS });
  const path = join(roots.stateRoot, "locks", lock + ".lock");
  assertWritable(roots, [path]);
  let read = null;
  try { read = await readLock(path); } catch (error) { if (error.code !== "ENOENT") read = { unsafe: true }; }
  let holder = null, reason, lockHash = null;
  if (!read) reason = "no-lock";
  else if (read.unsafe) { holder = { unreadable: true, alive: false }; reason = "unreadable"; }
  else {
    lockHash = sha256(read.bytes);
    try { holder = holderOf(read.bytes); } catch { holder = { unreadable: true, alive: false }; }
    reason = holder.unreadable ? "unreadable" : holder.host !== hostname() ? "other-host" : !Number.isInteger(holder.pid) || holder.pid <= 0 ? "unreadable" : holder.alive ? "owner-running" : "owner-not-running";
  }
  const plan = finalizePlan({ kind: "lock-release", lock, path, host: hostname(), holder, lockHash, release: reason === "owner-not-running", reason });
  return { plan, read };
}
// Preview: the lock's owner record and whether it may be released. Nothing is written.
export async function planLockRelease(roots, { lock }) { return (await releaseState(roots, lock)).plan; }
// Removes only the previewed lock file, and only when this host's recorded owner is no longer running and the bytes are unchanged.
export async function applyLockRelease(roots, { lock, fingerprint }) {
  const { plan, read } = await releaseState(roots, lock);
  assertFingerprint(plan, fingerprint);
  if (plan.reason === "no-lock") throw new DevtwinError("NOT_FOUND", "Lock not held", { lock });
  if (plan.reason === "owner-running") throw new DevtwinError("BUSY", "Lock owner is still running", { lock, holder: plan.holder });
  if (!plan.release) throw new DevtwinError("GATE_REQUIRED", "Lock cannot be released from this host", { lock, reason: plan.reason });
  const current = await readLock(plan.path).catch(() => null);
  if (!current || current.dev !== read.dev || current.ino !== read.ino || sha256(current.bytes) !== plan.lockHash) throw new DevtwinError("STALE_VERSION", "Lock changed during release", { lock });
  const st = await lstat(plan.path);
  if (st.dev !== read.dev || st.ino !== read.ino) throw new DevtwinError("STALE_VERSION", "Lock changed during release", { lock });
  await unlink(plan.path);
  return { released: true, lock, path: plan.path, holder: plan.holder, lockHash: plan.lockHash };
}
export const locksReleaseCommand = { options: { lock: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  if (!values.apply) return planLockRelease(ctx.roots, { lock: values.lock });
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyLockRelease(ctx.roots, { lock: values.lock, fingerprint: values["plan-fingerprint"] });
} };
