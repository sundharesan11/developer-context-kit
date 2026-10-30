// U37: activity (read-only) and undo. undo previews, then applies with --apply and the plan fingerprint. undo --apply
// is an owner action: the hook denies it from agent shells and the apply shows the owner dialog.
import { DevtwinError } from "../errors.mjs";
import { AGENT_IDS } from "../agents/adapters/index.mjs";

export const activityCommand = { options: { since: { type: "string" }, held: { type: "boolean" } }, async run(values, ctx) {
  const { activity } = await import("./digest.mjs");
  return activity(ctx.roots, { since: values.since, held: values.held ?? false }, { now: ctx.now });
} };
export const undoCommand = { options: { id: { type: "string" }, since: { type: "string" }, session: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const undo = await import("./undo.mjs");
  const input = { id: values.id, since: values.since, session: values.session };
  if (!values.apply) return { preview: true, ...(await undo.planUndo(ctx.roots, input)) };
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return undo.applyUndo(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
// U25: activity review previews every waiting item with its full text; --apply with the plan fingerprint shows the
// owner dialogs. It is an owner action: the hook denies activity review --apply from agent shells. --home and --agent
// name the instruction targets written again after preferences are accepted, as instructions plan takes them.
const AGENTS = AGENT_IDS;
export const activityReviewCommand = { options: { reject: { type: "string", multiple: true }, home: { type: "string" }, agent: { type: "string", multiple: true }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const review = await import("./review.mjs");
  if (values.agent?.some((a) => !AGENTS.includes(a))) throw new DevtwinError("INVALID_INPUT", "Invalid instruction target selection", { field: "agent" });
  const input = { reject: values.reject ?? [], targetHome: values.home, agents: values.agent ? [...new Set(values.agent)].sort() : undefined };
  if (!values.apply) return { preview: true, ...(await review.planReview(ctx.roots, ctx.pilot, input)) };
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return review.applyReview(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
