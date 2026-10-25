import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { validateRoot } from "../config/roots.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { ensurePrivatePath, readPrivateJson, readPrivateBytes, writeNewFile, atomicReplace, fsyncDir, info, isWithin } from "../storage/fsx.mjs";
import { RUN_ID } from "../storage/runs.mjs";
import { PACKAGE_LIMITS } from "../skill-builder/validate.mjs";
import { AGENT_HOMES } from "./install.mjs";
const marker = ".devtwin-owned.json";
export function safeHome(roots, targetHome) {
  assertWritable(roots, []);
  if (typeof targetHome !== "string") throw new DevtwinError("INVALID_INPUT", "Target home required");
  const pilot = roots.pilot;
  assertInPilot(pilot, targetHome, "agentHomes");
  let real;
  try { real = realpathSync.native(targetHome); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("GATE_REQUIRED", "Pilot agent home unavailable"); throw error; }
  const home = realpathSync.native(homedir());
  if (isWithin(real, home) || isWithin(home, real)) throw new DevtwinError("GATE_REQUIRED", "Real home refused");
  return pilot;
}
export function agentsCheck(agents) {
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => typeof a !== "string" || !Object.hasOwn(AGENT_HOMES, a))) throw new DevtwinError("INVALID_INPUT", "Invalid agent selection");
  return [...new Set(agents)].sort();
}
export function checkAgentParents(targetHome, agent, layouts = AGENT_HOMES) {
  const parts = layouts[agent].split("/");
  let at = targetHome;
  for (const part of parts) {
    at = join(at, part);
    const st = info(at);
    if (st && (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077))) throw new DevtwinError("PATH_UNSAFE", "Unsafe agent skill directory");
  }
}
export function entries(dir, prefix = "", {strictModes = false} = {}) {
  if (prefix.split("/").length > 5) throw new DevtwinError("LIMIT", "Installed depth limit");
  const result = [];
  const names = readdirSync(dir).sort();
  if (names.length > 64) throw new DevtwinError("LIMIT", "Installed entry limit");
  for (const name of names) {
    const rel = prefix ? prefix + "/" + name : name, path = join(dir, name), st = lstatSync(path);
    if ((strictModes && (st.mode & 0o7777) !== (st.isDirectory() ? 0o700 : 0o600)) || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || (st.isFile() && st.nlink !== 1)) throw new DevtwinError("PATH_UNSAFE", "Unsafe installed entry");
    if (st.isDirectory()) { result.push({ rel, directory: true }); result.push(...entries(path, rel, {strictModes})); }
    else if (st.isFile()) result.push({ rel, directory: false });
    else throw new DevtwinError("PATH_UNSAFE", "Unsafe installed entry");
  }
  return result;
}
export function fileHashes(files) { return Object.fromEntries(Object.keys(files).sort().map((rel) => [rel, sha256(files[rel])])); }
export function roleConflict(oldFiles, newFiles) {
  return Object.keys(oldFiles).some((oldRel) => Object.keys(newFiles).some((newRel) => {
    const oldFolded = oldRel.toLowerCase(), newFolded = newRel.toLowerCase();
    return (oldFolded === newFolded && oldRel !== newRel) || oldFolded.startsWith(newFolded + "/") || newFolded.startsWith(oldFolded + "/");
  }));
}
export async function journals(roots, targetHome) {
  const runs = join(roots.stateRoot, "runs"), incomplete = [], reviewed = [];
  let ids = []; try { ids = await readdir(runs); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const id of ids) {
    if (!RUN_ID.test(id)) continue;
    const path = join(runs, id, "journal.json"), moved = join(runs, id, "reviewed", "journal.json");
    if (existsSync(moved)) {
      try { const j = await readPrivateJson(moved); if (!j.targetHome || j.targetHome === targetHome) reviewed.push(id); }
      catch { reviewed.push(id); }
    }
    if (!existsSync(path)) continue;
    try {
      const j = await readPrivateJson(path);
      if (j.targetHome && j.targetHome !== targetHome) continue;
      // A bundled run closed by an approved recovery plan is finished even though some intended actions never completed.
      if (j.kind === "skill-bundled" && j.closed === true) continue;
      if (j.kind === "skill-source-local" && (JSON.stringify(Object.keys(j).sort()) !== JSON.stringify(["schemaVersion", "kind", "decision", "contentDecision", "planFingerprint", "targetHome", "intended", "completed"].sort()) || j.schemaVersion !== 1 || !/^dc_[a-z0-9_-]{8,64}$/.test(j.decision ?? "") || !/^dc_[a-z0-9_-]{8,64}$/.test(j.contentDecision ?? "") || !/^sha256:[0-9a-f]{64}$/.test(j.planFingerprint ?? "") || typeof j.targetHome !== "string" || !Array.isArray(j.intended) || !j.intended.length || j.intended.length > 2)) { incomplete.push(id); continue; }
      if (!Array.isArray(j.intended) || !Array.isArray(j.completed) || j.completed.length > j.intended.length || j.completed.length < j.intended.length || j.completed.some((action, i) => canonicalJson(action) !== canonicalJson(j.intended[i])) || (j.kind === "skill-package-local" && (j.schemaVersion !== 1 || !/^ws_[a-z0-9_-]{8,64}$/.test(j.workspace ?? "") || !/^dc_[a-z0-9_-]{8,64}$/.test(j.decision ?? "")))) incomplete.push(id);
    } catch { incomplete.push(id); }
  }
  return { incomplete, reviewed };
}
async function writeFiles(dir, files, replace = false) {
  const touchedDirs = new Set([dir]);
  for (const rel of Object.keys(files).sort()) {
    const parts = rel.split("/");
    if (parts.length > 1) {
      ensurePrivatePath(dir, parts.slice(0, -1));
      for (let i = 1; i < parts.length; i++) touchedDirs.add(join(dir, ...parts.slice(0, i)));
    }
    const path = join(dir, ...parts);
    if (replace && info(path)) await atomicReplace(path, files[rel]); else await writeNewFile(path, files[rel]);
  }
  for (const path of [...touchedDirs].sort((a, b) => b.length - a.length)) fsyncDir(path);
}
async function removeFiles(dir, rels) {
  for (const rel of rels) await unlink(join(dir, ...rel.split("/")));
  const dirs = new Set(rels.flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }));
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(join(dir, ...rel.split("/"))); }
    catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
  }
}

