import { DevtwinError } from "../errors.mjs";
import { sha256, digest, canonicalJson } from "../storage/canonical.mjs";
import { assertActorRef, assertProjectId, assertScopeId, recordIdFor, personalRecordIdFor, orgRecordIdFor } from "../identity/ids.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { assertNoSensitive, assertNoValueLike, findForbiddenFields } from "./redact.mjs";
export const KINDS = ["brief", "map", "command", "environment", "constraint", "fact", "decision", "experiment", "unknown", "handoff", "lesson", "preference", "retraction"];
// U37 (KTD40): a retraction is the undo of a record. It supersedes the current head of that record's chain and is
// never delivered: the brief, the lesson index, handoffs and the stack match all skip it.
// Only undo writes one (the retraction option of the store writes, which no CLI argument reaches): a retraction from
// any other caller would hide a record that undo cannot bring back.
export const isDelivered = (record) => record.kind !== "retraction";
export const STATUSES = ["proposed", "observed", "confirmed", "disputed"];
export const CLASSES = ["fact", "lesson"];
export const REACHES = ["personal", "project", "org"];
export const MATCH_LIMITS = { paths: 20, packages: 20, topics: 10, commands: 10 };
// U32 (KTD31): a command prefix is one to three lower-case words with no shell operators, such as "git push".
export const COMMAND = /^(?=.{1,64}$)[a-z0-9][a-z0-9._+-]*(?: [a-z0-9][a-z0-9._+-]*){0,2}$/;
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
// Also validates the match block of a hub lesson (src/hubs/read.mjs).
export function validateMatch(value) { return match(value); }
function match(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !(key in MATCH_LIMITS))) invalid();
  const out = {};
  for (const [key, limit] of Object.entries(MATCH_LIMITS)) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > limit || new Set(list).size !== list.length) invalid();
    for (const item of list) {
      if (key === "paths") glob(item);
      else if (key === "commands") { if (typeof item !== "string" || !COMMAND.test(item)) invalid(); }
      else if (typeof item !== "string" || !(key === "packages" ? item.length <= 214 && PACKAGE.test(item) : TOPIC.test(item))) invalid();
    }
    // commands is kept only when given, so records written before U32 keep their canonical bytes.
    if (key !== "commands" || list.length) out[key] = list;
  }
  return out;
}
// U29 (KTD36): an environment record may say where things live: a name, a kind and a place. The place is a
// repo-relative path, a home-relative path (~/), a host name or a named service. It is never an absolute path or a
// parent segment, and never a value: the sensitive and value-like scans refuse it (src/records/redact.mjs).
export const LOCATION_KINDS = ["file", "directory", "host", "service", "secret-store"];
export const LOCATION_LIMIT = 20;
const LOCATION_UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
function locationText(value, max) {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value || LOCATION_UNSAFE.test(value)) invalid();
}
function where(value) {
  locationText(value, 200);
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value) || /^~(?!\/)/.test(value) || /(?:^|\/)\.\.(?:\/|$)/.test(value)) invalid();
  assertNoValueLike(value);
}
export function validateLocations(value) {
  if (!Array.isArray(value) || value.length > LOCATION_LIMIT) invalid();
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((key) => !["name", "kind", "where"].includes(key))) invalid();
    locationText(entry.name, 80);
    if (!LOCATION_KINDS.includes(entry.kind)) invalid();
    where(entry.where);
  }
  if (new Set(value.map((entry) => entry.name)).size !== value.length) invalid();
  return value.map(({ name, kind, where }) => ({ name, kind, where }));
}
// The location text the sensitive, plain-rule and scope-name checks see.
export const locationLines = (locations = []) => locations.flatMap((entry) => [entry.name, entry.where]);
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
// A confirmed record needs a reviewer. Who may write one is the route's tier (src/policy/tiers.mjs): the owner dialog,
// never the caller's actor, which comes from environment variables.
export function validateDraft(draft, { recordedBy, retraction = false } = {}) {
  if (!draft || !KINDS.includes(draft.kind) || !STATUSES.includes(draft.status)) invalid();
  if (draft.kind === "retraction" && !retraction) throw new DevtwinError("INVALID_INPUT", "Only devtwin undo writes a retraction", { field: "kind" });
  if (Object.keys(draft).some((key) => !["kind", "status", "title", "body", "sources", "tags", "verification", "applicability", "review", "revisitAfter", "class", "reach", "match", "locations"].includes(key))) invalid();
  if (typeof draft.title !== "string" || draft.title.length < 1 || draft.title.length > 200 || /[\r\n]/.test(draft.title)) invalid();
  if (typeof draft.body !== "string" || Buffer.byteLength(draft.body) > 32768) invalid();
  if (!Array.isArray(draft.sources ?? []) || (draft.sources ?? []).length > 20 || !Array.isArray(draft.tags ?? []) || (draft.tags ?? []).length > 10) invalid();
  for (const item of draft.sources ?? []) source(item.ref);
  classAndReach(draft.kind, draft.class ?? defaultClass(draft.kind), draftReach(draft));
  if (draft.match !== undefined) match(draft.match);
  if (draft.locations !== undefined && (draft.kind !== "environment" || validateLocations(draft.locations).length === 0)) invalid();
  if (!recordedBy || !["human", "claude", "codex", "other"].includes(recordedBy.actor)) invalid();
  if (draft.status === "confirmed" && !draft.review?.reviewer) throw new DevtwinError("APPROVAL_REQUIRED", "Confirmation requires reviewer");
  if (draft.review?.reviewer) assertActorRef(draft.review.reviewer);
  assertNoSensitive([draft.title, draft.body, ...locationLines(draft.locations)].join("\n"));
  if (findForbiddenFields(draft).length) invalid();
  return draft;
}
// Fields shared by project, personal and org records. The caller supplies the identity fields.
function recordFields({ requestId, requestHash, operationId = null, recordedBy, draft, supersedes = [] }, now) {
  return { kind: draft.kind, class: draft.class ?? defaultClass(draft.kind), reach: draftReach(draft), match: match(draft.match ?? {}), status: draft.status, title: draft.title, bodyHash: sha256(draft.body), bodyBytes: Buffer.byteLength(draft.body), sources: draft.sources ?? [], verification: draft.verification ?? [], recordedBy, applicability: { level: draft.applicability?.level ?? "project", branch: draft.applicability?.branch ?? null, commit: draft.applicability?.commit ?? null, worktree: draft.applicability?.worktree ?? null, task: draft.applicability?.task ?? null, environment: draft.applicability?.environment ?? null }, supersedes, review: draft.review ? { reviewer: draft.review.reviewer, receipt: "owner-cli-confirmation", note: draft.review.note ?? "" } : null, revisitAfter: draft.revisitAfter ?? null, requestId, requestHash, operationId, createdAt: now().toISOString(), ...(draft.locations !== undefined && { locations: validateLocations(draft.locations) }) };
}
export function buildRecord({ scope, project, requestId, requestHash, operationId = null, recordedBy, draft, supersedes = [] }, { now = () => new Date(), retraction = false } = {}) {
  assertScopeId(scope); assertProjectId(project, scope);
  validateDraft(draft, { recordedBy, retraction });
  assertProjectReach(draft);
  return { schemaVersion: 2, id: recordIdFor({ scope, project, requestId }), scope, project, ...recordFields({ requestId, requestHash, operationId, recordedBy, draft, supersedes }, now) };
}
// Personal and org homes. Each home takes one reach and a fixed set of kinds, and never an operation ID.
export const HOME_KINDS = { personal: ["lesson", "preference", "retraction"], org: ["lesson", "retraction"] };
export function assertHomeReach(reach, draft) {
  if (!HOME_KINDS[reach]?.includes(draft?.kind) || draftReach(draft) !== reach) throw new DevtwinError("INVALID_INPUT", "Record reach does not match its home");
}
export function buildHomeRecord({ reach, scope = null, requestId, requestHash, recordedBy, draft, supersedes = [] }, { now = () => new Date(), retraction = false } = {}) {
  validateDraft(draft, { recordedBy, retraction });
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
    if (record.locations !== undefined && (record.kind !== "environment" || record.locations.length === 0 || canonicalJson(validateLocations(record.locations)) !== canonicalJson(record.locations))) invalid();
  } else if (record.locations !== undefined) invalid();
  return record;
}
export const recordHash = (record) => digest(record);
