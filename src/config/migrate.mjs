import { readdirSync, realpathSync, mkdirSync, chmodSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { loadPilot, checkLiveConfig, rootsFromPilot } from "./pilot.mjs";
import { KEYS, configPath, configText, runningKit, assertConfigDir, storeLayout } from "./live.mjs";
import { info, overlaps, isWithin, readPrivateBytes, writeNewFile, fsyncDir } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sha256, digest, canonicalJson } from "../storage/canonical.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { gitQuery } from "../identity/git.mjs";
import { incompleteInstallRuns } from "../agents/install.mjs";
import { envNotes, KIT_ENV, LEGACY_KIT_ENV } from "./legacy.mjs";
// live migrate copies a live setup made under the former devctx name (by default ~/.devctx) to a new live config folder
// (by default ~/.devtwin). It runs from the new kit, never writes to the legacy folder (apart from holding its locks),
// and never deletes it. The copy is staged beside the new store and renamed into place only after it verifies.
const STAGING = ".store-migrating";
const RECEIPT = ["state", "live", "migration.json"], APPROVAL = ["state", "live", "approved-config.json"];
const TEMP = /^\.devtwin-migrate-[0-9a-f]{16}\.tmp$/;
const NODE_LIMIT = 200000, FILE_LIMIT = 256 * 1048576, JSON_LIMIT = 16 * 1048576;
// Config files whose absolute paths into the legacy folder are rewritten. Other files are immutable or hashed and are only reported.
const REWRITABLE = (rel) => /^config\/scopes\/[^/]+\.json$/.test(rel);
const gate = (field, reason, extra = {}) => { throw new DevtwinError("GATE_REQUIRED", "Live migrate gate refused", { field, reason, ...extra }); };
const conflict = (message, details) => { throw new DevtwinError("CONFLICT", message, details); };
const relOf = (parts) => parts.join("/");
const quote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
function realDir(path, field) {
  try { return realpathSync.native(path); } catch { throw new DevtwinError("PATH_UNSAFE", "Live config folder must exist and be private", { field }); }
}
// Every node under root, parents before children, as { path, type, mode, size, sha256 }. Symlinks, foreign owners,
// group or other access, special bits and hard-linked files are refused: the store is private and never holds them.
async function walk(root, { skip = new Set(), temps = false } = {}) {
  const rows = [];
  async function visit(rel) {
    const path = rel ? join(root, ...rel.split("/")) : root, st = info(path);
    if (!st) return;
    if (rows.length >= NODE_LIMIT) throw new DevtwinError("LIMIT", "Store too large to migrate");
    const unsafe = (reason) => { throw new DevtwinError("PATH_UNSAFE", "Store holds an entry live migrate cannot copy", { path: rel || ".", reason }); };
    if (st.isSymbolicLink()) unsafe("symlink");
    if (!st.isDirectory() && !st.isFile()) unsafe("type");
    if (st.uid !== process.getuid()) unsafe("owner");
    if (st.mode & 0o7077) unsafe("mode");
    if (st.isFile()) {
      if (st.nlink !== 1) unsafe("hard-link");
      const bytes = await readPrivateBytes(path, FILE_LIMIT);
      rows.push({ path: rel, type: "file", mode: st.mode & 0o777, size: bytes.length, sha256: sha256(bytes), temp: temps && TEMP.test(basename(path)) });
      return;
    }
    if (rel) rows.push({ path: rel, type: "dir", mode: st.mode & 0o777 });
    for (const name of readdirSync(path).sort()) {
      const child = rel ? rel + "/" + name : name;
      if (!skip.has(child)) await visit(child);
    }
  }
  await visit("");
  return rows;
}
// Absolute paths into the legacy folder, as JSON pointers to string values.
function legacyPointers(value, fromDir, pointer = "") {
  if (typeof value === "string") return value === fromDir || value.startsWith(fromDir + sep) ? [pointer] : [];
  if (Array.isArray(value)) return value.flatMap((item, i) => legacyPointers(item, fromDir, pointer + "/" + i));
  if (value && typeof value === "object") return Object.keys(value).sort().flatMap((key) => legacyPointers(value[key], fromDir, pointer + "/" + key.replace(/~/g, "~0").replace(/\//g, "~1")));
  return [];
}
function rewritePaths(value, fromDir, toDir) {
  if (typeof value === "string") return value === fromDir || value.startsWith(fromDir + sep) ? toDir + value.slice(fromDir.length) : value;
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, fromDir, toDir));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePaths(item, fromDir, toDir)]));
  return value;
}
const byPath = (rows) => [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const stripRows = (rows) => rows.map(({ temp, ...row }) => row);
function nextSteps({ to, toDir, fromDir, kitRoot, agents }) {
  const cli = "node " + quote(join(kitRoot, "bin", "devtwin.mjs"));
  return [
    ...agents.map((agent) => ({ step: "replace-skills", agent, command: cli + " agents install --pilot " + quote(to) + " --agent " + agent, note: "Preview, review, then apply with --apply --plan-fingerprint. Installs devtwin-* and removes the owned legacy devctx-* entries in one journaled run." })),
    { step: "shell-profile", command: "export " + KIT_ENV + "=" + quote(kitRoot), note: "Replace the export " + LEGACY_KIT_ENV + " line in the shell profile with this one, then open a new terminal." },
    { step: "verify", command: cli + " agents status --pilot " + quote(to), note: "Expect no legacy devctx-* actions and no notes. Run a fresh-session check as in docs/LIVE.md." },
    { step: "remove-legacy-root", command: "rm -rf " + quote(fromDir), note: "Only after the checks above pass. live migrate never deletes it. Nothing under " + toDir + " depends on it." }
  ];
}
async function readJsonMaybe(path) {
  try { return JSON.parse((await readPrivateBytes(path, JSON_LIMIT)).toString("utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw new DevtwinError("INTEGRITY", "Migration receipt unreadable", { path }); }
}
// Everything a preview and an apply both need. held names lock files this process holds in the legacy store.
async function inspect(input, ctx, { held = [] } = {}) {
  if (typeof input.from !== "string") throw new DevtwinError("INVALID_INPUT", "Legacy live config required", { field: "from" });
  const to = configPath(input.configPath), from = (() => { try { return configPath(input.from); } catch { return gate("from", "path"); } })();
  const toDir = dirname(to), fromDir = dirname(from), toStore = join(toDir, "store"), staging = join(toDir, STAGING);
  assertConfigDir(toDir);
  if (!info(from)) throw new DevtwinError("NOT_FOUND", "Legacy live config not found", { field: "from" });
  const realTo = realDir(toDir, "configDir"), realFrom = realDir(fromDir, "from");
  if (realTo !== toDir || realFrom !== fromDir) gate("from", "path");
  if (overlaps(realFrom, realTo)) gate("from", "overlap");
  const kitRoot = runningKit(ctx);
  if (isWithin(kitRoot, realFrom)) gate("live.kitRoot", "inside-legacy-root");
  const head = gitQuery(kitRoot, ["rev-parse", "--verify", "HEAD"], { notRepo: true });
  if (head.notRepo) gate("live.kitRoot", "not-top-level");
  const kitCommit = head.stdout.trim(), notes = envNotes(ctx.env ?? process.env);
  // Already migrated: report it, write nothing. Later live config changes to the new config do not matter here.
  if (info(to)) {
    const receipt = await readJsonMaybe(join(toStore, ...RECEIPT)), current = await readJsonMaybe(to);
    if (!receipt || receipt.kind !== "live-migration" || receipt.from?.config !== from || receipt.configId !== current?.live?.configId) conflict("Live config already exists", { field: "pilot" });
    const agents = Object.keys(current.live.skillDirs ?? {}).sort();
    const plan = finalizePlan({ kind: "live-migrate", status: "migrated", from: { config: from, root: fromDir, configId: receipt.configId }, to: { config: to, root: toDir } });
    return { plan, notes, next: nextSteps({ to, toDir, fromDir, kitRoot: current.live.kitRoot, agents }) };
  }
  // The legacy config must load under the new code with its approval intact. The running kit stands in for its kit.
  const legacy = await loadPilot(from, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot, liveGate: { kit: { kitRoot, kitCommit } } });
  if (!legacy.live) gate("from", "not-live");
  const layout = storeLayout(fromDir);
  if (Object.entries(layout).some(([key, path]) => legacy[key] !== path)) gate("from", "layout");
  // The new config: every path into the legacy folder moves to the new folder, and the kit is the running kit.
  const raw = Object.fromEntries(KEYS.map((key) => [key, legacy[key]]));
  const fields = legacyPointers({ ...raw, live: { ...raw.live, kitRoot: null } }, fromDir);
  const config = { ...rewritePaths(raw, fromDir, toDir), live: { ...rewritePaths(raw.live, fromDir, toDir), kitRoot, kitCommit } };
  const next = checkLiveConfig(config, to, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot });
  const configId = legacy.live.configId, agents = Object.keys(legacy.live.skillDirs).sort();
  const warnings = [...next.warnings, ...(kitRoot === join(toDir, "kit") ? [] : [{ code: "KIT_NOT_SIBLING" }])];
  // A consistent legacy store: no held lock and no interrupted install.
  const lockDir = join(legacy.stateRoot, "locks"), heldRel = new Set(held.map((path) => "state/locks/" + basename(path)));
  const locks = info(lockDir) ? readdirSync(lockDir).filter((name) => !heldRel.has("state/locks/" + name)).sort() : [];
  if (locks.length) throw new DevtwinError("BUSY", "A legacy store lock is held", { locks });
  const incomplete = await incompleteInstallRuns(legacy);
  if (incomplete.length) throw new DevtwinError("RECOVERY_REQUIRED", "The legacy store has an interrupted install", { runs: incomplete, remedy: "agents recover with the legacy kit" });
  const rows = stripRows(await walk(legacy.pilotRoot, { skip: heldRel }));
  // Files whose bytes change: scope configs with legacy paths, the approval and the migration receipt.
  const overrides = new Map(), rewrites = [{ file: "live.json", pointers: fields }], references = [];
  for (const row of rows) {
    if (row.type !== "file" || !row.path.endsWith(".json") || row.size > JSON_LIMIT) continue;
    const bytes = await readPrivateBytes(join(legacy.pilotRoot, ...row.path.split("/")), JSON_LIMIT);
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { continue; }
    const pointers = legacyPointers(value, fromDir);
    if (!pointers.length) continue;
    if (REWRITABLE(row.path) && bytes.toString("utf8") === canonicalJson(value) + "\n") {
      overrides.set(row.path, Buffer.from(canonicalJson(rewritePaths(value, fromDir, toDir)) + "\n"));
      rewrites.push({ file: "store/" + row.path, pointers });
    } else if (row.path !== relOf(RECEIPT)) references.push({ file: "store/" + row.path, pointers });
  }
  if (references.length) warnings.push({ code: "LEGACY_PATH_REFERENCE", files: references });
  const manifest = digest(rows);
  overrides.set(relOf(APPROVAL), Buffer.from(JSON.stringify({ schemaVersion: 1, configId, digest: next.digest }) + "\n"));
  const receipt = { schemaVersion: 1, kind: "live-migration", configId, from: { config: from, root: fromDir, digest: legacy.digest }, to: { config: to, root: toDir, digest: next.digest, kitRoot, kitCommit }, manifest };
  overrides.set(relOf(RECEIPT), Buffer.from(canonicalJson(receipt) + "\n"));
  // The exact tree the new store must hold.
  const expected = new Map(rows.map((row) => [row.path, overrides.has(row.path) ? { ...row, size: overrides.get(row.path).length, sha256: sha256(overrides.get(row.path)) } : row]));
  for (const [path, bytes] of overrides) if (!expected.has(path)) expected.set(path, { path, type: "file", mode: 0o600, size: bytes.length, sha256: sha256(bytes) });
  if (!expected.has(dirname(relOf(APPROVAL)))) gate("from", "unapproved-store");
  let status = "migrate", partial = null;
  if (info(toStore)) {
    const found = await readJsonMaybe(join(toStore, ...RECEIPT));
    if (!found || found.kind !== "live-migration" || found.from?.config !== from) conflict("A store already exists in the new live config folder", { field: "pilotRoot" });
    if (canonicalJson(found) !== canonicalJson(receipt)) conflict("The new store was copied from a different legacy state", { field: "pilotRoot", remedy: "inspect " + toStore + ", move it aside by hand, then preview again" });
    status = "finish";
  } else {
    const allowed = new Set([STAGING, ...(dirname(kitRoot) === toDir ? [basename(kitRoot)] : [])]);
    const extra = readdirSync(toDir).filter((name) => !allowed.has(name)).sort();
    if (extra.length) conflict("The new live config folder is not empty", { field: "configDir", entries: extra });
    if (info(staging)) partial = { path: staging, ...(await partialState(staging, expected)) };
  }
  const plan = finalizePlan({
    kind: "live-migrate", status,
    from: { config: from, root: fromDir, configId, digest: legacy.digest, pilotRoot: legacy.pilotRoot },
    to: { config: to, root: toDir, pilotRoot: config.pilotRoot, digest: next.digest, kitRoot, kitCommit },
    config, rewrites,
    store: { dirs: rows.filter((r) => r.type === "dir").length, files: rows.filter((r) => r.type === "file").length, bytes: rows.reduce((n, r) => n + (r.size ?? 0), 0), manifest },
    partial, leftBehind: readdirSync(fromDir).filter((name) => name !== "store" && name !== basename(from)).sort(), warnings
  });
  return { plan, notes, next: nextSteps({ to, toDir, fromDir, kitRoot, agents }), legacy, expected, overrides, rows, paths: { to, toDir, toStore, staging }, config };
}
// A staging folder left by an interrupted apply may be discarded only when it is provably a partial copy: every file
// is an expected file with its expected bytes, or one of this module's temporary files.
async function partialState(staging, expected) {
  const st = info(staging);
  if (!st?.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) return { removable: false, reason: "not-a-private-folder" };
  let rows;
  try { rows = await walk(staging, { temps: true }); } catch (error) { return { removable: false, reason: error.details?.reason ?? "unreadable", entry: error.details?.path }; }
  for (const row of rows) {
    const want = expected.get(row.path);
    if (row.temp) continue;
    if (!want || want.type !== row.type || (row.type === "file" && want.sha256 !== row.sha256)) return { removable: false, reason: "unexpected-entry", entry: row.path };
  }
  return { removable: true, nodes: rows.length };
}
function removeTree(root) {
  const st = info(root);
  if (!st) return;
  if (st.isDirectory() && !st.isSymbolicLink()) {
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) removeTree(join(root, name));
    rmdirSync(root);
  } else unlinkSync(root);
}
async function writeFileAs(path, bytes, mode) {
  const temp = join(dirname(path), ".devtwin-migrate-" + randomBytes(8).toString("hex") + ".tmp");
  await writeNewFile(temp, bytes);
  chmodSync(temp, mode);
  if (info(path)) { unlinkSync(temp); throw new DevtwinError("CONFLICT", "Staged file already exists", { path }); }
  renameSync(temp, path);
}
// faults.afterFile, beforeRename and afterRename are test seams that crash part way.
async function copyStore(state, faults) {
  const { legacy, expected, overrides, rows, paths } = state;
  try { mkdirSync(paths.staging, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new DevtwinError("CONFLICT", "Staging folder already exists", { path: paths.staging }); throw error; }
  chmodSync(paths.staging, 0o700);
  try {
    for (const row of rows) {
      const dest = join(paths.staging, ...row.path.split("/"));
      if (row.type === "dir") { mkdirSync(dest, { mode: 0o700 }); chmodSync(dest, 0o700); continue; }
      let bytes = await readPrivateBytes(join(legacy.pilotRoot, ...row.path.split("/")), FILE_LIMIT);
      if (sha256(bytes) !== row.sha256) throw new DevtwinError("STALE_VERSION", "Legacy store changed during migrate", { path: row.path });
      if (overrides.has(row.path)) bytes = overrides.get(row.path);
      await writeFileAs(dest, bytes, row.mode);
      await faults.afterFile?.(row.path);
    }
    for (const [path, bytes] of overrides) if (!rows.some((row) => row.path === path)) await writeFileAs(join(paths.staging, ...path.split("/")), bytes, 0o600);
    // Directory modes last, deepest first, so a read-only source folder still received its files.
    for (const row of [...rows].reverse()) if (row.type === "dir") { const dest = join(paths.staging, ...row.path.split("/")); fsyncDir(dest); chmodSync(dest, row.mode); }
    fsyncDir(paths.staging);
    // The staged tree must be exactly the expected tree, and the legacy store must not have moved meanwhile.
    const staged = stripRows(await walk(paths.staging));
    if (digest(byPath(staged)) !== digest(byPath([...expected.values()]))) throw new DevtwinError("INTEGRITY", "Staged store differs from the plan");
    const again = stripRows(await walk(legacy.pilotRoot, { skip: state.heldRel }));
    if (digest(again) !== digest(rows)) throw new DevtwinError("STALE_VERSION", "Legacy store changed during migrate");
    await faults.beforeRename?.();
  } catch (error) {
    // This call made the staging folder, so it removes it again. A crash instead leaves it for the next preview.
    try { removeTree(paths.staging); } catch { /* The original error matters more. */ }
    throw error;
  }
  renameSync(paths.staging, paths.toStore);
  fsyncDir(paths.toDir);
  await faults.afterRename?.();
}
const output = (state, extra = {}) => ({ ...state.plan, ...extra, notes: state.notes, next: state.next });
export async function previewLiveMigrate(input, ctx) {
  return output(await inspect(input, ctx), { preview: true });
}
export async function applyLiveMigrate(input, ctx, { faults = {} } = {}) {
  const first = await inspect(input, ctx);
  assertFingerprint(first.plan, input.fingerprint);
  if (first.plan.status === "migrated") return output(first, { applied: false });
  const roots = rootsFromPilot(first.legacy), locks = join(roots.stateRoot, "locks");
  const liveLock = join(locks, "live.lock"), installLock = join(locks, "install.lock");
  // Holding the legacy live and install locks keeps legacy live config changes and skill installs out while copying.
  return withPilotLock(roots, liveLock, { kind: "live-migrate" }, () => withPilotLock(roots, installLock, { kind: "live-migrate" }, async () => {
    const state = await inspect(input, ctx, { held: [liveLock, installLock] });
    assertFingerprint(state.plan, input.fingerprint);
    state.heldRel = new Set(["state/locks/live.lock", "state/locks/install.lock"]);
    if (state.plan.status === "migrate") {
      if (state.plan.partial) {
        // Re-checked under the locks: discard only a staging folder that is still provably ours.
        const now = await partialState(state.paths.staging, state.expected);
        if (!now.removable) throw new DevtwinError("RECOVERY_REQUIRED", "Staging folder from an interrupted migrate is not a clean partial copy", { path: state.paths.staging, ...now });
        removeTree(state.paths.staging);
        fsyncDir(state.paths.toDir);
      }
      await copyStore(state, faults);
    }
    // The new config is written last, so a config on disk always sits on a complete, approved store.
    await writeNewFile(state.paths.to, configText(state.config));
    fsyncDir(state.paths.toDir);
    const pilot = await loadPilot(state.paths.to, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot });
    return output(state, { applied: true, status: "migrated", configId: pilot.live.configId, digest: pilot.digest });
  }, { destinations: [locks] }), { destinations: [locks] });
}
