// U37 (KTD40): the audit log, the source of the activity digest and of undo. Each knowledge write appends one entry to
// stateRoot/audit/<yyyy-mm>.jsonl (folder 0700, file 0600) under the audit lock, before the write itself. The entry is
// keyed by the write's request ID, so a retry of the same write reuses its entry, and a crash between the entry and
// the write leaves an entry that activity reports as never landed. There is no second "landed" line: an entry has
// landed when every record it names exists (landed below).
//
// An entry holds IDs, routes, tiers and the caller, never body text or titles:
//   { schemaVersion: 1, id: "aud_<hex>", at, kind, tier, route, target, home, scope, project, recordIds, supersedes,
//     itemIds, sourceHash, actor, session, requestId, undoes, state: "intent" }
// kind is what undo dispatches on (src/audit/undo.mjs): "record" for a record write, "undo" for an undo. home is where
// the records live (project, personal or org); supersedes lists the records the write replaced.
//
// KTD43: an agent session (by --session) makes at most SESSION_CAP automatic knowledge writes; later ones wait for the
// weekly activity review. Writes with no --session count in one bucket per caller and UTC day (actor:<actor>:<date>)
// with the same cap, so leaving out --session does not lift it. Fresh --session values do not lift it either: each caller
// makes at most DAY_CAP automatic writes per UTC day across all its sessions (bucket day:<actor>:<date>). Whichever
// limit is reached first refuses, and the error names that bucket. Undo entries do not count.
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { openSync, closeSync, fstatSync, writeSync, fsyncSync, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { checkNode, ensurePrivatePath, info, readPrivateText } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { RECORD_ID } from "../identity/ids.mjs";
import { TIERS } from "../policy/tiers.mjs";
import { ACTORS } from "../policy/actor.mjs";
import { SESSION_ID } from "../lessons/propose.mjs";
import { projectRecordFile } from "../records/store.mjs";
import { homeRecordFile } from "../records/personal.mjs";

export const AUDIT_ID = /^aud_[a-f0-9]{24}$/;
export const SESSION_CAP = 20, DAY_CAP = 100;
export const HOMES = Object.freeze(["project", "personal", "org"]);
const MONTH = /^\d{4}-\d{2}\.jsonl$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const KIND = /^[a-z][a-z-]{0,31}$/, MONTH_BYTES = 16 << 20;
const FIELDS = ["kind", "tier", "route", "target", "home", "scope", "project", "recordIds", "supersedes", "itemIds", "sourceHash", "actor", "session", "requestId", "undoes"];
export const auditDir = (roots) => join(roots.stateRoot, "audit");
const lockPath = (roots) => join(roots.stateRoot, "locks", "audit.lock");
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid audit entry", { field }); };

const ids = (list, pattern) => Array.isArray(list) && list.length <= 50 && list.every((x) => typeof x === "string" && pattern.test(x));
const text = (value, max = 200) => value === null || (typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value));
// The fields a writer gives, checked before anything is written. Body text has no field to go in.
function cleanFields(fields) {
  if (!fields || typeof fields !== "object" || Object.keys(fields).some((key) => !FIELDS.includes(key))) invalid("fields");
  const entry = { kind: fields.kind, tier: fields.tier, route: fields.route, target: fields.target ?? null, home: fields.home ?? null, scope: fields.scope ?? null, project: fields.project ?? null,
    recordIds: fields.recordIds ?? [], supersedes: fields.supersedes ?? [], itemIds: fields.itemIds ?? [], sourceHash: fields.sourceHash ?? null, actor: fields.actor, session: fields.session ?? null,
    requestId: fields.requestId, undoes: fields.undoes ?? null };
  if (typeof entry.kind !== "string" || !KIND.test(entry.kind)) invalid("kind");
  if (!TIERS.includes(entry.tier)) invalid("tier");
  if (typeof entry.route !== "string" || !text(entry.route, 64)) invalid("route");
  if (!text(entry.target, 64)) invalid("target");
  if (entry.home !== null && !HOMES.includes(entry.home)) invalid("home");
  if (!text(entry.scope, 128) || !text(entry.project, 256)) invalid("scope");
  if (!ids(entry.recordIds, RECORD_ID) || !ids(entry.supersedes, RECORD_ID)) invalid("recordIds");
  if (!ids(entry.itemIds, /^[a-z]{2,8}_[A-Za-z0-9]{8,64}$/)) invalid("itemIds");
  if (entry.sourceHash !== null && !/^sha256:[a-f0-9]{64}$/.test(entry.sourceHash)) invalid("sourceHash");
  if (![...ACTORS, "other"].includes(entry.actor)) invalid("actor");
  if (entry.session !== null && (typeof entry.session !== "string" || !SESSION_ID.test(entry.session))) invalid("session");
  if (typeof entry.requestId !== "string" || !REQUEST_ID.test(entry.requestId)) invalid("requestId");
  if (entry.undoes !== null && !AUDIT_ID.test(entry.undoes)) invalid("undoes");
  return entry;
}
function validEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1 || !AUDIT_ID.test(value.id ?? "") || typeof value.at !== "string" || !ISO.test(value.at) || value.state !== "intent") return null;
  const { schemaVersion, id, at, state, ...fields } = value;
  try { return { schemaVersion, id, at, ...cleanFields(fields), state }; } catch { return null; }
}

