import { dirname, relative } from "node:path";
import { DevctxError } from "../errors.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { addRecord, supersedeRecord, previewRecord, proposeRecord, publishProposal } from "./store.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const options = { scope: { type: "string" }, project: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, status: { type: "string" }, source: { type: "string", multiple: true }, reviewer: { type: "string" }, "request-id": { type: "string" }, apply: { type: "boolean" }, target: { type: "string", multiple: true }, "expect-hash": { type: "string", multiple: true }, proposal: { type: "string" } };
async function inputFrom(values, ctx) {
  if (values.body !== undefined && values["body-file"] !== undefined) throw new DevctxError("USAGE", "Choose one body input");
  let body = values.body ?? "";
  if (values["body-file"]) {
    // The fence check runs on the parent directory: validateRoot refuses an existing file as a pilot root.
    assertInPilot(ctx.pilot, dirname(values["body-file"]), "inputsRoot");
    const rel = relative(ctx.pilot.inputsRoot, values["body-file"]);
    const read = await readApprovedSource(ctx.pilot.inputsRoot, rel);
    if (read.skipped || Buffer.byteLength(read.text) > 32768) throw new DevctxError("INVALID_INPUT", "Body file unavailable");
    body = read.text;
  }
  return { scope: values.scope, project: values.project, requestId: values["request-id"], recordedBy: { actor: "human", runId: "run_cli00001" }, draft: { kind: values.kind, status: values.status ?? "observed", title: values.title, body, sources: list(values.source).map((ref) => ({ ref })), applicability: { level: "project" }, review: values.reviewer ? { reviewer: values.reviewer } : null } };
}
export const recordAddCommand = { options, async run(values, ctx) { const input = await inputFrom(values, ctx); if (!values.apply) return previewRecord(ctx.roots, input); if (!input.requestId) throw new DevctxError("PLAN_REQUIRED", "Request ID required"); return addRecord(ctx.roots, input, { now: ctx.now }); } };
export const recordSupersedeCommand = { options, async run(values, ctx) { const input = { ...await inputFrom(values, ctx), targets: list(values.target), expectHashes: list(values["expect-hash"]) }; if (!values.apply) return previewRecord(ctx.roots, input); if (!input.requestId) throw new DevctxError("PLAN_REQUIRED", "Request ID required"); return supersedeRecord(ctx.roots, input, { now: ctx.now }); } };
export const recordProposeCommand = { options, async run(values, ctx) { const input = await inputFrom(values, ctx); if (!values.apply) return previewRecord(ctx.roots, input); if (!input.requestId) throw new DevctxError("PLAN_REQUIRED", "Request ID required"); return proposeRecord(ctx.roots, input, { now: ctx.now }); } };
export const recordPublishCommand = { options, async run(values, ctx) { if (!values.apply) return { preview: true, proposalId: values.proposal }; return publishProposal(ctx.roots, { scope: values.scope, project: values.project, proposalId: values.proposal, review: values.reviewer ? { reviewer: values.reviewer } : null }, { controller: true, now: ctx.now }); } };
