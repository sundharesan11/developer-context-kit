// U10 (KTD1, KTD15, KTD22): hub sync and hub status. Sync is the one read path that uses the network: it takes the
// hub-sync lock, fetches with a timeout, drains the outbox, reads the clone through src/hubs/read.mjs and rebuilds
// the lesson index with the hub as a source. A failed fetch keeps the old clone and the last sync time. U12: it also
// records replacements of this developer's own lessons as notices (src/lessons/supersede.mjs).
// U13: it writes the notes cache that the hook reads (src/notes/post.mjs).
// U14: after the outbox it deletes this developer's own expired notes (src/hubs/published.mjs), and it adds each valid
// tombstone it sees to the tombstone memory before the index rebuild, so that lesson never reaches agents again.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readHubBinding, writeHubBinding } from "../config/store.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace } from "../storage/fsx.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { isolationTerms } from "../records/isolation.mjs";
import { rebuildIndex, readIndex } from "../lessons/index.mjs";
import { recordNotices } from "../lessons/supersede.mjs";
import { writeNotesCache } from "../notes/post.mjs";
import { HUB_SCHEMA_VERSION, readHub, readHubManifest } from "./read.mjs";
import { hubGit, withHubLock, hubStateDir, drainOutbox, listOutbox } from "./git-write.mjs";
import { cleanExpiredNotes, readTombstoneMemory, rememberTombstones, validTombstones } from "./published.mjs";

