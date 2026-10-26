// U15: pref propose (agent-callable, private, at most three per session), the owner's proposals, accept, decline,
// list and retire. propose applies with --apply, as lesson propose does; accept, decline and retire apply with --apply
// and the plan fingerprint. accept --apply is an owner action: the hook denies it from agent shells, and it shows the
// owner dialog.
import { DevtwinError } from "../errors.mjs";
const needPlan = (values) => { if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required"); };
const planOptions = { id: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const store = () => import("./store.mjs");
export const prefProposeCommand = { options: { session: { type: "string" }, title: { type: "string" }, text: { type: "string" }, topic: { type: "string" }, apply: { type: "boolean" } }, async run(values, ctx) {
  return (await store()).proposePreference(ctx.roots, { session: values.session, title: values.title, text: values.text, topic: values.topic ?? null }, { now: ctx.now, apply: values.apply ?? false });
} };
export const prefProposalsCommand = { options: { all: { type: "boolean" } }, run: async (values, ctx) => (await store()).listPreferenceProposals(ctx.roots, { all: values.all ?? false }) };
export const prefListCommand = { options: {}, run: async (values, ctx) => (await store()).listPreferences(ctx.roots) };
export const prefAcceptCommand = { options: planOptions, async run(values, ctx) {
  const s = await store();
  if (!values.apply) return s.planAcceptPreference(ctx.roots, { id: values.id });
  needPlan(values);
  return s.applyAcceptPreference(ctx.roots, { id: values.id }, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
export const prefDeclineCommand = { options: planOptions, async run(values, ctx) {
  const s = await store();
  if (!values.apply) return s.planDeclinePreference(ctx.roots, { id: values.id });
  needPlan(values);
  return s.applyDeclinePreference(ctx.roots, { id: values.id }, { fingerprint: values["plan-fingerprint"], now: ctx.now });
} };
export const prefRetireCommand = { options: planOptions, async run(values, ctx) {
  const s = await store();
  if (!values.apply) return s.planRetirePreference(ctx.roots, { id: values.id });
  needPlan(values);
  return s.applyRetirePreference(ctx.roots, { id: values.id }, { fingerprint: values["plan-fingerprint"] });
} };
