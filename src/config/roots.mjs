import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { info, ensurePrivateDir, overlaps } from "../storage/fsx.mjs";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "./pilot.mjs";
export const defaultRoots = (home) => ({ configRoot: join(home, ".config/devctx"), dataRoot: join(home, ".local/share/devctx"), stateRoot: join(home, ".local/state/devctx") });
export function deepestExisting(path) { let p = path; while (!info(p)) { const parent = dirname(p); if (parent === p) break; p = parent; } return p; }
export function validateRoot(path, label, allowFile = false) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new DevctxError("GATE_REQUIRED", "Non-canonical pilot path", { field: label });
  const ancestor = deepestExisting(path);
  if (!lstatSync(ancestor).isDirectory() && !(allowFile && ancestor === path && lstatSync(ancestor).isFile())) throw new DevctxError("GATE_REQUIRED", "Non-directory pilot ancestor", { field: label });
  if (realpathSync(ancestor) !== ancestor) throw new DevctxError("PATH_UNSAFE", "Symlink ancestor", { field: label });
  return path;
}
export function ensureRoots(roots) {
  assertWritable(roots, [roots.configRoot, roots.dataRoot, roots.stateRoot]);
  if (overlaps(roots.configRoot, roots.dataRoot) || overlaps(roots.configRoot, roots.stateRoot) || overlaps(roots.dataRoot, roots.stateRoot)) throw new DevctxError("PATH_UNSAFE", "Overlapping roots");
  for (const [label, path] of Object.entries(roots).filter(([key]) => key.endsWith("Root"))) {
    validateRoot(path, label);
    ensurePrivateDir(path);
  }
}
