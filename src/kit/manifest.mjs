// U43 (KTD3): the package kit digest and KIT-MANIFEST.json. The digest is SHA-256 over the sorted lines
// `path NUL mode NUL sha256(file)`, one per file in the runtime set (src/kit/runtime-files.mjs), each line ending in LF.
// mode is the file mode as npm and Git normalize it: "755" when the owner execute bit is set, otherwise "644". So the
// source checkout, the packed tarball and the read-only installed copy (0400 and 0500, KTD4) all have one digest, and
// only an executable bit change, not a chmod for the lock, changes it. The manifest is not part of the digest.
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { writeNewFile } from "../storage/fsx.mjs";
import { scanRuntime, listRuntimeFiles } from "./runtime-files.mjs";
export const MANIFEST = "KIT-MANIFEST.json";
export const DIGEST = /^[0-9a-f]{64}$/;
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// A release version, without build metadata: a "+" would make the kitId ambiguous.
export const VERSION = /^(?=.{5,64}$)(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_MANIFEST_BYTES = 1048576;
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const refuse = (reason, field = "kitRoot", details = {}) => { throw new DevtwinError("GATE_REQUIRED", "Kit refused", { field, reason, ...details }); };
const RELATIVE = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[^/\0][^\0]*$/;
export function kitDigest(root, files = listRuntimeFiles(root)) {
  const lines = [...files].sort().map((rel) => rel + "\0" + (lstatSync(join(root, rel)).mode & 0o100 ? "755" : "644") + "\0" + hex(readFileSync(join(root, rel))) + "\n");
  return hex(lines.join(""));
}
function validManifest(m) {
  return Boolean(m) && typeof m === "object" && !Array.isArray(m) && Object.keys(m).sort().join(",") === "digest,files,schemaVersion,sourceCommit,version"
    && m.schemaVersion === 1 && typeof m.version === "string" && VERSION.test(m.version) && typeof m.digest === "string" && DIGEST.test(m.digest)
    && (m.sourceCommit === null || (typeof m.sourceCommit === "string" && COMMIT.test(m.sourceCommit)))
    && Array.isArray(m.files) && m.files.length > 0 && m.files.every((f, i) => typeof f === "string" && RELATIVE.test(f) && f !== MANIFEST && (i === 0 || m.files[i - 1] < f));
}
// The fast read: the manifest alone, through no link, checked for shape only. The hook fast path and the identity of a
// running kit use it; only verifyKit says the files match it.
export function readManifest(root) {
  let fd;
  try { fd = openSync(join(root, MANIFEST), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { refuse("manifest"); }
  let manifest;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) refuse("manifest");
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) { const n = readSync(fd, buf, offset, buf.length - offset, offset); if (!n) break; offset += n; }
    manifest = JSON.parse(buf.subarray(0, offset).toString("utf8"));
  } catch (error) { if (error instanceof DevtwinError) throw error; refuse("manifest"); } finally { closeSync(fd); }
  if (!validManifest(manifest)) refuse("manifest");
  return manifest;
}
// The manifest for a staged kit folder, from its package.json version and runtime set. U44 writes it before the lock.
export function buildManifest(root, { sourceCommit = null } = {}) {
  const files = listRuntimeFiles(root), { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const manifest = { schemaVersion: 1, version, digest: kitDigest(root, files), files, sourceCommit };
  if (!validManifest(manifest)) throw new DevtwinError("INVALID_INPUT", "Kit manifest invalid", { field: "manifest" });
  return manifest;
}
export async function writeManifest(root, options) {
  const manifest = buildManifest(root, options);
  await writeNewFile(join(root, MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}
// The full check: every entry under root is a plain file with one link or a folder (check(path, node, rel) sees each,
// root first), the files are exactly the manifest's plus the manifest, the runtime set is exactly the manifest's list
// and the digest recomputes. lstat is a test seam for the owner checks. Throws GATE_REQUIRED with the reason; returns the manifest.
export function verifyKit(root, { lstat = lstatSync, check = () => {}, field = "kitRoot" } = {}) {
  const files = [];
  const visit = (rel) => {
    const path = rel ? join(root, rel) : root, node = lstat(path);
    if (node.isSymbolicLink()) refuse("link", field);
    if (!node.isDirectory() && !node.isFile()) refuse("special", field);
    // A hard-linked file shares its bytes with a path outside the kit, which a write there would change.
    if (node.isFile() && node.nlink !== 1) refuse("hardlink", field);
    check(path, node, rel);
    if (node.isFile()) return files.push(rel);
    const names = readdirSync(path);
    // An empty folder is not in any listing of files, so it is an extra entry.
    if (!names.length && rel) refuse("listing", field);
    for (const name of names) visit(rel ? rel + "/" + name : name);
  };
  visit("");
  let manifest;
  try { manifest = readManifest(root); } catch (error) { refuse(error.details?.reason ?? "manifest", field); }
  const want = [...manifest.files, MANIFEST].sort();
  if (files.sort().join("\0") !== want.join("\0")) refuse("listing", field);
  const runtime = scanRuntime(root);
  if (runtime.refused.length || runtime.files.join("\0") !== manifest.files.join("\0")) refuse("listing", field);
  if (kitDigest(root, runtime.files) !== manifest.digest) refuse("digest", field);
  return { manifest };
}