export const FETCH_TIMEOUT_MS = 30_000;
// The job runs every 600 seconds; a run within 540 seconds of the last one is skipped, so missed runs collapse into one.
export const JOB_SKIP_MS = 540_000;
export const STALE_HOURS = 24;
const HOUR = 3600 * 1000;
export const syncStatePath = (roots, hubId) => join(hubStateDir(roots, hubId), "sync.json");
export const jobReceiptPath = (roots, hubId) => join(hubStateDir(roots, hubId), "job-receipt.json");
async function readState(path) {
  try { return await readPrivateJson(path, 8192); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function writeState(roots, hubId, path, value) {
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["hubs", hubId]);
  await atomicReplace(path, canonicalJson({ schemaVersion: 1, hubId, ...value }) + "\n");
}
export const readSyncState = (roots, hubId) => readState(syncStatePath(roots, hubId));
export const writeSyncState = (roots, hubId, value) => writeState(roots, hubId, syncStatePath(roots, hubId), value);
export async function requireJoined(roots, scope) {
  const binding = await readHubBinding(roots, assertScopeId(scope));
  if (!binding || binding.status !== "joined") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub", { scope });
  return binding;
}
// "hub last synced N h ago" once the last good sync is more than a day old.
export function syncAge(state, now) {
  const last = Date.parse(state?.lastSyncedAt ?? "");
  if (!Number.isFinite(last)) return { hours: null, warning: "hub never synced" };
  const hours = Math.max(0, Math.floor((now.getTime() - last) / HOUR));
  return { hours, warning: hours > STALE_HOURS ? "hub last synced " + hours + " h ago" : null };
}
// For context brief: a HUB_STALE warning for a joined scope whose clone is more than a day old, else null.
export async function hubWarning(roots, scope, now) {
  const binding = await readHubBinding(roots, scope);
  if (!binding || binding.status !== "joined") return null;
  const { hours, warning } = syncAge(await readSyncState(roots, binding.hubId), now);
  return warning ? { code: "HUB_STALE", message: warning, hubId: binding.hubId, hours } : null;
}

// job: the scheduled run. It checks the job's own flag and its receipt before the lock and before any network call.
export async function syncHub(roots, scope, { now = () => new Date(), job = false } = {}) {
  const first = await requireJoined(roots, scope);
  if (job) {
    if (first.jobs?.hubSync?.enabled !== true) return { scope: first.scope, hubId: first.hubId, skipped: "job-disabled" };
    const receipt = await readState(jobReceiptPath(roots, first.hubId));
    const since = now().getTime() - Date.parse(receipt?.lastRunAt ?? "");
    if (since >= 0 && since < JOB_SKIP_MS) return { scope: first.scope, hubId: first.hubId, skipped: "ran-recently", lastRunAt: receipt.lastRunAt };
  }
  return withHubLock(roots, async () => {
    let binding = await requireJoined(roots, scope);
    const at = now().toISOString();
    if (job) await writeState(roots, binding.hubId, jobReceiptPath(roots, binding.hubId), { lastRunAt: at });
    assertWritable(roots, [binding.clone], { writeClass: "hubRoot" });
    const previous = await readSyncState(roots, binding.hubId);
    const fetched = hubGit(binding, ["fetch", "-q", "--prune", "--no-recurse-submodules", "origin"], { timeoutMs: FETCH_TIMEOUT_MS }).ok;
    if (fetched) {
      for (const args of [["reset", "-q", "--hard", "refs/remotes/origin/" + binding.branch], ["clean", "-fdq"]]) {
        if (!hubGit(binding, args).ok) throw new DevtwinError("HUB_GIT_FAILED", "Hub Git step failed", { step: args[0] });
      }
    }
    const manifest = await readHubManifest(binding.clone);
    if (manifest.hubId !== binding.hubId) throw new DevtwinError("HUB_INVALID", "Hub ID changed", { hubId: binding.hubId });
    const readOnly = manifest.schemaVersion > HUB_SCHEMA_VERSION;
    if (readOnly !== binding.readOnly || manifest.schemaVersion !== binding.hubSchemaVersion) {
      binding = { ...binding, readOnly, hubSchemaVersion: manifest.schemaVersion };
      await writeHubBinding(roots, binding);
    }
    const outbox = fetched && !readOnly ? await drainOutbox(roots, binding, { now, terms: await isolationTerms(roots) }) : { pushed: [], dropped: [], kept: (await listOutbox(roots, binding)).map((x) => x.id) };
    // A failed cleanup is reported, not fatal; it never queues, and the next sync tries again.
    let noteCleanup = { deleted: 0, skipped: readOnly ? "read-only" : "fetch-failed" };
    if (fetched && !readOnly) {
      try { noteCleanup = await cleanExpiredNotes(roots, binding, { now }); }
      catch (error) { noteCleanup = { deleted: 0, problem: error.code ?? "DEVTWIN_INTERNAL" }; }
    }
    // A damaged tombstone memory is started again from the tombstones this sync can tie to their authors.
    let memory, memoryProblem = null;
    try { memory = await readTombstoneMemory(roots, binding); } catch (error) { memory = []; memoryProblem = error.code ?? "DEVTWIN_INTERNAL"; }
    const read = await readHub(binding.clone, { now: now(), seen: memory });
    let priorIndex = null;
    try { priorIndex = await readIndex(roots, binding.scope); } catch { priorIndex = null; }
    let seen = [];
    if (!read.readOnly) {
      try { seen = await rememberTombstones(roots, binding, validTombstones(read, priorIndex?.entries), { now, damaged: Boolean(memoryProblem) }); }
      catch (error) { memoryProblem = error.code ?? "DEVTWIN_INTERNAL"; }
    }
    // A damaged notices file is reported, not fatal: delivery and the outbox matter more than the notice.
    let notices;
    try { notices = read.readOnly ? { added: 0, pending: null } : await recordNotices(roots, binding, read, { now }); }
    catch (error) { notices = { added: 0, pending: null, problem: error.code ?? "DEVTWIN_INTERNAL" }; }
    // U13: the active notes, cached for the hook, which reads no Git. A failed cache write is reported, not fatal.
    let notesCache = "written";
    try { await writeNotesCache(roots, binding, read.notes); } catch (error) { notesCache = error.code ?? "DEVTWIN_INTERNAL"; }
    const index = await rebuildIndex(roots, binding.scope);
    const state = { lastAttemptAt: at, lastSyncedAt: fetched ? at : previous?.lastSyncedAt ?? binding.joinedAt, lastResult: fetched ? "ok" : "fetch-failed" };
    await writeSyncState(roots, binding.hubId, state);
    const age = syncAge(state, now());
    return { scope: binding.scope, hubId: binding.hubId, fetched, readOnly, lastSyncedAt: state.lastSyncedAt, hoursSinceSync: age.hours, warning: age.warning,
      outbox, lessons: read.lessons.length, notes: read.notes.length, expiredNotes: read.expiredNotes, notesCache, refused: read.refused,
      noteCleanup, tombstones: { removed: read.removed, ignored: read.ignoredTombstones, seen, heldBack: read.heldBack, ...(memoryProblem ? { problem: memoryProblem } : {}) },
      supersession: { superseded: read.superseded.map((x) => x.id), contested: read.contested, ignored: read.ignoredSupersessions }, notices, warnings: read.warnings, index: { written: index.written, fingerprint: index.fingerprint, counts: index.counts } };
  });
}
// Read-only: the binding, the last sync, the outbox size and the job state. No network call.
export async function hubStatus(roots, scope, { now = () => new Date() } = {}) {
  const binding = await readHubBinding(roots, assertScopeId(scope));
  if (!binding) return { scope, joined: false };
  if (binding.status !== "joined") return { scope, joined: false, status: binding.status, hubId: binding.hubId, leftAt: binding.leftAt };
  const state = await readSyncState(roots, binding.hubId), age = syncAge(state, now());
  let outbox;
  try { outbox = (await listOutbox(roots, binding)).length; } catch (error) { outbox = { problem: error.code }; }
  return { scope, joined: true, hubId: binding.hubId, remote: binding.remote, branch: binding.branch, handle: binding.handle, email: binding.email, readOnly: binding.readOnly,
    delivery: binding.delivery, noteConsent: binding.noteConsent ? { rulesDigest: binding.noteConsent.rulesDigest, grantedAt: binding.noteConsent.grantedAt } : null,
    job: binding.jobs?.hubSync ?? null, lastSyncedAt: state?.lastSyncedAt ?? null, lastAttemptAt: state?.lastAttemptAt ?? null, lastResult: state?.lastResult ?? null,
    hoursSinceSync: age.hours, warning: age.warning, outbox };
}
