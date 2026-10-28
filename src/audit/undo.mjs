// U37 (KTD40): undo. `undo --id <aud_...>` reverses one audit entry and `undo --since <time>` every entry after a time,
// newest first. Both preview, then apply with the plan fingerprint. Every undo is always ask (src/policy/tiers.mjs): the
// apply shows the owner dialog, and the hook denies undo --apply from agent shells. A caller's --session cannot be
// proven, so it is kept for display only.
// Undo dispatches on the entry's kind through a small registry. Later kinds (held and outbound items) register their
// own handler; an unknown kind is refused. An undo is never undone, and an entry is undone at most once. An entry whose
// write never landed is reported and left alone. Each undone entry gets its own audit entry (route "undo") before its
// writes, and the affected lesson indexes are rebuilt before undo returns.
//
// A record entry is undone with a retraction: a record of kind retraction that supersedes the current head of each
// chain the entry wrote (the head may be a later sharpened version). A supersede entry (one that replaced earlier
// records) also gets a restored copy of each earlier record, a new record with the earlier draft fields. The first
// restored copy supersedes the retraction, so the chain reads earlier <- successor <- retraction <- restored copy and
// exactly one record is effective. Any further earlier record (a write that replaced two) is restored as a plain add.
// An undo that stopped between the retraction and the restores (a crash) is resumed: the next preview finds the
// retraction and plans only the missing restores.
//
// U30 (KTD40): a learning-branch entry ("repo-learning") registers its own kind in src/learnings/push.mjs, loaded on
// use. Its undo adds a revert commit to the branch, and queues the revert's push when the branch was pushed.
//
// U41 (KTD40, KTD41): a hub-lesson entry (a lesson accepted to a hub under consent) is undone while it waits: undo
// removes it from the held queue, or from the hub outbox when its push failed. Once it was sent it cannot be undone
// here: the lesson is in the hub's Git history, and removing it is `published delete`, which the owner runs.
import { DevtwinError } from "../errors.mjs";
import { finalizePlan, assertFingerprint, deterministicRequestId } from "../storage/plan.mjs";
import { recordIdFor, personalRecordIdFor, orgRecordIdFor } from "../identity/ids.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { tierOf } from "../policy/tiers.mjs";
import { cliRecorder } from "../policy/actor.mjs";
import { SESSION_ID } from "../lessons/propose.mjs";
import { readAudit, appendEntry, landed, undoneMap, outboundStates, AUDIT_ID } from "./log.mjs";

const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const DIALOG_ENTRIES = 20;

// The records of one home: read, supersede and add.
async function homeOps(entry) {
  const store = await import("../records/store.mjs"), personal = await import("../records/personal.mjs");
  const { scope, project } = entry;
  if (entry.home === "project") return {
    read: async (roots) => (await store.readSnapshot(roots, scope, project)).records,
    supersede: (roots, input, options) => store.supersedeRecord(roots, { scope, project, ...input }, options),
    add: (roots, input, options) => store.addRecord(roots, { scope, project, ...input }, options),
    idFor: (requestId) => recordIdFor({ scope, project, requestId })
  };
  if (entry.home === "personal") return {
    read: async (roots) => (await personal.readPersonalSnapshot(roots)).records,
    supersede: (roots, input, options) => personal.supersedePersonalRecord(roots, input, options),
    add: (roots, input, options) => personal.addPersonalRecord(roots, input, options),
    idFor: (requestId) => personalRecordIdFor({ requestId })
  };
  if (entry.home === "org") return {
    read: async (roots) => (await personal.readOrgSnapshot(roots, scope)).records,
    supersede: (roots, input, options) => personal.supersedeOrgRecord(roots, { scope, ...input }, options),
    add: (roots, input, options) => personal.addOrgRecord(roots, { scope, ...input }, options),
    idFor: (requestId) => orgRecordIdFor({ scope, requestId })
  };
  throw new DevtwinError("INTEGRITY", "Audit entry names no record home", { id: entry.id });
}
// The effective records each chain ends in, following supersededBy from the entry's records.
function headsOf(records, ids) {
  const byId = new Map(records.map((r) => [r.id, r])), heads = new Map(), seen = new Set(), queue = [...ids];
  while (queue.length) {
    const record = byId.get(queue.shift());
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    if (record.effective !== "superseded") heads.set(record.id, record);
    else queue.push(...record.supersededBy);
  }
  return [...heads.values()].sort((a, b) => a.id < b.id ? -1 : 1);
}
const retractRequest = (entry) => deterministicRequestId("undo-retract", { entry: entry.id });
const restoreRequest = (entry, id) => deterministicRequestId("undo-restore", { entry: entry.id, record: id });
const retractionDraft = (entry, heads) => ({ kind: "retraction", class: "lesson", reach: entry.home, status: "observed", title: "Retraction by devtwin undo of " + entry.id,
  body: "Undoes audit entry " + entry.id + ".\n", sources: heads.slice(0, 20).map((r) => ({ ref: "record:" + r.id })), applicability: { level: "project" } });
