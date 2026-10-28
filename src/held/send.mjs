// U41 (R5, KTD41): the senders. sendDue hands every held item whose sendAfter has passed to the sender registered for
// its target kind; an item not yet due is never touched. The hub-sync job sends its own scope's items after it drains
// the outbox (src/hubs/sync.mjs); the hourly learning-send job sends every target (src/schedule/jobs.mjs).
//
// The hub sender re-runs the sensitive scan and the isolation check on the lesson file, then hands it to the existing
// publish path (publishLesson in src/lessons/publish.mjs). A failed push goes to the hub outbox, as before. A check
// that fails drops the item and reports it; a replacement that went stale meanwhile is dropped as "stale". An item
// whose hub binding changed stays held and is reported.
//
// Consent (KTD39): each sender reads the consent again for each item, inside the held lock, and sends only under the
// grant the item was queued under: a valid consent with the item's rule digest and grant time (consentGap). With no
// valid consent the item stays held as "needs-consent"; under a later grant it stays held as "consent-changed", so a
// grant made after a revoke or a rules change never releases items queued before it. consent revoke cancels the
// target's items under the same lock before it removes the consent (src/consent/commands.mjs). A kept item records its
// reason (blocked), and the activity digest lists it; the owner cancels it with undo, and a learning branch goes again
// under the new grant with learning send --branch. Each item that leaves the
// queue gets a held-state audit entry (src/audit/log.mjs): sent, outbox or dropped. When hub sync later pushes or
// drops an outbox item that came from here, settleOutbox appends sent or dropped.
//
// Repository pushes (U30) register the "repo" sender in src/learnings/push.mjs, which sendDue loads when a repo item is
// due. A target kind with no sender is kept with the reason "no-sender".
import { DevtwinError } from "../errors.mjs";
import { readHubBinding } from "../config/store.mjs";
import { deterministicRequestId } from "../storage/plan.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { readConsent } from "../consent/store.mjs";
import { appendEntry, readAudit, outboundStates } from "../audit/log.mjs";
import { withHubLock } from "../hubs/git-write.mjs";
import { listHeld, readHeldItem, removeHeld, noteBlocked, withHeldLock, isDue, targetKind } from "./queue.mjs";

// target kind -> async (roots, target, items, { now, route, binding, locked }) -> { sent, dropped, kept }
const SENDERS = new Map();
export function registerSender(kind, send) {
  if (SENDERS.has(kind) || typeof send !== "function") throw new DevtwinError("CONFLICT", "Sender already registered", { kind });
  SENDERS.set(kind, send);
}

// The audit entry for an item that left the queue. The request ID comes from the item's entry and the new state, so a
// retry appends nothing new.
export async function markState(roots, item, state, { now, route, tier = "consented", actor = "other", extra = [] }) {
  return appendEntry(roots, { kind: "held-state", tier, route, target: state, scope: item.payload?.scope ?? null, itemIds: [item.payload?.lessonId, item.id, ...extra].filter(Boolean),
    actor, requestId: deterministicRequestId("held-state", { audit: item.audit, state, route }), marks: item.audit }, { now, cap: false });
}
// Why a held item may not go under this consent: null, "needs-consent" (none, or void) or "consent-changed" (another
// grant than the one it was queued under). An item queued before grant times were recorded goes under a grant that is
// not newer than the item.
export function consentGap(item, consent) {
  if (!consent?.valid) return "needs-consent";
  if (consent.ruleDigest !== item.consent.ruleDigest) return "consent-changed";
  const granted = item.consent.grantedAt;
  if (granted !== undefined ? consent.grantedAt !== granted : !(typeof consent.grantedAt === "string" && consent.grantedAt <= item.createdAt)) return "consent-changed";
  return null;
}
// A sender keeps an item: its reason is recorded on the item (under the held lock) and returned.
export async function keepHeld(roots, item, reason, now) {
  await noteBlocked(roots, item.target, item.id, reason, now());
  return { keep: reason };
}
const reasonOf = (error) => error.code === "DEVTWIN_ISOLATION" ? "isolation" : error.code === "DEVTWIN_SENSITIVE_CONTENT" ? "sensitive" : "invalid";

// Sends due items. target limits the run to one target; binding and locked: true mean the caller (hub sync) holds the
// hub-sync lock for that target's hub.
export async function sendDue(roots, { target, now = () => new Date(), route = "learning-send", binding, locked = false } = {}) {
  const out = { sent: [], dropped: [], kept: [] };
  const at = now(), items = await listHeld(roots, target === undefined ? {} : { target });
  const byTarget = new Map();
  for (const item of items) {
    if (!isDue(item, at)) { out.kept.push({ id: item.id, target: item.target, reason: "not-due", sendAfter: item.sendAfter }); continue; }
    if (!byTarget.has(item.target)) byTarget.set(item.target, []);
    byTarget.get(item.target).push(item);
  }
  for (const [name, due] of byTarget) {
    if (targetKind(name) === "repo" && !SENDERS.has("repo")) await import("../learnings/push.mjs");
    const send = SENDERS.get(targetKind(name));
    if (!send) { out.kept.push(...due.map((item) => ({ id: item.id, target: name, reason: "no-sender" }))); continue; }
    let result;
    try { result = await send(roots, name, due, { now, route, binding, locked }); }
    catch (error) {
      if (error.code !== "DEVTWIN_BUSY") throw error;
      result = { sent: [], dropped: [], kept: due.map((item) => ({ id: item.id, target: name, reason: "busy" })) };
    }
    out.sent.push(...result.sent); out.dropped.push(...result.dropped); out.kept.push(...result.kept);
  }
  return out;
}

