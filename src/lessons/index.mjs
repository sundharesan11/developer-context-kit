import { join, dirname, resolve } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readRegistry } from "../config/registry.mjs";
import { loadScope, readBindingVersion, readHubBinding } from "../config/store.mjs";
import { readHub, hubRecords } from "../hubs/read.mjs";
import { readTombstoneMemory } from "../hubs/published.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { assertScopeId, ACTOR_REF } from "../identity/ids.mjs";
import { readSnapshot } from "../records/store.mjs";
import { readOrgSnapshot, readPersonalSnapshot } from "../records/personal.mjs";
import { isDelivered } from "../records/schema.mjs";
// U6: one match index per scope at stateRoot/lessons/<scope>.json. It is a derived cache: every field comes from the
// scope's project records, its org records, the personal store and the registry bindings, so a rebuild can replace it
// at any time. The hook reads it and never rebuilds it (KTD22).
const INDEX_LIMIT = 8 << 20, MAX_ENTRIES = 5000, SUMMARY_BYTES = 160;
// Effective states that match. Superseded, proposed and disputed records do not, nor any later state such as a tombstone.
const LIVE = ["observed", "confirmed"];
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
export const indexPath = (roots, scope) => join(roots.stateRoot, "lessons", assertScopeId(scope) + ".json");
// An underscore keeps this lock name apart from every scope lock name.
const indexLockPath = (roots, scope) => join(roots.stateRoot, "locks", "lessons_" + scope + ".lock");
const failure = (error) => error?.code ?? "DEVTWIN_INTERNAL";
// The latest registry entry for each project in the scope.
function latestEntries(registry, scope) {
  const latest = new Map();
  for (const entry of registry.bindings.filter((b) => b.scope === scope)) {
    const seen = latest.get(entry.project);
    if (!seen || entry.bindingVersion > seen.bindingVersion) latest.set(entry.project, entry);
  }
  return [...latest.values()].sort((a, b) => a.project < b.project ? -1 : 1);
}
// Sources give {records, unavailable}. A superseded hub lesson never reaches the hub source (src/hubs/read.mjs), and a
// contested replacement keeps contested: true in its entry (U12). Records carry body and effective, as the snapshot readers return them.
// The hub clone is the fourth source (U10). It reads the clone only while the scope is joined with delivery on, and a
// hub with a newer schema version gives nothing. Its records name the author in recordedBy.actorRef, which claimedBy
// then uses in place of the local user.
export const SOURCES = [
  { name: "project", async read(roots, scope) {
    const records = [], unavailable = [];
    for (const entry of latestEntries((await readRegistry(roots)).value, scope)) {
      try { records.push(...(await readSnapshot(roots, scope, entry.project)).records); }
      catch (error) { unavailable.push({ source: "project", project: entry.project, code: failure(error) }); }
    }
    return { records, unavailable };
  } },
  { name: "org", async read(roots, scope) { return { records: (await readOrgSnapshot(roots, scope)).records, unavailable: [] }; } },
  { name: "personal", async read(roots) { return { records: (await readPersonalSnapshot(roots)).records, unavailable: [] }; } },
  { name: "hub", async read(roots, scope) {
    const binding = await readHubBinding(roots, scope);
    if (!binding || binding.status !== "joined" || binding.delivery !== "on") return { records: [], unavailable: [] };
    // U14: a lesson whose valid tombstone this machine has seen stays out. A damaged memory gives no hub lessons.
    let seen;
    try { seen = await readTombstoneMemory(roots, binding); } catch (error) { return { records: [], unavailable: [{ source: "hub", code: failure(error) }] }; }
    const read = await readHub(binding.clone, { seen });
    if (read.readOnly) return { records: [], unavailable: [{ source: "hub", code: "DEVTWIN_HUB_SCHEMA_NEWER" }] };
    return { records: hubRecords(binding, read), unavailable: [] };
  } }
];
// U32: a lesson that matches only commands is live too.
const hasMatch = (match) => ["paths", "packages", "topics", "commands"].some((key) => match?.[key]?.length);
// U37: a retraction is never delivered (it is not a lesson kind either).
const isLive = (r) => r.schemaVersion === 2 && isDelivered(r) && ["lesson", "preference"].includes(r.kind) && LIVE.includes(r.effective) && hasMatch(r.match);
function capBytes(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text;
  let out = "", bytes = 0;
  for (const ch of text) { const n = Buffer.byteLength(ch); if (bytes + n > limit - 3) break; out += ch; bytes += n; }
  return out.trimEnd() + "\u2026";
}
// The one-line "do or do not": the first body line without list or heading marks, or the title when the body has none.
function summaryOf(record) {
  const line = String(record.body ?? "").split("\n").map((l) => l.replace(UNSAFE, " ").replace(/^\s*(?:[#>*+-]+|\d+[.)])\s*/, "").replace(/\s+/g, " ").trim()).find(Boolean);
  return capBytes(line ?? record.title, SUMMARY_BYTES);
}
async function localHandle(roots) {
  try { const ref = (await readPrivateJson(join(roots.configRoot, "user.json"))).actorRefs?.[0]; return ACTOR_REF.test(ref ?? "") ? ref : "handle:local"; }
  catch { return "handle:local"; }
}
// Each bound root with its Git common directory. A linked worktree of a bound repository shares that common directory.
async function boundRoots(roots, scope) {
  const out = [], unavailable = [];
  for (const entry of latestEntries((await readRegistry(roots)).value, scope)) {
    try { for (const r of (await readBindingVersion(roots, entry)).roots) out.push({ root: r.path, commonDir: r.commonDir, kind: r.kind, scope, project: entry.project }); }
    catch (error) { unavailable.push({ source: "binding", project: entry.project, code: failure(error) }); }
  }
  return { roots: out.sort((a, b) => a.root < b.root ? -1 : a.root > b.root ? 1 : 0), unavailable };
}
async function gather(roots, scope, { sources = SOURCES } = {}) {
  assertScopeId(scope);
  await loadScope(roots, scope);
  const handle = await localHandle(roots);
  const entries = [], bodies = new Map(), unavailable = [], counts = {};
  for (const source of sources) {
    let read;
    try { read = await source.read(roots, scope); }
    catch (error) { unavailable.push({ source: source.name, code: failure(error) }); continue; }
    unavailable.push(...read.unavailable);
    const live = read.records.filter(isLive);
    counts[source.name] = live.length;
    for (const r of live) {
      entries.push({ id: r.id, kind: r.kind, reach: r.reach, source: source.name, scope: r.scope, project: r.project, title: r.title, summary: summaryOf(r), claimedBy: ACTOR_REF.test(r.recordedBy?.actorRef ?? "") ? r.recordedBy.actorRef : handle, status: r.effective, actor: r.recordedBy?.actor ?? null, revisitAfter: r.revisitAfter ?? null, createdAt: r.createdAt, recordHash: r.recordHash, match: r.match, ...(r.contested ? { contested: true } : {}) });
      bodies.set(r.id, r.body);
    }
  }
  if (entries.length > MAX_ENTRIES) throw new DevtwinError("LIMIT", "Too many lessons for one index", { max: MAX_ENTRIES });
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const bound = await boundRoots(roots, scope);
  unavailable.push(...bound.unavailable);
  const body = { schemaVersion: 1, scope, roots: bound.roots, entries, unavailable,
    counts: { entries: entries.length, project: counts.project ?? 0, org: counts.org ?? 0, personal: counts.personal ?? 0, hub: counts.hub ?? 0, roots: bound.roots.length, unavailable: unavailable.length } };
  // No clock value goes in, so the same sources always give the same bytes and fingerprint.
  return { index: { ...body, fingerprint: digest(body) }, bodies };
}
// The index for one scope, built in memory from its sources. Nothing is written.
export async function buildIndex(roots, scope, options = {}) { return (await gather(roots, scope, options)).index; }
// Writes the index only when its fingerprint changed. This is devtwin's own cache under stateRoot, like the
// approved-config digest, so it uses a locked atomic replace and no preview and apply step.
export async function rebuildIndex(roots, scope, options = {}) {
  const path = indexPath(roots, scope);
  assertWritable(roots, [path, indexLockPath(roots, scope)]);
  const result = await withPilotLock(roots, indexLockPath(roots, scope), { kind: "lesson-index" }, async () => {
    const { index } = await gather(roots, scope, options);
    let current = null;
    try { current = await readIndex(roots, scope); } catch { /* A damaged index is replaced. */ }
    const written = current?.fingerprint !== index.fingerprint;
    if (written) {
      assertWritable(roots, [path]);
      ensurePrivatePath(roots.stateRoot, ["lessons"]);
      await atomicReplace(path, canonicalJson(index) + "\n");
    }
    return { scope, path, written, fingerprint: index.fingerprint, counts: index.counts };
  }, { destinations: [path] });
  // U31 (KTD30): the session summaries read the index, so they follow it, after the index lock is released. A failed
  // summary never fails the rebuild.
  const { refreshSummaries } = await import("../context/summary.mjs");
  await refreshSummaries(roots, scope);
  return result;
}
// The stored index, or null when none is built. A changed or damaged file fails with INTEGRITY.
export async function readIndex(roots, scope) {
  let value;
  try { value = await readPrivateJson(indexPath(roots, scope), INDEX_LIMIT); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { fingerprint, ...body } = value ?? {};
  if (value?.schemaVersion !== 1 || value.scope !== scope || !Array.isArray(value.entries) || !Array.isArray(value.roots) || digest(body) !== fingerprint) throw new DevtwinError("INTEGRITY", "Lesson index invalid");
  return value;
}
// The effective lesson with this ID and its body, or null. The body is another person's text once hubs exist.
export async function findLesson(roots, scope, id, options = {}) {
  const { index, bodies } = await gather(roots, scope, options);
  const entry = index.entries.find((e) => e.id === id);
  return entry ? { entry, body: bodies.get(id) } : null;
}
// The Git common directory for a worktree root, read from its .git entry without running Git. A main worktree's
// .git is the directory itself. A linked worktree's .git file names its gitdir, whose commondir file names the
// shared directory. Any surprise gives null; callers fail open.
export function readCommonDir(root) {
  try {
    const dotGit = join(root, ".git"), node = info(dotGit);
    if (!node || node.isSymbolicLink()) return null;
    if (node.isDirectory()) return realpathSync(dotGit);
    if (!node.isFile() || node.size > 4096) return null;
    const match = /^gitdir: (.+?)\r?\n?$/.exec(readFileSync(dotGit, "utf8"));
    if (!match) return null;
    const gitDir = resolve(root, match[1]);
    const common = info(join(gitDir, "commondir"));
    if (!common) return realpathSync(gitDir);
    if (!common.isFile() || common.size > 4096) return null;
    return realpathSync(resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim()));
  } catch { return null; }
}
// The nearest folder at or above a canonical path that has a .git entry, or null.
export function findRepoRoot(path) {
  for (let at = path; ; at = dirname(at)) {
    if (info(join(at, ".git"))) return at;
    if (dirname(at) === at) return null;
  }
}
// Path-to-scope lookup (KTD6): an exact bound root first, then a linked worktree through its common directory.
export function resolveRepo(index, { root, commonDir }) {
  const exact = index.roots.find((r) => r.root === root);
  if (exact) return { scope: exact.scope, project: exact.project, via: "root" };
  const shared = commonDir ? index.roots.find((r) => r.commonDir === commonDir) : null;
  return shared ? { scope: shared.scope, project: shared.project, via: "common-dir" } : null;
}
