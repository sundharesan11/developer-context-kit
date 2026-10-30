// U9: setup status | plan --step <id> | apply --step <id> --plan-fingerprint <f>. Each route reads the step data in
// steps.mjs; plan and apply delegate to the step's own preview and apply, so no setup logic is repeated here.
// U9 (one approval): plan and apply with --steps <id,...> or --all-pending run a batch of owner steps behind one owner
// dialog (src/setup/batch.mjs); apply then takes --apply and the batch fingerprint.
import { DevtwinError, toJson } from "../errors.mjs";
import { STEPS, stepById } from "./steps.mjs";
import { support } from "../agents/adapters/index.mjs";

// The flags every setup route takes: the step, and the inputs each step passes to the command it wraps.
export const setupOptions = {
  step: { type: "string" }, home: { type: "string" }, "run-id": { type: "string" },
  work: { type: "string" }, "stack-current": { type: "string", multiple: true }, "stack-known": { type: "string", multiple: true },
  preference: { type: "string", multiple: true }, writing: { type: "string", multiple: true }, "seed-from-init": { type: "boolean" }, "proposed-by": { type: "string" },
  starter: { type: "string", multiple: true },
  scope: { type: "string" }, "display-name": { type: "string" }, project: { type: "string" }, repo: { type: "string" },
  doc: { type: "string", multiple: true }, "expect-remote": { type: "string", multiple: true }, environment: { type: "string", multiple: true },
  actor: { type: "string", multiple: true }, accept: { type: "string" }, "request-id": { type: "string" }, "keep-previous": { type: "boolean" },
  recommendation: { type: "string", multiple: true },
  "hub-remote": { type: "string" }, "hub-handle": { type: "string" }, "hub-email": { type: "string" }, "ssh-command": { type: "string" }, "hub-root": { type: "string" },
  "push-repo": { type: "string" }, "hold-hours": { type: "string" }, "backup-target": { type: "string", multiple: true },
  steps: { type: "string", multiple: true }, "all-pending": { type: "boolean" }
};
export const stepContext = (values, ctx) => ({ ...ctx, values });
// A step's header: the consent text and its state. done and skip never write; a failed check reads as not done.
export async function describe(step, ctx) {
  const skip = step.available === true && step.skip ? step.skip(ctx) : null;
  let done = false, problem;
  if (step.available === true && !skip) {
    try { done = await step.done(ctx); } catch (error) { problem = toJson(error); }
  }
  // A job step whose job is on but whose plist is not what it would write now (after live set-kit) says outdated.
  let outdated = false;
  if (!done && !problem && !skip && step.outdated) { try { outdated = await step.outdated(ctx); } catch (error) { problem = toJson(error); } }
  return { id: step.id, title: step.title, available: step.available, owner: step.owner === true, what: step.what, why: step.why, undo: step.undo, done, ...(outdated ? { status: "outdated" } : {}), ...(skip ? { skipped: skip } : {}), ...(problem ? { problem } : {}),
    // Issue #8: an agent step names its agent and that agent's support level, so a partial agent shows plainly.
    ...(step.agent ? { agent: step.agent, supportLevel: support(step.agent).supportLevel } : {}) };
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
const batch = () => import("./batch.mjs");
const isBatch = (values) => values["all-pending"] === true || values.steps !== undefined;
const requireStep = (values) => {
  if (typeof values.step !== "string") throw new DevtwinError("INVALID_INPUT", "Setup step required", { field: "step" });
  if (isBatch(values)) throw new DevtwinError("INVALID_INPUT", "Give --step for one step, or --steps or --all-pending for a batch", { field: "step" });
  return stepById(values.step);
};
export const setupStatusCommand = { options: setupOptions, async run(values, ctx) {
  const c = stepContext(values, ctx), steps = [];
  for (const step of STEPS) steps.push(await describe(step, c));
  const next = steps.find((s) => s.available === true && !s.done && !s.skipped)?.id ?? null;
  // Every enabled job whose plist is outdated, with or without a setup step (import-daily, activity-weekly and
  // learning-send have none). setup apply --all-pending rewrites them all.
  let outdated;
  try { outdated = await (await import("../schedule/jobs.mjs")).outdatedJobs(c.roots, c); } catch (error) { outdated = { problem: toJson(error) }; }
  return { steps, next, outdatedJobs: outdated };
} };
export const setupPlanCommand = { options: setupOptions, async run(values, ctx) {
  if (isBatch(values) && values.step === undefined) return { preview: true, ...(await (await batch()).buildBatch(values, stepContext(values, ctx))).plan };
  return planStep(requireStep(values), stepContext(values, ctx));
} };
export const setupApplyCommand = { options: { ...setupOptions, "plan-fingerprint": { type: "string" }, apply: { type: "boolean" } }, async run(values, ctx) {
  if (isBatch(values) && values.step === undefined) return (await batch()).applyBatch(values, stepContext(values, ctx));
  return applyStep(requireStep(values), stepContext(values, ctx), values["plan-fingerprint"]);
} };
