import { dirname, isAbsolute, join, resolve } from "node:path";
import { realpathSync, lstatSync } from "node:fs";
import { info, ensurePrivateDir, overlaps } from "../storage/fsx.mjs";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "./pilot.mjs";
export const defaultRoots = (home) => ({ configRoot: join(home, ".config/devtwin"), dataRoot: join(home, ".local/share/devtwin"), stateRoot: join(home, ".local/state/devtwin") });
export function deepestExisting(path) { let p = path; while (!info(p)) { const parent = dirname(p); if (parent === p) break; p = parent; } return p; }
// Control, format and line-separator characters never belong in a path devtwin writes or shows: they could forge a
// line in an owner dialog or hide part of a path.
export const UNSAFE_PATH_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
export function validateRoot(path, label, allowFile = false) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new DevtwinError("GATE_REQUIRED", "Non-canonical pilot path", { field: label });
  if (UNSAFE_PATH_CHARS.test(path)) throw new DevtwinError("PATH_UNSAFE", "Control or format character in path", { field: label });
  const ancestor = deepestExisting(path);
  if (!lstatSync(ancestor).isDirectory() && !(allowFile && ancestor === path && lstatSync(ancestor).isFile())) throw new DevtwinError("GATE_REQUIRED", "Non-directory pilot ancestor", { field: label });
  if (realpathSync(ancestor) !== ancestor) throw new DevtwinError("PATH_UNSAFE", "Symlink ancestor", { field: label });
  return path;
}
export function ensureRoots(roots) {
  assertWritable(roots, [roots.configRoot, roots.dataRoot, roots.stateRoot]);
  if (overlaps(roots.configRoot, roots.dataRoot) || overlaps(roots.configRoot, roots.stateRoot) || overlaps(roots.dataRoot, roots.stateRoot)) throw new DevtwinError("PATH_UNSAFE", "Overlapping roots");
  for (const [label, path] of Object.entries(roots).filter(([key]) => key.endsWith("Root"))) {
    validateRoot(path, label);
    ensurePrivateDir(path);
  }
}
