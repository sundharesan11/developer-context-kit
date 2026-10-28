// U21 (R34, R35, R36): review plan | review apply. review plan is read-only: it lists the setup review's suggestions
// (src/review/collect.mjs), less the ones the owner already decided while their evidence stays the same.
// review apply takes one decision per listed line: --accept <id> or --reject <id>, repeatable. It refuses when no
// decision is given, when a listed line has none, or when a line has both. Without --apply it previews; --apply with
// the plan fingerprint shows the owner dialog with every accepted line, then runs each accepted change through its own
// route, plan first and then apply, as the owner would run it: pref retire, consent revoke, undo, setup apply or profile
// apply. That route keeps its own checks and its own owner dialog. A change that is the owner's to make (delete a
// memory file or a branch) is informational: accepting it only records the decision.
//
// review apply is always ask (src/policy/tiers.mjs): the hook denies review apply --apply from agent shells
// (src/hooks/owner-block.mjs). Every decision gets an audit entry (kind "setup-review", route "review apply", target
// accept or reject, the suggestion ID) before its change runs. Decisions are kept at stateRoot/setup-review/decisions.json
// (0600, atomic replace under the setup review lock) with the evidence hash, so a decided line comes back only when its
// evidence changes. A change that fails is reported and its decision is not kept, so the line comes back next time.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readPrivateJson, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval, fitsDialog } from "../owner/dialog.mjs";
import { collectSuggestions, NOT_COLLECTED, SUGGESTION_ID } from "./collect.mjs";

const ROUTE = "review apply", OWNER = "human";
const decisionsPath = (roots) => join(roots.stateRoot, "setup-review", "decisions.json");
const lockPath = (roots) => join(roots.stateRoot, "locks", "setup-review.lock");

async function readDecisions(roots) {
  let value;
  try { value = await readPrivateJson(decisionsPath(roots), 1 << 20); } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, decisions: {} }; throw error; }
  if (value?.schemaVersion !== 1 || !value.decisions || typeof value.decisions !== "object" || Array.isArray(value.decisions)) throw new DevtwinError("INTEGRITY", "Setup review decisions invalid");
  return value;
}
const decided = (decisions, s) => decisions.decisions[s.id]?.evidenceHash === s.evidenceHash;

// The open lines: every suggestion the owner has not decided with the same evidence.
export async function openSuggestions(roots, ctx) {
  const { suggestions, failed } = await collectSuggestions(roots, ctx), decisions = await readDecisions(roots);
  return { suggestions: suggestions.filter((s) => !decided(decisions, s)), hidden: suggestions.filter((s) => decided(decisions, s)).length, failed };
}
const view = ({ id, kind, target, evidence, evidenceHash, change }) => ({ id, kind, target, evidence, evidenceHash, change: { text: change.text, ...(change.command ? { command: change.command } : {}), informational: !change.action } });
export async function planSetupReview(roots, ctx) {
  const open = await openSuggestions(roots, ctx);
  return finalizePlan({ kind: "setup-review", suggestions: open.suggestions.map(view), counts: { open: open.suggestions.length, decided: open.hidden }, notCollected: NOT_COLLECTED, failed: open.failed,
    next: open.suggestions.length ? "Decide each line with --accept <id> or --reject <id> on devtwin review apply." : null });
}

// The decision for each open line. Every line needs exactly one.
function decide(suggestions, { accept = [], reject = [] }) {
  if (!accept.length && !reject.length) throw new DevtwinError("INVALID_INPUT", "Give one --accept or --reject for each line of review plan", { field: "decision" });
  const both = accept.filter((id) => reject.includes(id));
  if (both.length) throw new DevtwinError("INVALID_INPUT", "A line takes one decision, accept or reject", { field: "decision", ids: both });
  for (const id of [...accept, ...reject]) {
    if (!SUGGESTION_ID.test(id)) throw new DevtwinError("INVALID_ID", "Invalid suggestion ID", { id });
    if (!suggestions.some((s) => s.id === id)) throw new DevtwinError("NOT_FOUND", "No open suggestion with this ID", { id });
  }
  const missing = suggestions.filter((s) => !accept.includes(s.id) && !reject.includes(s.id)).map((s) => s.id);
  if (missing.length) throw new DevtwinError("INVALID_INPUT", "Every line needs a decision", { field: "decision", missing });
  return suggestions.map((s) => ({ ...s, decision: accept.includes(s.id) ? "accept" : "reject" }));
}
const dialogFor = (lines) => {
  const accepted = lines.filter((l) => l.decision === "accept"), rejected = lines.filter((l) => l.decision === "reject");
  return { title: "Setup review: " + accepted.length + " accepted, " + rejected.length + " rejected", body: [
    "Approve runs each accepted change below through its own command, which may ask you again. Deny changes nothing.",
    ...accepted.flatMap((l, i) => ["", "Accept " + (i + 1) + " of " + accepted.length + " (" + l.id + ", " + l.kind + ")", "Target: " + l.target, l.change.text, ...(l.change.command ? ["Runs: " + l.change.command] : ["Informational: devtwin records the decision only."])]),
    ...(rejected.length ? ["", "Rejected (no change; the line stays hidden until its evidence changes):", ...rejected.map((l) => l.id + " " + l.kind + ": " + l.target)] : [])
  ].join("\n") };
};
async function buildApply(roots, ctx, input) {
  const { suggestions } = await openSuggestions(roots, ctx), lines = decide(suggestions, input);
  const plan = finalizePlan({ kind: "setup-review-apply", lines: lines.map((l) => ({ ...view(l), decision: l.decision })), dialog: true });
  return { plan, lines };
}

