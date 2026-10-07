import { constants, lstatSync, realpathSync, openSync, closeSync, fstatSync, readSync, writeSync, fsyncSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import { randomBytes } from "node:crypto";
import { DevctxError } from "../errors.mjs";
export const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const isWithin = (child, parent) => child === parent || (!relative(parent, child).startsWith("..") && !isAbsolute(relative(parent, child)));
export const overlaps = (a, b) => isWithin(a, b) || isWithin(b, a);
export function safeJoin(root, ...segments) {
  if (!isAbsolute(root) || segments.some((s) => !SEGMENT.test(s) || s === "..")) throw new DevctxError("PATH_ESCAPE", "Unsafe path segment");
  return join(root, ...segments);
}
export function info(path) { try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } }
export function checkNode(node, path, { directory = false } = {}) {
  if (!node || node.isSymbolicLink() || (directory ? !node.isDirectory() : !node.isFile()) || node.uid !== process.getuid() || (!directory && node.nlink !== 1) || (node.mode & 0o077)) throw new DevctxError("PATH_UNSAFE", "Unsafe private path", { path });
  return node;
}
export function ensurePrivateDir(path) {
  const st = info(path);
  if (st) return checkNode(st, path, { directory: true });
  mkdirSync(path, { mode: 0o700 });
  return checkNode(info(path), path, { directory: true });
}
export function ensurePrivatePath(root, segments = []) {
  ensurePrivateDir(root);
  let at = root;
  for (const seg of segments) { at = safeJoin(at, seg); ensurePrivateDir(at); }
  return at;
}
export async function readPrivateText(path, limit = 131072) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (e) { if (e.code === "ELOOP") throw new DevctxError("PATH_UNSAFE", "Unsafe private path"); throw e; }
  try {
    const before = checkNode(fstatSync(fd), path);
    if (before.size > limit) throw new DevctxError("LIMIT", "Private file exceeds limit");
    const buf = Buffer.alloc(before.size); let offset = 0;
    while (offset < buf.length) { const n = readSync(fd, buf, offset, buf.length - offset, offset); if (!n) break; offset += n; }
    const after = fstatSync(fd);
    if (offset !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new DevctxError("INTEGRITY", "Private file changed");
    return buf.toString("utf8");
  } finally { closeSync(fd); }
}
export async function readPrivateJson(path, limit) { try { return JSON.parse(await readPrivateText(path, limit)); } catch (e) { if (e instanceof SyntaxError) throw new DevctxError("INTEGRITY", "Invalid private JSON"); throw e; } }
export async function writeNewFile(path, content) {
  let fd;
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { if (e.code === "EEXIST") throw new DevctxError("CONFLICT", "Private file already exists"); throw e; }
  try { const buf = Buffer.from(content); let off = 0; while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off); fsyncSync(fd); }
  finally { closeSync(fd); }
}
export function fsyncDir(path) { const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
export async function atomicReplace(path, content) {
  const temp = join(dirname(path), ".devctx-" + randomBytes(8).toString("hex") + ".tmp");
  await writeNewFile(temp, content);
  renameSync(temp, path);
  fsyncDir(dirname(path));
}
