import { dirname, relative } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { recordIdFor } from "../identity/ids.mjs";
import { cliRecorder } from "../policy/actor.mjs";
import { tierOf } from "../policy/tiers.mjs";
import { addRecord, supersedeRecord, previewRecord, proposeRecord, publishProposal, requireCommittedProject, readSnapshot } from "./store.mjs";
import { validateDraft, assertProjectReach, locationLines } from "./schema.mjs";
import { isolationTerms, assertOutboundClean } from "./isolation.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
// U37 (KTD38, KTD40, KTD42, KTD43): record add and record supersede are automatic. recordedBy names the caller. A write of
// observed or proposed knowledge passes the plain-rule and scope-name checks, then appends an audit entry with the
// caller's --session before the record is written. confirmed still needs a human reviewer (validateDraft), and an
// agent may not supersede a confirmed record: that changes only through the owner.
const options = { session: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, status: { type: "string" }, source: { type: "string", multiple: true }, reviewer: { type: "string" }, "request-id": { type: "string" }, apply: { type: "boolean" }, target: { type: "string", multiple: true }, "expect-hash": { type: "string", multiple: true }, proposal: { type: "string" }, location: { type: "string", multiple: true } };
// U29 (KTD36): --location <kind>:<name>:<where>, repeatable, on an environment record. The name holds no colon; the
// place is everything after the second one. The error never echoes the text, which may be a value.
function parseLocation(text) {
  const first = text.indexOf(":"), second = first < 0 ? -1 : text.indexOf(":", first + 1);
  if (first < 1 || second < 0) throw new DevtwinError("INVALID_INPUT", "Location must be <kind>:<name>:<where>", { field: "location" });
  return { name: text.slice(first + 1, second), kind: text.slice(0, first), where: text.slice(second + 1) };
}
async function inputFrom(values, ctx) {
  if (values.body !== undefined && values["body-file"] !== undefined) throw new DevtwinError("USAGE", "Choose one body input");
  let body = values.body ?? "";
  if (values["body-file"]) {
    // The fence check runs on the parent directory: validateRoot refuses an existing file as a pilot root.
    assertInPilot(ctx.pilot, dirname(values["body-file"]), "inputsRoot");
    const rel = relative(ctx.pilot.inputsRoot, values["body-file"]);
    const read = await readApprovedSource(ctx.pilot.inputsRoot, rel);
    if (read.skipped || Buffer.byteLength(read.text) > 32768) throw new DevtwinError("INVALID_INPUT", "Body file unavailable");
    body = read.text;
  }
  return { scope: values.scope, project: values.project, requestId: values["request-id"], recordedBy: cliRecorder(ctx.env ?? process.env), draft: { kind: values.kind, status: values.status ?? "observed", title: values.title, body, sources: list(values.source).map((ref) => ({ ref })), applicability: { level: "project" }, review: values.reviewer ? { reviewer: values.reviewer } : null, ...(values.location !== undefined && { locations: list(values.location).map(parseLocation) }) } };
}
const AUDITED = ["observed", "proposed"];
// The checks that run before the audit entry, so a write refused here leaves no entry behind.
async function automaticWrite(ctx, route, input, session, { targets = [], expectHashes = [] } = {}) {
  const { SESSION_ID } = await import("../lessons/propose.mjs");
  if (session !== undefined && !SESSION_ID.test(session)) throw new DevtwinError("INVALID_INPUT", "Invalid session ID", { field: "session" });
  if (!REQUEST_ID.test(input.requestId)) throw new DevtwinError("INVALID_ID", "Invalid request ID");
  const recordId = recordIdFor(input);
  validateDraft(input.draft, { recordedBy: input.recordedBy, supersedes: targets });
  assertProjectReach(input.draft);
  await requireCommittedProject(ctx.roots, input.scope, input.project);
  if (targets.length) {
    const records = (await readSnapshot(ctx.roots, input.scope, input.project)).records;
    targets.forEach((id, i) => {
      const target = records.find((r) => r.id === id);
      if (!target || target.effective === "superseded" || target.recordHash !== expectHashes[i]) throw new DevtwinError("STALE_VERSION", "Target changed");
      if (target.status === "confirmed" && input.recordedBy.actor !== "human") throw new DevtwinError("APPROVAL_REQUIRED", "A confirmed record changes only through the owner", { id });
    });
  }
  if (!AUDITED.includes(input.draft.status)) return null;
  const { checkAutomaticText } = await import("../audit/checks.mjs");
  checkAutomaticText({ lines: [input.draft.title, ...locationLines(input.draft.locations)], body: input.draft.body });
  assertOutboundClean([input.draft.title, input.draft.body, ...locationLines(input.draft.locations)].join("\n"), await isolationTerms(ctx.roots), { except: input.scope });
  const { appendEntry } = await import("../audit/log.mjs");
  return appendEntry(ctx.roots, { kind: "record", tier: tierOf({ route }), route, home: "project", scope: input.scope, project: input.project, recordIds: [recordId], supersedes: targets, actor: input.recordedBy.actor, session: session ?? null, requestId: input.requestId }, { now: ctx.now });
}
const withAudit = (result, entry) => entry ? { ...result, audit: entry.id } : result;
export const recordAddCommand = { options, async run(values, ctx) {
  const input = await inputFrom(values, ctx);
  if (!values.apply) return previewRecord(ctx.roots, input);
  if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required");
  const entry = await automaticWrite(ctx, "record add", input, values.session);
  return withAudit(await addRecord(ctx.roots, input, { now: ctx.now }), entry);
} };
export const recordSupersedeCommand = { options, async run(values, ctx) {
  const input = { ...await inputFrom(values, ctx), targets: list(values.target), expectHashes: list(values["expect-hash"]) };
  if (!values.apply) return previewRecord(ctx.roots, input);
  if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required");
  if (input.targets.length === 0 || input.targets.length !== input.expectHashes.length) throw new DevtwinError("INVALID_INPUT", "Targets and hashes required");
  const { scope, project, requestId, recordedBy, draft } = input;
  const entry = await automaticWrite(ctx, "record supersede", { scope, project, requestId, recordedBy, draft }, values.session, input);
  return withAudit(await supersedeRecord(ctx.roots, input, { now: ctx.now }), entry);
} };
export const recordProposeCommand = { options, async run(values, ctx) { const input = await inputFrom(values, ctx); if (!values.apply) return previewRecord(ctx.roots, input); if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required"); return proposeRecord(ctx.roots, input, { now: ctx.now }); } };
export const recordPublishCommand = { options, async run(values, ctx) { if (!values.apply) return { preview: true, proposalId: values.proposal }; return publishProposal(ctx.roots, { scope: values.scope, project: values.project, proposalId: values.proposal, review: values.reviewer ? { reviewer: values.reviewer } : null }, { controller: true, now: ctx.now }); } };