// The hub sender, for "hub:<scope>" targets.
async function sendHub(roots, target, due, { now, route, binding: given, locked }) {
  const scope = target.slice(4);
  const run = async (binding) => {
    const out = { sent: [], dropped: [], kept: [] };
    const keep = (item, reason) => out.kept.push({ id: item.id, target, reason });
    const terms = await isolationTerms(roots);
    const { publishLesson } = await import("../lessons/publish.mjs");
    for (const item of due) {
      if (!binding || binding.status !== "joined" || binding.delivery !== "on") { keep(item, "hub-not-joined"); continue; }
      if (binding.readOnly) { keep(item, "hub-read-only"); continue; }
      if (binding.hubId !== item.payload.hubId || binding.actorRef !== item.payload.author) { keep(item, "hub-changed"); continue; }
      const outcome = await withHeldLock(roots, "held-send", async () => {
        const current = await readHeldItem(roots, target, item.id);
        if (!current) return { gone: true };
        const gap = consentGap(current, await readConsent(roots, "hub-publish", scope));
        if (gap) return keepHeld(roots, current, gap, now);
        try { assertOutboundClean(item.payload.content, terms, { except: scope }); }
        catch (error) { removeHeld(roots, target, item.id); return { state: "dropped", reason: reasonOf(error) }; }
        let result;
        try { result = await publishLesson(roots, binding, item.payload, { now, createdAt: item.payload.createdAt, locked: true }); }
        catch (error) {
          // A replacement whose predecessor changed meanwhile cannot go; a lesson the hub already has was sent before.
          if (error.code === "DEVTWIN_STALE_VERSION") { removeHeld(roots, target, item.id); return { state: "dropped", reason: "stale", stale: error.details?.reason ?? null, ...(error.details?.successorId ? { successorId: error.details.successorId } : {}) }; }
          if (error.code === "DEVTWIN_CONFLICT" && error.details?.lessonId === item.payload.lessonId) { removeHeld(roots, target, item.id); return { state: "sent", already: true }; }
          if (error instanceof DevtwinError) return { keep: error.code };
          throw error;
        }
        removeHeld(roots, target, item.id);
        return result.pushed ? { state: "sent", commit: result.commit } : { state: "outbox", queued: result.queued, reason: result.reason };
      });
      if (outcome.gone) continue;
      if (outcome.keep) { keep(item, outcome.keep); continue; }
      const audit = await markState(roots, item, outcome.state, { now, route, extra: outcome.queued ? [outcome.queued] : [] });
      const view = { id: item.id, target, lessonId: item.payload.lessonId, audit: item.audit, state: audit.target };
      if (outcome.state === "dropped") out.dropped.push({ ...view, reason: outcome.reason, ...(outcome.stale ? { stale: outcome.stale } : {}), ...(outcome.successorId ? { successorId: outcome.successorId } : {}) });
      else out.sent.push({ ...view, ...(outcome.commit ? { commit: outcome.commit } : {}), ...(outcome.queued ? { queued: outcome.queued, reason: outcome.reason } : {}) });
    }
    return out;
  };
  if (locked) return run(given);
  return withHubLock(roots, async () => run(await readHubBinding(roots, scope)));
}
registerSender("hub", sendHub);

// After hub sync drains the outbox: an outbox item that came from the held queue moves to sent when it was pushed and
// to dropped when the drain dropped it.
export async function settleOutbox(roots, drained, { now = () => new Date(), route = "hub sync" } = {}) {
  const pushed = new Set(drained.pushed), dropped = new Set(drained.dropped.map((x) => x.id));
  if (!pushed.size && !dropped.size) return [];
  const { entries } = await readAudit(roots);
  const states = outboundStates(entries), settled = [];
  for (const entry of entries) {
    if (entry.kind !== "held-state" || entry.target !== "outbox" || states.get(entry.marks) !== "outbox") continue;
    const outboxId = entry.itemIds.find((x) => x.startsWith("obx_"));
    const state = pushed.has(outboxId) ? "sent" : dropped.has(outboxId) ? "dropped" : null;
    if (!state) continue;
    const item = { id: entry.itemIds.find((x) => x.startsWith("hld_")), audit: entry.marks, payload: { scope: entry.scope, lessonId: entry.itemIds.find((x) => x.startsWith("lsn_")) } };
    await markState(roots, item, state, { now, route, extra: [outboxId] });
    states.set(entry.marks, state);
    settled.push({ audit: entry.marks, outboxId, state });
  }
  return settled;
}
