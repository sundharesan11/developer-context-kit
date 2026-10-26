// U17: template list, template show and template from. list and show only read. from previews the structure it
// would save, then saves it with --apply and the plan fingerprint. A saved template is personal and local.
import { DevtwinError } from "../errors.mjs";
const outputs = () => import("./outputs.mjs");
export const templateListCommand = { options: {}, run: async (values, ctx) => (await outputs()).listOutputTemplates(ctx.roots, ctx) };
export const templateShowCommand = { options: { kind: { type: "string" }, format: { type: "string" } }, run: async (values, ctx) => (await outputs()).showOutputTemplate(ctx.roots, { kind: values.kind, format: values.format }, ctx) };
export const templateFromCommand = { options: { file: { type: "string" }, kind: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const o = await outputs(), input = { file: values.file, kind: values.kind };
  if (!values.apply) return o.planTemplateFrom(ctx.roots, ctx.pilot, input, ctx);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return o.applyTemplateFrom(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], now: ctx.now, ctx });
} };
