import { readdirSync, readlinkSync, openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { sha256, canonicalJson } from "../storage/canonical.mjs";
import { readPrivateJson, writeNewFile, info, isWithin } from "../storage/fsx.mjs";
import { RUN_ID } from "../storage/runs.mjs";
import { LEGACY_SKILL_PREFIX } from "../config/legacy.mjs";
// The pre-apply inventory of each target skill folder. Rollback is evidence, not automation: nothing here restores anything.
export const INVENTORY = "inventory.json";
const OWNED = ["devtwin-", LEGACY_SKILL_PREFIX], WALK_LIMIT = 10000, FILE_LIMIT = 16 * 1048576, INVENTORY_LIMIT = 16 * 1048576;
const typeOf = (st) => st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
// Reads a regular file without following a symlink swapped in after lstat, and without blocking on a FIFO.
function hashFile(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    if (st.size > FILE_LIMIT) throw new DevtwinError("LIMIT", "Skill folder file too large to inventory");
    const buf = Buffer.alloc(st.size); let offset = 0;
    while (offset < buf.length) { const n = readSync(fd, buf, offset, buf.length - offset, offset); if (!n) break; offset += n; }
    return sha256(buf.subarray(0, offset));
  } finally { closeSync(fd); }
}
// Foreign entries: top-level lstat only, never opened or walked.
function foreignEntry(path, name, st) {
  const row = { name, type: typeOf(st), mode: st.mode, size: st.size, mtime: new Date(st.mtimeMs).toISOString() };
  if (st.isSymbolicLink()) row.link = readlinkSync(path);
  return row;
}
// devtwin-* (and legacy devctx-*) entries: every node with content hashes, never following a symlink.
function walkOwned(dir, rel, rows) {
  const path = join(dir, rel), st = info(path);
  if (!st) return;
  if (rows.length >= WALK_LIMIT) throw new DevtwinError("LIMIT", "Skill folder too large to inventory");
  const row = { path: rel, type: typeOf(st), mode: st.mode };
  if (st.isSymbolicLink()) row.link = readlinkSync(path);
  else if (st.isFile()) { row.size = st.size; row.sha256 = hashFile(path); }
  rows.push(row);
  if (st.isDirectory() && !st.isSymbolicLink()) for (const name of readdirSync(path).sort()) walkOwned(dir, rel + "/" + name, rows);
}
export function inventoryFolder(agent, dir) {
  const st = info(dir);
  if (!st) return { agent, dir, existed: false, type: null, entries: [], devtwin: [] };
  if (st.isSymbolicLink() || !st.isDirectory()) return { agent, dir, existed: true, type: typeOf(st), entries: [], devtwin: [] };
  const entries = [], devtwin = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), node = info(path);
    if (!node) continue;
    if (OWNED.some((prefix) => name.startsWith(prefix))) walkOwned(dir, name, devtwin);
    else entries.push(foreignEntry(path, name, node));
  }
  return { agent, dir, existed: true, type: "dir", entries, devtwin };
}
// Called by apply after the run folder exists and before the first copy or target write.
export async function recordInventory(runDir, { runId, configId, mode, folders }) {
  const inventory = { schemaVersion: 1, kind: "skill-inventory", runId, configId, mode, recordedAt: new Date().toISOString(), folders: folders.map(({ agent, dir }) => inventoryFolder(agent, dir)) };
  await writeNewFile(join(runDir, INVENTORY), canonicalJson(inventory) + "\n");
  return inventory;
}
function diff(before, now, key) {
  const a = new Map(before.map((r) => [r[key], r])), b = new Map(now.map((r) => [r[key], r])), out = [];
  for (const [id, row] of a) {
    if (!b.has(id)) out.push({ [key]: id, change: "removed", before: row, now: null });
    else if (canonicalJson(row) !== canonicalJson(b.get(id))) out.push({ [key]: id, change: "changed", before: row, now: b.get(id) });
  }
  for (const [id, row] of b) if (!a.has(id)) out.push({ [key]: id, change: "added", before: null, now: row });
  return out.sort((x, y) => (x[key] < y[key] ? -1 : x[key] > y[key] ? 1 : 0));
}
const wellFormed = (inv, runId) => inv?.schemaVersion === 1 && inv.kind === "skill-inventory" && inv.runId === runId && ["install", "uninstall"].includes(inv.mode) && Array.isArray(inv.folders)
  && inv.folders.every((f) => typeof f?.agent === "string" && typeof f.dir === "string" && typeof f.existed === "boolean" && Array.isArray(f.entries) && Array.isArray(ownedRows(f)));
// Inventories recorded before the rename name the owned rows "devctx".
const ownedRows = (folder) => folder.devtwin ?? folder.devctx;
// A folder the inventory names must still be one this pilot may install into.
function assertTarget(pilot, { agent, dir }) {
  const allowed = pilot.live ? Object.hasOwn(pilot.live.skillDirs, agent) && pilot.live.skillDirs[agent] === dir : (pilot.agentHomes ?? []).some((home) => isWithin(dir, home));
  if (!allowed) throw new DevtwinError("GATE_REQUIRED", "Inventory names a folder outside this live config", { agent });
}
// Read-only: compares each skill folder now with an install run's inventory. Fails on any devtwin-* difference; lists foreign changes.
export async function rollbackCheck(roots, pilot, { runId }) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new DevtwinError("INVALID_ID", "Invalid run ID");
  const path = join(roots.stateRoot, "runs", runId, INVENTORY);
  if (!info(path)) throw new DevtwinError("NOT_FOUND", "Install inventory unavailable", { runId });
  const inventory = await readPrivateJson(path, INVENTORY_LIMIT);
  if (!wellFormed(inventory, runId)) throw new DevtwinError("INTEGRITY", "Invalid install inventory", { runId });
  if (inventory.configId !== (pilot.live?.configId ?? null)) throw new DevtwinError("GATE_REQUIRED", "Inventory belongs to another live config", { runId });
  if (inventory.mode !== "install") throw new DevtwinError("INVALID_INPUT", "Rollback check needs an install run", { runId });
  const folders = inventory.folders.map((before) => {
    assertTarget(pilot, before);
    const now = inventoryFolder(before.agent, before.dir);
    return {
      agent: before.agent, dir: before.dir, existedBefore: before.existed, existsNow: now.existed,
      folder: { before: before.type, now: now.type },
      devtwin: diff(ownedRows(before), now.devtwin, "path"),
      foreign: diff(before.entries, now.entries, "name")
    };
  });
  const report = { runId, recordedAt: inventory.recordedAt, folders };
  // A folder replaced by something other than a directory cannot be checked, so it fails like a devtwin-* difference.
  if (folders.some((f) => f.devtwin.length || (f.existsNow && f.folder.now !== "dir"))) throw new DevtwinError("ROLLBACK_MISMATCH", "Skill folder differs from its install inventory", report);
  return { status: "ok", ...report };
}
