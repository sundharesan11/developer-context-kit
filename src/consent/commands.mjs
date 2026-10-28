// U36 (KTD39): consent grant | revoke | list. grant and revoke are always-ask actions: they preview, then apply with the
// plan fingerprint after the owner dialog, and the hook denies their --apply from agent shells
// (src/hooks/owner-block.mjs). list is read-only and also shows each hub's note consent (KTD10), which note consent
// and note revoke manage.
// U41 (KTD39): revoke also cancels the target's held items and the outbox items that came from them. The preview lists
// the held items; the apply cancels what is held when it runs, after the consent is gone, so no sender can take one.
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { readHubBinding, listHubBindings } from "../config/store.mjs";
import { readRegistry } from "../config/registry.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { readAudit, outboundStates } from "../audit/log.mjs";
import { withHubLock, removeOutboxItem } from "../hubs/git-write.mjs";
import { listHeld, removeHeld, withHeldLock, hubTarget } from "../held/queue.mjs";
import { markState } from "../held/send.mjs";
import { HOLD_HOURS, assertKind, assertHoldHours, consentRules, ruleDigestFor, readConsent, listConsents, writeConsent, removeConsent, withConsentLock } from "./store.mjs";

const usage = (message, field) => { throw new DevtwinError("INVALID_INPUT", message, { field }); };
async function isBound(roots, path) {
  try { return (await readRegistry(roots)).value.bindings.some((binding) => binding.path === path); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
// The target of a consent. A grant needs a bound repository or a joined hub; a revoke takes any stored target.
async function targetFor(roots, { kind, repo, scope }, { grant }) {
  assertKind(kind);
  if (kind === "repo-push") {
    if (scope !== undefined) usage("A repo-push consent takes --repo, not --scope", "scope");
    if (typeof repo !== "string" || !repo) usage("A repo-push consent needs --repo", "repo");
    let real;
    try { real = realpathSync(repo); } catch { if (grant) throw new DevtwinError("PATH_UNSAFE", "Repository unavailable", { field: "repo" }); real = resolve(repo); }
    if (grant && !(await isBound(roots, real))) throw new DevtwinError("PROJECT_UNBOUND", "Repository is not bound; onboard it first", { reason: "not-bound", field: "repo" });
    return { target: real, hub: null };
  }
  if (repo !== undefined) usage("A hub-publish consent takes --scope, not --repo", "repo");
  const target = assertScopeId(scope);
  const binding = await readHubBinding(roots, target);
  if (grant && binding?.status !== "joined") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub", { scope: target });
  return { target, hub: binding?.status === "joined" ? binding.hubId : null };
}
function holdHoursFrom(value) {
  if (value === undefined) return HOLD_HOURS.default;
  if (!/^[0-9]{1,3}$/.test(value)) usage("Hold hours must be a whole number from 1 to 168", "hold-hours");
  return assertHoldHours(Number(value));
}
const targetLine = (plan) => plan.consent.kind === "repo-push" ? "Repository: " + plan.consent.target : "Scope: " + plan.consent.target + (plan.hub ? "\nHub: " + plan.hub : "");
const ACTION = {
  "repo-push": "push learning branches to this repository's remote without asking each time. No command pushes a learning branch yet; this consent is kept for that step.",
  "hub-publish": "publish lessons to this hub without asking each time (lesson accept --target hub). Everyone with access to the hub can read them, and Git history keeps the text."
};

export async function planGrant(roots, input) {
  const kind = assertKind(input.kind), holdHours = holdHoursFrom(input.holdHours);
  const { target, hub } = await targetFor(roots, input, { grant: true });
  return finalizePlan({ kind: "consent-grant", consent: { kind, target, holdHours, ruleDigest: ruleDigestFor(kind, holdHours), rules: consentRules(kind, holdHours) }, hub,
    current: await readConsent(roots, kind, target), destination: { root: "stateRoot", path: "consents/" + kind } });
}
const grantDialog = (plan) => ({ title: plan.consent.kind === "repo-push" ? "Allow learning-branch pushes to a repository" : "Allow lessons to go to an organization hub", body: [
  targetLine(plan), "", "Agents and scheduled jobs may " + ACTION[plan.consent.kind],
  "Each item waits " + plan.consent.holdHours + " hours in the held queue before it is sent. A notification names it when it is held, devtwin activity --held shows its text, and devtwin undo cancels it.",
  "Checks: " + plan.consent.rules.checks.join(", ") + ".",
  "A change to these rules voids the consent. consent revoke ends it."
].join("\n") });
export async function applyGrant(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planGrant(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, grantDialog(plan));
  return withConsentLock(roots, "consent-grant", async () => {
    const current = await readConsent(roots, plan.consent.kind, plan.consent.target);
    if (JSON.stringify(current) !== JSON.stringify(plan.current)) throw new DevtwinError("STALE_VERSION", "Consent changed");
    return { granted: true, ...(await writeConsent(roots, plan.consent, { now })) };
  });
}

export async function planRevoke(roots, input) {
  const kind = assertKind(input.kind);
  const { target, hub } = await targetFor(roots, input, { grant: false });
  const current = await readConsent(roots, kind, target);
  if (!current) throw new DevtwinError("NOT_FOUND", "No consent for this target", { kind, target });
  const held = (await listHeld(roots, { target: heldTarget(kind, target) })).map((item) => ({ id: item.id, title: item.title, sendAfter: item.sendAfter }));
  return finalizePlan({ kind: "consent-revoke", consent: { kind, target }, hub, current, held });
}
const revokeDialog = (plan) => ({ title: "Revoke a standing consent", body: [
  targetLine(plan), "", "Agents and scheduled jobs stop at \"needs consent\" for this target until you grant it again.",
  ...(plan.held.length ? ["", "It also cancels " + plan.held.length + (plan.held.length === 1 ? " held item" : " held items") + " and any outbox item that came from them:", ...plan.held.map((x) => "- " + x.title)] : [])
].join("\n") });
// The held-queue target of a consent. A repo-push target is the repository root's hash.
const heldTarget = (kind, target) => kind === "hub-publish" ? hubTarget(target) : "repo:" + createHash("sha256").update(target).digest("hex");
// Cancels every held item of the target, and each outbox item a sender moved there from the held queue. Each gets a
// held-state audit entry "cancelled". The hub-sync lock, then the held lock, as the senders take them.
async function cancelHeld(roots, plan, { now }) {
  const target = heldTarget(plan.consent.kind, plan.consent.target), cancelled = { held: [], outbox: [] };
  const { entries } = await readAudit(roots);
  const states = outboundStates(entries);
  const waiting = entries.filter((e) => e.kind === "held-state" && e.target === "outbox" && states.get(e.marks) === "outbox" && e.scope === plan.consent.target && plan.consent.kind === "hub-publish");
  const marks = [];
  await withHubLock(roots, () => withHeldLock(roots, "consent-revoke", async () => {
    for (const item of await listHeld(roots, { target })) {
      if (removeHeld(roots, target, item.id)) { cancelled.held.push(item.id); marks.push([item, []]); }
    }
    for (const entry of waiting) {
      const outboxId = entry.itemIds.find((x) => x.startsWith("obx_")), hubId = plan.hub ?? null;
      if (!hubId) continue;
      removeOutboxItem(roots, { hubId }, outboxId);
      cancelled.outbox.push(outboxId);
      marks.push([{ id: entry.itemIds.find((x) => x.startsWith("hld_")), audit: entry.marks, payload: { scope: entry.scope, lessonId: entry.itemIds.find((x) => x.startsWith("lsn_")) } }, [outboxId]]);
    }
  }));
  for (const [item, extra] of marks) await markState(roots, item, "cancelled", { now, route: "consent revoke", tier: "always-ask", actor: "human", extra });
  return cancelled;
}
export async function applyRevoke(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planRevoke(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, revokeDialog(plan));
  const revoked = await withConsentLock(roots, "consent-revoke", async () => {
    const current = await readConsent(roots, plan.consent.kind, plan.consent.target);
    if (JSON.stringify(current) !== JSON.stringify(plan.current)) throw new DevtwinError("STALE_VERSION", "Consent changed");
    return removeConsent(roots, plan.consent);
  });
  // After the consent lock is released: the consent lock comes last in the lock order. A sender that runs meanwhile
  // finds no consent and keeps the item held.
  return { revoked, kind: plan.consent.kind, target: plan.consent.target, cancelled: await cancelHeld(roots, plan, { now }) };
}

// Read-only. Note consents are shown as they are; consent grant and consent revoke never change them.
export async function listAll(roots) {
  const { noteConsentValid, NOTE_RULES_DIGEST } = await import("../hubs/join.mjs");
  const notes = (await listHubBindings(roots)).map((binding) => ({ kind: "note", scope: binding.scope, hubId: binding.hubId, valid: noteConsentValid(binding),
    grantedAt: binding.noteConsent?.grantedAt ?? null, rulesDigest: binding.noteConsent?.rulesDigest ?? null, currentRulesDigest: NOTE_RULES_DIGEST, readOnly: true, managedBy: ["note consent", "note revoke"] }));
  return { consents: await listConsents(roots), notes };
}

const options = { kind: { type: "string" }, repo: { type: "string" }, scope: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const inputOf = (values) => ({ kind: values.kind, repo: values.repo, scope: values.scope, holdHours: values["hold-hours"] });
export const consentGrantCommand = { options: { ...options, "hold-hours": { type: "string" } }, async run(values, ctx) {
  if (!values.apply) return planGrant(ctx.roots, inputOf(values));
  needPlan(values);
  return applyGrant(ctx.roots, inputOf(values), { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const consentRevokeCommand = { options, async run(values, ctx) {
  if (!values.apply) return planRevoke(ctx.roots, inputOf(values));
  needPlan(values);
  return applyRevoke(ctx.roots, inputOf(values), { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const consentListCommand = { options: {}, run: (values, ctx) => listAll(ctx.roots) };
