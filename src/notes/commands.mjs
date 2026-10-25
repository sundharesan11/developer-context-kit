// U13: note list | revoke | consent. There is no route that posts a note: only the hook event path posts, under the
// standing consent that hub join (or note consent) records (KTD10). note list is read-only. note revoke and note
// consent preview, then apply with the plan fingerprint after the owner dialog; the hook denies their --apply from
// agent shells (src/hooks/owner-block.mjs).
import { DevtwinError } from "../errors.mjs";
import { writeHubBinding } from "../config/store.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { renderInbound } from "../records/isolation.mjs";
import { NOTE_RULES, NOTE_RULES_DIGEST, NOTE_CONSENT_TEXT, noteConsentValid } from "../hubs/join.mjs";
import { readHub, NOTE_REL, parseHubNote } from "../hubs/read.mjs";
import { withHubLock, listOutbox, removeOutboxItem, enqueueOutbox } from "../hubs/git-write.mjs";
import { requireJoined } from "../hubs/sync.mjs";
import { reportText } from "./post.mjs";

const MAX_WRITES = 20;
const view = (note) => ({ id: note.id, handle: note.handle, area: note.area, line: note.line, createdAt: note.createdAt, expiresAt: note.expiresAt });
// Queued note items that post one of this developer's notes.
const queuedPosts = (items, handle) => items.filter((x) => x.kind === "note" && x.writes.some((w) => w.content !== null && NOTE_REL.exec(w.rel)?.[1] === handle));
async function activeNotes(binding, now) {
  const read = await readHub(binding.clone, { now });
  return read.readOnly ? [] : read.notes;
}

// Read-only: colleagues' active notes from the local clone (as of the last sync), as fenced data, and the developer's
// own active and queued notes.
export async function listNotes(roots, { scope }, { now = () => new Date() } = {}) {
  const binding = await requireJoined(roots, assertScopeId(scope));
  const notes = await activeNotes(binding, now());
  const queued = queuedPosts(await listOutbox(roots, binding), binding.handle).flatMap((x) => x.writes.filter((w) => w.content !== null).map((w) => ({ outboxId: x.id, ...view(parseHubNote(w.content)) })));
  return { scope: binding.scope, hubId: binding.hubId, handle: binding.handle, consent: noteConsentValid(binding),
    colleagues: notes.filter((n) => n.value.handle !== binding.handle).map((n) => ({ ...view(n.value), text: renderInbound(reportText(n.value), { handle: "handle:" + n.value.handle }) })),
    own: notes.filter((n) => n.value.handle === binding.handle).map((n) => ({ rel: n.rel, ...view(n.value) })), queued };
}

// Revoke: clear the note consent and discard queued note posts. With --delete-notes it also queues the removal of the
// developer's active notes in the hub; hub sync pushes it.
export async function planRevoke(roots, { scope, deleteNotes = false }, { now = () => new Date() } = {}) {
  const binding = await requireJoined(roots, assertScopeId(scope));
  const own = (await activeNotes(binding, now())).filter((n) => n.value.handle === binding.handle);
  return finalizePlan({ kind: "note-revoke", scope: binding.scope, hubId: binding.hubId, consent: binding.noteConsent ? "granted" : "none",
    discardQueued: queuedPosts(await listOutbox(roots, binding), binding.handle).map((x) => x.id),
    deleteNotes: deleteNotes ? own.map((n) => n.rel).sort() : [],
    deleteExpiresAt: deleteNotes && own.length ? own.map((n) => n.value.expiresAt).sort().at(-1) : null,
    offer: !deleteNotes && own.length ? { activeNotes: own.length, option: "--delete-notes" } : null });
}
const revokeDialog = (plan) => ({ title: "Stop working-on notes", body: [
  "Scope: " + plan.scope, "Hub: " + plan.hubId, "Stops \"working on\" notes for this hub and revokes the note consent.",
  plan.discardQueued.length ? "Discards " + plan.discardQueued.length + " queued note(s) that were not posted yet." : "No queued notes.",
  plan.deleteNotes.length ? "Queues the removal of your " + plan.deleteNotes.length + " active note(s) from the hub." : "Your active notes stay in the hub until they expire.",
  "Lessons still arrive. Run note consent to post notes again."
].join("\n") });
export async function applyRevoke(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planRevoke(roots, input, { now });
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, revokeDialog(plan));
  return withHubLock(roots, async () => {
    const binding = await requireJoined(roots, plan.scope);
    if (binding.hubId !== plan.hubId) throw new DevtwinError("SOURCE_CHANGED", "Hub binding changed");
    await writeHubBinding(roots, { ...binding, noteConsent: null });
    for (const id of plan.discardQueued) removeOutboxItem(roots, binding, id);
    const queued = [];
    if (plan.deleteNotes.length && binding.delivery === "on" && !binding.readOnly) {
      for (let i = 0; i < plan.deleteNotes.length; i += MAX_WRITES) {
        const writes = plan.deleteNotes.slice(i, i + MAX_WRITES).map((rel) => ({ rel, content: null }));
        queued.push((await enqueueOutbox(roots, binding, { kind: "note", message: "Remove working-on notes", writes, createdAt: now().toISOString(), expiresAt: plan.deleteExpiresAt }, { now })).id);
      }
    }
    return { revoked: true, scope: plan.scope, hubId: plan.hubId, discarded: plan.discardQueued.length, queuedRemovals: queued };
  });
}

// Consent: record the note consent for the current NOTE_RULES, for example after the rules changed or after a revoke.
export async function planConsent(roots, { scope }) {
  const binding = await requireJoined(roots, assertScopeId(scope));
  return finalizePlan({ kind: "note-consent", scope: binding.scope, hubId: binding.hubId, handle: binding.handle, current: noteConsentValid(binding), rules: NOTE_RULES, rulesDigest: NOTE_RULES_DIGEST, text: NOTE_CONSENT_TEXT });
}
const consentDialog = (plan) => ({ title: "Allow working-on notes", body: ["Scope: " + plan.scope, "Hub: " + plan.hubId, "Handle: " + plan.handle, "", plan.text].join("\n") });
export async function applyConsent(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planConsent(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, consentDialog(plan));
  return withHubLock(roots, async () => {
    const binding = await requireJoined(roots, plan.scope);
    if (binding.hubId !== plan.hubId) throw new DevtwinError("SOURCE_CHANGED", "Hub binding changed");
    const noteConsent = { rulesDigest: NOTE_RULES_DIGEST, rules: NOTE_RULES, grantedAt: now().toISOString() };
    await writeHubBinding(roots, { ...binding, noteConsent });
    return { consent: true, scope: plan.scope, hubId: plan.hubId, rulesDigest: noteConsent.rulesDigest, grantedAt: noteConsent.grantedAt };
  });
}

const planOptions = { scope: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
export const noteListCommand = { options: { scope: { type: "string" } }, run: (values, ctx) => listNotes(ctx.roots, { scope: values.scope }, { now: ctx.now }) };
export const noteRevokeCommand = { options: { ...planOptions, "delete-notes": { type: "boolean" } }, async run(values, ctx) {
  const input = { scope: values.scope, deleteNotes: values["delete-notes"] ?? false };
  if (!values.apply) return planRevoke(ctx.roots, input, { now: ctx.now });
  needPlan(values);
  return applyRevoke(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const noteConsentCommand = { options: planOptions, async run(values, ctx) {
  if (!values.apply) return planConsent(ctx.roots, { scope: values.scope });
  needPlan(values);
  return applyConsent(ctx.roots, { scope: values.scope }, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