// Runs one accepted change through its own route, plan then apply, with the caller's context: the route's own checks
// and owner dialog apply. addInterest reads the profile's interests now, so two accepted interests both stay.
async function runChange(action, ctx) {
  const { COMMANDS } = await import("../cli.mjs");
  let values = action.values;
  if (action.addInterest) {
    const { readProfile } = await import("../profile/store.mjs");
    values = { ...values, interest: [...((await readProfile(ctx.roots)).profile?.radar?.interests ?? []), action.addInterest] };
  }
  const planned = await (await COMMANDS[action.plan].load()).run({ ...values }, ctx);
  if (!planned?.fingerprint) throw new DevtwinError(planned?.problem?.code ?? "PLAN_REQUIRED", "The change could not be planned", { route: action.plan, ...(planned?.problem ? { problem: planned.problem.code } : {}) });
  return (await COMMANDS[action.apply].load()).run({ ...values, ...(action.plan === action.apply ? { apply: true } : {}), "plan-fingerprint": planned.fingerprint }, ctx);
}
const devtwinError = (error) => typeof error?.code === "string" && error.code.startsWith("DEVTWIN_");

export async function applySetupReview(roots, input, { fingerprint, ctx }) {
  const { plan, lines } = await buildApply(roots, ctx, input);
  assertFingerprint(plan, fingerprint);
  const content = dialogFor(lines);
  if (!fitsDialog(content)) throw new DevtwinError("LIMIT", "Too many accepted lines for one owner dialog; reject some now and accept them in a later review", { field: "accept" });
  await requireOwnerApproval(ctx, content);
  const { appendEntry } = await import("../audit/log.mjs");
  const out = { applied: true, accepted: [], rejected: [], failed: [] }, kept = [];
  for (const l of lines) {
    const entry = await appendEntry(roots, { kind: "setup-review", tier: "always-ask", route: ROUTE, target: l.decision, itemIds: [l.id], actor: OWNER,
      requestId: "req_srv" + digest({ id: l.id, evidenceHash: l.evidenceHash, decision: l.decision }).slice(7, 31) }, { now: ctx.now });
    const row = { id: l.id, kind: l.kind, target: l.target, audit: entry.id };
    if (l.decision === "reject") { out.rejected.push(row); kept.push({ ...l, audit: entry.id }); continue; }
    if (!l.change.action) { out.accepted.push({ ...row, informational: true }); kept.push({ ...l, audit: entry.id }); continue; }
    try { out.accepted.push({ ...row, route: l.change.action.apply, result: await runChange(l.change.action, ctx) }); kept.push({ ...l, audit: entry.id }); }
    catch (error) { if (!devtwinError(error)) throw error; out.failed.push({ ...row, code: error.code }); }
  }
  if (kept.length) {
    const path = decisionsPath(roots);
    assertWritable(roots, [path]);
    await withPilotLock(roots, lockPath(roots), { kind: "setup-review" }, async () => {
      const current = await readDecisions(roots), at = ctx.now().toISOString();
      for (const l of kept) current.decisions[l.id] = { decision: l.decision, kind: l.kind, evidenceHash: l.evidenceHash, at, audit: l.audit };
      ensurePrivatePath(roots.stateRoot, ["setup-review"]);
      await atomicReplace(path, canonicalJson(current) + "\n");
    }, { destinations: [path] });
  }
  return out;
}

export const reviewPlanCommand = { options: {}, run: (values, ctx) => planSetupReview(ctx.roots, ctx) };
export const reviewApplyCommand = { options: { accept: { type: "string", multiple: true }, reject: { type: "string", multiple: true }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const input = { accept: [...new Set(values.accept ?? [])], reject: [...new Set(values.reject ?? [])] };
  if (!values.apply) return { preview: true, ...(await buildApply(ctx.roots, ctx, input)).plan };
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applySetupReview(ctx.roots, input, { fingerprint: values["plan-fingerprint"], ctx });
} };
