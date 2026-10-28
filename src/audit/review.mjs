// U25 (R7, R8, KTD38, KTD43): the weekly owner review. The few always-ask items wait in one place, and
// `activity review` asks the owner about them in the owner dialog. The waiting list has two parts:
//   preference      a pending preference proposal (src/prefs/store.mjs), from an agent's pref propose or from a
//                   Claude memory of type user (U28). The proposal store already is this part of the list, so nothing
//                   is copied here.
//   general-lesson  the general member of a lesson accept: a personal-store lesson reaches every organization
//   capped-record   a record write refused by the session or day cap (src/audit/log.mjs); the item keeps the draft, the
//                   audit log never holds its text
//   outside         a project record from content devtwin fetched or synced itself (source fetched or synced). No
//                   automatic write path writes such content today: hub sync delivers hub lessons from the clone and
//                   the radar writes digests, neither as records. parkOutsideItem is the entry point for one that does.
// The last three are files at stateRoot/review/<wait_id>.json (folder 0700, file 0600), written with an exclusive,
// no-follow create under the review lock, and removed when the owner answers. The ID comes from the type and the
// request ID, so parking the same write twice keeps one item.
//
// activity review previews every item with its full text. --apply with the plan fingerprint shows the owner dialog:
// one dialog for up to ten items as long as the full text fits the dialog limit; an item that does not fit with
// others gets its own dialog, and an item too long for any dialog stays waiting (tooLong) until the owner rejects it.
// The dialog answers approve or deny only, so approving a dialog accepts every item in it and denying leaves them all
// waiting. --reject <id> names items to remove; they get one dialog of their own. Every accept and every reject gets
// an audit entry (route "activity review", actor human) before its write. Accepted preferences become personal
// records and the instruction block is written again without a second dialog (applyReviewedPreferences); general
// lessons become personal records; record drafts become observed project records. The hook denies
// activity review --apply from agent shells.
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readPrivateJson, writeNewFile, ensurePrivatePath, fsyncDir, info, checkNode } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint, REQUEST_ID } from "../storage/plan.mjs";
import { requireOwnerApproval, fitsDialog } from "../owner/dialog.mjs";
import { personalRecordIdFor, recordIdFor } from "../identity/ids.mjs";
import { appendEntry } from "./log.mjs";

export const WAIT_ID = /^wait_[a-f0-9]{24}$/;
export const WAITING_TYPES = Object.freeze(["general-lesson", "capped-record", "outside"]);
export const OUTSIDE_SOURCES = Object.freeze(["fetched", "synced"]);
export const ITEMS_PER_DIALOG = 10;
const MAX_ITEMS = 1000, ITEM_BYTES = 65536, MAX_REJECTS = 20;
const OWNER = Object.freeze({ actor: "human", runId: "run_cli00001" });
const ROUTE = "activity review";
export const reviewDir = (roots) => join(roots.stateRoot, "review");
const pathOf = (roots, id) => join(reviewDir(roots), id + ".json");
const lockPath = (roots) => join(roots.stateRoot, "locks", "review.lock");
export const withReviewLock = (roots, kind, action) => withPilotLock(roots, lockPath(roots), { kind }, action, { destinations: [reviewDir(roots)] });
const waitIdFor = (type, requestId) => "wait_" + digest({ type, requestId }).slice(7, 31);

