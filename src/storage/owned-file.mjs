import { constants, openSync, closeSync, fstatSync, readSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath, writeNewFile, fsyncDir, atomicReplace } from "./fsx.mjs";
import { canonicalJson } from "./canonical.mjs";
import { RUN_ID } from "./runs.mjs";
import { DevtwinError } from "../errors.mjs";
// Edits to files the developer owns: only devtwin's marker block or devtwin's own JSON entries change.
export const MARKERS = Object.freeze({ begin: "<!-- devtwin:begin -->", end: "<!-- devtwin:end -->" });
const OWNED_LIMIT = 262144;
const UNSAFE_KEYS = ["__proto__", "constructor", "prototype"];
const count = (text, part) => text.split(part).length - 1;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
// Replaces the one devtwin block, appends one when there is none, or removes it when body is null.
// Bytes before the begin marker and after the end marker are kept exactly; malformed markers are a conflict.
export function replaceMarkedBlock(text, body, { begin = MARKERS.begin, end = MARKERS.end } = {}) {
  const current = text ?? "";
  if (body !== null && (typeof body !== "string" || body.includes(begin) || body.includes(end))) throw new DevtwinError("INVALID_INPUT", "Invalid devtwin block");
  const block = body === null ? "" : begin + "\n" + body + (body.endsWith("\n") ? "" : "\n") + end;
  const begins = count(current, begin), ends = count(current, end);
  if (!begins && !ends) {
    if (body === null) return current;
    return current + (current && !current.endsWith("\n") ? "\n" : "") + block + "\n";
  }
  const at = current.indexOf(begin), to = current.indexOf(end);
  if (begins !== 1 || ends !== 1 || to < at) throw new DevtwinError("CONFLICT", "Devtwin markers are malformed");
  let after = to + end.length;
  // Removing the block also drops the one newline that an appended block brought with it.
  if (body === null && current[after] === "\n") after++;
  return current.slice(0, at) + block + current.slice(after);
}
// In a JSON object file, replaces the array entries that owns() claims at keys with entries, keeping every other
// entry in place. Unchanged content returns the text as is; a changed file keeps its indent but is re-serialized.
export function replaceOwnedEntries(text, { path: keys, owns, entries }) {
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== "string" || UNSAFE_KEYS.includes(key)) || typeof owns !== "function" || !Array.isArray(entries) || entries.some((entry) => !owns(entry))) throw new DevtwinError("INVALID_INPUT", "Invalid owned JSON edit");
  let root;
  try { root = text ? JSON.parse(text) : {}; } catch { throw new DevtwinError("INTEGRITY", "Owned file is not plain JSON"); }
  if (!isObject(root)) throw new DevtwinError("CONFLICT", "Owned JSON file is not an object");
  const before = canonicalJson(root);
  let parent = root;
  for (const key of keys.slice(0, -1)) {
    if (!Object.hasOwn(parent, key)) parent[key] = {};
    if (!isObject(parent[key])) throw new DevtwinError("CONFLICT", "Owned JSON path is not an object");
    parent = parent[key];
  }
  const last = keys.at(-1), list = Object.hasOwn(parent, last) ? parent[last] : [];
  if (!Array.isArray(list)) throw new DevtwinError("CONFLICT", "Owned JSON path is not a list");
  const first = list.findIndex((entry) => owns(entry)), kept = list.filter((entry) => !owns(entry));
  const at = first === -1 ? kept.length : list.slice(0, first).filter((entry) => !owns(entry)).length;
  parent[last] = [...kept.slice(0, at), ...entries, ...kept.slice(at)];
  if (canonicalJson(root) === before && text) return text;
  const indent = /\n([ \t]+)"/.exec(text ?? "")?.[1] ?? "  ";
  return JSON.stringify(root, null, indent) + (text && !text.endsWith("\n") ? "" : "\n");
}
// Reads a developer-owned file without following a link: a regular, single-link file of this user that is not
// group or other writable. Its mode may be 0644, unlike store files. A missing file returns null.
function readOwned(path, limit) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") throw new DevtwinError("PATH_UNSAFE", "Unsafe owned file");
    throw error;
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.uid !== process.getuid() || before.nlink !== 1 || (before.mode & 0o022)) throw new DevtwinError("PATH_UNSAFE", "Unsafe owned file");
    if (before.size > limit) throw new DevtwinError("LIMIT", "Owned file exceeds limit");
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fstatSync(fd);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new DevtwinError("INTEGRITY", "Owned file changed");
    return { bytes, dev: before.dev, ino: before.ino, mode: before.mode & 0o755 };
  } finally { closeSync(fd); }
}
function decode(bytes) {
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw new DevtwinError("INTEGRITY", "Owned file is not UTF-8"); }
  if (!Buffer.from(text).equals(bytes)) throw new DevtwinError("INTEGRITY", "Owned file is not UTF-8");
  return text;
}
// Edits one approved write-class file. edit(text) gets the current text, or null when the file is absent, and
// returns the new text. Before the replace, the exact prior bytes go to stateRoot/runs/<runId>/backups/ with a
// record naming the path; an absent file gets a record only. A run never overwrites a backup it already wrote.
// faults.beforeReplace is a test seam between the backup and the replace.
export async function editOwnedFile(roots, { path, writeClass, runId, edit, limit = OWNED_LIMIT }, { faults = {} } = {}) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new DevtwinError("INVALID_ID", "Invalid run ID");
  if (typeof edit !== "function") throw new DevtwinError("INVALID_INPUT", "Invalid owned file edit");
  const name = createHash("sha256").update(String(path)).digest("hex");
  const dir = join(roots.stateRoot, "runs", runId, "backups"), backup = join(dir, name + ".bak"), record = join(dir, name + ".json");
  assertWritable(roots, [path], { writeClass });
  assertWritable(roots, [backup, record]);
  const prior = readOwned(path, limit), text = prior ? decode(prior.bytes) : null;
  const next = edit(text);
  if (typeof next !== "string" || Buffer.byteLength(next) > limit) throw new DevtwinError("INVALID_INPUT", "Invalid owned file content");
  if (prior && next === text) return { changed: false, path, backup: null };
  ensurePrivatePath(roots.stateRoot, ["runs", runId, "backups"]);
  assertWritable(roots, [backup, record]);
  if (prior) await writeNewFile(backup, prior.bytes);
  const sum = prior ? "sha256:" + createHash("sha256").update(prior.bytes).digest("hex") : null;
  await writeNewFile(record, JSON.stringify({ schemaVersion: 1, path, writeClass, ...(prior ? { sha256: sum, size: prior.bytes.length } : { absent: true }) }) + "\n");
  fsyncDir(dir);
  await faults.beforeReplace?.();
  const current = readOwned(path, limit);
  if (prior ? !current || current.dev !== prior.dev || current.ino !== prior.ino || !current.bytes.equals(prior.bytes) : current) throw new DevtwinError("INTEGRITY", "Owned file changed");
  assertWritable(roots, [path], { writeClass });
  await atomicReplace(path, next);
  // The replacement is written 0600; an existing file keeps the developer's own mode.
  if (prior) chmodSync(path, prior.mode);
  return { changed: true, path, backup: prior ? backup : null, record };
}
