import { open, readFile, lstat, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath } from "./fsx.mjs";
export const registryLockPath = (roots) => join(roots.stateRoot, "locks", "registry.lock");
export const scopeLockPath = (roots, scope) => join(roots.stateRoot, "locks", scope + ".lock");
export async function describeLock(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    let alive = false;
    if (value.host === hostname() && Number.isInteger(value.pid)) {
      try { process.kill(value.pid, 0); alive = true; } catch { alive = false; }
    }
    return { ...value, alive };
  } catch (error) { if (error.code === "ENOENT") return null; return { unreadable: true, alive: false }; }
}
export async function withLock(lockPath, owner, action, { waitMs = 2000 } = {}) {
  const until = Date.now() + waitMs;
  let fd;
  for (;;) {
    try { fd = await open(lockPath, "wx", 0o600); break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= until) throw new DevctxError("BUSY", "Lock busy", { holder: await describeLock(lockPath) });
      await sleep(50);
    }
  }
  try {
    await fd.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), owner, startedAt: new Date().toISOString() }));
    await fd.sync();
    return await action();
  } finally {
    const own = await fd.stat();
    await fd.close();
    try { const current = await lstat(lockPath); if (current.dev === own.dev && current.ino === own.ino) await unlink(lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
export async function withPilotLock(roots, lockPath, owner, action, { destinations, waitMs = 2000, targetHome } = {}) {
  if (!Array.isArray(destinations) || !destinations.length) throw new DevctxError("INVALID_INPUT", "Lock destinations required");
  assertWritable(roots, [lockPath, ...destinations], { targetHome });
  const rel = relative(roots.stateRoot, dirname(lockPath));
  if (rel !== "locks") throw new DevctxError("PATH_UNSAFE", "Lock path outside lock directory");
  ensurePrivatePath(roots.stateRoot, ["locks"]);
  return withLock(lockPath, owner, async () => { assertWritable(roots, [lockPath, ...destinations], { targetHome }); return action(); }, { waitMs });
}
