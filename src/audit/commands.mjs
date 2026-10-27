// U37: activity (read-only) and undo. undo previews, then applies with --apply and the plan fingerprint. undo --since
// --apply is an owner action the hook denies from agent shells; undo --id of another session's entry shows the owner
// dialog.
import { DevtwinError } from "../errors.mjs";

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
