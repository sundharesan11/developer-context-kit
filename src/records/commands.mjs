import { dirname, relative } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { recordIdFor } from "../identity/ids.mjs";
import { cliRecorder, isJobRecorder } from "../policy/actor.mjs";
import { tierOf } from "../policy/tiers.mjs";
import { addRecord, supersedeRecord, previewRecord, proposeRecord, publishProposal, requireCommittedProject, readSnapshot } from "./store.mjs";
import { validateDraft, assertProjectReach, locationLines } from "./schema.mjs";
import { isolationTerms, assertOutboundClean } from "./isolation.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
// U37 (KTD38, KTD40, KTD42, KTD43): record add and record supersede. recordedBy names the caller. Every write passes the
// plain-rule and scope-name checks, then appends an audit entry with the caller's --session before the record is
// written. The tier comes from the record's status (src/policy/tiers.mjs): observed and proposed knowledge is
// automatic; a confirmed or disputed record, or a write that replaces a confirmed or disputed record, shows the owner dialog
// first, whoever the caller is, and its audit entry has tier always-ask. A retraction is refused (validateDraft).
const options = { session: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, kind: { type: "string" }, title: { type: "string" }, body: { type: "string" }, "body-file": { type: "string" }, status: { type: "string" }, source: { type: "string", multiple: true }, reviewer: { type: "string" }, "request-id": { type: "string" }, apply: { type: "boolean" }, target: { type: "string", multiple: true }, "expect-hash": { type: "string", multiple: true }, proposal: { type: "string" }, location: { type: "string", multiple: true }, path: { type: "string", multiple: true }, package: { type: "string", multiple: true }, topic: { type: "string", multiple: true }, command: { type: "string", multiple: true } };
// U29 (KTD36): --location <kind>:<name>:<where>, repeatable, on an environment record. The name holds no colon; the
// place is everything after the second one. The error never echoes the text, which may be a value.
function parseLocation(text) {
  const first = text.indexOf(":"), second = first < 0 ? -1 : text.indexOf(":", first + 1);
  if (first < 1 || second < 0) throw new DevtwinError("INVALID_INPUT", "Location must be <kind>:<name>:<where>", { field: "location" });
  return { name: text.slice(first + 1, second), kind: text.slice(0, first), where: text.slice(second + 1) };
}
// U28: --path, --package, --topic and --command give a record a match block, so an agent can sharpen an imported
// lesson by superseding it (skills/devtwin-capture). With none of them, the record has no match block, as before.
function matchOf(values) {
  if ([values.path, values.package, values.topic, values.command].every((v) => v === undefined)) return {};
  return { match: { paths: list(values.path), packages: list(values.package), topics: list(values.topic), ...(values.command === undefined ? {} : { commands: list(values.command) }) } };
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
  return { scope: values.scope, project: values.project, requestId: values["request-id"], recordedBy: cliRecorder(ctx.env ?? process.env), draft: { kind: values.kind, status: values.status ?? "observed", title: values.title, body, sources: list(values.source).map((ref) => ({ ref })), applicability: { level: "project" }, review: values.reviewer ? { reviewer: values.reviewer } : null, ...(values.location !== undefined && { locations: list(values.location).map(parseLocation) }), ...matchOf(values) } };
}
// The record's tier target: its status, or replaces-confirmed (replaces-disputed) for a write that replaces a confirmed
// (disputed) record. A disputed record is the owner's open question, so an agent cannot settle it by replacing it.
const recordTarget = (draft, replaces) => replaces ? "replaces-" + replaces : draft.status;
const REPLACED = { "replaces-confirmed": "Replace a confirmed devtwin record", "replaces-disputed": "Replace a disputed devtwin record" };
const ownerDialog = (route, input, target, targets) => ({ title: REPLACED[target] ?? "Record " + (input.draft.status === "confirmed" ? "a confirmed" : "a disputed") + " devtwin fact",
  body: ["Route: " + route, "Project: " + input.project, "Kind: " + input.draft.kind + ", status " + input.draft.status, ...(input.draft.review?.reviewer ? ["Reviewer: " + input.draft.review.reviewer] : []),
    ...(targets.length ? ["Replaces: " + targets.join(", ")] : []), "", "Title: " + input.draft.title].join("\n") });
