import { DevtwinError } from "../errors.mjs";
import { RECORD_ID, assertActorRef } from "../identity/ids.mjs";
import { KINDS, STATUSES } from "../records/schema.mjs";
import { assertNoSensitive } from "../records/redact.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { sha256 } from "../storage/canonical.mjs";

export const HASH = /^sha256:[a-f0-9]{64}$/;
export const COMMIT = /^[a-f0-9]{7,64}$/;
const TRIPWIRES = [
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\//i,
  /\b(?:mailto|data|javascript|vbscript):\S/i,
  /\bfile:(?:\/|[A-Za-z]:[\\/])/i,
  /(^|[\s(<"'`=])\/\S/u,
  /~(?:[A-Za-z0-9._-]+)?[\\/]/u,
  /[A-Za-z]:[\\/]/u,
  /\\\\[^\\\s]+\\/u,
  /[\w.-]+@[\w.-]+:[\w./~-]/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  /\b(?:email|github|slack|linear|handle):[A-Za-z0-9._@+-]+/i
];
export function unsafe() { throw new DevtwinError("HANDOFF_UNSAFE", "Selected evidence is not portable"); }
export function assertPortableText(text) {
  if (typeof text !== "string") unsafe();
  assertNoSensitive(text);
  if (TRIPWIRES.some((pattern) => pattern.test(text))) unsafe();
}
export function canonicalTime(value, dateOnly = false) {
  if (typeof value !== "string") unsafe();
  const instant = dateOnly && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value + "T00:00:00.000Z" : value;
  try { if (new Date(instant).toISOString() !== instant) unsafe(); } catch { unsafe(); }
  return instant;
}
function scanExtra(value, depth = 0) {
  if (depth > 8) unsafe();
  if (typeof value === "string") assertPortableText(value);
  else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { assertPortableText(key); scanExtra(child, depth + 1); }
}
function sourceProjection(source, projected) {
  if (!source || typeof source !== "object" || Array.isArray(source)) unsafe();
  if (projected && source.kind === "user" && source.recorded === true && Object.keys(source).length === 2) return { kind: "user", recorded: true };
  const ref = source.ref;
  if (typeof ref !== "string") unsafe();
  assertNoSensitive(ref);
  for (const [key, value] of Object.entries(source)) if (!["ref", "sha256", "revision"].includes(key)) scanExtra({ [key]: value });
  if (ref.startsWith("user:")) {
    if (projected) unsafe();
    try { assertActorRef(ref.slice(5)); } catch { unsafe(); }
    // Even withheld refs must not smuggle unsafe extra provenance.
    for (const value of [source.sha256, source.revision]) if (value != null) assertPortableText(value);
    return { kind: "user", recorded: true };
  }
  if (ref.startsWith("file:")) {
    try { assertSourceRel(ref.slice(5)); if (isDeniedRel(ref.slice(5))) unsafe(); } catch { unsafe(); }
    assertPortableText(ref.slice(5));
  } else if (!/^commit:[a-f0-9]{7,64}$/.test(ref) && !/^record:rec_[a-f0-9]{24}$/.test(ref) && !/^issue:[A-Z]+-[0-9]+$/.test(ref)) unsafe();
  if (source.sha256 != null && !HASH.test(source.sha256) || source.revision != null && !COMMIT.test(source.revision)) unsafe();
  return { ref, sha256: source.sha256 ?? null, revision: source.revision ?? null };
}
// The second argument is internal: render validates the already projected shape too.
export function portableRecord(record, { projected = false } = {}) {
  if (!record || !RECORD_ID.test(record.id) || !HASH.test(record.recordHash) || !HASH.test(record.bodyHash) || !KINDS.includes(record.kind) || !STATUSES.includes(record.status) || record.status === "proposed" || record.effective !== record.status) unsafe();
  if (typeof record.title !== "string" || !record.title.length || record.title.length > 200 || /[\r\n]/.test(record.title)) unsafe();
  assertPortableText(record.title); assertPortableText(record.body);
  const bodyBytes = Buffer.byteLength(record.body), bodyEndsWithLF = record.body.endsWith("\n");
  if (sha256(record.body) !== record.bodyHash || bodyBytes !== record.bodyBytes || projected && bodyEndsWithLF !== record.bodyEndsWithLF) unsafe();
  canonicalTime(record.createdAt);
  if (record.revisitAfter != null) canonicalTime(record.revisitAfter, true);
  const by = record.recordedBy;
  if (!by || !["human", "claude", "codex", "other"].includes(by.actor) || !/^run_[a-z0-9_-]{8,64}$/.test(by.runId)) unsafe();
  let review = null;
  if (record.review != null) {
    if (projected) {
      if (record.review.reviewerRecorded !== true || record.review.receipt !== "owner-cli-confirmation" || Object.keys(record.review).some((key) => !["reviewerRecorded", "receipt"].includes(key))) unsafe();
    } else {
      try { assertActorRef(record.review.reviewer); } catch { unsafe(); }
      assertNoSensitive(record.review.reviewer);
      if (record.review.receipt !== "owner-cli-confirmation") unsafe();
    }
    review = { reviewerRecorded: true, receipt: "owner-cli-confirmation" };
  }
  if (record.status === "confirmed" && !review) unsafe();
  const app = record.applicability;
  if (!app || !["project", "branch", "commit", "worktree", "task", "environment"].includes(app.level)) unsafe();
  if (app.branch != null) assertPortableText(app.branch);
  if (app.commit != null && !COMMIT.test(app.commit)) unsafe();
  if (!Array.isArray(record.sources) || record.sources.length > 20) unsafe();
  return {
    id: record.id, recordHash: record.recordHash, bodyHash: record.bodyHash, bodyBytes, bodyEndsWithLF,
    title: record.title, body: record.body, kind: record.kind, status: record.status, effective: record.effective,
    createdAt: record.createdAt, recordedBy: { actor: by.actor, runId: by.runId }, review,
    revisitAfter: record.revisitAfter ?? null,
    applicability: { level: app.level, branch: app.branch ?? null, commit: app.commit ?? null },
    sources: record.sources.map((source) => sourceProjection(source, projected))
  };
}
const SAFE_CODES = new Set(["INVALID_INPUT", "INVALID_ID", "LIMIT", "HANDOFF_UNSAFE", "SENSITIVE_CONTENT", "GATE_REQUIRED", "PATH_UNSAFE", "PATH_ESCAPE", "PROJECT_UNBOUND", "RECORD_NOT_EXPORTABLE", "INTEGRITY", "RECOVERY_REQUIRED", "SOURCE_CHANGED", "CONFLICT", "GIT_UNAVAILABLE", "STORAGE_ERROR", "SCHEMA_UNSUPPORTED"]);
export function handoffError(error) {
  const code = error instanceof DevtwinError ? error.code.replace(/^DEVTWIN_/, "") : "STORAGE_ERROR";
  const message = "Portable handoff held; inspect selected evidence and pilot locally";
  // Corrupt-record IDs are opaque hashes; pass them through so an operator can find the record.
  const ids = code === "INTEGRITY" ? error.details?.records : null;
  if (Array.isArray(ids) && ids.length && ids.every((id) => typeof id === "string" && RECORD_ID.test(id))) return new DevtwinError(code, message + "; corrupt records: " + ids.slice(0, 5).join(", ") + (ids.length > 5 ? ", ..." : ""), { records: ids });
  return new DevtwinError(SAFE_CODES.has(code) ? code : "STORAGE_ERROR", message);
}
