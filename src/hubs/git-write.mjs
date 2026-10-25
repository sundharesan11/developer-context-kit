// U10 (KTD2, KTD18): Git writes to a hub clone, and the local outbox. Every hub Git call keeps global config, hooks
// and filters off (src/identity/git.mjs), allows only the SSH transport, keeps symlinks and submodules off, and uses
// the hub's own SSH command. A commit names the recorded handle and email as per-command config. A rejected push
// fetches, rebases, re-runs the caller's preconditions and tries again, three tries in all; it never force-pushes.
// After the last try the item goes to the outbox at stateRoot/hubs/<hubId>/outbox/, which hub sync drains.
//
// API for later units (U11 lessons, U13 notes, U14 tombstones):
//   publishToHub(roots, binding, { writes: [{ rel, content | null }], message, preconditions, now, queue, locked })
//     -> { pushed: true, attempts, commit } | { pushed: false, reason, queued: <outbox id> | null }
//   enqueueOutbox(roots, binding, { kind, message, writes, createdAt, expiresAt }, { now }) -> { id, queued }
//   listOutbox(roots, binding) -> [item]          removeOutboxItem(roots, binding, id)
//   drainOutbox(roots, binding, { now, terms }) -> { pushed: [id], dropped: [{ id, reason }], kept: [id] }
//   withHubLock(roots, action)                    the hub-sync lock; publishToHub takes it unless locked is true
//   checkRemoteSupersession(binding, { lessonId, supersedes })   U12: the predecessor check on the fetched remote branch
import { join, dirname } from "node:path";
import { mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { git } from "../identity/git.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { info, writeNewFile, ensurePrivatePath, readPrivateJson, fsyncDir } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { assertOutboundClean } from "../records/isolation.mjs";
import { LESSON_REL, NOTE_REL, TOMBSTONE_REL, HUB_SCHEMA_VERSION, HUB_ID, parseHubLesson, parseHubNote, parseHubTombstone, readHubManifest } from "./read.mjs";

export const PUSH_TRIES = 3;
export const HUB_GIT_TIMEOUT_MS = 30_000;
// Used when the hub has no SSH command of its own: no prompts, and a bounded connect time.
export const DEFAULT_SSH_COMMAND = "ssh -o BatchMode=yes -o ConnectTimeout=15";
const HARDEN = ["-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "core.symlinks=false", "-c", "submodule.recurse=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "pull.rebase=false"];
const MAX_WRITES = 20, OUTBOX_LIMIT = 500, OUTBOX_FILE_BYTES = 262144;
const KINDS = ["lesson", "note", "tombstone"];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const OUTBOX_ID = /^obx_[a-f0-9]{24}$/;

export const hubLockPath = (roots) => join(roots.stateRoot, "locks", "hub-sync.lock");
export const hubStateDir = (roots, hubId) => {
  if (!HUB_ID.test(hubId ?? "")) throw new DevtwinError("INVALID_ID", "Invalid hub ID");
  return join(roots.stateRoot, "hubs", hubId);
};
export const outboxDir = (roots, hubId) => join(hubStateDir(roots, hubId), "outbox");
// The hub-sync lock (KTD22). It is releasable by hand with `locks release --lock hub-sync`.
export function withHubLock(roots, action) {
  return withPilotLock(roots, hubLockPath(roots), { kind: "hub-sync" }, action, { destinations: [join(roots.stateRoot, "hubs"), join(roots.configRoot, "hubs")] });
}
// One hub Git call. cwd defaults to the clone; ssh is the hub's own command.
export function hubGit(binding, args, { cwd = binding.clone, timeoutMs = HUB_GIT_TIMEOUT_MS } = {}) {
  try { return git(cwd, [...HARDEN, ...args], { timeoutMs, sshCommand: binding.sshCommand ?? DEFAULT_SSH_COMMAND }); }
  catch (error) { if (error.code === "DEVTWIN_GIT_QUERY_FAILED" || error.code === "DEVTWIN_LIMIT") return { ok: false, status: null, stdout: "", stderr: "", reason: error.details?.reason ?? "failed" }; throw error; }
}
const identity = (binding) => ["-c", "user.name=" + binding.handle, "-c", "user.email=" + binding.email];
const required = (result, what) => { if (!result.ok) throw new DevtwinError("HUB_GIT_FAILED", "Hub Git step failed", { step: what }); return result; };

function refuse(rel, reason) { throw new DevtwinError("HUB_PATH_REFUSED", "Hub path is not one of the developer's own files", { rel, reason }); }
// A developer only adds or removes their own files (KTD2): their lessons, notes in their handle's folder, and
// tombstones they sign. A lesson removal is checked against the current file's author.
export async function checkWrite(binding, write) {
  if (!write || typeof write.rel !== "string" || (write.content !== null && typeof write.content !== "string")) refuse(String(write?.rel), "shape");
  const { rel, content } = write, lesson = LESSON_REL.exec(rel), note = NOTE_REL.exec(rel), stone = TOMBSTONE_REL.exec(rel);
  if (!lesson && !note && !stone) refuse(rel, "layout");
  if (note && note[1] !== binding.handle) refuse(rel, "other-handle");
  try {
    if (content === null) {
      if (lesson) {
        const read = await readApprovedSource(binding.clone, rel);
        if (!read.skipped && parseHubLesson(read.text).meta.author !== binding.actorRef) refuse(rel, "other-author");
      }
      return;
    }
    if (lesson) { const { meta } = parseHubLesson(content); if (meta.id !== lesson[1] || meta.author !== binding.actorRef) refuse(rel, "other-author"); }
    if (note) { const value = parseHubNote(content); if (value.id !== note[2] || value.handle !== binding.handle) refuse(rel, "other-handle"); }
    if (stone) { const value = parseHubTombstone(content); if (value.id !== stone[1] || value.handle !== binding.handle) refuse(rel, "other-handle"); }
  } catch (error) {
    if (error.code === "DEVTWIN_HUB_PATH_REFUSED") throw error;
    refuse(rel, "invalid");
  }
}
function requireWritable(binding) {
  if (!binding || binding.status !== "joined" || binding.delivery !== "on") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub");
  if (binding.readOnly) throw new DevtwinError("HUB_READ_ONLY", "Hub uses a newer format; devtwin does not write to it", { hubId: binding.hubId });
}
async function checkWrites(binding, writes) {
  if (!Array.isArray(writes) || !writes.length || writes.length > MAX_WRITES) throw new DevtwinError("INVALID_INPUT", "Invalid hub writes", { field: "writes" });
  if (new Set(writes.map((w) => w?.rel)).size !== writes.length) throw new DevtwinError("INVALID_INPUT", "Duplicate hub write", { field: "writes" });
  for (const write of writes) await checkWrite(binding, write);
}
const cleanMessage = (message) => {
  const text = String(message ?? "").replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 72);
  if (!text) throw new DevtwinError("INVALID_INPUT", "Commit message required", { field: "message" });
  return text;
};
// Folders inside the clone: each part must be a real folder, never a link.
function ensureCloneDir(clone, relDir) {
  let at = clone;
  for (const part of relDir.split("/").filter(Boolean)) {
    at = join(at, part);
    const node = info(at);
    if (!node) { mkdirSync(at, { mode: 0o700 }); continue; }
    if (node.isSymbolicLink() || !node.isDirectory()) throw new DevtwinError("PATH_UNSAFE", "Hub clone folder unsafe", { rel: relDir });
  }
}
async function writeFiles(roots, binding, writes) {
  for (const { rel, content } of writes) {
    const path = join(binding.clone, rel);
    assertWritable(roots, [path], { writeClass: "hubRoot" });
    ensureCloneDir(binding.clone, dirname(rel));
    const node = info(path);
    if (node && (node.isSymbolicLink() || !node.isFile())) throw new DevtwinError("PATH_UNSAFE", "Hub clone file unsafe", { rel });
    if (node) unlinkSync(path);
    if (content !== null) await writeNewFile(path, content);
  }
}
const remoteRef = (binding) => "refs/remotes/origin/" + binding.branch;
function resetToRemote(binding) {
  hubGit(binding, ["rebase", "--abort"]);
  required(hubGit(binding, ["reset", "-q", "--hard", remoteRef(binding)]), "reset");
  required(hubGit(binding, ["clean", "-fdq"]), "clean");
}
// A removal of a file that is already gone (for example an own note that an earlier item deleted) stages nothing and
// does not fail. When nothing is staged at all, no commit is made and the push sends nothing new.
async function commit(roots, binding, writes, message) {
  await writeFiles(roots, binding, writes);
  const adds = writes.filter((w) => w.content !== null).map((w) => w.rel), removes = writes.filter((w) => w.content === null).map((w) => w.rel);
  if (adds.length) required(hubGit(binding, ["add", "-A", "--", ...adds]), "add");
  if (removes.length) required(hubGit(binding, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...removes]), "rm");
  const staged = hubGit(binding, ["diff", "--cached", "--quiet"]);
  if (staged.ok) return;
  if (staged.status !== 1) required(staged, "diff");
  required(hubGit(binding, [...identity(binding), "commit", "-q", "--no-verify", "-m", message]), "commit");
}
// U12 (KTD3): the predecessor check for a replacement. It reads the fetched remote branch, never the clone's work tree,
// so it sees what the push would land on. Each predecessor must be there with the named hash, must not carry its
// author's tombstone, and no other lesson on the branch may already replace it with that hash. Any failure throws
// STALE_VERSION; publishToHub then resets the clone to the remote head, so the local commit is dropped.
const stale = (reason, details) => { throw new DevtwinError("STALE_VERSION", "Lesson replacement is stale", { reason, ...details }); };
export function checkRemoteSupersession(binding, { lessonId, supersedes }) {
  const ref = remoteRef(binding), own = "lessons/" + lessonId + ".md";
  for (const { id, hash } of supersedes ?? []) {
    const rel = "lessons/" + id + ".md";
    const blob = hubGit(binding, ["cat-file", "blob", ref + ":" + rel]);
    if (!blob.ok) stale("predecessor-missing", { predecessorId: id });
    if (sha256(blob.stdout) !== hash) stale("predecessor-changed", { predecessorId: id });
    const author = (() => { try { return parseHubLesson(blob.stdout).meta.author; } catch { return null; } })();
    const stone = hubGit(binding, ["cat-file", "blob", ref + ":tombstones/" + id + ".json"]);
    if (stone.ok) { try { if ("handle:" + parseHubTombstone(stone.stdout).handle === author) stale("predecessor-removed", { predecessorId: id }); } catch (error) { if (error.code === "DEVTWIN_STALE_VERSION") throw error; } }
    // Lessons whose text names the predecessor ID; each is parsed to see whether it really replaces it.
    const found = hubGit(binding, ["grep", "-l", "-F", "-e", id, ref, "--", "lessons/"]);
    if (!found.ok && found.status !== 1) throw new DevtwinError("HUB_GIT_FAILED", "Hub Git step failed", { step: "grep" });
    for (const line of found.ok ? found.stdout.split("\n").filter(Boolean) : []) {
      const other = line.startsWith(ref + ":") ? line.slice(ref.length + 1) : null;
      if (!other || other === own || other === rel || !LESSON_REL.test(other)) continue;
      const read = hubGit(binding, ["cat-file", "blob", ref + ":" + other]);
      let meta = null;
      try { meta = read.ok ? parseHubLesson(read.stdout).meta : null; } catch { meta = null; }
      if (meta?.supersedes?.some((x) => x.id === id && x.hash === hash)) stale("already-superseded", { predecessorId: id, successorId: meta.id });
    }
  }
}
// The supersedes list of a queued lesson write, or null when the item replaces nothing.
function queuedSupersession(item) {
  if (item.kind !== "lesson") return null;
  for (const write of item.writes) {
    if (write.content === null || !LESSON_REL.test(write.rel)) continue;
    const { meta } = parseHubLesson(write.content);
    if (meta.supersedes?.length) return { lessonId: meta.id, supersedes: meta.supersedes };
  }
  return null;
}
const REJECTED = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to update ref|stale info/;

