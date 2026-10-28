// U28 (R6, KTD25, KTD26): reading Claude Code memory for bound repositories. devtwin reads memory and never writes it.
//
// Claude Code keeps one folder per working directory at <claude dir>/projects/<name>, where <name> is the real absolute
// path with every character other than a letter or digit replaced by "-" (checked for "/" on Claude Code 2.1.311; other
// characters, such as ".", are assumed to follow the same rule). Memory files are <folder>/memory/*.md; MEMORY.md is an
// index and is skipped. Session transcripts are <folder>/*.jsonl, one JSON object per line, with a cwd field.
//
// The folder name is not unique (a "-" and a "." in a path give the same name), so a folder is read only when it can be
// proven to belong to the bound root: no other bound root computes the same name, and every cwd its transcripts record
// is the root, a folder under it, or a linked worktree of it (sessions cd into subfolders). A folder with a cwd elsewhere,
// or with no recorded cwd, is "ambiguous" and is skipped. A linked worktree has its own folder; it is not imported here.
// The proof fails closed: a folder with more transcripts than the cap, or a transcript longer than the byte cap, has
// lines nobody checked, so it is "ambiguous" with the reason "proof-capped".
//
// Claude Code shortens a very long folder name and adds a hash to it. devtwin does not compute that form, so a root
// whose folder name is long enough to be shortened reads as "absent" (docs/LIMITATIONS.md).
//
// This is the importer's read-only exception for the computed folder: memory files go through the no-follow,
// regular-file, size-capped reader (src/storage/source-read.mjs); transcripts are read with no-follow opens up to a byte
// cap, and only their cwd fields are kept.
import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { agentDirsFor } from "../config/pilot.mjs";
import { info, isWithin } from "../storage/fsx.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { gitQuery } from "../identity/git.mjs";
import { digest } from "../storage/canonical.mjs";

export const MEMORY_LIMITS = Object.freeze({ files: 200, transcripts: 200, transcriptBytes: 8 << 20, chunkBytes: 1 << 20 });
export const MEMORY_TYPES = Object.freeze(["user", "feedback", "project", "reference"]);
export const claudeFolderName = (root) => root.replace(/[^A-Za-z0-9]/g, "-");

// The Claude Code folder devtwin reads: the live home's (CLAUDE_CONFIG_DIR wins, as for skills), or in a pilot the first
// agent home's. null when there is none.
export function claudeDirFor(pilot, env = process.env) {
  if (pilot?.live) return agentDirsFor({ home: pilot.live.home, env }).claude;
  const home = pilot?.agentHomes?.[0];
  return home ? agentDirsFor({ home, env: {} }).claude : null;
}
// The real path of <claude dir>/projects, or null when it is absent or not a folder.
export function projectsDirOf(claudeDir) {
  if (!claudeDir) return null;
  const path = join(claudeDir, "projects");
  try { const real = realpathSync(path); return info(real)?.isDirectory() ? real : null; } catch { return null; }
}
// Folder names under projects/, each a real folder (a symlinked folder is left out).
export function listFolders(projectsDir) {
  if (!projectsDir) return [];
  return readdirSync(projectsDir).filter((name) => info(join(projectsDir, name))?.isDirectory() === true).sort();
}
// The bound root and its linked worktrees, as real paths. A Git failure leaves the root alone.
export function worktreesOf(root) {
  const out = new Set([root]);
  try {
    for (const line of gitQuery(root, ["worktree", "list", "--porcelain"]).stdout.split("\n")) {
      if (!line.startsWith("worktree ")) continue;
      try { out.add(realpathSync(line.slice(9))); } catch { /* A removed worktree is not a place a session ran. */ }
    }
  } catch { /* Not a repository any more: the root alone. */ }
  return [...out].sort();
}
const realOrSame = (path) => { try { return realpathSync(path); } catch { return path; } };
// The cwd values one transcript records, read with a no-follow open up to the byte cap. capped: the file is longer than
// the cap, so its later lines were not read.
function transcriptCwds(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return { skipped: true, cwds: [] }; }
  const cwds = new Set();
  try {
    if (!fstatSync(fd).isFile()) return { skipped: true, cwds: [] };
    const buf = Buffer.alloc(MEMORY_LIMITS.chunkBytes);
    let carry = "", read = 0;
    const take = (line) => {
      if (!line.includes('"cwd"')) return;
      try { const value = JSON.parse(line); if (typeof value?.cwd === "string" && value.cwd.startsWith("/")) cwds.add(value.cwd); } catch { /* Not a JSON line. */ }
    };
    while (read < MEMORY_LIMITS.transcriptBytes) {
      const n = readSync(fd, buf, 0, Math.min(buf.length, MEMORY_LIMITS.transcriptBytes - read), read);
      if (!n) break;
      read += n;
      const lines = (carry + buf.subarray(0, n).toString("utf8")).split("\n");
      carry = lines.pop();
      lines.forEach(take);
    }
    if (read < MEMORY_LIMITS.transcriptBytes) take(carry);
    else if (readSync(fd, Buffer.alloc(1), 0, 1, read) > 0) return { skipped: false, capped: true, cwds: [...cwds] };
  } finally { closeSync(fd); }
  return { skipped: false, cwds: [...cwds] };
}
// Whether the folder can be proven to belong to the root: { ok } or { ok: false, reason }.
export function proveFolder(folder, allowed) {
  let names;
  try { names = readdirSync(folder).filter((name) => name.endsWith(".jsonl")).sort(); } catch { return { ok: false, reason: "unreadable" }; }
  if (names.length > MEMORY_LIMITS.transcripts) return { ok: false, reason: "proof-capped" };
  const cwds = new Set();
  for (const name of names) {
    const read = transcriptCwds(join(folder, name));
    if (read.capped) return { ok: false, reason: "proof-capped" };
    for (const cwd of read.cwds) cwds.add(cwd);
  }
  if (!cwds.size) return { ok: false, reason: "no-cwd" };
  const inside = (cwd) => allowed.some((root) => isWithin(cwd, root));
  for (const cwd of cwds) if (!inside(cwd) && !inside(realOrSame(cwd))) return { ok: false, reason: "outside-cwd" };
  return { ok: true, transcripts: names.length };
}

