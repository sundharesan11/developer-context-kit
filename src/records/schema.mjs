import { DevtwinError } from "../errors.mjs";
import { sha256, digest } from "../storage/canonical.mjs";
import { assertActorRef, assertProjectId, assertScopeId, recordIdFor } from "../identity/ids.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { assertNoSensitive, findForbiddenFields } from "./redact.mjs";
export const KINDS = ["brief", "map", "command", "environment", "constraint", "fact", "decision", "experiment", "unknown", "handoff"];
export const STATUSES = ["proposed", "observed", "confirmed", "disputed"];
const invalid = () => { throw new DevtwinError("INVALID_INPUT", "Invalid record draft"); };
function source(ref) {
  if (typeof ref !== "string") invalid();
  if (ref.startsWith("file:")) { const rel = ref.slice(5); try { assertSourceRel(rel); if (isDeniedRel(rel)) invalid(); } catch { invalid(); } return; }
  if (/^commit:[a-f0-9]{7,64}$/.test(ref) || /^record:rec_[a-f0-9]{24}$/.test(ref) || /^issue:[A-Z]+-[0-9]+$/.test(ref)) return;
  if (ref.startsWith("user:")) { assertActorRef(ref.slice(5)); return; }
  if (ref.startsWith("url:")) {
    try { const u = new URL(ref.slice(4)); if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) invalid(); return; } catch { invalid(); }
  }
  invalid();
}
export function validateDraft(draft, { recordedBy, supersedes = [] } = {}) {
  if (!draft || !KINDS.includes(draft.kind) || !STATUSES.includes(draft.status)) invalid();
  if (Object.keys(draft).some((key) => !["kind", "status", "title", "body", "sources", "tags", "verification", "applicability", "review", "revisitAfter"].includes(key))) invalid();
  if (typeof draft.title !== "string" || draft.title.length < 1 || draft.title.length > 200 || /[\r\n]/.test(draft.title)) invalid();
  if (typeof draft.body !== "string" || Buffer.byteLength(draft.body) > 32768) invalid();
  if (!Array.isArray(draft.sources ?? []) || draft.sources.length > 20 || !Array.isArray(draft.tags ?? []) || draft.tags?.length > 10) invalid();
  for (const item of draft.sources ?? []) source(item.ref);
  if (!recordedBy || !["human", "claude", "codex", "other"].includes(recordedBy.actor)) invalid();
  if (draft.status === "confirmed" && (!draft.review?.reviewer || (recordedBy.actor !== "human" && supersedes.length === 0))) throw new DevtwinError("APPROVAL_REQUIRED", "Confirmation requires reviewer");
  if (draft.review?.reviewer) assertActorRef(draft.review.reviewer);
  assertNoSensitive(draft.title + "\n" + draft.body);
  if (findForbiddenFields(draft).length) invalid();
  return draft;
}
export function buildRecord({ scope, project, requestId, requestHash, operationId = null, recordedBy, draft, supersedes = [] }, { now = () => new Date() } = {}) {
  assertScopeId(scope); assertProjectId(project, scope);
  validateDraft(draft, { recordedBy, supersedes });
  return { schemaVersion: 1, id: recordIdFor({ scope, project, requestId }), scope, project, kind: draft.kind, status: draft.status, title: draft.title, bodyHash: sha256(draft.body), bodyBytes: Buffer.byteLength(draft.body), sources: draft.sources ?? [], verification: draft.verification ?? [], recordedBy, applicability: { level: draft.applicability?.level ?? "project", branch: draft.applicability?.branch ?? null, commit: draft.applicability?.commit ?? null, worktree: draft.applicability?.worktree ?? null, task: draft.applicability?.task ?? null, environment: draft.applicability?.environment ?? null }, supersedes, review: draft.review ? { reviewer: draft.review.reviewer, receipt: "owner-cli-confirmation", note: draft.review.note ?? "" } : null, revisitAfter: draft.revisitAfter ?? null, requestId, requestHash, operationId, createdAt: now().toISOString() };
}
export function validateRecord(record) {
  if (record.schemaVersion !== 1) throw new DevtwinError("SCHEMA_UNSUPPORTED", "Record schema unsupported");
  if (!record.id || !record.bodyHash || !record.requestHash) invalid();
  return record;
}
export const recordHash = (record) => digest(record);
