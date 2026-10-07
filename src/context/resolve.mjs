import { realpathSync } from "node:fs";
import { resolve, relative } from "node:path";
import { DevctxError } from "../errors.mjs";
import { locateWorktree } from "../identity/git.mjs";
import { readRegistry } from "../config/registry.mjs";
import { requireCommittedProject } from "../records/store.mjs";
export async function resolveContext(roots, { scope, cwd }) {
  let canonical;
  try { canonical = realpathSync(cwd); } catch { throw new DevctxError("PATH_UNSAFE", "Working directory unavailable"); }
  if (canonical !== resolve(cwd)) throw new DevctxError("PATH_UNSAFE", "Working directory must be canonical");
  const location = await locateWorktree(canonical);
  if (!location.git) throw new DevctxError("PROJECT_UNBOUND", "No repository", { reason: "not-bound-in-scope" });
  const registry = (await readRegistry(roots)).value;
  const entry = registry.bindings.find((x) => x.path === location.root && x.scope === scope);
  if (!entry) {
    const reason = registry.bindings.some((x) => x.scope === scope && x.commonDir === location.commonDir) ? "worktree-not-confirmed" : "not-bound-in-scope";
    throw new DevctxError("PROJECT_UNBOUND", "Worktree not bound in selected scope", { reason, remedy: "project onboard --scope " + scope + " --repo <worktree>" });
  }
  const { binding } = await requireCommittedProject(roots, entry.scope, entry.project);
  if (!binding.roots.some((r) => r.path === location.root)) throw new DevctxError("RECOVERY_REQUIRED", "Binding root mismatch");
  return { state: "bound", scope, project: entry.project, binding, worktree: { root: location.root, branch: location.branch, head: location.head, dirty: location.dirty }, cwdRelative: relative(location.root, canonical), warnings: location.warnings };
}