// The front matter of a memory file: top-level "key: value" lines and one level of nested maps (metadata). Values may
// be double-quoted (JSON rules), single-quoted or plain. Block scalars (| and >) take the indented lines below them.
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return value.slice(1, -1); } }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}
export function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { front: {}, body: text };
  const front = {}, lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const top = /^([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(lines[i]);
    if (!top) continue;
    const [, key, raw = ""] = top;
    const block = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) block.push(lines[++i]);
    if (/^[|>][+-]?$/.test(raw.trim())) { const parts = block.map((l) => l.trim()).filter(Boolean); front[key] = raw.trim().startsWith("|") ? parts.join("\n") : parts.join(" "); continue; }
    if (raw.trim() === "") {
      const nested = {};
      for (const line of block) { const sub = /^\s+([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(line); if (sub) nested[sub[1]] = scalar(sub[2] ?? ""); }
      front[key] = nested;
      continue;
    }
    front[key] = scalar(raw);
  }
  return { front, body: m[2] };
}
const cleanBody = (body) => body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() + "\n";
// One memory file as the importer sees it. The dedupe hash covers the body, the name and metadata.type (KTD27), not
// volatile fields such as modified or originSessionId.
export function memoryItem(file, text) {
  const { front, body } = parseFrontMatter(text);
  const name = typeof front.name === "string" && front.name ? front.name : file.replace(/\.md$/, "");
  const type = typeof front.metadata?.type === "string" ? front.metadata.type : typeof front.type === "string" ? front.type : null;
  const description = typeof front.description === "string" ? front.description : null;
  const clean = cleanBody(body);
  return { file, name, type, description, body: clean, hash: digest({ name, type, body: clean }) };
}
// The memory files of one proven folder. skipped lists files left out with a reason, never their text.
export async function readMemoryFiles(folder) {
  const items = [], skipped = [];
  const dir = join(folder, "memory");
  const node = info(dir);
  if (!node) return { items, skipped };
  if (!node.isDirectory()) return { items, skipped: [{ file: "memory", reason: node.isSymbolicLink() ? "symlink" : "not-regular" }] };
  const names = readdirSync(dir).filter((name) => name.endsWith(".md")).sort();
  for (const [i, file] of names.entries()) {
    if (file === "MEMORY.md") { skipped.push({ file, reason: "index" }); continue; }
    if (i >= MEMORY_LIMITS.files) { skipped.push({ file, reason: "cap" }); continue; }
    let read;
    try { read = await readApprovedSource(folder, "memory/" + file); }
    catch (error) { skipped.push({ file, reason: error.code === "DEVTWIN_PATH_ESCAPE" ? "unsafe-name" : "unreadable" }); continue; }
    if (read.skipped) { skipped.push({ file, reason: read.skipped }); continue; }
    if (!read.utf8Valid) { skipped.push({ file, reason: "not-utf8" }); continue; }
    items.push(memoryItem(file, read.text));
  }
  return { items, skipped };
}