// Every readable entry, oldest first, with a warning for each unreadable month file or line. Nothing is repaired.
export async function readAudit(roots) {
  let names;
  try { names = (await readdir(auditDir(roots))).filter((name) => MONTH.test(name)).sort(); }
  catch (error) { if (error.code === "ENOENT") return { entries: [], warnings: [] }; throw error; }
  const entries = [], warnings = [], seen = new Set();
  for (const file of names) {
    let body;
    try { body = await readPrivateText(join(auditDir(roots), file), MONTH_BYTES); }
    catch (error) { warnings.push({ file, code: error.code ?? "DEVTWIN_INTERNAL" }); continue; }
    body.split("\n").forEach((line, i) => {
      if (!line) return;
      let entry = null;
      try { entry = validEntry(JSON.parse(line)); } catch { entry = null; }
      if (!entry || seen.has(entry.id)) { warnings.push({ file, line: i + 1, code: "DEVTWIN_INTEGRITY" }); return; }
      seen.add(entry.id);
      entries.push(entry);
    });
  }
  entries.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return { entries, warnings };
}
// O_APPEND keeps a line whole; the file must be the private file this user owns.
function appendLine(path, value) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { checkNode(fstatSync(fd), path); writeSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
// The cap bucket of an entry: its session, or its caller and UTC day when it has none.
const capBucket = (entry, at) => entry.session ? "session:" + entry.session : "actor:" + entry.actor + ":" + at.slice(0, 10);
// The day bucket: every automatic write by this caller on this UTC day, whatever its session.
const dayBucket = (entry, at) => "day:" + entry.actor + ":" + at.slice(0, 10);
// Appends the intent entry for one write and returns it. A second call for the same route and request ID returns the
// first entry and appends nothing. cap: false skips the session cap (undo entries).
export async function appendEntry(roots, fields, { now = () => new Date(), cap = true } = {}) {
  const clean = cleanFields(fields);
  const at = now().toISOString(), path = join(auditDir(roots), at.slice(0, 7) + ".jsonl");
  return withPilotLock(roots, lockPath(roots), { kind: "audit" }, async () => {
    const { entries } = await readAudit(roots);
    const same = entries.find((e) => e.route === clean.route && e.requestId === clean.requestId);
    if (same) return same;
    if (cap && clean.tier === "automatic" && clean.kind !== "undo") {
      const bucket = capBucket(clean, at);
      const used = new Set(entries.filter((e) => e.kind !== "undo" && capBucket(e, e.at) === bucket).map((e) => e.requestId)).size;
      if (used >= SESSION_CAP) throw new DevtwinError("GATE_REQUIRED", "This session already made " + SESSION_CAP + " automatic writes; later ones wait for the weekly activity review", { session: clean.session, bucket, max: SESSION_CAP, via: "activity review" });
      const day = dayBucket(clean, at);
      const today = new Set(entries.filter((e) => e.kind !== "undo" && e.tier === "automatic" && dayBucket(e, e.at) === day).map((e) => e.requestId)).size;
      if (today >= DAY_CAP) throw new DevtwinError("GATE_REQUIRED", "This caller already made " + DAY_CAP + " automatic writes today; later ones wait for the weekly activity review", { session: clean.session, bucket: day, max: DAY_CAP, via: "activity review" });
    }
    const entry = { schemaVersion: 1, id: "aud_" + randomBytes(12).toString("hex"), at, ...clean, state: "intent" };
    ensurePrivatePath(roots.stateRoot, ["audit"]);
    appendLine(path, entry);
    return entry;
  }, { destinations: [path] });
}
// Where one of an entry's records lands.
export function recordFile(roots, entry, id) {
  return entry.home === "project" ? projectRecordFile(roots, entry.scope, entry.project, id) : homeRecordFile(roots, entry.home, entry.scope, id);
}
// An entry has landed when every record it names exists. An entry with no records (a later held or outbound kind)
// has landed by definition here; its own kind reports more.
export function landed(roots, entry) {
  try { return entry.recordIds.every((id) => info(recordFile(roots, entry, id))?.isFile() === true); } catch { return false; }
}
// The landed undo entry for each undone entry ID. An undo whose own write never landed does not count, so it can run again.
export function undoneMap(roots, entries) {
  const out = new Map();
  for (const e of entries) if (e.kind === "undo" && e.undoes && landed(roots, e)) out.set(e.undoes, e);
  return out;
}