// The earlier record's draft fields, as validateDraft takes them.
const restoredDraft = (r) => ({ kind: r.kind, class: r.class, reach: r.reach, status: r.status, title: r.title, body: r.body, sources: r.sources, verification: r.verification ?? [],
  applicability: r.applicability, review: r.review ? { reviewer: r.review.reviewer, note: r.review.note ?? "" } : null, revisitAfter: r.revisitAfter ?? null, match: r.match,
  ...(r.locations ? { locations: r.locations.map(({ name, kind, where }) => ({ name, kind, where })) } : {}) });

// What undo of a record entry does now: the heads it retracts (none when a retraction from this undo already exists),
// and the earlier records it restores (only those that exist and are not restored yet).
async function recordState(roots, entry) {
  const ops = await homeOps(entry), records = await ops.read(roots), byId = new Map(records.map((r) => [r.id, r]));
  const retraction = byId.get(ops.idFor(retractRequest(entry))) ?? null;
  const heads = retraction ? [] : headsOf(records, entry.recordIds).filter((r) => r.kind !== "retraction");
  const restores = entry.supersedes.map((id, i) => ({ id, first: i === 0, recordId: ops.idFor(restoreRequest(entry, id)), earlier: byId.get(id) })).filter((r) => r.earlier);
  return { ops, retraction, heads, restores, missing: restores.filter((r) => !byId.has(r.recordId)) };
}
const recordKind = {
  // What undo would do now, or why it skips the entry. resume: a retraction from this undo exists but restores are missing.
  async preview(roots, entry) {
    const { retraction, heads, missing } = await recordState(roots, entry);
    if (retraction ? !missing.length : !heads.length) return { skip: "already-retracted" };
    return { heads: heads.map((r) => ({ id: r.id, recordHash: r.recordHash, status: r.status })), restores: missing.map((r) => r.id), ...(retraction ? { resume: true } : {}) };
  },
  // The record IDs undo writes, for the undo entry: the retraction and each restore that will be written.
  async recordIds(roots, entry) {
    const { ops, restores } = await recordState(roots, entry);
    return [ops.idFor(retractRequest(entry)), ...restores.map((r) => r.recordId)];
  },
  async apply(roots, entry, { recordedBy, now, faults = {} }) {
    const state = await recordState(roots, entry), { ops, heads } = state;
    let retraction = state.retraction && { recordId: state.retraction.id, recordHash: state.retraction.recordHash };
    if (!retraction) {
      if (!heads.length) throw new DevtwinError("STALE_VERSION", "Nothing left to retract", { id: entry.id });
      retraction = await ops.supersede(roots, { requestId: retractRequest(entry), recordedBy, draft: retractionDraft(entry, heads), targets: heads.map((r) => r.id), expectHashes: heads.map((r) => r.recordHash) }, { now, retraction: true });
      if (faults.afterRetraction) await faults.afterRetraction();
    }
    const restored = [], missing = new Set(state.missing.map((r) => r.recordId));
    for (const r of state.restores) {
      if (!missing.has(r.recordId)) { restored.push(r.recordId); continue; }
      const input = { requestId: restoreRequest(entry, r.id), recordedBy, draft: restoredDraft(r.earlier) };
      const done = r.first ? await ops.supersede(roots, { ...input, targets: [retraction.recordId], expectHashes: [retraction.recordHash] }, { now, retraction: true }) : await ops.add(roots, input, { now, retraction: true });
      restored.push(done.recordId);
    }
    return { retraction: retraction.recordId, retracted: heads.map((r) => r.id), restored };
  }
};
const published = (message) => new DevtwinError("GATE_REQUIRED", message, { field: "id", reason: "published-delete", via: "published delete" });
// Where a hub-lesson entry's item waits now: { held } (the held item), { outbox } (the outbox item and its hub), a
// skip reason for an item that already left, or null once it was sent.
async function hubLessonState(roots, entry) {
  const { heldForAudit } = await import("../held/queue.mjs");
  const held = await heldForAudit(roots, entry.id);
  if (held) return { held };
  const { entries } = await readAudit(roots), state = outboundStates(entries).get(entry.id);
  if (state === "dropped" || state === "cancelled") return { skip: state };
  if (state !== "outbox") return null;
  const marker = entries.find((e) => e.kind === "held-state" && e.marks === entry.id && e.target === "outbox");
  const { listOutbox } = await import("../hubs/git-write.mjs");
  const { readHubBinding } = await import("../config/store.mjs");
  const binding = await readHubBinding(roots, entry.scope);
  const outboxId = marker.itemIds.find((x) => x.startsWith("obx_"));
  const item = binding ? (await listOutbox(roots, binding)).find((x) => x.id === outboxId) : null;
  return item ? { outbox: { id: item.id, hubId: binding.hubId } } : null;
}
const hubLessonKind = {
  async preview(roots, entry) {
    const state = await hubLessonState(roots, entry);
    if (!state) throw published("A lesson sent to a hub is removed with `devtwin published delete`, which the owner runs");
    if (state.skip) return { skip: state.skip };
    return { heads: [], cancel: state.held ? { held: state.held.id, target: state.held.target, title: state.held.title, sendAfter: state.held.sendAfter } : { outbox: state.outbox.id, hubId: state.outbox.hubId } };
  },
  recordIds: async () => [],
  // The hub-sync lock first, then the held lock, the order the senders use; a sender that already took the item wins
  // and undo stops with STALE_VERSION.
  async apply(roots, entry) {
    const { withHubLock, removeOutboxItem } = await import("../hubs/git-write.mjs");
    const { withHeldLock, removeHeld } = await import("../held/queue.mjs");
    return withHubLock(roots, () => withHeldLock(roots, "undo", async () => {
      const state = await hubLessonState(roots, entry);
      if (!state || state.skip) throw new DevtwinError("STALE_VERSION", "The held item already left the queue", { id: entry.id });
      if (state.held) { removeHeld(roots, state.held.target, state.held.id); return { cancelled: { held: state.held.id } }; }
      removeOutboxItem(roots, { hubId: state.outbox.hubId }, state.outbox.id);
      return { cancelled: { outbox: state.outbox.id } };
    }));
  }
};
const KINDS = new Map([["record", recordKind], ["hub-lesson", hubLessonKind]]);
// For later units: a held or outbound kind registers { preview, recordIds, apply } under its entry kind.
export function registerUndoKind(kind, handler) {
  if (KINDS.has(kind) || kind === "undo") throw new DevtwinError("CONFLICT", "Undo kind already registered", { kind });
  KINDS.set(kind, handler);
}
const unknownKind = (entry) => new DevtwinError("INVALID_INPUT", "devtwin cannot undo this kind of entry", { field: "id", reason: "unknown-kind", kind: entry.kind });

