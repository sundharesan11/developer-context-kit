// U41 (R5, KTD39, KTD41): the held queue. A consented outbound item waits here for its consent's hold time before a
// sender hands it to the existing publish or push path (src/held/send.mjs). One private JSON file per item at
// stateRoot/held/<target dir>/<id>.json (folders 0700, files 0600, exclusive no-follow create under the held lock).
//   target      "hub:<scope>" for a hub lesson; "repo:<sha256 of the repository root>" for a learning-branch push (U30)
//   target dir  the target with ":" replaced by "-" (hub-example, repo-<hex>)
//   item        { schemaVersion: 1, id: "hld_<hex>", target, kind, title, audit, requestId, createdAt, sendAfter,
//                 consent: { kind, holdHours, ruleDigest, grantedAt }, payload, blocked? }
// kind picks the sender; payload is what that sender needs (for "hub-lesson": hubId, scope, author, lessonId, rel,
// content, supersedes). audit is the ID of the audit entry appended before the enqueue (KTD40). The ID comes from the
// target and the request ID, so a retried enqueue finds the same file and writes nothing new. consent.grantedAt is the
// grant the item was queued under: a sender sends it only under that same grant (src/held/send.mjs). blocked
// ({ reason, at }) is the last reason a sender kept the item; the activity digest shows it.
// enqueueHeld sends one notification naming the target and the title; ctx.notifier is the test seam.
import { join } from "node:path";
import { readdirSync, unlinkSync } from "node:fs";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { SCOPE_ID } from "../identity/ids.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { atomicReplace, ensurePrivatePath, fsyncDir, info, readPrivateJson, writeNewFile } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { notify } from "../schedule/notify.mjs";

export const HELD_ID = /^hld_[a-f0-9]{24}$/;
const TARGET = /^(hub):([a-z][a-z0-9-]{1,31})$|^(repo):([a-f0-9]{64})$/;
const DIR = /^(?:hub-[a-z][a-z0-9-]{1,31}|repo-[a-f0-9]{64})$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ITEM_BYTES = 262144, QUEUE_LIMIT = 500;
const KEYS = ["schemaVersion", "id", "target", "kind", "title", "audit", "requestId", "createdAt", "sendAfter", "consent", "payload", "blocked"];

export const heldRoot = (roots) => join(roots.stateRoot, "held");
export const hubTarget = (scope) => "hub:" + scope;
export function assertTarget(target) {
  if (typeof target !== "string" || !TARGET.test(target) || (target.startsWith("hub:") && !SCOPE_ID.test(target.slice(4)))) throw new DevtwinError("INVALID_INPUT", "Invalid held target", { field: "target" });
  return target;
}
export const targetKind = (target) => assertTarget(target).split(":")[0];
const targetDir = (target) => assertTarget(target).replace(":", "-");
const dirTarget = (name) => name.replace("-", ":");
const lockPath = (roots) => join(roots.stateRoot, "locks", "held.lock");
// The held-queue lock. Its place in the backup's lock order (src/backup/archive.mjs) is after the audit lock and
// before the consent lock; nothing here takes the audit or consent lock while it holds this one.
export const withHeldLock = (roots, owner, action) => withPilotLock(roots, lockPath(roots), { kind: owner }, action, { destinations: [heldRoot(roots)] });
export const heldIdFor = (target, requestId) => "hld_" + digest({ target, requestId }).slice(7, 31);
const itemPath = (roots, target, id) => join(heldRoot(roots), targetDir(target), id + ".json");

function checkItem(item) {
  const bad = (field) => { throw new DevtwinError("INTEGRITY", "Held item invalid", { field }); };
  if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !KEYS.includes(key)) || item.schemaVersion !== 1) bad("shape");
  if (!HELD_ID.test(item.id ?? "")) bad("id");
  try { assertTarget(item.target); } catch { bad("target"); }
  if (typeof item.kind !== "string" || !/^[a-z][a-z-]{0,31}$/.test(item.kind)) bad("kind");
  if (typeof item.title !== "string" || !item.title.length || item.title.length > 200) bad("title");
  if (!/^aud_[a-f0-9]{24}$/.test(item.audit ?? "") || !REQUEST_ID.test(item.requestId ?? "")) bad("audit");
  if (!ISO.test(item.createdAt ?? "") || !ISO.test(item.sendAfter ?? "")) bad("time");
  if (!item.consent || typeof item.consent.kind !== "string" || !Number.isInteger(item.consent.holdHours)) bad("consent");
  if (item.consent.grantedAt !== undefined && !ISO.test(item.consent.grantedAt)) bad("consent");
  if (item.blocked !== undefined && (typeof item.blocked?.reason !== "string" || !/^[a-z][a-z-]{0,39}$/.test(item.blocked.reason) || !ISO.test(item.blocked.at ?? ""))) bad("blocked");
  if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) bad("payload");
  return item;
}

