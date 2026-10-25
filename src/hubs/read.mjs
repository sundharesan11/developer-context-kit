// U10 (KTD2, KTD19): reading a hub clone. Hub content is untrusted input from other people. Every file goes through the
// no-follow, regular-file, size-capped reader, and Git's own index must list it as a regular file, so a committed
// symlink or submodule is refused before any read. File size, file count and JSON depth are capped. Nothing here
// runs the network or writes.
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { git } from "../identity/git.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { info } from "../storage/fsx.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { ACTOR_REF } from "../identity/ids.mjs";
import { validateMatch } from "../records/schema.mjs";

export const HUB_SCHEMA_VERSION = 1;
export const HUB_LIMITS = Object.freeze({ hubJsonBytes: 4096, lessonBytes: 65536, lessonBodyBytes: 32768, noteBytes: 4096, tombstoneBytes: 4096, lessons: 2000, notes: 5000, tombstones: 2000, handles: 500, jsonDepth: 6, notePaths: 10, notePackages: 10, noteLineChars: 200 });
export const HUB_ID = /^[a-z][a-z0-9-]{1,63}$/;
export const HUB_HANDLE = /^[a-z0-9][a-z0-9._-]{0,38}$/;
export const LESSON_ID = /^lsn_[a-f0-9]{24}$/;
export const NOTE_ID = /^note_[a-f0-9]{24}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const LINE_UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const bad = () => { throw new DevtwinError("HUB_INVALID", "Hub file invalid"); };
// The developer's own files: a lesson, a note in their handle's folder, or a tombstone.
export const LESSON_REL = /^lessons\/(lsn_[a-f0-9]{24})\.md$/;
export const NOTE_REL = /^notes\/([a-z0-9][a-z0-9._-]{0,38})\/(note_[a-f0-9]{24})\.json$/;
export const TOMBSTONE_REL = /^tombstones\/(lsn_[a-f0-9]{24})\.json$/;

function depth(value) {
  if (!value || typeof value !== "object") return 0;
  let max = 0;
  for (const child of Object.values(value)) max = Math.max(max, depth(child));
  return max + 1;
}
export function parseHubJson(text, limit) {
  if (Buffer.byteLength(text) > limit) bad();
  let value;
  try { value = JSON.parse(text); } catch { bad(); }
  if (!isObject(value) || depth(value) > HUB_LIMITS.jsonDepth) bad();
  return value;
}
const isoTime = (value) => typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value));
const oneLine = (value, limit) => typeof value === "string" && value.length >= 1 && [...value].length <= limit && !LINE_UNSAFE.test(value);
// hub.json: { hubId, schemaVersion }. Other keys are allowed for a later schema version.
export function parseHubManifest(text) {
  const value = parseHubJson(text, HUB_LIMITS.hubJsonBytes);
  if (typeof value.hubId !== "string" || !HUB_ID.test(value.hubId) || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1) bad();
  return { hubId: value.hubId, schemaVersion: value.schemaVersion };
}

