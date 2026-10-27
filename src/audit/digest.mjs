// U37 (R3, KTD40): the activity digest, read from the audit log. `activity [--since <time>] [--held]` is read-only. It
// lists what devtwin learned (each knowledge write: entry ID, time, route, target, record IDs, caller and whether it
// landed), what it holds for sending and what waits for the owner. The weekly job (src/schedule/jobs.mjs) sends one
// notification with the counts. Held and waiting items come from later units, which register a source here.
import { DevtwinError } from "../errors.mjs";
import { readAudit, landed, undoneMap } from "./log.mjs";

const WEEK_MS = 7 * 86400000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
// kind -> async (roots, { sinceMs, full }) => items. held: items waiting in the held queue (full: true adds their text).
// waiting: items that wait for the owner's weekly activity review.
const SOURCES = { held: [], waiting: [] };
export function registerActivitySource(kind, read) {
  if (!Object.hasOwn(SOURCES, kind) || typeof read !== "function") throw new DevtwinError("INVALID_INPUT", "Invalid activity source", { kind });
  SOURCES[kind].push(read);
}
async function collect(roots, kind, options) {
  const out = [];
  for (const read of SOURCES[kind]) out.push(...await read(roots, options));
  return out;
}
export function sinceMs(since, now) {
  if (since === undefined || since === null) return now().getTime() - WEEK_MS;
  const ms = typeof since === "string" && ISO_TIME.test(since) ? Date.parse(since) : NaN;
  if (Number.isNaN(ms)) throw new DevtwinError("INVALID_INPUT", "Invalid time; use an ISO time such as 2026-10-01T00:00:00Z", { field: "since" });
  return ms;
}
export async function activity(roots, { since, held = false } = {}, { now = () => new Date() } = {}) {
  const from = sinceMs(since, now);
  const { entries, warnings } = await readAudit(roots);
  const done = undoneMap(roots, entries);
  const recent = entries.filter((e) => Date.parse(e.at) >= from);
  const learned = recent.filter((e) => e.kind !== "undo").map((e) => ({ id: e.id, at: e.at, kind: e.kind, tier: e.tier, route: e.route, target: e.target, scope: e.scope, project: e.project,
    recordIds: e.recordIds, actor: e.actor, session: e.session, landed: landed(roots, e), undoneBy: done.get(e.id)?.id ?? null }));
  const undos = recent.filter((e) => e.kind === "undo").map((e) => ({ id: e.id, at: e.at, undoes: e.undoes, tier: e.tier, recordIds: e.recordIds, actor: e.actor, session: e.session, landed: landed(roots, e) }));
  const heldItems = await collect(roots, "held", { sinceMs: from, full: held }), waiting = await collect(roots, "waiting", { sinceMs: from, full: false });
  const counts = { learned: learned.length, neverLanded: learned.filter((e) => !e.landed).length, undone: learned.filter((e) => e.undoneBy).length, held: heldItems.length, waiting: waiting.length };
  const window = new Date(from).toISOString();
  if (held) return { since: window, counts, held: heldItems, warnings };
  return { since: window, counts, learned, undos, held: heldItems, waiting, warnings };
}
// The weekly notification text: counts only.
export const weeklyMessage = (counts) => "This week devtwin learned " + counts.learned + (counts.learned === 1 ? " item" : " items") + ", holds " + counts.held + " for sending and has " + counts.waiting + " waiting for you. Run devtwin activity to see them.";
