// U42 (KTD3, KTD7): the runtime set, defined once. It is the package.json `files` allowlist plus package.json, which npm
// always packs. The package audit checks that `files` equals RUNTIME_ENTRIES and that the pack equals this set.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
export const RUNTIME_ENTRIES = Object.freeze(["bin/", "src/", "skills/", "templates/", "schemas/", "catalog/", "LICENSE", "NOTICE", "README.md"]);
// Finder litter, which npm never packs.
const IGNORED = new Set([".DS_Store"]);
// The runtime files under root as sorted relative paths, and every entry that is not a plain file or folder.
// A missing entry is left out, as npm leaves it out of the pack.
export function scanRuntime(root) {
  const files = [], refused = [];
  const visit = (rel) => {
    let st;
    try { st = lstatSync(join(root, rel)); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (st.isDirectory()) { for (const name of readdirSync(join(root, rel))) if (!IGNORED.has(name)) visit(rel + "/" + name); }
    else if (st.isFile()) files.push(rel);
    else refused.push({ path: rel, reason: st.isSymbolicLink() ? "link" : "special" });
  };
  for (const entry of ["package.json", ...RUNTIME_ENTRIES]) visit(entry.replace(/\/$/, ""));
  return { files: files.sort(), refused: refused.sort((a, b) => a.path < b.path ? -1 : 1) };
}
// The runtime files of a kit root. A link or special file anywhere in the set is refused.
export function listRuntimeFiles(root) {
  const { files, refused } = scanRuntime(root);
  if (refused.length) throw new DevtwinError("PATH_UNSAFE", "Kit holds a link or special file", { paths: refused.map((r) => r.path) });
  return files;
}