async function readItem(roots, id) {
  const value = await readPrivateJson(pathOf(roots, id), ITEM_BYTES);
  if (value?.schemaVersion !== 1 || value.id !== id || !WAITING_TYPES.includes(value.type) || typeof value.title !== "string" || !REQUEST_ID.test(value.requestId ?? "") || !value.payload || typeof value.payload !== "object") throw new DevtwinError("INTEGRITY", "Waiting item invalid", { id });
  return value;
}
// Every readable item, oldest first, and a warning for each file that is not one.
async function readItems(roots) {
  let names;
  try { names = await readdir(reviewDir(roots)); } catch (error) { if (error.code === "ENOENT") return { items: [], warnings: [] }; throw error; }
  const items = [], warnings = [];
  for (const name of names.filter((n) => n.endsWith(".json") && WAIT_ID.test(n.slice(0, -5))).sort()) {
    try { items.push(await readItem(roots, name.slice(0, -5))); } catch (error) { warnings.push({ id: name.slice(0, -5), code: error.code ?? "DEVTWIN_INTERNAL" }); }
  }
  return { items, warnings };
}
// Adds one item. locked: the caller already holds the review lock (lesson accept takes it before the proposal lock).
export async function parkItem(roots, { type, source, title, requestId, payload }, { now = () => new Date(), locked = false } = {}) {
  if (!WAITING_TYPES.includes(type) || typeof title !== "string" || !REQUEST_ID.test(requestId ?? "")) throw new DevtwinError("INVALID_INPUT", "Invalid waiting item", { field: "type" });
  const id = waitIdFor(type, requestId), path = pathOf(roots, id);
  const write = async () => {
    if (info(path)) return { id, created: false };
    if ((await readItems(roots)).items.length >= MAX_ITEMS) throw new DevtwinError("LIMIT", "Too many items wait for the activity review", { max: MAX_ITEMS });
    ensurePrivatePath(roots.stateRoot, ["review"]);
    assertWritable(roots, [path]);
    const body = canonicalJson({ schemaVersion: 1, id, type, source, title, requestId, payload, createdAt: now().toISOString() }) + "\n";
    if (Buffer.byteLength(body) > ITEM_BYTES) throw new DevtwinError("LIMIT", "Waiting item too large", { maxBytes: ITEM_BYTES });
    await writeNewFile(path, body);
    fsyncDir(reviewDir(roots));
    return { id, created: true };
  };
  return locked ? write() : withReviewLock(roots, "review-park", write);
}
function removeItem(roots, id) {
  const path = pathOf(roots, id);
  checkNode(info(path), path);
  assertWritable(roots, [path]);
  unlinkSync(path);
  fsyncDir(reviewDir(roots));
}

// A record write refused by the session or day cap (src/records/commands.mjs). Returns the item ID.
export async function parkCappedRecord(roots, { route, input, session = null, targets = [], expectHashes = [] }, { now } = {}) {
  const { scope, project, requestId, recordedBy, draft } = input;
  return parkItem(roots, { type: "capped-record", source: "agent", title: draft.title, requestId,
    payload: { route, scope, project, draft, targets, expectHashes, from: { actor: recordedBy.actor, session } } }, { now });
}
// A project record from content devtwin fetched or synced itself. It runs the write-time checks first.
export async function parkOutsideItem(roots, { source, scope, project, requestId, draft }, { now } = {}) {
  if (!OUTSIDE_SOURCES.includes(source)) throw new DevtwinError("INVALID_INPUT", "Invalid outside source", { field: "source", allowed: OUTSIDE_SOURCES });
  await checkRecordDraft(roots, { scope, project, draft });
  return parkItem(roots, { type: "outside", source, title: draft.title, requestId, payload: { scope, project, draft } }, { now });
}
// The write-time checks of a project record (as src/records/commands.mjs runs them), again at accept time.
async function checkRecordDraft(roots, { scope, project, draft }) {
  const { validateDraft, assertProjectReach, locationLines } = await import("../records/schema.mjs");
  const { requireCommittedProject } = await import("../records/store.mjs");
  const { checkAutomaticText } = await import("./checks.mjs");
  const { isolationTerms, assertOutboundClean } = await import("../records/isolation.mjs");
  validateDraft(draft, { recordedBy: OWNER });
  assertProjectReach(draft);
  await requireCommittedProject(roots, scope, project);
  checkAutomaticText({ lines: [draft.title, ...locationLines(draft.locations)], body: draft.body });
  assertOutboundClean([draft.title, draft.body, ...locationLines(draft.locations)].join("\n"), await isolationTerms(roots), { except: scope });
}