function sinceTime(since) {
  const ms = typeof since === "string" && ISO_TIME.test(since) ? Date.parse(since) : NaN;
  if (Number.isNaN(ms)) throw new DevtwinError("INVALID_INPUT", "Invalid time; use an ISO time such as 2026-10-01T00:00:00Z", { field: "since" });
  return ms;
}
// The undo preview. Nothing is written.
export async function planUndo(roots, { id, since, session } = {}) {
  await import("../learnings/push.mjs");
  if ((id === undefined) === (since === undefined)) throw new DevtwinError("INVALID_INPUT", "Give --id or --since", { field: "id" });
  if (session !== undefined && session !== null && (typeof session !== "string" || !SESSION_ID.test(session))) throw new DevtwinError("INVALID_INPUT", "Invalid session ID", { field: "session" });
  const { entries } = await readAudit(roots);
  const done = undoneMap(roots, entries);
  let targets, mode;
  if (id !== undefined) {
    mode = "id";
    if (typeof id !== "string" || !AUDIT_ID.test(id)) throw new DevtwinError("INVALID_ID", "Invalid audit entry ID");
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new DevtwinError("NOT_FOUND", "No audit entry with this ID", { id });
    if (entry.kind === "undo") throw new DevtwinError("INVALID_INPUT", "An undo cannot be undone", { field: "id", reason: "undo-of-undo" });
    if (!KINDS.has(entry.kind)) throw unknownKind(entry);
    if (done.has(id)) throw new DevtwinError("CONFLICT", "This entry is already undone", { id, undoneBy: done.get(id).id });
    targets = [entry];
  } else {
    mode = "since";
    const from = sinceTime(since);
    // held-state entries only record where an outbound item went; they are not writes of their own.
    // U25: review-reject entries record a removed waiting item; there is nothing to undo.
    targets = entries.filter((e) => e.kind !== "undo" && e.kind !== "held-state" && e.kind !== "review-reject" && Date.parse(e.at) > from && !done.has(e.id)).reverse();
  }
  const planned = [], skipped = [];
  for (const entry of targets) {
    const handler = KINDS.get(entry.kind);
    if (!handler) { skipped.push({ id: entry.id, reason: "unknown-kind" }); continue; }
    if (!landed(roots, entry)) { skipped.push({ id: entry.id, reason: "never-landed" }); continue; }
    let preview;
    // A kind undo refuses (hub-lesson) stops undo --id, and is skipped with its reason by undo --since.
    try { preview = await handler.preview(roots, entry); }
    catch (error) { if (mode === "since" && error.details?.reason) { skipped.push({ id: entry.id, reason: error.details.reason }); continue; } throw error; }
    if (preview.skip) { skipped.push({ id: entry.id, reason: preview.skip }); continue; }
    planned.push({ id: entry.id, at: entry.at, kind: entry.kind, route: entry.route, target: entry.target, recordIds: entry.recordIds, heads: preview.heads, restores: preview.restores, ...(preview.resume ? { resume: true } : {}), ...(preview.cancel ? { cancel: preview.cancel } : {}), ...(preview.revert ? { revert: preview.revert } : {}) });
  }
  const tier = tierOf({ route: "undo" });
  return finalizePlan({ kind: "undo", mode, ...(mode === "since" ? { since } : { id }), session: session ?? null, tier, dialog: tier !== "automatic", entries: planned, skipped });
}
const revertLine = (revert) => "adds a revert commit to " + revert.branch + (revert.held ? ", cancels its held push" : "") + (revert.push ? " and pushes the revert after the hold" : "; nothing is pushed");
const cancelLine = (cancel) => cancel.held ? "cancels the held item \"" + cancel.title + "\" for " + cancel.target + " before it is sent" : "cancels the outbox item " + cancel.outbox + " before it is pushed";
const dialogFor = (plan) => ({ title: plan.mode === "since" ? "Undo devtwin writes since " + plan.since : "Undo a devtwin write", body: [
  plan.entries.length + " entr" + (plan.entries.length === 1 ? "y" : "ies") + ", newest first. Each record gets a retraction, so sessions stop seeing it; a replaced earlier version comes back.", "",
  ...plan.entries.slice(0, DIALOG_ENTRIES).map((e) => e.id + " " + e.at + " " + e.route + ": " + (e.cancel ? cancelLine(e.cancel) : e.revert ? revertLine(e.revert) : e.heads.map((h) => h.id).join(", "))),
  ...(plan.entries.length > DIALOG_ENTRIES ? ["and " + (plan.entries.length - DIALOG_ENTRIES) + " more"] : [])
].join("\n") });

