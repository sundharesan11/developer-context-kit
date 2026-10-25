import { DevtwinError } from "../errors.mjs";
import { planDraft, applyDraft } from "./save.mjs";
// No message-type, send, post or connector option: draft save only stores an approved draft privately.
export const draftSaveCommand = {
  options: { "body-file": { type: "string" }, scope: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } },
  async run(values, ctx) {
    const input = { scope: values.scope, bodyFile: values["body-file"] };
    if (!values.apply) return planDraft(ctx.roots, input);
    if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
    return applyDraft(ctx.roots, input, { fingerprint: values["plan-fingerprint"] });
  }
};