// U12 (KTD3): a replacement names each predecessor's ID and the sha256 of its exact hub file, as [{ id, hash }].
// Distinct IDs, never the lesson's own, at most MAX_SUPERSEDES entries. Any other shape makes the file invalid.
export const MAX_SUPERSEDES = 5;
function checkSupersedes(list, own) {
  if (!Array.isArray(list) || !list.length || list.length > MAX_SUPERSEDES) bad();
  for (const entry of list) {
    if (!isObject(entry) || Object.keys(entry).length !== 2 || !LESSON_ID.test(entry.id ?? "") || entry.id === own || typeof entry.hash !== "string" || !HASH.test(entry.hash)) bad();
  }
  if (new Set(list.map((entry) => entry.id)).size !== list.length) bad();
}
// A hub lesson file: a front matter block of one JSON line between "---" lines, then the Markdown body.
const LESSON_KEYS = ["schemaVersion", "id", "author", "title", "match", "createdAt", "revisitAfter", "localRecordHash", "supersedes"];
function checkLessonMeta(meta) {
  if (!isObject(meta) || Object.keys(meta).some((key) => !LESSON_KEYS.includes(key)) || meta.schemaVersion !== 1) bad();
  if (!LESSON_ID.test(meta.id ?? "") || typeof meta.author !== "string" || !ACTOR_REF.test(meta.author) || !meta.author.startsWith("handle:")) bad();
  if (!oneLine(meta.title, 200) || !isoTime(meta.createdAt)) bad();
  if (meta.revisitAfter !== undefined && meta.revisitAfter !== null && !(typeof meta.revisitAfter === "string" && DATE.test(meta.revisitAfter))) bad();
  if (meta.localRecordHash !== undefined && meta.localRecordHash !== null && !(typeof meta.localRecordHash === "string" && HASH.test(meta.localRecordHash))) bad();
  if (meta.supersedes !== undefined && meta.supersedes !== null) checkSupersedes(meta.supersedes, meta.id);
  try { validateMatch(meta.match ?? {}); } catch { bad(); }
  if (!["paths", "packages", "topics"].some((key) => meta.match?.[key]?.length)) bad();
  return meta;
}
export function renderHubLesson(meta, body) {
  checkLessonMeta(meta);
  if (typeof body !== "string" || Buffer.byteLength(body) > HUB_LIMITS.lessonBodyBytes) bad();
  return "---\n" + JSON.stringify(meta) + "\n---\n" + body;
}
export function parseHubLesson(text) {
  if (Buffer.byteLength(text) > HUB_LIMITS.lessonBytes) bad();
  const match = /^---\n([^\n]+)\n---\n([\s\S]*)$/.exec(text);
  if (!match) bad();
  const meta = checkLessonMeta(parseHubJson(match[1], HUB_LIMITS.lessonBytes));
  if (Buffer.byteLength(match[2]) > HUB_LIMITS.lessonBodyBytes) bad();
  return { meta, body: match[2] };
}
// A "working on" note (KTD10): the area, one line, the handle and the time. U13 builds and posts them.
const NOTE_KEYS = ["schemaVersion", "id", "handle", "area", "line", "createdAt", "expiresAt"];
export function parseHubNote(text) {
  const note = parseHubJson(text, HUB_LIMITS.noteBytes);
  if (Object.keys(note).some((key) => !NOTE_KEYS.includes(key)) || note.schemaVersion !== 1 || !NOTE_ID.test(note.id ?? "") || !HUB_HANDLE.test(note.handle ?? "")) bad();
  if (!isObject(note.area) || Object.keys(note.area).some((key) => !["paths", "packages"].includes(key))) bad();
  const paths = note.area.paths ?? [], packages = note.area.packages ?? [];
  if (!Array.isArray(paths) || paths.length > HUB_LIMITS.notePaths || !Array.isArray(packages) || packages.length > HUB_LIMITS.notePackages) bad();
  if ([...paths, ...packages].some((item) => !oneLine(item, 200) || item.startsWith("/") || item.split("/").includes(".."))) bad();
  if (!oneLine(note.line, HUB_LIMITS.noteLineChars) || !isoTime(note.createdAt) || !isoTime(note.expiresAt) || Date.parse(note.expiresAt) <= Date.parse(note.createdAt)) bad();
  return note;
}
// A tombstone names a lesson ID and the handle that asks for its removal.
export function parseHubTombstone(text) {
  const value = parseHubJson(text, HUB_LIMITS.tombstoneBytes);
  if (Object.keys(value).some((key) => !["schemaVersion", "id", "handle", "createdAt"].includes(key)) || value.schemaVersion !== 1 || !LESSON_ID.test(value.id ?? "") || !HUB_HANDLE.test(value.handle ?? "") || !isoTime(value.createdAt)) bad();
  return value;
}
// KTD20: a tombstone is honored only when its handle matches the lesson's author. U14 adds the publish side.
export function applyTombstones(lessons, tombstones) {
  const removed = [], ignored = [];
  const kept = lessons.filter((lesson) => {
    const stone = tombstones.find((t) => t.value.id === lesson.meta.id);
    if (!stone) return true;
    if ("handle:" + stone.value.handle === lesson.meta.author) { removed.push(lesson.meta.id); return false; }
    return true;
  });
  for (const stone of tombstones) if (!removed.includes(stone.value.id)) ignored.push({ rel: stone.rel, reason: lessons.some((l) => l.meta.id === stone.value.id) ? "handle-mismatch" : "no-lesson" });
  return { kept, removed, ignored };
}
// U12 (KTD3): supersession over the lessons left after tombstones. A replacement is valid when its predecessor is
// one of those lessons and the named hash equals the sha256 of the predecessor's file. A predecessor with at least one
// valid replacement stops delivering. When two or more valid replacements name the same predecessor, both were pushed
// before either client saw the other (a later one fails with STALE_VERSION at publish), so each is marked contested.
// An invalid supersession (unknown or removed predecessor, wrong hash) is ignored: the predecessor stays and the
// replacement is delivered as a plain lesson, so a wrong hash can never hide another person's lesson.
export function applySupersession(lessons) {
  const byId = new Map(lessons.map((lesson) => [lesson.meta.id, lesson]));
  const successors = new Map(), ignored = [];
  for (const lesson of lessons) for (const entry of lesson.meta.supersedes ?? []) {
    const predecessor = byId.get(entry.id);
    const reason = !predecessor ? "no-lesson" : predecessor.sha256 !== entry.hash ? "hash-mismatch" : null;
    if (reason) { ignored.push({ id: lesson.meta.id, predecessorId: entry.id, reason }); continue; }
    if (!successors.has(entry.id)) successors.set(entry.id, []);
    successors.get(entry.id).push(lesson);
  }
  const contestedIds = new Set(), superseded = [], contested = [];
  for (const [id, list] of [...successors].sort(([x], [y]) => x < y ? -1 : 1)) {
    const by = list.map((l) => ({ id: l.meta.id, title: l.meta.title, author: l.meta.author })).sort((x, y) => x.id < y.id ? -1 : 1);
    const predecessor = byId.get(id).meta;
    superseded.push({ id, title: predecessor.title, author: predecessor.author, sha256: byId.get(id).sha256, by });
    if (by.length > 1) { contested.push({ predecessorId: id, successorIds: by.map((x) => x.id) }); for (const x of by) contestedIds.add(x.id); }
  }
  const kept = lessons.filter((lesson) => !successors.has(lesson.meta.id)).map((lesson) => contestedIds.has(lesson.meta.id) ? { ...lesson, contested: true } : lesson);
  return { kept, superseded, contested, ignored };
}