// Commits the writes and pushes them. preconditions({ attempt }) runs before the first write and again after each
// rebase; it throws to stop the publish (for example STALE_VERSION), which leaves the clone at the remote head.
export async function publishToHub(roots, binding, { writes, message, preconditions = async () => undefined, now = () => new Date(), queue = true, locked = false, kind = "lesson", createdAt, expiresAt } = {}) {
  requireWritable(binding);
  await checkWrites(binding, writes);
  const text = cleanMessage(message);
  const run = async () => {
    const manifest = await readHubManifest(binding.clone);
    if (manifest.hubId !== binding.hubId) throw new DevtwinError("HUB_INVALID", "Hub ID changed");
    if (manifest.schemaVersion > HUB_SCHEMA_VERSION) throw new DevtwinError("HUB_READ_ONLY", "Hub uses a newer format; devtwin does not write to it", { hubId: binding.hubId });
    resetToRemote(binding);
    let reason = "rejected";
    try {
      await preconditions({ attempt: 1 });
      await commit(roots, binding, writes, text);
      for (let attempt = 1; attempt <= PUSH_TRIES; attempt++) {
        const push = hubGit(binding, ["push", "--porcelain", "origin", "HEAD:refs/heads/" + binding.branch]);
        if (push.ok) return { pushed: true, attempts: attempt, commit: required(hubGit(binding, ["rev-parse", "HEAD"]), "rev-parse").stdout.trim() };
        if (!REJECTED.test(push.stdout + "\n" + push.stderr)) { reason = "push-failed"; break; }
        if (attempt === PUSH_TRIES) break;
        if (!hubGit(binding, ["fetch", "-q", "--no-recurse-submodules", "origin"]).ok) { reason = "fetch-failed"; break; }
        if (!hubGit(binding, [...identity(binding), "rebase", "-q", remoteRef(binding)]).ok) {
          resetToRemote(binding);
          await commit(roots, binding, writes, text);
        }
        await preconditions({ attempt: attempt + 1 });
      }
    } catch (error) { resetToRemote(binding); throw error; }
    resetToRemote(binding);
    const queued = queue ? (await enqueueOutbox(roots, binding, { kind, message: text, writes, createdAt: createdAt ?? now().toISOString(), ...(expiresAt ? { expiresAt } : {}) }, { now })).id : null;
    return { pushed: false, reason, queued };
  };
  return locked ? run() : withHubLock(roots, run);
}