// faults.afterRetraction is a test seam: it fails an undo between its retraction and its restores.
export async function applyUndo(roots, input, { fingerprint, now = () => new Date(), ctx = {}, faults = {} } = {}) {
  const plan = await planUndo(roots, input);
  assertFingerprint(plan, fingerprint);
  if (plan.dialog && plan.entries.length) await requireOwnerApproval(ctx, dialogFor(plan));
  const recordedBy = cliRecorder(ctx.env ?? process.env);
  const { entries } = await readAudit(roots);
  const undone = [], homes = [];
  for (const planned of plan.entries) {
    const entry = entries.find((e) => e.id === planned.id), handler = KINDS.get(entry.kind);
    const audit = await appendEntry(roots, { kind: "undo", tier: plan.tier, route: "undo", target: plan.mode, home: entry.home, scope: entry.scope, project: entry.project,
      recordIds: await handler.recordIds(roots, entry), supersedes: planned.heads.map((h) => h.id), actor: recordedBy.actor, session: plan.session, requestId: deterministicRequestId("undo", { entry: entry.id }), undoes: entry.id }, { now, cap: false });
    const result = await handler.apply(roots, entry, { recordedBy, now, faults, audit: audit.id, ctx });
    undone.push({ entry: entry.id, audit: audit.id, ...result });
    homes.push(entry);
  }
  // KTD22: the lesson indexes that saw these records. A personal record is in every scope's index.
  const { indexScopesFor, rebuildIndexes } = await import("../lessons/publish.mjs");
  const scopes = new Set();
  for (const entry of homes) for (const scope of await indexScopesFor(roots, entry.home, entry.scope)) scopes.add(scope);
  const index = await rebuildIndexes(roots, [...scopes].sort());
  return { applied: true, mode: plan.mode, tier: plan.tier, undone, skipped: plan.skipped, index };
}
