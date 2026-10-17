import { DevctxError } from "../errors.mjs";
import { loadStackCatalog, validateStackCatalog } from "./catalog.mjs";
import { planStack, approveStack, readStackApproval, approvalDifferences, noPublicReadBinding } from "./plan.mjs";
import { runStackCheck } from "./check.mjs";
import { planDigest, applyDigest } from "./digest.mjs";
// ctx.stackCatalog and ctx.resolvePublicRead are seams: tests pass a fixture catalog, and routing will supply the
// public-read binding resolver. The default resolver reports no binding and reads no environment variable.
const deps = (ctx) => ({ catalog: ctx.stackCatalog ? validateStackCatalog(ctx.stackCatalog) : loadStackCatalog(), resolvePublicRead: ctx.resolvePublicRead ?? noPublicReadBinding });
const input = (values) => ({ feeds: values.feed ?? [], maps: values.map ?? [], groups: values.with ?? [], clearOverrides: values["clear-overrides"] === true });
const options = { feed: { type: "string", multiple: true }, map: { type: "string", multiple: true }, with: { type: "string", multiple: true }, "clear-overrides": { type: "boolean" } };
export const stackPlanCommand = {
  options,
  async run(values, ctx) {
    const plan = await planStack(ctx.roots, input(values), deps(ctx));
    const approval = await readStackApproval(ctx.roots);
    const differences = approvalDifferences(approval, plan);
    return { ...plan, approval: { status: !approval ? "none" : differences.length ? "stale" : "matches", differences: approval ? differences : [] } };
  }
};
export const stackApproveCommand = {
  options: { ...options, "plan-fingerprint": { type: "string" } },
  async run(values, ctx) {
    if (!values["plan-fingerprint"]) throw new DevctxError("PLAN_REQUIRED", "Plan fingerprint required");
    return approveStack(ctx.roots, input(values), deps(ctx), { fingerprint: values["plan-fingerprint"], now: ctx.now });
  }
};
// Read-only: fetches from the approved hosts and returns structured findings; it writes no file (U6 owns the digest).
export const stackCheckCommand = {
  options: { scope: { type: "string" } },
  async run(values, ctx) {
    return runStackCheck(ctx.roots, { scope: values.scope ?? null }, { ...deps(ctx), request: ctx.request, lookup: ctx.lookup, now: ctx.now });
  }
};
// Preview writes only the pending file; --apply makes no request and writes the digest and that scope's seen state.
export const stackDigestCommand = {
  options: { scope: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } },
  async run(values, ctx) {
    const scope = values.scope ?? null;
    if (!values.apply) return planDigest(ctx.roots, { scope }, { ...deps(ctx), request: ctx.request, lookup: ctx.lookup, now: ctx.now });
    if (!values["plan-fingerprint"]) throw new DevctxError("PLAN_REQUIRED", "Plan fingerprint required");
    return applyDigest(ctx.roots, { scope, fingerprint: values["plan-fingerprint"] });
  }
};