// Adds one item and notifies. fields: { target, kind, title, audit, requestId, consent: { kind, holdHours, ruleDigest,
// grantedAt }, payload }. sendAfter is now plus the consent's hold. -> { item, queued, notification }
export async function enqueueHeld(roots, fields, { now = () => new Date(), ctx = {} } = {}) {
  const at = now(), target = assertTarget(fields.target);
  const item = checkItem({ schemaVersion: 1, id: heldIdFor(target, fields.requestId), target, kind: fields.kind, title: fields.title, audit: fields.audit, requestId: fields.requestId,
    createdAt: at.toISOString(), sendAfter: new Date(at.getTime() + fields.consent.holdHours * 3600 * 1000).toISOString(), consent: fields.consent, payload: fields.payload });
  const path = itemPath(roots, target, item.id);
  const written = await withHeldLock(roots, "held-enqueue", async () => {
    assertWritable(roots, [path]);
    if (info(path)) return { item: await readHeld(path), queued: false };
    const dir = ensurePrivatePath(roots.stateRoot, ["held", targetDir(target)]);
    if (listNames(dir).length >= QUEUE_LIMIT) throw new DevtwinError("LIMIT", "Held queue full", { max: QUEUE_LIMIT, target });
    const text = canonicalJson(item) + "\n";
    if (Buffer.byteLength(text) > ITEM_BYTES) throw new DevtwinError("LIMIT", "Held item too large");
    await writeNewFile(path, text);
    fsyncDir(dir);
    return { item, queued: true };
  });
  if (!written.queued) return written;
  const notification = notify(ctx, { title: "devtwin held an item", message: "Held for " + target + ": " + item.title + ". It is sent after " + item.sendAfter + ". devtwin undo cancels it." });
  return { ...written, notification: { shown: notification.shown } };
}

const listNames = (dir) => { try { return readdirSync(dir).filter((n) => n.endsWith(".json") && HELD_ID.test(n.slice(0, -5))); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
async function readHeld(path) {
  const item = checkItem(await readPrivateJson(path, ITEM_BYTES));
  if (item.id + ".json" !== path.split("/").at(-1)) throw new DevtwinError("INTEGRITY", "Held item invalid", { field: "id" });
  return item;
}
// Every held item, or those of one target, oldest sendAfter first. A damaged item fails with INTEGRITY.
export async function listHeld(roots, { target } = {}) {
  let dirs;
  if (target !== undefined) dirs = [targetDir(target)];
  else {
    try { dirs = readdirSync(heldRoot(roots)).filter((n) => DIR.test(n)).sort(); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }
  const items = [];
  for (const dir of dirs) {
    for (const name of listNames(join(heldRoot(roots), dir)).sort()) {
      const item = await readHeld(join(heldRoot(roots), dir, name));
      if (item.target !== dirTarget(dir)) throw new DevtwinError("INTEGRITY", "Held item invalid", { field: "target" });
      items.push(item);
    }
  }
  return items.sort((a, b) => a.sendAfter < b.sendAfter ? -1 : a.sendAfter > b.sendAfter ? 1 : a.id < b.id ? -1 : 1);
}
// The held item an audit entry enqueued, or null.
export async function heldForAudit(roots, auditId) {
  return (await listHeld(roots)).find((item) => item.audit === auditId) ?? null;
}
export async function readHeldItem(roots, target, id) {
  if (!HELD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid held item ID");
  const path = itemPath(roots, target, id);
  return info(path) ? readHeld(path) : null;
}
// Removes one item; false when it was already gone. The caller holds the held lock.
export function removeHeld(roots, target, id) {
  if (!HELD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid held item ID");
  const path = itemPath(roots, target, id);
  assertWritable(roots, [path]);
  const node = info(path);
  if (!node) return false;
  if (!node.isFile()) throw new DevtwinError("PATH_UNSAFE", "Unsafe private path", { path });
  unlinkSync(path);
  fsyncDir(join(heldRoot(roots), targetDir(target)));
  return true;
}
export const isDue = (item, at) => Date.parse(item.sendAfter) <= at.getTime();
async function replaceItem(roots, item) {
  const path = itemPath(roots, item.target, item.id);
  assertWritable(roots, [path]);
  await atomicReplace(path, canonicalJson(checkItem(item)) + "\n");
  return item;
}
// Records why a sender kept an item. The caller holds the held lock. The same reason is not written again.
export async function noteBlocked(roots, target, id, reason, at) {
  const item = await readHeldItem(roots, target, id);
  if (!item || item.blocked?.reason === reason) return item;
  return replaceItem(roots, { ...item, blocked: { reason, at: at.toISOString() } });
}
// learning send for an item kept as "consent-changed": the item goes under the current consent with a new hold, and
// one notification names it. The caller holds the held lock. -> { item, notification }
export async function rearmHeld(roots, item, consent, { now = () => new Date(), ctx = {} } = {}) {
  const at = now(), { blocked, ...rest } = item;
  const next = await replaceItem(roots, { ...rest, consent: { kind: consent.kind, holdHours: consent.holdHours, ruleDigest: consent.ruleDigest, grantedAt: consent.grantedAt },
    sendAfter: new Date(at.getTime() + consent.holdHours * 3600 * 1000).toISOString() });
  const notification = notify(ctx, { title: "devtwin held an item", message: "Held again for " + next.target + ": " + next.title + ". It is sent after " + next.sendAfter + ". devtwin undo cancels it." });
  return { item: next, notification: { shown: notification.shown } };
}
