// U14 (R6, KTD2, KTD9, KTD20): what devtwin published in this developer's name, and its removal.
//
// published list    read-only and open to agents. It reads the hub clone, not the local store, so it still works
//                   on a fresh machine: the developer's lessons (by binding.actorRef) with their status, their own
//                   active and expired notes, their own tombstones and the queued outbox items.
// published delete  owner-only (hook block and owner dialog). The preview names every file it removes or adds and
//                   states the Git-history caveat. The apply makes one commit through publishToHub: it removes the
//                   developer's own file and, for a lesson, adds tombstones/<id>.json signed with their handle. A
//                   push that fails goes to the outbox as a "tombstone" item.
//
// The tombstone memory: stateRoot/hubs/<hubId>/tombstones.json lists each lesson whose valid tombstone this machine has
// seen ([{ id, author, seenAt }]). The index and the hook keep those lessons out even if the file comes back later.
//
// The note cleanup: hub sync deletes this developer's own expired notes, at most NOTE_CLEANUP_BATCH files in one
// commit per sync. Other developers' notes are never touched; each devtwin cleans only its own.
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readHubBinding } from "../config/store.mjs";
import { assertScopeId, ACTOR_REF } from "../identity/ids.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace, info } from "../storage/fsx.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { LESSON_ID, NOTE_ID, HUB_HANDLE, HUB_LIMITS, readHub, readOwnNotes } from "./read.mjs";
import { hubGit, hubStateDir, publishToHub, listOutbox, withHubLock, MAX_REMOVES } from "./git-write.mjs";

export const DELETE_CAVEAT = "Git history and colleagues' existing clones keep this text; a history rewrite is a manual step for the hub admin.";
export const NOTE_CLEANUP_BATCH = MAX_REMOVES;
const MEMORY_BYTES = 1 << 20, MAX_MEMORY = 5000;

async function joinedBinding(roots, scope, { writable = false } = {}) {
  const binding = await readHubBinding(roots, assertScopeId(scope));
  if (!binding || binding.status !== "joined") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub", { scope });
  if (writable && binding.delivery !== "on") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub", { scope });
  if (writable && binding.readOnly) throw new DevtwinError("HUB_READ_ONLY", "Hub uses a newer format; devtwin does not write to it", { hubId: binding.hubId });
  return binding;
}

// The tombstone memory. A missing file is empty; a damaged one fails with INTEGRITY, and readers fail closed.
export const tombstoneMemoryPath = (roots, hubId) => join(hubStateDir(roots, hubId), "tombstones.json");
export async function readTombstoneMemory(roots, binding) {
  let value;
  try { value = await readPrivateJson(tombstoneMemoryPath(roots, binding.hubId), MEMORY_BYTES); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  if (value?.schemaVersion !== 1 || value.hubId !== binding.hubId || value.scope !== binding.scope || !Array.isArray(value.removed)
    || !value.removed.every((x) => LESSON_ID.test(x?.id ?? "") && ACTOR_REF.test(x?.author ?? "") && typeof x.seenAt === "string")) throw new DevtwinError("INTEGRITY", "Tombstone memory invalid");
  return value.removed;
}
// Adds entries ({ id, author }) not yet in the memory and returns their IDs. damaged: true starts a new memory.
// The caller holds the hub-sync lock.
export async function rememberTombstones(roots, binding, entries, { now = () => new Date(), damaged = false } = {}) {
  const current = damaged ? [] : await readTombstoneMemory(roots, binding);
  const known = new Set(current.map((x) => x.id)), added = [];
  for (const { id, author } of entries) if (!known.has(id)) { known.add(id); added.push({ id, author, seenAt: now().toISOString() }); }
  if (!added.length && !damaged) return [];
  const removed = [...current, ...added].sort((x, y) => x.seenAt < y.seenAt ? -1 : x.seenAt > y.seenAt ? 1 : x.id < y.id ? -1 : 1).slice(-MAX_MEMORY).sort((x, y) => x.id < y.id ? -1 : 1);
  const path = tombstoneMemoryPath(roots, binding.hubId);
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["hubs", binding.hubId]);
  await atomicReplace(path, canonicalJson({ schemaVersion: 1, hubId: binding.hubId, scope: binding.scope, removed }) + "\n");
  return added.map((x) => x.id).sort();
}
// The valid tombstones in a hub read that this machine can tie to the lesson's author: the lesson file is still
// there, or the index built before this sync listed the lesson under the tombstone's handle. previousEntries are
// that index's entries.
export function validTombstones(read, previousEntries = []) {
  const known = new Map(previousEntries.filter((e) => e.source === "hub").map((e) => [e.id, e.claimedBy]));
  const out = new Map();
  for (const stone of read.tombstones) {
    const author = "handle:" + stone.value.handle;
    if (read.removed.includes(stone.value.id) || known.get(stone.value.id) === author) out.set(stone.value.id, { id: stone.value.id, author });
  }
  return [...out.values()];
}

