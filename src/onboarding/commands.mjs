import { DevtwinError } from "../errors.mjs";
import { planOnboard, applyOnboard } from "./onboard.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
export const projectOnboardCommand = {
  options: { scope: { type: "string" }, project: { type: "string" }, repo: { type: "string" }, doc: { type: "string", multiple: true }, "expect-remote": { type: "string", multiple: true }, environment: { type: "string", multiple: true }, actor: { type: "string", multiple: true }, accept: { type: "string" }, "request-id": { type: "string" }, "keep-previous": { type: "boolean" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } },
  async run(values, ctx) {
    const input = { scope: values.scope, project: values.project, repo: values.repo, approvedDocs: list(values.doc), expectedRemotes: list(values["expect-remote"]), environments: list(values.environment), actorRefs: list(values.actor), accept: values.accept ?? "none", requestId: values["request-id"], keepPrevious: values["keep-previous"] === true };
    if (!values.apply) return planOnboard(ctx.roots, ctx.pilot, input);
    if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
    return applyOnboard(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], now: ctx.now });
  }
};
