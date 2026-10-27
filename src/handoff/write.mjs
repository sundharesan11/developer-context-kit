import { DevtwinError } from "../errors.mjs";
import { cliRecorder } from "../policy/actor.mjs";
import { checkAutomaticText } from "../audit/checks.mjs";
import { addRecord, previewRecord } from "../records/store.mjs";
import { auditedWrite } from "../records/commands.mjs";
// U33 (R12, KTD32, KTD38, KTD43): `handoff write` stores where a session stopped, the next step and where the artifacts
// are, as an observed project handoff record. It is automatic: it goes through the same audited write as record add
// (plain-rule, sensitive and scope-name checks, an audit entry with --session first, the per-session cap), and the
// record write rebuilds the session summary, whose last-handoff line reads the "Next step:" line. Pass the session ID
// from the hook's session-start line: a handoff from that session hides the stop stub's line at the next start.
export const HANDOFF_TITLE = "Session handoff";
const FIELD_CHARS = 300, ARTIFACT_CHARS = 200, ARTIFACTS = 10;
const options = { session: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, stopped: { type: "string" }, next: { type: "string" }, artifact: { type: "string", multiple: true }, "request-id": { type: "string" }, apply: { type: "boolean" } };
// One line of text: present, within its limit, with no line break. The error names the field, never the text.
function oneLine(value, field, max) {
  if (typeof value !== "string" || !value.trim() || [...value].length > max || /[\r\n\u2028\u2029]/.test(value)) throw new DevtwinError("INVALID_INPUT", "Handoff field must be one line of at most " + max + " characters", { field });
  return value.trim();
}
export function handoffBody({ stopped, next, artifacts = [] }) {
  return ["Stopped: " + stopped, "Next step: " + next, ...(artifacts.length ? ["Artifacts: " + artifacts.join("; ")] : [])].join("\n") + "\n";
}
export function handoffInput(values, env) {
  const stopped = oneLine(values.stopped, "stopped", FIELD_CHARS), next = oneLine(values.next, "next", FIELD_CHARS);
  const list = values.artifact ?? [];
  if (list.length > ARTIFACTS) throw new DevtwinError("INVALID_INPUT", "At most " + ARTIFACTS + " artifacts", { field: "artifact" });
  const artifacts = list.map((a) => oneLine(a, "artifact", ARTIFACT_CHARS));
  // Each field is a one-line field: it gets every plain-rule check, not only the body checks.
  for (const [field, lines] of [["stopped", [stopped]], ["next", [next]], ["artifact", artifacts]]) checkAutomaticText({ lines }, { field });
  return { scope: values.scope, project: values.project, requestId: values["request-id"], recordedBy: cliRecorder(env),
    draft: { kind: "handoff", status: "observed", title: HANDOFF_TITLE, body: handoffBody({ stopped, next, artifacts }), sources: [], applicability: { level: "project" }, review: null } };
}
export const handoffWriteCommand = { options, async run(values, ctx) {
  const input = handoffInput(values, ctx.env ?? process.env);
  if (!values.apply) return { ...await previewRecord(ctx.roots, input), body: input.draft.body };
  if (!input.requestId) throw new DevtwinError("PLAN_REQUIRED", "Request ID required");
  const entry = await auditedWrite(ctx, "handoff write", input, values.session);
  return { ...await addRecord(ctx.roots, input, { now: ctx.now }), audit: entry.id };
} };