// published list.
const noteView = (note, expired) => ({ id: note.value.id, rel: note.rel, area: note.value.area, line: note.value.line, createdAt: note.value.createdAt, expiresAt: note.value.expiresAt, expired });
const byId = (x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
function lessonStatus(read, lesson) {
  const id = lesson.meta.id;
  if (read.removed.includes(id)) return { status: "tombstoned" };
  const replaced = read.superseded.find((x) => x.id === id);
  if (replaced) return { status: "superseded", replacedBy: replaced.by.map((x) => x.id) };
  return { status: read.lessons.find((l) => l.meta.id === id)?.contested ? "contested" : "active" };
}
export async function listPublished(roots, { scope }, { now = () => new Date() } = {}) {
  const binding = await joinedBinding(roots, scope);
  const at = now(), read = await readHub(binding.clone, { now: at, notes: false });
  const queued = (await listOutbox(roots, binding)).map((item) => ({ outboxId: item.id, kind: item.kind, createdAt: item.createdAt,
    removes: item.writes.filter((w) => w.content === null).map((w) => w.rel), adds: item.writes.filter((w) => w.content !== null).map((w) => w.rel) }));
  const head = { scope: binding.scope, hubId: binding.hubId, handle: binding.handle, author: binding.actorRef, readOnly: read.readOnly, warnings: read.warnings };
  if (read.readOnly) return { ...head, lessons: [], notes: [], tombstones: [], queued };
  const stones = read.tombstones.filter((s) => s.value.handle === binding.handle);
  const lessons = read.allLessons.filter((l) => l.meta.author === binding.actorRef).map((l) => ({ id: l.meta.id, title: l.meta.title, createdAt: l.meta.createdAt, rel: l.rel, ...lessonStatus(read, l), ...(l.meta.supersedes ? { replaces: l.meta.supersedes.map((x) => x.id) } : {}) }));
  // A lesson whose file is gone shows only its tombstone; its title stays in the hub's Git history.
  for (const stone of stones) if (!lessons.some((l) => l.id === stone.value.id)) lessons.push({ id: stone.value.id, title: null, createdAt: null, rel: null, status: "tombstoned", deletedAt: stone.value.createdAt });
  const own = await readOwnNotes(binding.clone, binding.handle, { now: at });
  return { ...head, lessons: lessons.sort(byId), notes: [...own.active.map((n) => noteView(n, false)), ...own.expired.map((n) => noteView(n, true))].sort(byId),
    tombstones: stones.map((s) => ({ id: s.value.id, rel: s.rel, createdAt: s.value.createdAt, lessonFile: read.allLessons.some((l) => l.meta.id === s.value.id) })).sort(byId),
    queued, ...(own.truncated ? { notesTruncated: HUB_LIMITS.notes } : {}) };
}

// published delete.
const refuse = (rel, reason) => { throw new DevtwinError("HUB_PATH_REFUSED", "Hub path is not one of the developer's own files", { rel, reason }); };
const quoted = (lesson) => "\"" + lesson.title + "\" [" + lesson.id + "]";
function lessonEffects(read, id) {
  const effects = ["Colleagues' agents stop receiving it after their next hub sync."];
  const replaced = read.superseded.find((x) => x.id === id);
  if (replaced) effects.push("It is already replaced by " + replaced.by.map((x) => x.id).join(", ") + "; that does not change.");
  for (const entry of read.superseded.filter((x) => x.by.some((y) => y.id === id))) {
    const others = entry.by.filter((y) => y.id !== id);
    if (!others.length) effects.push(quoted(entry) + " is no longer replaced and reaches agents again.");
    else if (others.length === 1) effects.push("Ends the contest over " + quoted(entry) + ": " + others[0].id + " becomes its single replacement.");
    else effects.push("The contest over " + quoted(entry) + " stays open between " + others.map((y) => y.id).join(", ") + ".");
  }
  return effects;
}
async function lessonPlan(binding, id) {
  const read = await readHub(binding.clone, { notes: false });
  const lesson = read.allLessons.find((l) => l.meta.id === id), rel = "lessons/" + id + ".md";
  if (!lesson) {
    if (read.tombstones.some((s) => s.value.id === id && s.value.handle === binding.handle)) throw new DevtwinError("CONFLICT", "Lesson is already deleted", { id, reason: "already-deleted" });
    throw new DevtwinError("NOT_FOUND", "No hub lesson with this ID", { id });
  }
  if (lesson.meta.author !== binding.actorRef) refuse(rel, "other-author");
  return { item: { kind: "lesson", id, rel, sha256: lesson.sha256, title: lesson.meta.title, ...lessonStatus(read, lesson) },
    removes: [rel], adds: [{ rel: "tombstones/" + id + ".json", handle: binding.handle }], effects: lessonEffects(read, id) };
}
async function notePlan(binding, id) {
  const own = await readOwnNotes(binding.clone, binding.handle);
  const found = [...own.active.map((n) => [n, false]), ...own.expired.map((n) => [n, true])].find(([n]) => n.value.id === id);
  if (!found) {
    const parent = info(join(binding.clone, "notes"));
    if (parent?.isDirectory() && !parent.isSymbolicLink()) {
      const other = readdirSync(join(binding.clone, "notes")).filter((h) => HUB_HANDLE.test(h) && h !== binding.handle).find((h) => info(join(binding.clone, "notes", h, id + ".json")));
      if (other) refuse("notes/" + other + "/" + id + ".json", "other-handle");
    }
    throw new DevtwinError("NOT_FOUND", "No hub note with this ID in your folder", { id });
  }
  const [note, expired] = found;
  return { item: { kind: "note", id, rel: note.rel, sha256: note.sha256, line: note.value.line, expiresAt: note.value.expiresAt, expired },
    removes: [note.rel], adds: [], effects: ["Colleagues stop seeing it after their next hub sync."] };
}
export async function planDelete(roots, { scope, id }) {
  const binding = await joinedBinding(roots, scope, { writable: true });
  const kind = LESSON_ID.test(id ?? "") ? "lesson" : NOTE_ID.test(id ?? "") ? "note" : null;
  if (!kind) throw new DevtwinError("INVALID_ID", "Invalid published item ID", { allowed: ["lsn_<24 hex>", "note_<24 hex>"] });
  const body = kind === "lesson" ? await lessonPlan(binding, id) : await notePlan(binding, id);
  return finalizePlan({ kind: "published-delete", preview: true, scope: binding.scope, hubId: binding.hubId, author: binding.actorRef, ...body, caveat: DELETE_CAVEAT });
}
const deleteDialog = (plan) => ({ title: "Delete a published item from an organization hub", body: [
  "Scope: " + plan.scope, "Hub: " + plan.hubId, "Author: " + plan.author,
  plan.item.kind === "lesson" ? "Lesson: " + plan.item.title + " [" + plan.item.id + "]" : "Note: " + plan.item.line + " [" + plan.item.id + "]",
  "Removes: " + plan.removes.join(", "), ...plan.adds.map((a) => "Adds the tombstone " + a.rel + ", signed by " + a.handle),
  ...plan.effects, "", plan.caveat
].join("\n") });
export async function applyDelete(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planDelete(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, deleteDialog(plan));
  const binding = await joinedBinding(roots, plan.scope, { writable: true });
  if (binding.hubId !== plan.hubId || binding.actorRef !== plan.author) throw new DevtwinError("STALE_VERSION", "Hub binding changed");
  const createdAt = now().toISOString(), { item } = plan;
  const writes = [{ rel: item.rel, content: null }, ...plan.adds.map((a) => ({ rel: a.rel, content: JSON.stringify({ schemaVersion: 1, id: item.id, handle: a.handle, createdAt }) + "\n" }))];
  // The file on the fetched remote branch must still be the one the preview showed.
  const preconditions = async () => {
    const blob = hubGit(binding, ["cat-file", "blob", "refs/remotes/origin/" + binding.branch + ":" + item.rel]);
    if (!blob.ok) throw new DevtwinError("STALE_VERSION", "Published item changed", { reason: "item-missing", id: item.id });
    if (sha256(blob.stdout) !== item.sha256) throw new DevtwinError("STALE_VERSION", "Published item changed", { reason: "item-changed", id: item.id });
  };
  const hub = await withHubLock(roots, async () => {
    const result = await publishToHub(roots, binding, { writes, message: "Remove " + item.kind + " " + item.id, preconditions, now, locked: true, kind: "tombstone", createdAt });
    // This machine stops delivering at once, even while the removal waits in the outbox.
    if (item.kind === "lesson") await rememberTombstones(roots, binding, [{ id: item.id, author: binding.actorRef }], { now });
    else {
      const { readNotesCache, writeNotesCache } = await import("../notes/post.mjs");
      await writeNotesCache(roots, binding, (await readNotesCache(roots, binding)).filter((n) => n.rel !== item.rel));
    }
    return result.pushed ? { pushed: true, commit: result.commit, attempts: result.attempts } : { pushed: false, reason: result.reason, queued: result.queued };
  });
  const { rebuildIndex } = await import("../lessons/index.mjs");
  const index = await rebuildIndex(roots, plan.scope);
  return { deleted: true, scope: plan.scope, hubId: plan.hubId, item: { kind: item.kind, id: item.id, rel: item.rel }, hub, caveat: DELETE_CAVEAT, index: { written: index.written, counts: index.counts } };
}

// The expired-note cleanup that hub sync runs under its lock after the fetch. It never queues: the next sync tries again.
export async function cleanExpiredNotes(roots, binding, { now = () => new Date() } = {}) {
  const own = await readOwnNotes(binding.clone, binding.handle, { now: now() });
  const expired = own.expired.map((n) => n.rel).sort();
  if (!expired.length) return { deleted: 0, remaining: 0 };
  const batch = expired.slice(0, NOTE_CLEANUP_BATCH);
  const result = await publishToHub(roots, binding, { writes: batch.map((rel) => ({ rel, content: null })), message: "Remove " + batch.length + " expired notes", now, queue: false, locked: true, kind: "tombstone" });
  const deleted = result.pushed ? batch.length : 0;
  return { deleted, remaining: expired.length - deleted, pushed: result.pushed, ...(result.pushed ? { commit: result.commit } : { reason: result.reason }), ...(own.truncated ? { truncated: true } : {}) };
}