// The outbox: one private JSON file per item. An item is queued again only by its own content, so a retry is idempotent.
function checkItem(item) {
  if (!item || !KINDS.includes(item.kind) || typeof item.createdAt !== "string" || !ISO.test(item.createdAt)) throw new DevtwinError("INVALID_INPUT", "Invalid outbox item");
  if (item.kind === "note" ? !(typeof item.expiresAt === "string" && ISO.test(item.expiresAt)) : item.expiresAt !== undefined && item.expiresAt !== null) throw new DevtwinError("INVALID_INPUT", "Invalid outbox item", { field: "expiresAt" });
}
export async function enqueueOutbox(roots, binding, item, { now = () => new Date() } = {}) {
  requireWritable(binding);
  checkItem(item);
  await checkWrites(binding, item.writes);
  const value = { schemaVersion: 1, hubId: binding.hubId, scope: binding.scope, kind: item.kind, message: cleanMessage(item.message), writes: item.writes.map(({ rel, content }) => ({ rel, content })), createdAt: item.createdAt, expiresAt: item.expiresAt ?? null };
  const id = "obx_" + digest(value).slice(7, 31), dir = outboxDir(roots, binding.hubId), path = join(dir, id + ".json");
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["hubs", binding.hubId, "outbox"]);
  if (info(path)) return { id, queued: false };
  const text = canonicalJson({ ...value, id, queuedAt: now().toISOString() }) + "\n";
  if (Buffer.byteLength(text) > OUTBOX_FILE_BYTES) throw new DevtwinError("LIMIT", "Outbox item too large");
  if (readdirSafe(dir).length >= OUTBOX_LIMIT) throw new DevtwinError("LIMIT", "Outbox full", { max: OUTBOX_LIMIT });
  await writeNewFile(path, text);
  fsyncDir(dir);
  return { id, queued: true };
}
const readdirSafe = (dir) => { try { return readdirSync(dir).filter((n) => OUTBOX_ID.test(n.replace(/\.json$/, "")) && n.endsWith(".json")); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
export async function listOutbox(roots, binding) {
  const dir = outboxDir(roots, binding.hubId), items = [];
  for (const name of readdirSafe(dir).sort()) {
    const value = await readPrivateJson(join(dir, name), OUTBOX_FILE_BYTES);
    if (value?.schemaVersion !== 1 || value.id + ".json" !== name || value.hubId !== binding.hubId) throw new DevtwinError("INTEGRITY", "Outbox item invalid", { id: name.slice(0, -5) });
    items.push(value);
  }
  return items.sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
}
export function removeOutboxItem(roots, binding, id) {
  if (!OUTBOX_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid outbox ID");
  const path = join(outboxDir(roots, binding.hubId), id + ".json");
  assertWritable(roots, [path]);
  try { unlinkSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
}
// A note older than half its expiry is not worth posting late (KTD10, R20).
export const noteIsStale = (item, now) => {
  const created = Date.parse(item.createdAt), expires = Date.parse(item.expiresAt);
  return now.getTime() >= created + (expires - created) / 2;
};
// Pushes queued items one by one. Each item passes the sensitive-content and all-scope checks again at push time
// (KTD11), because a scope added after queueing must still be refused. A queued replacement re-runs the predecessor
// check (U12) before its commit and after each rebase; when another replacement landed meanwhile, the item is
// dropped with reason "stale". The caller holds the hub-sync lock.
export async function drainOutbox(roots, binding, { now = () => new Date(), terms }) {
  const out = { pushed: [], dropped: [], kept: [] };
  if (binding.readOnly) return out;
  let offline = false;
  for (const item of await listOutbox(roots, binding)) {
    if (offline) { out.kept.push(item.id); continue; }
    if (item.kind === "note" && noteIsStale(item, now())) { removeOutboxItem(roots, binding, item.id); out.dropped.push({ id: item.id, reason: "stale" }); continue; }
    try {
      for (const write of item.writes) if (write.content !== null) assertOutboundClean(write.content, terms, { except: binding.scope });
      await checkWrites(binding, item.writes);
    } catch (error) {
      removeOutboxItem(roots, binding, item.id);
      out.dropped.push({ id: item.id, reason: error.code === "DEVTWIN_ISOLATION" ? "isolation" : error.code === "DEVTWIN_SENSITIVE_CONTENT" ? "sensitive" : "invalid" });
      continue;
    }
    const replacement = queuedSupersession(item);
    const preconditions = replacement ? async () => checkRemoteSupersession(binding, replacement) : undefined;
    let result;
    try { result = await publishToHub(roots, binding, { writes: item.writes, message: item.message, preconditions, now, queue: false, locked: true, kind: item.kind }); }
    catch (error) {
      if (error.code !== "DEVTWIN_STALE_VERSION") throw error;
      removeOutboxItem(roots, binding, item.id);
      out.dropped.push({ id: item.id, reason: "stale" });
      continue;
    }
    if (result.pushed) { removeOutboxItem(roots, binding, item.id); out.pushed.push(item.id); }
    else { out.kept.push(item.id); offline = result.reason !== "rejected"; }
  }
  return out;
}
