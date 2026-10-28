import { constants, closeSync, fstatSync, openSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readPrivateJson, readPrivateText, ensurePrivatePath, atomicReplace, checkNode, info } from "../storage/fsx.mjs";
// U7: per-session hook state and the budget meter (KTD17, KTD22, KTD23). A session is one agent session ID. State is
// one small file per session, written by atomic replace and with no pilot lock. Two hook calls in the same session at
// the same time can both read the old state; the later write wins, and a lesson can then arrive twice.
const SESSION_BYTES = 65536, MAX_DELIVERED = 512;
const LOG_ROTATE_BYTES = 4 << 20, LOG_READ_BYTES = 8 << 20;
const SESSION_MAX_AGE_MS = 14 * 24 * 3600 * 1000, TEMP_MAX_AGE_MS = 3600 * 1000;
const KEY = /^[a-f0-9]{64}$/, STATE_FILE = /^[a-f0-9]{64}(?:\.notes)?\.json$/, TEMP = /^\.devtwin-[a-f0-9]{16}\.tmp$/;
export const hooksDir = (stateRoot) => join(stateRoot, "hooks");
export const sessionsDir = (stateRoot) => join(stateRoot, "hooks", "sessions");
export const budgetLogPath = (stateRoot) => join(stateRoot, "hooks", "budget.jsonl");
export const hookLogPath = (stateRoot) => join(stateRoot, "hooks", "hook.log");
export const sessionKey = (agent, sessionId) => createHash("sha256").update(agent + "\0" + sessionId).digest("hex");
const sessionPath = (stateRoot, key) => join(sessionsDir(stateRoot), key + ".json");
// U13: the session's note state sits in its own file, <key>.notes.json, so compaction (which removes <key>.json) does
// not reset the six-note cap.
const noteStatePath = (stateRoot, key) => join(sessionsDir(stateRoot), key + ".notes.json");
const MAX_NOTE_AREAS = 256, MAX_REPORTED = 64;
const strings = (list, max) => Array.isArray(list) && list.length <= max && list.every((x) => typeof x === "string");
const validNotes = (s, agent) => s?.schemaVersion === 1 && s.agent === agent && Number.isInteger(s.posted) && s.posted >= 0 && strings(s.areas, MAX_NOTE_AREAS) && strings(s.reported, MAX_REPORTED);
// The note state, a fresh one when none exists, or null for a damaged file (the caller then posts and reports nothing).
export async function readNoteState(stateRoot, agent, key) {
  try {
    const state = await readPrivateJson(noteStatePath(stateRoot, key), SESSION_BYTES);
    return validNotes(state, agent) ? state : null;
  } catch (error) { return error.code === "ENOENT" ? { schemaVersion: 1, agent, posted: 0, areas: [], reported: [] } : null; }
}
export async function writeNoteState(stateRoot, key, state, now) {
  ensurePrivatePath(stateRoot, ["hooks", "sessions"]);
  await atomicReplace(noteStatePath(stateRoot, key), JSON.stringify({ ...state, areas: state.areas.slice(-MAX_NOTE_AREAS), reported: state.reported.slice(-MAX_REPORTED), updatedAt: now.toISOString() }) + "\n");
}
const fresh = (agent) => ({ schemaVersion: 1, agent, delivered: [], lines: 0, overflowed: false });
const valid = (s, agent) => s?.schemaVersion === 1 && s.agent === agent && Array.isArray(s.delivered) && s.delivered.length <= MAX_DELIVERED && s.delivered.every((id) => typeof id === "string") && Number.isInteger(s.lines) && s.lines >= 0 && typeof s.overflowed === "boolean";
// The session state, a fresh state when none exists, or { corrupt: true } for a damaged file (such as one cut short
// when a run was killed). The caller removes a corrupt file and emits nothing for that event.
export async function readSession(stateRoot, agent, key) {
  try {
    const state = await readPrivateJson(sessionPath(stateRoot, key), SESSION_BYTES);
    return valid(state, agent) ? state : { corrupt: true };
  } catch (error) { return error.code === "ENOENT" ? fresh(agent) : { corrupt: true }; }
}
export async function writeSession(stateRoot, key, state, now) {
  ensurePrivatePath(stateRoot, ["hooks", "sessions"]);
  await atomicReplace(sessionPath(stateRoot, key), JSON.stringify({ ...state, delivered: state.delivered.slice(-MAX_DELIVERED), updatedAt: now.toISOString() }) + "\n");
}
// Compaction resets dedupe and the cap: the session file goes, and the next event starts from a fresh state.
// It returns whether a file was there, so one compaction seen by several events is counted once.
export function removeSession(stateRoot, key) {
  try { unlinkSync(sessionPath(stateRoot, key)); return true; } catch (error) { if (error.code !== "ENOENT") throw error; return false; }
}
// Session files (lesson and note state) untouched for 14 days and temp files left by a killed write more than an hour ago are removed.
export function pruneSessions(stateRoot, now) {
  const dir = sessionsDir(stateRoot);
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const limit = TEMP.test(name) ? TEMP_MAX_AGE_MS : STATE_FILE.test(name) ? SESSION_MAX_AGE_MS : null;
    if (limit === null) continue;
    const node = info(join(dir, name));
    if (node?.isFile() && now.getTime() - node.mtimeMs > limit) { try { unlinkSync(join(dir, name)); removed++; } catch { /* Another call removed it. */ } }
  }
  return removed;
}
// One JSON line appended to a private log. O_APPEND keeps concurrent lines whole. A log over 4 MiB moves to
// <name>.1 first, replacing the older one, so the meter keeps about two files of history. The hooks folder must
// already exist: `hook verify` creates it, so a hook with no receipt never creates folders under a stateRoot.
function appendLine(stateRoot, path, value) {
  const dir = info(hooksDir(stateRoot));
  if (!dir) return;
  checkNode(dir, hooksDir(stateRoot), { directory: true });
  const current = info(path);
  if (current?.isFile() && current.size > LOG_ROTATE_BYTES) renameSync(path, path + ".1");
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { checkNode(fstatSync(fd), path); writeSync(fd, JSON.stringify(value) + "\n"); } finally { closeSync(fd); }
}
// Logged per injection: no prompt text, command text, path or lesson text, only counts and the delivered lesson IDs.
export function logBudget(stateRoot, entry) { appendLine(stateRoot, budgetLogPath(stateRoot), entry); }
// Hook failures, as error codes only. Logging itself never throws into the hook.
export function logHook(stateRoot, entry) { try { appendLine(stateRoot, hookLogPath(stateRoot), entry); } catch { /* Fail open. */ } }
async function readLog(path) {
  try { return (await readPrivateText(path, LOG_READ_BYTES)).split("\n").filter(Boolean); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
const blank = () => ({ events: 0, bytes: 0, lines: 0, overflow: 0, compactions: 0 });
function add(total, e) {
  if (e.event === "compact") { total.compactions++; return; }
  total.events++; total.bytes += e.bytes; total.lines += e.lines; total.overflow += e.overflow;
}
// U21: the time each lesson was last delivered, from the budget log and its rotated copy. A damaged line is skipped.
export async function lastDelivered(stateRoot) {
  const path = budgetLogPath(stateRoot), out = new Map();
  for (const row of [...await readLog(path + ".1"), ...await readLog(path)]) {
    let e;
    try { e = JSON.parse(row); } catch { continue; }
    if (typeof e?.at !== "string" || !Array.isArray(e.lessons)) continue;
    for (const id of e.lessons) if (typeof id === "string" && !(out.get(id) > e.at)) out.set(id, e.at);
  }
  return out;
}
// Totals per session and per agent from the budget log and its rotated copy. A damaged line is counted as skipped.
export async function budgetReport(stateRoot) {
  const path = budgetLogPath(stateRoot);
  const rows = [...await readLog(path + ".1"), ...await readLog(path)];
  const sessions = new Map(), agents = {}, totals = blank();
  let skipped = 0;
  for (const row of rows) {
    let e;
    try { e = JSON.parse(row); } catch { skipped++; continue; }
    if (!KEY.test(e?.session ?? "") || typeof e.agent !== "string" || typeof e.event !== "string" || ![e.bytes, e.lines, e.overflow].every((n) => Number.isInteger(n) && n >= 0)) { skipped++; continue; }
    if (!sessions.has(e.session)) sessions.set(e.session, { session: e.session, agent: e.agent, first: e.at, last: e.at, ...blank() });
    const s = sessions.get(e.session);
    s.last = e.at;
    add(s, e); add(agents[e.agent] ??= blank(), e); add(totals, e);
  }
  return { sessions: [...sessions.values()], agents, totals: { sessions: sessions.size, ...totals }, skipped };
}