export async function performPackageAction(roots, action, {files, priorReceipt, nextReceipt, journalPath, targetHome}, {faults = {}} = {}) {
  assertWritable(roots, [action.path, journalPath], {targetHome});
  validateRoot(action.path, "target");
  if (!["create", "update", "remove"].includes(action.status)) throw new DevtwinError("INVALID_INPUT", "Invalid package action");
  if (action.status === "create") {
    await mkdir(dirname(action.path), {recursive: true, mode: 0o700});
    await mkdir(action.path, {mode: 0o700});
    await writeFiles(action.path, files);
  } else if (action.status === "update") {
    await writeFiles(action.path, files, true);
    const removed = Object.keys(priorReceipt.files).filter((rel) => !Object.hasOwn(files, rel));
    if (removed.length) await removeFiles(action.path, removed);
  } else {
    for (const rel of Object.keys(priorReceipt.files)) if (sha256(await readPrivateBytes(join(action.path, ...rel.split("/")), PACKAGE_LIMITS.fileBytes)) !== priorReceipt.files[rel]) throw new DevtwinError("CONFLICT", "Installed skill changed");
    for (const rel of Object.keys(priorReceipt.files)) await unlink(join(action.path, ...rel.split("/")));
  }
  await faults.beforeReceipt?.(action);
  assertWritable(roots, [action.path, journalPath], {targetHome});
  validateRoot(action.path, "target");
  if (action.status === "remove") {
    await unlink(join(action.path, marker));
    const dirs = new Set(Object.keys(priorReceipt.files).flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }));
    for (const rel of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(join(action.path, ...rel.split("/")));
    await rmdir(action.path);
    fsyncDir(dirname(action.path));
  } else {
    await verifyWritten(action.path, files, nextReceipt.schemaVersion === 3);
    if (action.status === "create") await writeNewFile(join(action.path, marker), canonicalJson(nextReceipt) + "\n");
    else await atomicReplace(join(action.path, marker), canonicalJson(nextReceipt) + "\n");
    fsyncDir(action.path);
  }
}

async function verifyWritten(dir, files, strictModes) {
  if (strictModes) {
    let at = dir;
    for (let i = 0; i < 3; i++, at = dirname(at)) {
      const st = lstatSync(at);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== 0o700) throw new DevtwinError("PATH_UNSAFE", "Source directory mode changed");
    }
  }
  const found = entries(dir, "", {strictModes});
  const actual = found.filter((e) => !e.directory && e.rel !== marker).map((e) => e.rel).sort();
  const expectedDirs = new Set(Object.keys(files).flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }));
  if (canonicalJson(actual) !== canonicalJson(Object.keys(files).sort()) || canonicalJson(found.filter((e) => e.directory).map((e) => e.rel).sort()) !== canonicalJson([...expectedDirs].sort())) throw new DevtwinError("INTEGRITY", "Written inventory changed");
  for (const rel of Object.keys(files)) if (sha256(await readPrivateBytes(join(dir, ...rel.split("/")), PACKAGE_LIMITS.fileBytes)) !== sha256(files[rel])) throw new DevtwinError("INTEGRITY", "Written package changed");
}