// The modes Git's index records for each path, read from the local clone. 100644 and 100755 are regular files.
function indexModes(clone) {
  const result = git(clone, ["ls-files", "-s", "-z", "--", "hub.json", "lessons", "notes", "tombstones"]);
  if (!result.ok) throw new DevtwinError("HUB_INVALID", "Hub clone unreadable");
  const modes = new Map();
  for (const entry of result.stdout.split("\0").filter(Boolean)) {
    const match = /^([0-7]{6}) [0-9a-f]+ \d+\t(.+)$/s.exec(entry);
    if (match) modes.set(match[2], match[1]);
  }
  return modes;
}
// The names in one hub folder; a missing folder is empty. A symlinked or odd folder is refused as a whole.
function names(clone, rel, refused) {
  const node = info(join(clone, rel));
  if (!node) return [];
  if (node.isSymbolicLink() || !node.isDirectory()) { refused.push({ rel, reason: "not-regular" }); return []; }
  return readdirSync(join(clone, rel)).sort();
}
async function readOne(clone, rel, modes, limit, refused) {
  const mode = modes.get(rel);
  if (mode !== "100644" && mode !== "100755") { refused.push({ rel, reason: mode ? "not-regular" : "untracked" }); return null; }
  const read = await readApprovedSource(clone, rel);
  if (read.skipped) { refused.push({ rel, reason: read.skipped }); return null; }
  if (!read.utf8Valid) { refused.push({ rel, reason: "not-utf8" }); return null; }
  if (read.size > limit) { refused.push({ rel, reason: "too-large" }); return null; }
  return read;
}
// The hub manifest alone: { hubId, schemaVersion } or HUB_INVALID.
export async function readHubManifest(clone) {
  const read = await readOne(clone, "hub.json", indexModes(clone), HUB_LIMITS.hubJsonBytes, []);
  if (!read) throw new DevtwinError("HUB_INVALID", "Hub manifest missing or unsafe");
  return parseHubManifest(read.text);
}
// Everything the client reads from a clone. A hub with a newer schema version is read-only: nothing else is read.
// now drops expired notes.
export async function readHub(clone, { now = new Date() } = {}) {
  const modes = indexModes(clone), refused = [], warnings = [];
  const manifestRead = await readOne(clone, "hub.json", modes, HUB_LIMITS.hubJsonBytes, refused);
  if (!manifestRead) throw new DevtwinError("HUB_INVALID", "Hub manifest missing or unsafe");
  const hub = parseHubManifest(manifestRead.text);
  if (hub.schemaVersion > HUB_SCHEMA_VERSION) {
    warnings.push({ code: "HUB_SCHEMA_NEWER", schemaVersion: hub.schemaVersion, supported: HUB_SCHEMA_VERSION, message: "This hub uses a newer format. devtwin reads nothing from it and writes nothing to it until the kit is upgraded." });
    return { hub, readOnly: true, warnings, lessons: [], notes: [], tombstones: [], refused, removed: [], ignoredTombstones: [], superseded: [], contested: [], ignoredSupersessions: [], expiredNotes: 0 };
  }
  const lessons = [], notes = [], stones = [];
  const lessonNames = names(clone, "lessons", refused);
  if (lessonNames.length > HUB_LIMITS.lessons) throw new DevtwinError("LIMIT", "Too many hub lessons", { max: HUB_LIMITS.lessons });
  for (const name of lessonNames) {
    const rel = "lessons/" + name, match = LESSON_REL.exec(rel);
    if (!match) { refused.push({ rel, reason: "unexpected-name" }); continue; }
    const read = await readOne(clone, rel, modes, HUB_LIMITS.lessonBytes, refused);
    if (!read) continue;
    try {
      const lesson = parseHubLesson(read.text);
      if (lesson.meta.id !== match[1]) throw new Error("id");
      lessons.push({ rel, sha256: read.sha256, ...lesson });
    } catch { refused.push({ rel, reason: "invalid" }); }
  }
  const handles = names(clone, "notes", refused);
  if (handles.length > HUB_LIMITS.handles) throw new DevtwinError("LIMIT", "Too many hub note folders", { max: HUB_LIMITS.handles });
  let noteCount = 0, expiredNotes = 0;
  for (const handle of handles) {
    if (!HUB_HANDLE.test(handle)) { refused.push({ rel: "notes/" + handle, reason: "unexpected-name" }); continue; }
    for (const name of names(clone, "notes/" + handle, refused)) {
      if (++noteCount > HUB_LIMITS.notes) throw new DevtwinError("LIMIT", "Too many hub notes", { max: HUB_LIMITS.notes });
      const rel = "notes/" + handle + "/" + name, match = NOTE_REL.exec(rel);
      if (!match) { refused.push({ rel, reason: "unexpected-name" }); continue; }
      const read = await readOne(clone, rel, modes, HUB_LIMITS.noteBytes, refused);
      if (!read) continue;
      try {
        const note = parseHubNote(read.text);
        if (note.id !== match[2] || note.handle !== handle) throw new Error("id");
        if (Date.parse(note.expiresAt) <= now.getTime()) { expiredNotes++; continue; }
        notes.push({ rel, sha256: read.sha256, value: note });
      } catch { refused.push({ rel, reason: "invalid" }); }
    }
  }
  const stoneNames = names(clone, "tombstones", refused);
  if (stoneNames.length > HUB_LIMITS.tombstones) throw new DevtwinError("LIMIT", "Too many hub tombstones", { max: HUB_LIMITS.tombstones });
  for (const name of stoneNames) {
    const rel = "tombstones/" + name, match = TOMBSTONE_REL.exec(rel);
    if (!match) { refused.push({ rel, reason: "unexpected-name" }); continue; }
    const read = await readOne(clone, rel, modes, HUB_LIMITS.tombstoneBytes, refused);
    if (!read) continue;
    try {
      const value = parseHubTombstone(read.text);
      if (value.id !== match[1]) throw new Error("id");
      stones.push({ rel, value });
    } catch { refused.push({ rel, reason: "invalid" }); }
  }
  const { kept, removed, ignored } = applyTombstones(lessons, stones);
  const replaced = applySupersession(kept);
  return { hub, readOnly: false, warnings, lessons: replaced.kept, notes, tombstones: stones, refused, removed, ignoredTombstones: ignored,
    superseded: replaced.superseded, contested: replaced.contested, ignoredSupersessions: replaced.ignored, expiredNotes };
}
// Hub lessons as index records: org reach in the binding's scope, attributed to the claimed author (KTD20). A
// superseded lesson is already gone from read.lessons; a contested replacement carries contested: true.
export function hubRecords(binding, read) {
  return read.lessons.map((lesson) => ({
    schemaVersion: 2, id: lesson.meta.id, kind: "lesson", reach: "org", scope: binding.scope, project: null,
    title: lesson.meta.title, body: lesson.body, effective: "confirmed", status: "confirmed", match: { paths: [], packages: [], topics: [], ...lesson.meta.match },
    recordedBy: { actor: "human", actorRef: lesson.meta.author }, revisitAfter: lesson.meta.revisitAfter ?? null,
    createdAt: lesson.meta.createdAt, recordHash: lesson.sha256 ?? sha256(lesson.body), hubId: binding.hubId, ...(lesson.contested ? { contested: true } : {})
  }));
}
