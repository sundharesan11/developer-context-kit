import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { info, ensurePrivateDir, overlaps } from "../storage/fsx.mjs";
import { DevctxError } from "../errors.mjs";
export const defaultRoots = (home) => ({ configRoot: join(home, ".config/devctx"), dataRoot: join(home, ".local/share/devctx"), stateRoot: join(home, ".local/state/devctx") });
export function deepestExisting(path) { let p = path; while (!info(p)) { const parent = dirname(p); if (parent === p) break; p = parent; } return p; }
export function validateRoot(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new DevctxError("GATE_REQUIRED", "Non-canonical pilot path", { field: label });
  const ancestor = deepestExisting(path);
  if (realpathSync(ancestor) !== ancestor) throw new DevctxError("PATH_UNSAFE", "Symlink ancestor", { field: label });
  return path;
}
export function ensureRoots(roots) {
  for (const [label, path] of Object.entries(roots).filter(([key]) => key.endsWith("Root"))) {
    validateRoot(path, label);
    ensurePrivateDir(path);
  }
  if (overlaps(roots.configRoot, roots.dataRoot) || overlaps(roots.configRoot, roots.stateRoot) || overlaps(roots.dataRoot, roots.stateRoot)) throw new DevctxError("PATH_UNSAFE", "Overlapping roots");
}
