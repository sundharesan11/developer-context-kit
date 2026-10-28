// U21 (R34, R35, R36): review plan | review apply. review plan is read-only: it lists the setup review's suggestions
// (src/review/collect.mjs), less the ones the owner already decided while their evidence stays the same.
// review apply takes decisions for listed lines: --accept <id> or --reject <id>, repeatable. It refuses when no
// decision is given or when a line has both. A line without a decision stays open: nothing changes for it. Without
// --apply it previews; --apply with the plan fingerprint shows the owner dialog with every accepted line in full and
// the rejected lines as a count, then runs each accepted change through its own route, plan first and then apply, as
// the owner would run it: pref retire, consent revoke, undo, setup apply or profile apply. That route keeps its own
// checks and its own owner dialog. When accepted lines alone do not fit one dialog, it refuses: accept fewer at once.
// When nothing is accepted there is no dialog: a reject changes nothing but the decisions file. A change that is the
// owner's to make (delete a memory file or a branch) is informational: accepting it only records the decision.
//
// review apply is always ask (src/policy/tiers.mjs): the hook denies review apply --apply from agent shells
// (src/hooks/owner-block.mjs). Every decision gets an audit entry (kind "setup-review", route "review apply", target
// accept or reject, the suggestion ID) before its change runs. Decisions are kept at stateRoot/setup-review/decisions.json
// (0600, atomic replace under the setup review lock) with the evidence hash, so a decided line comes back only when its
// evidence changes. Each decision is saved as soon as its change completes, so an error later in the run loses none.
// A change that fails is reported and its decision is not kept, so the line comes back next time.
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readPrivateJson, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval, fitsDialog } from "../owner/dialog.mjs";
import { collectSuggestions, SUGGESTION_ID, INTEREST_MAX } from "./collect.mjs";

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
  const { suggestions, failed, notCollected } = await collectSuggestions(roots, ctx), decisions = await readDecisions(roots);
  return { suggestions: suggestions.filter((s) => !decided(decisions, s)), hidden: suggestions.filter((s) => decided(decisions, s)).length, failed, notCollected };
}
const view = ({ id, kind, target, evidence, evidenceHash, change }) => ({ id, kind, target, evidence, evidenceHash, change: { text: change.text, ...(change.command ? { command: change.command } : {}), informational: !change.action } });
export async function planSetupReview(roots, ctx) {
  const open = await openSuggestions(roots, ctx);
  return finalizePlan({ kind: "setup-review", suggestions: open.suggestions.map(view), counts: { open: open.suggestions.length, decided: open.hidden }, notCollected: open.notCollected, failed: open.failed,
    next: open.suggestions.length ? "Decide each line with --accept <id> or --reject <id> on devtwin review apply." : null });
}

// The decided lines, in plan order. A line takes at most one decision; a line without one stays open.
function decide(suggestions, { accept = [], reject = [] }) {
  if (!accept.length && !reject.length) throw new DevtwinError("INVALID_INPUT", "Give --accept or --reject for the lines of review plan you decide", { field: "decision" });
  const both = accept.filter((id) => reject.includes(id));
  if (both.length) throw new DevtwinError("INVALID_INPUT", "A line takes one decision, accept or reject", { field: "decision", ids: both });
  for (const id of [...accept, ...reject]) {
    if (!SUGGESTION_ID.test(id)) throw new DevtwinError("INVALID_ID", "Invalid suggestion ID", { id });
    if (!suggestions.some((s) => s.id === id)) throw new DevtwinError("NOT_FOUND", "No open suggestion with this ID", { id });
  }
  return suggestions.filter((s) => accept.includes(s.id) || reject.includes(s.id)).map((s) => ({ ...s, decision: accept.includes(s.id) ? "accept" : "reject" }));
}
// The owner dialog: every accepted line in full, with the command it runs; the rejected lines as a count.
const dialogFor = (lines) => {
  const accepted = lines.filter((l) => l.decision === "accept"), rejected = lines.length - accepted.length;
  return { title: "Setup review: " + accepted.length + " accepted, " + rejected + " rejected", body: [
    "Approve runs each accepted change below through its own command, which may ask you again. Deny changes nothing.",
    ...accepted.flatMap((l, i) => ["", "Accept " + (i + 1) + " of " + accepted.length + " (" + l.id + ", " + l.kind + ")", "Target: " + l.target, l.change.text, ...(l.change.command ? ["Runs: " + l.change.command] : ["Informational: devtwin records the decision only."])]),
    ...(rejected ? ["", "And " + rejected + (rejected === 1 ? " line" : " lines") + " rejected: no change; each stays hidden until its evidence changes."] : [])
  ].join("\n") };
};
async function buildApply(roots, ctx, input) {
  const { suggestions } = await openSuggestions(roots, ctx), lines = decide(suggestions, input);
  const accepted = lines.filter((l) => l.decision === "accept").length;
  const plan = finalizePlan({ kind: "setup-review-apply", lines: lines.map((l) => ({ ...view(l), decision: l.decision })), open: suggestions.length - lines.length, dialog: accepted > 0 });
  return { plan, lines };
}

