import { constants, lstatSync, realpathSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { DevtwinError } from "../errors.mjs";
export const SOURCE_LIMITS = { maxFiles: 24, maxBytes: 131072 };
const REL = /^[A-Za-z0-9._\/-]{1,200}$/;
const segmentDeny = [/^\.env/i, /^\.git$/i, /^node_modules$/i, /^(\.npmrc|\.pypirc|\.netrc|\.pgpass|id_[a-z0-9]+|credentials(\.json)?)$/i];
const finalDeny = /\.(pem|key|p12|pfx|kdbx|sqlite3?|db)$/i;
export function assertSourceRel(rel) {
  if (typeof rel !== "string" || !REL.test(rel) || rel.split("/").some((part) => !part || part === "." || part === "..")) throw new DevtwinError("PATH_ESCAPE", "Unsafe source path");
  return rel;
}
export function isDeniedRel(rel) {
  assertSourceRel(rel);
  const parts = rel.split("/");
  return parts.some((part) => segmentDeny.some((rule) => rule.test(part))) || finalDeny.test(parts.at(-1));
}
const changed = () => new DevtwinError("SOURCE_CHANGED", "Approved source changed");
function ancestors(root, rel) {
  const parts = rel.split("/").slice(0, -1);
  const paths = [root];
  for (const part of parts) paths.push(join(paths.at(-1), part));
  const result = [];
  for (const path of paths) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return { skipped: "absent" }; throw error; }
    if (stat.isSymbolicLink()) return { skipped: "symlink" };
    if (!stat.isDirectory()) return { skipped: "not-regular" };
    result.push({ dev: stat.dev, ino: stat.ino });
  }
  return { paths, result };
}
export async function readApprovedSource(root, rel, { faults = {} } = {}) {
  assertSourceRel(rel);
  if (isDeniedRel(rel)) return { rel, skipped: "denied" };
  const beforeAncestors = ancestors(root, rel);
  if (beforeAncestors.skipped) return { rel, skipped: beforeAncestors.skipped };
  const path = join(root, rel);
  let handle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === "ELOOP") return { rel, skipped: "symlink" };
    if (error.code === "ENOENT") return { rel, skipped: "absent" };
    throw error;
  }
  try {
    const st1 = await handle.stat();
    if (!st1.isFile()) return { rel, skipped: "not-regular" };
    if (st1.size > SOURCE_LIMITS.maxBytes) return { rel, skipped: "too-large" };
    if (faults.afterStat) await faults.afterStat();
    const buf = Buffer.alloc(SOURCE_LIMITS.maxBytes + 1);
    let off = 0;
    while (off < buf.length) {
      const { bytesRead } = await handle.read(buf, off, buf.length - off, off);
      if (!bytesRead) break;
      off += bytesRead;
      if (off > st1.size || off > SOURCE_LIMITS.maxBytes) throw changed();
    }
    if (buf.subarray(0, off).includes(0)) return { rel, skipped: "binary" };
    if (faults.afterRead) await faults.afterRead();
    const st2 = await handle.stat();
    if (st1.dev !== st2.dev || st1.ino !== st2.ino || st1.size !== st2.size || st1.mtimeMs !== st2.mtimeMs || st1.ctimeMs !== st2.ctimeMs || off !== st2.size) throw changed();
    const afterAncestors = ancestors(root, rel);
    if (afterAncestors.skipped || JSON.stringify(beforeAncestors.result) !== JSON.stringify(afterAncestors.result)) throw changed();
    let final;
    try { final = lstatSync(path); } catch { throw changed(); }
    if (final.dev !== st1.dev || final.ino !== st1.ino || final.isSymbolicLink()) throw changed();
    if (realpathSync(dirname(path)) !== join(root, dirname(rel))) throw changed();
    const bytes = buf.subarray(0, off);
    const text = bytes.toString("utf8");
    return { rel, dev: st1.dev, ino: st1.ino, size: st1.size, mtimeMs: st1.mtimeMs, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex"), ancestors: beforeAncestors.result, text, utf8Valid: Buffer.from(text, "utf8").equals(bytes) };
  } finally { await handle.close(); }
}
// File identity (KTD3): sha256 of the exact bytes is the authority. dev, ino, size and the ancestor chain
// must also match when a binding is verified. mtimeMs is stored for compatibility and is informational only:
// its millisecond float loses precision, so it is never compared across reads; within one read, the
// mtimeMs/ctimeMs comparison above only detects a change racing that read.
export function sourceIdentity(bound) {
  const { rel, dev, ino, size, mtimeMs, sha256, ancestors } = bound;
  return { rel, dev, ino, size, mtimeMs, sha256, ancestors };
}
export async function verifySourceBinding(root, identity) {
  const actual = await readApprovedSource(root, identity.rel);
  if (actual.skipped || ["dev", "ino", "size", "sha256"].some((key) => actual[key] !== identity[key]) || JSON.stringify(actual.ancestors) !== JSON.stringify(identity.ancestors)) throw changed();
}
export async function checkSourceFreshness(root, identity) {
  try {
    const actual = await readApprovedSource(root, identity.rel);
    if (actual.skipped) return "source-missing";
    return actual.sha256 === identity.sha256 ? "current" : "needs-revalidation";
  } catch { return "source-missing"; }
}