// The full text the owner dialog shows for one item.
const matchLine = (match = {}) => ["paths", "packages", "topics", "commands"].filter((key) => match[key]?.length).map((key) => key + ": " + match[key].join(", ")).join("; ");
const recordLines = (draft) => ["Title: " + draft.title, ...(draft.locations ?? []).map((l) => "Location: " + l.name + " (" + l.kind + "): " + l.where), "", draft.body.trim() || "(no further text)"];
function itemText(item) {
  if (item.type === "preference") return ["Preference for every agent session, from " + (item.source === "memory" ? "your Claude memory" : "an agent session") + ".", "Title: " + item.title, "", item.text].join("\n");
  const p = item.payload;
  if (item.type === "general-lesson") return ["Lesson for every organization (your personal store), from scope " + p.scope + ".", "Title: " + p.lesson.title,
    ...(p.lesson.summary ? ["Do or don't: " + p.lesson.summary] : []), "", p.lesson.text.trim() || "(no further text)", ...(matchLine(p.lesson.match) ? ["", "Matches " + matchLine(p.lesson.match)] : [])].join("\n");
  const head = item.type === "capped-record" ? "Project record held back by the session cap (" + p.route + "), project " + p.project + ", kind " + p.draft.kind + "."
    : "Project record from a " + item.source + " source, project " + p.project + ", kind " + p.draft.kind + ".";
  return [head, ...(p.targets?.length ? ["Replaces: " + p.targets.join(", ")] : []), ...recordLines(p.draft)].join("\n");
}
const acceptDialog = (items) => ({ title: items.length === 1 ? "Review a waiting item" : "Review " + items.length + " waiting items", body: [
  "Approve saves " + (items.length === 1 ? "this item" : "every item below") + ". Deny leaves " + (items.length === 1 ? "it" : "them all") + " waiting.",
  ...(items.some((item) => item.type === "preference") ? ["A saved preference goes into the instruction block that every Claude Code and Codex session reads."] : []),
  ...items.flatMap((item, i) => ["", "Item " + (i + 1) + " of " + items.length + " (" + item.id + ")", item.text])
].join("\n") });
const rejectDialog = (items) => ({ title: "Reject " + items.length + " waiting item" + (items.length === 1 ? "" : "s"), body: [
  "Approve removes " + (items.length === 1 ? "this item" : "these items") + " for good. Deny leaves " + (items.length === 1 ? "it" : "them") + " waiting.", "",
  ...items.map((item) => item.type + ": " + item.title + " (" + item.id + ")")
].join("\n") });
// Dialog batching: items in order, up to ten in one dialog while the whole body fits uncut. An item that does not fit
// with the current dialog's items starts a new dialog; one that does not fit even alone is too long for any.
function batch(items) {
  const dialogs = [], tooLong = [];
  let current = [];
  for (const item of items) {
    if (!fitsDialog(acceptDialog([item]))) { tooLong.push(item.id); continue; }
    if (current.length < ITEMS_PER_DIALOG && fitsDialog(acceptDialog([...current, item]))) { current.push(item); continue; }
    dialogs.push(current.map((x) => x.id));
    current = [item];
  }
  if (current.length) dialogs.push(current.map((x) => x.id));
  return { dialogs, tooLong };
}

// Every waiting item with its full text and the hash of its file, oldest first.
async function loadAll(roots) {
  const { pendingPreferences } = await import("../prefs/store.mjs");
  const prefs = (await pendingPreferences(roots)).map((p) => ({ id: p.id, type: "preference", source: p.source, title: p.title, text: p.text, hash: p.hash, createdAt: p.createdAt }));
  const { items: files, warnings } = await readItems(roots);
  const items = [...prefs, ...files.map((f) => ({ ...f, hash: digest(f) }))].sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1);
  return { items: items.map((item) => ({ ...item, text: itemText(item) })), warnings };
}
// U25: the waiting items as the activity digest lists them: titles only.
export async function waitingForReview(roots) {
  return (await loadAll(roots)).items.map((item) => ({ kind: "review", id: item.id, type: item.type, source: item.source, title: item.title, createdAt: item.createdAt }));
}

