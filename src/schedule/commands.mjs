// U20: schedule plan | apply | off | status | run, for the radar-weekly, advisory-hourly, review-monthly and activity-weekly jobs.
// apply and off --apply are owner actions: the hook denies them from agent shells, and each shows the owner dialog.
// run is what the LaunchAgent calls; it loads the pilot itself so that a failing live gate still leaves a receipt.
import { DevtwinError } from "../errors.mjs";
import { loadPilot, rootsFromPilot } from "../config/pilot.mjs";

const jobs = () => import("./jobs.mjs");
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const stackDeps = async (ctx) => {
  const { loadStackCatalog, validateStackCatalog } = await import("../stack/catalog.mjs");
  return { catalog: ctx.stackCatalog ? validateStackCatalog(ctx.stackCatalog) : loadStackCatalog(), resolvePublicRead: ctx.resolvePublicRead, request: ctx.request, lookup: ctx.lookup };
};
const planOptions = { job: { type: "string" }, "plan-fingerprint": { type: "string" } };
export const schedulePlanCommand = { options: { job: { type: "string" } }, run: async (values, ctx) => ({ preview: true, ...(await (await jobs()).planSchedule(ctx.roots, { job: values.job }, ctx)) }) };
export const scheduleApplyCommand = { options: planOptions, async run(values, ctx) {
  needPlan(values);
  return (await jobs()).applySchedule(ctx.roots, { job: values.job }, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const scheduleOffCommand = { options: { ...planOptions, apply: { type: "boolean" } }, async run(values, ctx) {
  const j = await jobs();
  if (!values.apply) return { preview: true, ...(await j.planSchedule(ctx.roots, { job: values.job, off: true }, ctx)) };
  needPlan(values);
  return j.applySchedule(ctx.roots, { job: values.job, off: true }, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const scheduleStatusCommand = { options: {}, run: async (values, ctx) => (await jobs()).scheduleStatus(ctx.roots, ctx) };
export const scheduleRunCommand = { options: { pilot: { type: "string" }, job: { type: "string" } }, async run(values, ctx) {
  const j = await jobs();
  j.jobFor(values.job);
  let pilot;
  try { pilot = await loadPilot(values.pilot, { home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot }); }
  catch (error) { await j.recordGateFailure(values.pilot, values.job, error, { now: ctx.now }); throw error; }
  const roots = rootsFromPilot(pilot);
  return j.runJob(roots, values.job, { now: ctx.now, ctx: { ...ctx, roots, pilot }, deps: await stackDeps(ctx) });
} };
