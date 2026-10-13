import { existsSync, lstatSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { readRegistry } from "./registry.mjs";
import { readSnapshot, verifyManifestBundles } from "../records/store.mjs";
import { readBindingVersion, readManifest } from "./store.mjs";
import { describeLock } from "../storage/lock.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { locateWorktree } from "../identity/git.mjs";
const check = (id, status, detail) => ({ id, status, detail });
async function names(path) { try { return (await readdir(path)).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; } }
export async function runDoctor(roots) {
  const checks = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push(check("node", major > 22 || major === 22 && minor >= 13 ? "ok" : "fail", process.versions.node));
  const git = spawnSync("git", ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  checks.push(check("git", git.status === 0 ? "ok" : "unavailable", git.status === 0 ? "available" : "missing"));
  const rootStates = [roots.configRoot, roots.dataRoot, roots.stateRoot].map((path) => {
    if (!existsSync(path)) return "missing";
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid() && !(st.mode & 0o077) ? "ok" : "unsafe";
  });
  checks.push(check("roots", rootStates.includes("unsafe") ? "fail" : rootStates.includes("missing") ? "unavailable" : "ok", rootStates));
  const lockNames = await names(join(roots.stateRoot, "locks"));
  const locks = await Promise.all(lockNames.map(async (name) => ({ name, holder: await describeLock(join(roots.stateRoot, "locks", name)) })));
  checks.push(check("locks", locks.length ? "warn" : "ok", locks));
  const orphans = [];
  const scopesDir = join(roots.dataRoot, "scopes");
  for (const scope of await names(scopesDir)) {
    const projectsDir = join(scopesDir, scope, "projects");
    for (const project of await names(projectsDir)) {
      for (const id of await names(join(projectsDir, project, "staging"))) orphans.push({ scope, project, id });
    }
  }
  checks.push(check("orphan-staging", orphans.length ? "warn" : "ok", orphans));
  let registry;
  try { registry = (await readRegistry(roots)).value; }
  catch (error) { checks.push(check("registry", existsSync(join(roots.configRoot, "registry.json")) ? "fail" : "unavailable", error.code ?? "unavailable")); }
  let bundleProblems = 0, boundProblems = 0, registryProblems = 0, gitQueryFailed = 0;
  if (registry) for (const entry of registry.bindings) {
    try {
      const op = registry.operations.find((x) => x.operationId === entry.operationId);
      if (!op || op.manifestHash !== entry.manifestHash) throw new Error("operation mismatch");
      await readBindingVersion(roots, entry);
      const manifest = await readManifest(roots, entry.scope, entry.project, entry.operationId, entry.manifestHash);
      if (manifest.bindingHash !== entry.bindingHash) throw new Error("binding mismatch");
      await verifyManifestBundles(roots, entry.scope, entry.project, manifest);
    } catch { registryProblems++; }
    try { const snap = await readSnapshot(roots, entry.scope, entry.project); bundleProblems += snap.corrupt.length; }
    catch { bundleProblems++; }
    try { const loc = await locateWorktree(entry.path); if (!loc.git || loc.commonDir !== entry.commonDir) boundProblems++; }
    catch (error) { if (error?.code === "DEVCTX_GIT_QUERY_FAILED") gitQueryFailed++; else boundProblems++; }
  }
  if (registry) checks.push(check("registry", registryProblems ? "fail" : "ok", registryProblems ? { code: "DEVCTX_RECOVERY_REQUIRED", invalidEntries: registryProblems } : { generation: registry.generation }));
  checks.push(check("bundles", bundleProblems ? "fail" : registry ? "ok" : "unavailable", { corrupt: bundleProblems }));
  const incomplete = [];
  for (const run of await names(join(roots.stateRoot, "runs"))) {
    const path = join(roots.stateRoot, "runs", run, "journal.json");
    if (!existsSync(path)) continue;
    try { const j = await readPrivateJson(path); if (!Array.isArray(j.intended) || !Array.isArray(j.completed) || j.completed.length < j.intended.length) incomplete.push(run); }
    catch { incomplete.push(run); }
  }
  checks.push(check("install-journals", incomplete.length ? "warn" : "ok", incomplete));
  checks.push(check("bound-roots", boundProblems || gitQueryFailed ? "fail" : registry ? "ok" : "unavailable", gitQueryFailed ? { code: "DEVCTX_GIT_QUERY_FAILED", changed: boundProblems, gitQueryFailed } : { changed: boundProblems }));
  return { ok: !checks.some((c) => c.status === "fail"), checks };
}