// activity review preview. targetHome and agents name the instruction targets written again after preferences are
// accepted: the live home by default in live mode; in a pilot, only when --home is given.
async function buildReview(roots, pilot, { reject = [], targetHome, agents } = {}) {
  const { items, warnings } = await loadAll(roots);
  const byId = new Map(items.map((item) => [item.id, item]));
  const rejects = [...new Set(reject)];
  if (rejects.length > MAX_REJECTS) throw new DevtwinError("LIMIT", "Reject at most " + MAX_REJECTS + " items in one review", { max: MAX_REJECTS });
  for (const id of rejects) if (!byId.has(id)) throw new DevtwinError("NOT_FOUND", "No waiting item with this ID", { id });
  const { dialogs, tooLong } = batch(items.filter((item) => !rejects.includes(item.id)));
  const instructions = pilot?.live || targetHome !== undefined ? { targetHome: targetHome ?? null, agents: agents ?? ["claude", "codex"] } : null;
  const plan = finalizePlan({ kind: "activity-review", items: items.map(({ id, type, source, title, hash, createdAt, text }) => ({ id, type, source, title, createdAt, hash, text })),
    dialogs: dialogs.map((ids) => ({ items: ids })), tooLong, rejects, instructions, dialog: dialogs.length > 0 || rejects.length > 0, warnings });
  return { plan, byId };
}
export async function planReview(roots, pilot, input) { return (await buildReview(roots, pilot, input)).plan; }

// One accept, after its dialog was approved. Each re-reads its item and stops with STALE_VERSION if it changed.
async function acceptItem(roots, item, { now }) {
  const audit = (fields) => appendEntry(roots, { kind: "record", tier: "always-ask", route: ROUTE, target: item.type, itemIds: [item.id], actor: OWNER.actor, ...fields }, { now });
  if (item.type === "preference") {
    const { acceptPendingPreference } = await import("../prefs/store.mjs");
    let entry;
    const done = await acceptPendingPreference(roots, { id: item.id, proposalHash: item.hash }, { now, beforeWrite: async (recordId, requestId) => {
      entry = await audit({ home: "personal", recordIds: [recordId], requestId });
    } });
    return { id: item.id, type: item.type, recordId: done.recordId, audit: entry.id, home: "personal" };
  }
  return withReviewLock(roots, "review-accept", async () => {
    const current = await readItem(roots, item.id).catch((error) => { throw error.code === "ENOENT" ? new DevtwinError("STALE_VERSION", "Waiting item is gone", { id: item.id }) : error; });
    if (digest(current) !== item.hash) throw new DevtwinError("STALE_VERSION", "Waiting item changed", { id: item.id });
    const p = current.payload;
    if (current.type === "general-lesson") {
      const { checkLesson, lessonDraft, lessonText } = await import("../lessons/propose.mjs");
      const { isolationTerms, assertOutboundClean } = await import("../records/isolation.mjs");
      const { addPersonalRecord } = await import("../records/personal.mjs");
      const lesson = await checkLesson(roots, p.scope, p.lesson);
      assertOutboundClean(lessonText(lesson), await isolationTerms(roots));
      const entry = await audit({ home: "personal", scope: p.scope, recordIds: [personalRecordIdFor({ requestId: current.requestId })], requestId: current.requestId });
      const added = await addPersonalRecord(roots, { requestId: current.requestId, recordedBy: OWNER, draft: lessonDraft(lesson, { reach: "personal", status: "observed" }) }, { now });
      removeItem(roots, item.id);
      return { id: item.id, type: item.type, recordId: added.recordId, audit: entry.id, home: "personal", scope: p.scope };
    }
    // A record draft is written as observed, with the owner as the actor.
    const draft = { ...p.draft, status: "observed" }, input = { scope: p.scope, project: p.project, requestId: current.requestId, recordedBy: OWNER, draft };
    await checkRecordDraft(roots, input);
    const targets = p.targets ?? [], store = await import("../records/store.mjs");
    const entry = await audit({ home: "project", scope: p.scope, project: p.project, recordIds: [recordIdFor(input)], supersedes: targets, requestId: current.requestId });
    const added = targets.length ? await store.supersedeRecord(roots, { ...input, targets, expectHashes: p.expectHashes }, { now }) : await store.addRecord(roots, input, { now });
    removeItem(roots, item.id);
    return { id: item.id, type: item.type, recordId: added.recordId, audit: entry.id, home: "project", scope: p.scope, kind: draft.kind };
  });
}
async function rejectItem(roots, item, { now }) {
  const entry = await appendEntry(roots, { kind: "review-reject", tier: "always-ask", route: ROUTE, target: item.type, itemIds: [item.id], actor: OWNER.actor,
    requestId: "req_rvrj" + digest({ id: item.id, hash: item.hash }).slice(7, 31) }, { now });
  if (item.type === "preference") {
    const { declinePendingPreference } = await import("../prefs/store.mjs");
    await declinePendingPreference(roots, { id: item.id, proposalHash: item.hash }, { now });
  } else await withReviewLock(roots, "review-reject", async () => {
    const current = await readItem(roots, item.id);
    if (digest(current) !== item.hash) throw new DevtwinError("STALE_VERSION", "Waiting item changed", { id: item.id });
    removeItem(roots, item.id);
  });
  return { id: item.id, type: item.type, audit: entry.id };
}
const devtwinError = (error) => typeof error?.code === "string" && error.code.startsWith("DEVTWIN_");

