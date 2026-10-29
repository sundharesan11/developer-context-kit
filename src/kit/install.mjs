// U44 (KTD1, KTD4, KTD5): kit install copies the running package's runtime set into <home>/.devtwin/kits/<version>-
// <digest12>, a locked folder checked against its digest. Nothing runs from it until live set-kit pins it, so there is no
// owner dialog; the hook still denies kit install --apply from agent shells. kit list shows the folders and the pinned one.
import { constants, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeSync, fsyncSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { DevtwinError } from "../errors.mjs";
import { info, checkNode, ensurePrivateDir, fsyncDir, readPrivateJson } from "../storage/fsx.mjs";
import { assertKit, samePath } from "../config/pilot.mjs";
import { listRuntimeFiles } from "./runtime-files.mjs";
import { kitDigest, writeManifest, readManifest, verifyKit, COMMIT, VERSION } from "./manifest.mjs";
import { kitId, displayKitId, kitsFolder } from "./identity.mjs";
import { gitCommit } from "./version.mjs";
const KIT = resolve(import.meta.dirname, "../..");
// A folder being staged, or left by an interrupted install. kit list and assertKit never name it.
export const TEMP_PREFIX = ".tmp-";
// One apply at a time per kits folder: the lock is held from the stale temp cleanup to the final check, so a run never
// removes the folder another run is staging. A lock older than LOCK_STALE_MS was left by a killed run and is replaced.
export const INSTALL_LOCK = ".install.lock";
const LOCK_STALE_MS = 10 * 60 * 1000;
function takeLock(kits) {
  const path = join(kits, INSTALL_LOCK);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const node = info(path);
      if (attempt === 0 && node && Date.now() - node.mtimeMs > LOCK_STALE_MS) { removeTree(path); continue; }
      throw new DevtwinError("CONFLICT", "Another kit install is running", { field: "kits", reason: "install-running" });
    }
    try { writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    const own = lstatSync(path);
    // Removes the lock only while the path still names this run's file.
    return () => { try { const now = lstatSync(path); if (now.dev === own.dev && now.ino === own.ino) unlinkSync(path); } catch { /* Already gone. */ } };
  }
}
const corrupt = (kitRoot, error) => new DevtwinError("KIT_CORRUPT", "Kit folder present but does not verify", { kitRoot, reason: error.details?.reason ?? null });
// The KTD4 lock: files 0400, an executable file (only bin/devtwin.mjs in a release) 0500, folders 0500 deepest-first.
// The top folder is locked by the caller after it moves: macOS refuses to rename a folder its owner cannot write.
function lockTree(path, { top = true } = {}) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) lockTree(child);
    else chmodSync(child, info(child).mode & 0o100 ? 0o500 : 0o400);
  }
  if (top) chmodSync(path, 0o500);
}
// Removes a tree through no link: a link is unlinked, never followed. Folders get their owner write bits back first.
function removeTree(path) {
  const node = info(path);
  if (!node) return;
  if (node.uid !== process.getuid()) throw new DevtwinError("PATH_UNSAFE", "Unsafe private path", { path });
  if (!node.isDirectory()) return unlinkSync(path);
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) removeTree(join(path, name));
  rmdirSync(path);
}
// One runtime file, read through no final link and written new, keeping only the owner execute bit.
function copyFile(from, to) {
  const src = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(src);
    if (!st.isFile()) throw new DevtwinError("PATH_UNSAFE", "Kit holds a link or special file", { paths: [from] });
    const bytes = readFileSync(src);
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    const dst = openSync(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, st.mode & 0o100 ? 0o700 : 0o600);
    try { let off = 0; while (off < bytes.length) off += writeSync(dst, bytes, off, bytes.length - off); fsyncSync(dst); } finally { closeSync(dst); }
  } finally { closeSync(src); }
}
// Everything both the plan and the apply check, with no write.
function prepare({ home = homedir(), kitRoot } = {}) {
  const source = kitRoot ?? KIT;
  if (info(join(source, ".git")) || gitCommit(source)) throw new DevtwinError("GATE_REQUIRED", "Kit install runs from a package", { field: "kitRoot", reason: "git-clone", note: "This kit is a Git clone: pin the clone itself with live set-kit; kit install copies an npm package" });
  const devtwin = join(home, ".devtwin"), kits = kitsFolder(home);
  // devtwin never creates ~/.devtwin; the owner makes it at 0700.
  checkNode(info(devtwin), devtwin, { directory: true });
  const kitsNode = info(kits);
  if (kitsNode) checkNode(kitsNode, kits, { directory: true });
  const files = listRuntimeFiles(source), pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (typeof pkg.version !== "string" || !VERSION.test(pkg.version)) throw new DevtwinError("INVALID_INPUT", "Kit version invalid", { field: "version" });
  const version = pkg.version, digest = kitDigest(source, files), identity = { kind: "package", version, digest };
  const target = join(kits, version + "-" + digest.slice(0, 12));
  // npm records the source commit as gitHead when it packs from a clone.
  const sourceCommit = typeof pkg.gitHead === "string" && COMMIT.test(pkg.gitHead) ? pkg.gitHead : null;
  const plan = { applied: false, status: present(target, identity, home) ? "present" : "new", kitRoot: target, version, digest, kitId: kitId(identity), files: files.length,
    staleTemp: kitsNode ? readdirSync(kits).filter((name) => name.startsWith(TEMP_PREFIX)).length : 0, next: "devtwin live set-kit --kit " + version + "+" + digest };
  return { plan, source, kits, identity, sourceCommit };
}
// True for a folder that passes the kit gate, false for none; a folder that fails is never overwritten.
function present(target, identity, home) {
  if (!info(target)) return false;
  try { assertKit(target, identity, { home }); } catch (error) { if (error.code === "DEVTWIN_GATE_REQUIRED") throw corrupt(target, error); throw error; }
  return true;
}
export const planKitInstall = (ctx = {}) => prepare(ctx).plan;
// ctx.faults are test seams: beforeCopy runs after the plan, before the first copy; beforeRename gets the staged folder.
export async function applyKitInstall(ctx = {}) {
  const { plan, source, kits, identity, sourceCommit } = prepare(ctx), home = ctx.home ?? homedir();
  if (plan.status === "present") return plan;
  ensurePrivateDir(kits);
  const release = takeLock(kits);
  try { return await install({ plan, source, kits, identity, sourceCommit, home, faults: ctx.faults ?? {} }); } finally { release(); }
}
async function install({ plan, source, kits, identity, sourceCommit, home, faults }) {
  for (const name of readdirSync(kits)) if (name.startsWith(TEMP_PREFIX)) removeTree(join(kits, name));
  const temp = join(kits, TEMP_PREFIX + randomBytes(8).toString("hex"));
  mkdirSync(temp, { mode: 0o700 });
  try {
    if (faults.beforeCopy) await faults.beforeCopy();
    for (const rel of listRuntimeFiles(source)) copyFile(join(source, rel), join(temp, rel));
    const manifest = await writeManifest(temp, { sourceCommit });
    // The folder name comes from the plan's digest, so a source that changed while it was copied is refused.
    if (manifest.digest !== identity.digest || manifest.version !== identity.version) throw new DevtwinError("INTEGRITY", "Kit changed while it was copied", { field: "kitRoot" });
    verifyKit(temp);
    lockTree(temp, { top: false });
    // Another install may have finished first: keep its folder when it verifies, refuse it when it does not.
    if (present(plan.kitRoot, identity, home)) { removeTree(temp); return { ...plan, status: "present" }; }
    if (faults.beforeRename) faults.beforeRename(temp);
    renameSync(temp, plan.kitRoot);
  } catch (error) {
    try { removeTree(temp); } catch { /* The original error matters more. */ }
    if (error.code === "ENOTEMPTY" || error.code === "EEXIST") throw corrupt(plan.kitRoot, error);
    throw error;
  }
  chmodSync(plan.kitRoot, 0o500);
  fsyncDir(kits);
  try { assertKit(plan.kitRoot, identity, { home }); } catch (error) { throw corrupt(plan.kitRoot, error); }
  return { ...plan, applied: true, status: "installed" };
}
// The kit folders, sorted, with their kitId, whether they pass the kit gate, and which one the live config pins. The
// config is --pilot, or <home>/.devtwin/live.json when there is one; read-only, and it loads no kit.
export async function listKits({ home = homedir(), pilot } = {}) {
  const path = pilot ?? join(home, ".devtwin", "live.json");
  let config = null;
  try { config = await readPrivateJson(path); } catch (error) { if (pilot !== undefined || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error; }
  const pinned = typeof config?.live?.kitRoot === "string" ? config.live.kitRoot : null, kits = kitsFolder(home);
  const names = info(kits)?.isDirectory() ? readdirSync(kits).filter((name) => !name.startsWith(".")).sort() : [];
  return {
    pilot: config ? path : null,
    kits: names.map((name) => {
      const kitRoot = join(kits, name);
      let identity = null, reason = null;
      try { const m = readManifest(kitRoot); identity = { kind: "package", version: m.version, digest: m.digest }; assertKit(kitRoot, identity, { home }); }
      catch (error) { if (error.code !== "DEVTWIN_GATE_REQUIRED") throw error; reason = error.details?.reason ?? "manifest"; }
      return { name, kitRoot, kitId: identity && kitId(identity), display: identity && displayKitId(identity), status: reason ? "bad" : "ok", reason, pinned: pinned !== null && samePath(pinned, kitRoot) };
    })
  };
}