// The checks that run before the audit entry, so a write refused here leaves no entry behind. An always-ask write
// shows the owner dialog after the checks and before the entry.
// U28: sourceHash names the imported source a job write came from. A devtwin job (actor other with a job run ID,
// src/policy/actor.mjs) is not an agent session, so the KTD43 session and day caps do not count its writes; the job
// keeps its own cap (src/import/commands.mjs).
export async function auditedWrite(ctx, route, input, session, { targets = [], expectHashes = [], sourceHash = null } = {}) {
  const { SESSION_ID } = await import("../lessons/propose.mjs");
  if (session !== undefined && !SESSION_ID.test(session)) throw new DevtwinError("INVALID_INPUT", "Invalid session ID", { field: "session" });
  if (!REQUEST_ID.test(input.requestId)) throw new DevtwinError("INVALID_ID", "Invalid request ID");
  const recordId = recordIdFor(input);
  validateDraft(input.draft, { recordedBy: input.recordedBy });
  assertProjectReach(input.draft);
  await requireCommittedProject(ctx.roots, input.scope, input.project);
  let replaces = null;
  if (targets.length) {
    const records = (await readSnapshot(ctx.roots, input.scope, input.project)).records;
    targets.forEach((id, i) => {
      const target = records.find((r) => r.id === id);
      if (!target || target.effective === "superseded" || target.recordHash !== expectHashes[i]) throw new DevtwinError("STALE_VERSION", "Target changed");
      if (target.status === "confirmed") replaces = "confirmed";
      else if (target.status === "disputed") replaces ??= "disputed";
    });
  }
  const target = recordTarget(input.draft, replaces), tier = tierOf({ route, target });
  const { checkAutomaticText } = await import("../audit/checks.mjs");
  checkAutomaticText({ lines: [input.draft.title, ...locationLines(input.draft.locations)], body: input.draft.body });
  assertOutboundClean([input.draft.title, input.draft.body, ...locationLines(input.draft.locations)].join("\n"), await isolationTerms(ctx.roots), { except: input.scope });
  if (tier === "always-ask") await (await import("../owner/dialog.mjs")).requireOwnerApproval(ctx, ownerDialog(route, input, target, targets));
  const { appendEntry } = await import("../audit/log.mjs");
  return appendEntry(ctx.roots, { kind: "record", tier, route, target, home: "project", scope: input.scope, project: input.project, recordIds: [recordId], supersedes: targets, actor: input.recordedBy.actor, session: session ?? null, requestId: input.requestId, sourceHash }, { now: ctx.now, cap: !isJobRecorder(input.recordedBy) });
}
const withAudit = (result, entry) => ({ ...result, audit: entry.id });
export const recordAddCommand = { options, async run(values, ctx) {
  const input = await inputFrom(values, ctx);
  if (!values.apply) return previewRecord(ctx.roots, input);
  if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required");
  const entry = await auditedWrite(ctx, "record add", input, values.session);
  return withAudit(await addRecord(ctx.roots, input, { now: ctx.now }), entry);
} };
export const recordSupersedeCommand = { options, async run(values, ctx) {
  const input = { ...await inputFrom(values, ctx), targets: list(values.target), expectHashes: list(values["expect-hash"]) };
  if (!values.apply) return previewRecord(ctx.roots, input);
  if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required");
  if (input.targets.length === 0 || input.targets.length !== input.expectHashes.length) throw new DevtwinError("INVALID_INPUT", "Targets and hashes required");
  const { scope, project, requestId, recordedBy, draft } = input;
  const entry = await auditedWrite(ctx, "record supersede", { scope, project, requestId, recordedBy, draft }, values.session, input);
  return withAudit(await supersedeRecord(ctx.roots, input, { now: ctx.now }), entry);
} };
export const recordProposeCommand = { options, async run(values, ctx) { const input = await inputFrom(values, ctx); if (!values.apply) return previewRecord(ctx.roots, input); if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required"); return proposeRecord(ctx.roots, input, { now: ctx.now }); } };
export const recordPublishCommand = { options, async run(values, ctx) { if (!values.apply) return { preview: true, proposalId: values.proposal }; return publishProposal(ctx.roots, { scope: values.scope, project: values.project, proposalId: values.proposal, review: values.reviewer ? { reviewer: values.reviewer } : null }, { controller: true, now: ctx.now }); } };
