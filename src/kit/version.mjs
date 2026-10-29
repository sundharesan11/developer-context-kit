// U42 (KTD9): the version comes from the kit's package.json. A Git clone adds its commit, read from .git as the hook
// reads .git/HEAD (src/hooks/receipt.mjs): a few small reads, no Git process.
import { readFileSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
const KIT = resolve(import.meta.dirname, "../..");
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const read = (path) => readFileSync(path, "utf8").trim();
// The commit HEAD names, or null when the kit is not a Git clone or the refs cannot be read.
export function gitCommit(root) {
  try {
    let dir = join(root, ".git");
    if (lstatSync(dir).isFile()) dir = resolve(root, read(dir).match(/^gitdir: (.+)$/m)[1]);
    const head = read(join(dir, "HEAD"));
    if (OID.test(head)) return head;
    const ref = head.match(/^ref: (refs\/[\w./-]+)$/)?.[1];
    if (!ref) return null;
    let common = dir;
    try { common = resolve(dir, read(join(dir, "commondir"))); } catch {}
    try { const oid = read(join(common, ref)); if (OID.test(oid)) return oid; } catch {}
    const line = read(join(common, "packed-refs")).split("\n").find((l) => l.endsWith(" " + ref))?.split(" ")[0];
    return OID.test(line ?? "") ? line : null;
  } catch { return null; }
}
export function kitVersion(root = KIT) {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")), commit = gitCommit(root);
  return commit ? { name: "devtwin", version, commit } : { name: "devtwin", version };
}