// activity review --apply. The dialogs run in plan order, with no lock held while one is open. A denied dialog leaves
// its items waiting and the review goes on to the next dialog.
export async function applyReview(roots, pilot, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const { plan, byId } = await buildReview(roots, pilot, input);
  assertFingerprint(plan, fingerprint);
  const out = { applied: true, dialogs: [], accepted: [], rejected: [], waiting: [...plan.tooLong], failed: [] };
  const ask = async (content) => {
    try { await requireOwnerApproval(ctx, content); return { decision: "approved" }; }
    catch (error) { if (error.code !== "DEVTWIN_OWNER_DENIED") throw error; return { decision: "denied", reason: error.details?.reason ?? "denied" }; }
  };
  for (const [i, dialog] of plan.dialogs.entries()) {
    const items = dialog.items.map((id) => byId.get(id)), answer = await ask(acceptDialog(items));
    out.dialogs.push({ dialog: i + 1, items: dialog.items, ...answer });
    if (answer.decision !== "approved") { out.waiting.push(...dialog.items); continue; }
    for (const item of items) {
      try { out.accepted.push(await acceptItem(roots, item, { now })); }
      catch (error) { if (!devtwinError(error)) throw error; out.failed.push({ id: item.id, code: error.code }); out.waiting.push(item.id); }
    }
  }
  if (plan.rejects.length) {
    const items = plan.rejects.map((id) => byId.get(id)), answer = await ask(rejectDialog(items));
    out.dialogs.push({ dialog: plan.dialogs.length + 1, items: plan.rejects, reject: true, ...answer });
    if (answer.decision !== "approved") out.waiting.push(...plan.rejects);
    else for (const item of items) {
      try { out.rejected.push(await rejectItem(roots, item, { now })); }
      catch (error) { if (!devtwinError(error)) throw error; out.failed.push({ id: item.id, code: error.code }); out.waiting.push(item.id); }
    }
  }
  // The instruction block, written again with the accepted preferences.
  const shown = out.accepted.filter((a) => a.type === "preference").map((a) => a.recordId);
  if (shown.length) {
    const next = "Run devtwin instructions plan, then devtwin instructions apply.";
    if (!plan.instructions) out.instructions = { applied: false, reason: "no-target", next };
    else {
      const { applyReviewedPreferences } = await import("../agents/instructions.mjs");
      const target = { targetHome: plan.instructions.targetHome ?? undefined, agents: plan.instructions.agents, kitRoot: ctx.kitRoot };
      try { out.instructions = await applyReviewedPreferences(roots, pilot, target, { shown, runId: "run_" + randomBytes(12).toString("hex") }); }
      catch (error) { if (!devtwinError(error)) throw error; out.instructions = { applied: false, reason: "failed", code: error.code, next }; }
    }
  }
  // KTD22: the lesson indexes that see the new records. A personal record is in every scope's index.
  const written = out.accepted.filter((a) => a.type === "general-lesson" || a.kind === "lesson");
  if (written.length) {
    const { indexScopesFor, rebuildIndexes } = await import("../lessons/publish.mjs");
    const scopes = new Set();
    for (const a of written) for (const scope of await indexScopesFor(roots, a.home, a.scope)) scopes.add(scope);
    out.index = await rebuildIndexes(roots, [...scopes].sort());
  }
  return out;
}
