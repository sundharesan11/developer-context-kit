import { constants } from "node:fs";
import { open, lstat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath } from "./fsx.mjs";
export const registryLockPath = (roots) => join(roots.stateRoot, "locks", "registry.lock");
export const scopeLockPath = (roots, scope) => join(roots.stateRoot, "locks", scope + ".lock");
const LOCK_LIMIT = 4096;
async function readLockText(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new DevctxError("PATH_UNSAFE", "Lock is not a regular file");
    const buf = Buffer.alloc(LOCK_LIMIT); const { bytesRead } = await handle.read(buf, 0, LOCK_LIMIT, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}
// Describes the holder for BUSY errors only; a foreign lock is never broken here or anywhere else.
export async function describeLock(path) {
  try {
    const value = JSON.parse(await readLockText(path));
    let alive = false;
    if (value.host === hostname() && Number.isInteger(value.pid)) {
      try { process.kill(value.pid, 0); alive = true; } catch { alive = false; }
    }
    return { ...value, alive };
  } catch (error) { if (error.code === "ENOENT") return null; return { unreadable: true, alive: false }; }
}
// faults.beforeRelease is a test seam that fails the start of cleanup; release must still complete.
export async function withLock(lockPath, owner, action, { waitMs = 2000, faults = {} } = {}) {
  const until = Date.now() + waitMs;
  let fd, own;
  for (;;) {
    try { fd = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new DevctxError("BUSY", "Lock busy", { holder: await describeLock(lockPath) });
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
  if (!Array.isArray(destinations) || !destinations.length) throw new DevctxError("INVALID_INPUT", "Lock destinations required");
  assertWritable(roots, [lockPath, ...destinations], { targetHome });
  const rel = relative(roots.stateRoot, dirname(lockPath));
  if (rel !== "locks") throw new DevctxError("PATH_UNSAFE", "Lock path outside lock directory");
  ensurePrivatePath(roots.stateRoot, ["locks"]);
  return withLock(lockPath, owner, async () => { assertWritable(roots, [lockPath, ...destinations], { targetHome }); return action(); }, { waitMs });
}