// Runs one accepted change through its own route, plan then apply, with the caller's context: the route's own checks
// and owner dialog apply. addInterest reads the profile's interests now, so two accepted interests both stay.
async function runChange(action, ctx) {
  const { COMMANDS } = await import("../cli.mjs");
  let values = action.values;
  if (action.addInterest) {
    const { readProfile } = await import("../profile/store.mjs");
    const interests = (await readProfile(ctx.roots)).profile?.radar?.interests ?? [];
    // Several accepted interests in one apply: each one checks the room left after the ones before it.
    if (interests.length >= INTEREST_MAX) throw new DevtwinError("LIMIT", "Your radar interests are full (" + INTEREST_MAX + "); remove one with profile apply first", { field: "interest", max: INTEREST_MAX });
    values = { ...values, interest: [...interests, action.addInterest] };
  }
  const planned = await (await COMMANDS[action.plan].load()).run({ ...values }, ctx);
  if (!planned?.fingerprint) throw new DevtwinError(planned?.problem?.code ?? "PLAN_REQUIRED", "The change could not be planned", { route: action.plan, ...(planned?.problem ? { problem: planned.problem.code } : {}) });
  return (await COMMANDS[action.apply].load()).run({ ...values, ...(action.plan === action.apply ? { apply: true } : {}), "plan-fingerprint": planned.fingerprint }, ctx);
}
const devtwinError = (error) => typeof error?.code === "string" && error.code.startsWith("DEVTWIN_");

// Saves one decision under the setup review lock, by atomic replace.
async function keep(roots, l, audit, at) {
  const path = decisionsPath(roots);
  assertWritable(roots, [path]);
  await withPilotLock(roots, lockPath(roots), { kind: "setup-review" }, async () => {
    const current = await readDecisions(roots);
    current.decisions[l.id] = { decision: l.decision, kind: l.kind, evidenceHash: l.evidenceHash, at, audit };
    ensurePrivatePath(roots.stateRoot, ["setup-review"]);
    await atomicReplace(path, canonicalJson(current) + "\n");
  }, { destinations: [path] });
}

// faults.beforeChange(line) is a test seam: it runs before each accepted change.
export async function applySetupReview(roots, input, { fingerprint, ctx, faults = {} }) {
  const { plan, lines } = await buildApply(roots, ctx, input);
  assertFingerprint(plan, fingerprint);
  // A reject only hides a line, so an apply with no accepted line needs no dialog; the hook still keeps --apply from
  // agent shells.
  if (plan.dialog) {
    const content = dialogFor(lines);
    if (!fitsDialog(content)) throw new DevtwinError("LIMIT", "Too many accepted lines for one owner dialog; accept fewer at once and the rest in a later run", { field: "accept" });
    await requireOwnerApproval(ctx, content);
  }
  const { appendEntry } = await import("../audit/log.mjs");
  const out = { applied: true, accepted: [], rejected: [], failed: [], open: plan.open };
  for (const l of lines) {
    const entry = await appendEntry(roots, { kind: "setup-review", tier: "always-ask", route: ROUTE, target: l.decision, itemIds: [l.id], actor: OWNER,
      requestId: "req_srv" + digest({ id: l.id, evidenceHash: l.evidenceHash, decision: l.decision }).slice(7, 31) }, { now: ctx.now });
    const row = { id: l.id, kind: l.kind, target: l.target, audit: entry.id }, at = ctx.now().toISOString();
    if (l.decision === "reject") { await keep(roots, l, entry.id, at); out.rejected.push(row); continue; }
    if (!l.change.action) { await keep(roots, l, entry.id, at); out.accepted.push({ ...row, informational: true }); continue; }
    let result;
    try { await faults.beforeChange?.(l); result = await runChange(l.change.action, ctx); }
    catch (error) { if (!devtwinError(error)) throw error; out.failed.push({ ...row, code: error.code }); continue; }
    await keep(roots, l, entry.id, at);
    out.accepted.push({ ...row, route: l.change.action.apply, result });
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
