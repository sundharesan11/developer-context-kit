import { DevtwinError } from "../errors.mjs";
import { proposeHubLearning } from "./propose.mjs";
export const hubProposeCommand = { options: { scope: { type: "string" }, project: { type: "string" }, record: { type: "string", multiple: true }, hub: { type: "string" }, apply: { type: "boolean" } }, run: (values, ctx) => proposeHubLearning(ctx.roots, { scope: values.scope, project: values.project, recordIds: values.record ?? [], hubId: values.hub }, { now: ctx.now, apply: values.apply ?? false }) };
// U10: hub join | sync | leave | status | schedule. join, leave and schedule preview, then apply with --apply and the
// plan fingerprint after the owner dialog. ctx.ownerDialog and ctx.launchctl are test seams.
const joinOptions = { scope: { type: "string" }, remote: { type: "string" }, handle: { type: "string" }, email: { type: "string" }, "ssh-command": { type: "string" }, "hub-root": { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const joinInput = (values) => ({ scope: values.scope, remote: values.remote, handle: values.handle, email: values.email, sshCommand: values["ssh-command"], hubRoot: values["hub-root"] });
export const hubJoinCommand = { options: joinOptions, async run(values, ctx) {
  const join = await import("./join.mjs");
  if (!values.apply) return join.planJoin(ctx.roots, joinInput(values));
  needPlan(values);
  return join.applyJoin(ctx.roots, joinInput(values), { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const hubLeaveCommand = { options: { scope: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const join = await import("./join.mjs");
  if (!values.apply) return join.planLeave(ctx.roots, { scope: values.scope });
  needPlan(values);
  return join.applyLeave(ctx.roots, { scope: values.scope }, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const hubScheduleCommand = { options: { scope: { type: "string" }, off: { type: "boolean" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const join = await import("./join.mjs");
  const input = { scope: values.scope, off: values.off ?? false };
  if (!values.apply) return join.planSchedule(ctx.roots, input, ctx);
  needPlan(values);
  return join.applySchedule(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const hubSyncCommand = { options: { scope: { type: "string" }, job: { type: "boolean" } }, run: async (values, ctx) => (await import("./sync.mjs")).syncHub(ctx.roots, values.scope, { now: ctx.now, job: values.job ?? false }) };
export const hubStatusCommand = { options: { scope: { type: "string" } }, run: async (values, ctx) => (await import("./sync.mjs")).hubStatus(ctx.roots, values.scope, { now: ctx.now }) };
// U14: published list (read-only, open to agents) and published delete (owner-only: preview, then --apply with the plan
// fingerprint after the owner dialog; the hook denies it from agent shells).
export const publishedListCommand = { options: { scope: { type: "string" } }, run: async (values, ctx) => (await import("./published.mjs")).listPublished(ctx.roots, { scope: values.scope }, { now: ctx.now }) };
export const publishedDeleteCommand = { options: { scope: { type: "string" }, id: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const published = await import("./published.mjs");
  const input = { scope: values.scope, id: values.id };
  if (!values.apply) return published.planDelete(ctx.roots, input);
  needPlan(values);
  return published.applyDelete(ctx.roots, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
