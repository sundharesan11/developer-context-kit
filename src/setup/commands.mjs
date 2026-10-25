// U9: setup status | plan --step <id> | apply --step <id> --plan-fingerprint <f>. Each route reads the step data in
// steps.mjs; plan and apply delegate to the step's own preview and apply, so no setup logic is repeated here.
import { DevtwinError, toJson } from "../errors.mjs";
import { STEPS, stepById } from "./steps.mjs";

// The flags every setup route takes: the step, and the inputs each step passes to the command it wraps.
export const setupOptions = {
  step: { type: "string" }, home: { type: "string" }, "run-id": { type: "string" },
  work: { type: "string" }, "stack-current": { type: "string", multiple: true }, "stack-known": { type: "string", multiple: true },
  preference: { type: "string", multiple: true }, writing: { type: "string", multiple: true }, "seed-from-init": { type: "boolean" }, "proposed-by": { type: "string" },
  starter: { type: "string", multiple: true },
  scope: { type: "string" }, "display-name": { type: "string" }, project: { type: "string" }, repo: { type: "string" },
  doc: { type: "string", multiple: true }, "expect-remote": { type: "string", multiple: true }, environment: { type: "string", multiple: true },
  actor: { type: "string", multiple: true }, accept: { type: "string" }, "request-id": { type: "string" }, "keep-previous": { type: "boolean" },
  recommendation: { type: "string", multiple: true }
};
export const stepContext = (values, ctx) => ({ ...ctx, values });
// A step's header: the consent text and its state. done and skip never write; a failed check reads as not done.
export async function describe(step, ctx) {
  const skip = step.available === true && step.skip ? step.skip(ctx) : null;
  let done = false, problem;
  if (step.available === true && !skip) {
    try { done = await step.done(ctx); } catch (error) { problem = toJson(error); }
  }
  return { id: step.id, title: step.title, available: step.available, owner: step.owner === true, what: step.what, why: step.why, undo: step.undo, done, ...(skip ? { skipped: skip } : {}), ...(problem ? { problem } : {}) };
}
// The consent screen for one step: its header and the preview of the command it wraps. A preview that cannot be built
// (a missing input, a gate) is reported as problem, so the what, why and undo always show.
export async function planStep(step, ctx) {
  const header = await describe(step, ctx);
  if (step.available !== true || header.skipped) return { step: header, preview: null, fingerprint: null };
  try {
    const preview = await step.plan(ctx);
    return { step: header, preview, fingerprint: preview?.fingerprint ?? null };
  } catch (error) {
    return { step: header, preview: null, fingerprint: null, problem: toJson(error) };
  }
}
export async function applyStep(step, ctx, fingerprint) {
  if (step.available !== true) throw new DevtwinError("UNAVAILABLE", "Setup step not available yet", { step: step.id, available: step.available });
  const skip = step.skip ? step.skip(ctx) : null;
  if (skip) throw new DevtwinError("GATE_REQUIRED", "Setup step does not apply", { step: step.id, reason: skip });
  if (!fingerprint) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return { step: { id: step.id, title: step.title }, result: await step.apply(ctx, fingerprint) };
}
const requireStep = (values) => {
  if (typeof values.step !== "string") throw new DevtwinError("INVALID_INPUT", "Setup step required", { field: "step" });
  return stepById(values.step);
};
export const setupStatusCommand = { options: setupOptions, async run(values, ctx) {
  const c = stepContext(values, ctx), steps = [];
  for (const step of STEPS) steps.push(await describe(step, c));
  const next = steps.find((s) => s.available === true && !s.done && !s.skipped)?.id ?? null;
  return { steps, next };
} };
export const setupPlanCommand = { options: setupOptions, run: (values, ctx) => planStep(requireStep(values), stepContext(values, ctx)) };
export const setupApplyCommand = { options: { ...setupOptions, "plan-fingerprint": { type: "string" } }, run: (values, ctx) => applyStep(requireStep(values), stepContext(values, ctx), values["plan-fingerprint"]) };
