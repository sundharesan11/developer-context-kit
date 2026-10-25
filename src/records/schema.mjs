import { DevtwinError } from "../errors.mjs";
import { sha256, digest, canonicalJson } from "../storage/canonical.mjs";
import { assertActorRef, assertProjectId, assertScopeId, recordIdFor, personalRecordIdFor, orgRecordIdFor } from "../identity/ids.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { assertNoSensitive, findForbiddenFields } from "./redact.mjs";
export const KINDS = ["brief", "map", "command", "environment", "constraint", "fact", "decision", "experiment", "unknown", "handoff", "lesson", "preference"];
export const STATUSES = ["proposed", "observed", "confirmed", "disputed"];
export const CLASSES = ["fact", "lesson"];
export const REACHES = ["personal", "project", "org"];
export const MATCH_LIMITS = { paths: 20, packages: 20, topics: 10 };
const GLOB = /^[A-Za-z0-9._\/*?-]{1,200}$/;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,47}$/;
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
// Globs follow the file: source rules. Wildcards are replaced so the deny rules see a plain path.
function glob(value) {
  if (typeof value !== "string" || !GLOB.test(value)) invalid();
  const plain = value.replace(/[*?]/g, "x");
  try { assertSourceRel(plain); if (isDeniedRel(plain)) invalid(); } catch { invalid(); }
}
function match(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !(key in MATCH_LIMITS))) invalid();
  const out = {};
  for (const [key, limit] of Object.entries(MATCH_LIMITS)) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > limit || new Set(list).size !== list.length) invalid();
    for (const item of list) {
      if (key === "paths") glob(item);
      else if (typeof item !== "string" || !(key === "packages" ? item.length <= 214 && PACKAGE.test(item) : TOPIC.test(item))) invalid();
    }
    out[key] = list;
  }
  return out;
}
const defaultClass = (kind) => kind === "lesson" || kind === "preference" ? "lesson" : "fact";
const defaultReach = (kind) => kind === "preference" ? "personal" : "project";
// A fact stays in its project. A lesson kind is never a fact. A preference follows the developer, so it never has project reach.
function classAndReach(kind, cls, reach) {
  if (!CLASSES.includes(cls) || !REACHES.includes(reach)) invalid();
  if (cls === "fact" && reach !== "project" || kind === "lesson" && cls !== "lesson" || kind === "preference" && reach === "project") invalid();
}
export function draftReach(draft) { return draft.reach ?? defaultReach(draft.kind); }
// The project store holds project reach only. Personal and org records get their own homes.
export function assertProjectReach(draft) { if (draftReach(draft) !== "project") throw new DevtwinError("INVALID_INPUT", "Project records need project reach"); }
export function validateDraft(draft, { recordedBy, supersedes = [] } = {}) {
  if (!draft || !KINDS.includes(draft.kind) || !STATUSES.includes(draft.status)) invalid();
  if (Object.keys(draft).some((key) => !["kind", "status", "title", "body", "sources", "tags", "verification", "applicability", "review", "revisitAfter", "class", "reach", "match"].includes(key))) invalid();
  if (typeof draft.title !== "string" || draft.title.length < 1 || draft.title.length > 200 || /[\r\n]/.test(draft.title)) invalid();
  if (typeof draft.body !== "string" || Buffer.byteLength(draft.body) > 32768) invalid();
  if (!Array.isArray(draft.sources ?? []) || draft.sources.length > 20 || !Array.isArray(draft.tags ?? []) || draft.tags?.length > 10) invalid();
  for (const item of draft.sources ?? []) source(item.ref);
  classAndReach(draft.kind, draft.class ?? defaultClass(draft.kind), draftReach(draft));
  if (draft.match !== undefined) match(draft.match);
  if (!recordedBy || !["human", "claude", "codex", "other"].includes(recordedBy.actor)) invalid();
  if (draft.status === "confirmed" && (!draft.review?.reviewer || (recordedBy.actor !== "human" && supersedes.length === 0))) throw new DevtwinError("APPROVAL_REQUIRED", "Confirmation requires reviewer");
  if (draft.review?.reviewer) assertActorRef(draft.review.reviewer);
  assertNoSensitive(draft.title + "\n" + draft.body);
  if (findForbiddenFields(draft).length) invalid();
  return draft;
}
// Fields shared by project, personal and org records. The caller supplies the identity fields.
function recordFields({ requestId, requestHash, operationId = null, recordedBy, draft, supersedes = [] }, now) {
  return { kind: draft.kind, class: draft.class ?? defaultClass(draft.kind), reach: draftReach(draft), match: match(draft.match ?? {}), status: draft.status, title: draft.title, bodyHash: sha256(draft.body), bodyBytes: Buffer.byteLength(draft.body), sources: draft.sources ?? [], verification: draft.verification ?? [], recordedBy, applicability: { level: draft.applicability?.level ?? "project", branch: draft.applicability?.branch ?? null, commit: draft.applicability?.commit ?? null, worktree: draft.applicability?.worktree ?? null, task: draft.applicability?.task ?? null, environment: draft.applicability?.environment ?? null }, supersedes, review: draft.review ? { reviewer: draft.review.reviewer, receipt: "owner-cli-confirmation", note: draft.review.note ?? "" } : null, revisitAfter: draft.revisitAfter ?? null, requestId, requestHash, operationId, createdAt: now().toISOString() };
}
export function buildRecord({ scope, project, requestId, requestHash, operationId = null, recordedBy, draft, supersedes = [] }, { now = () => new Date() } = {}) {
  assertScopeId(scope); assertProjectId(project, scope);
  validateDraft(draft, { recordedBy, supersedes });
  assertProjectReach(draft);
  return { schemaVersion: 2, id: recordIdFor({ scope, project, requestId }), scope, project, ...recordFields({ requestId, requestHash, operationId, recordedBy, draft, supersedes }, now) };
}
// Personal and org homes. Each home takes one reach and a fixed set of kinds, and never an operation ID.
export const HOME_KINDS = { personal: ["lesson", "preference"], org: ["lesson"] };
export function assertHomeReach(reach, draft) {
  if (!HOME_KINDS[reach]?.includes(draft?.kind) || draftReach(draft) !== reach) throw new DevtwinError("INVALID_INPUT", "Record reach does not match its home");
}
export function buildHomeRecord({ reach, scope = null, requestId, requestHash, recordedBy, draft, supersedes = [] }, { now = () => new Date() } = {}) {
  validateDraft(draft, { recordedBy, supersedes });
  assertHomeReach(reach, draft);
  const id = reach === "org" ? orgRecordIdFor({ scope, requestId }) : personalRecordIdFor({ requestId });
  return { schemaVersion: 2, id, scope: reach === "org" ? scope : null, project: null, ...recordFields({ requestId, requestHash, recordedBy, draft, supersedes }, now) };
}
// Readers accept v1 and v2. A v1 record is returned as stored and never rewritten.
export function validateRecord(record) {
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) throw new DevtwinError("SCHEMA_UNSUPPORTED", "Record schema unsupported");
  if (!record.id || !record.bodyHash || !record.requestHash) invalid();
  if (record.schemaVersion === 2) {
    if (!KINDS.includes(record.kind)) invalid();
    classAndReach(record.kind, record.class, record.reach);
    if (canonicalJson(match(record.match)) !== canonicalJson(record.match)) invalid();
  }
  return record;
}
export const recordHash = (record) => digest(record);
