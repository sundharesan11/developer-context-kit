// U36 (KTD39): standing consents, one per kind and target, at stateRoot/consents/<kind>/<sha256 of target>.json
// (folders 0700, files 0600, atomic replace under the consent lock). A consent lets agents and jobs run a consented
// action for that target with no owner dialog (src/policy/tiers.mjs).
//   repo-push    target: the real path of a bound repository root; push a learning branch to it
//   hub-publish  target: a scope with a hub binding; publish a lesson to its hub
// Each record keeps the rule digest of the rules it was granted under. When the rules change (another check, another
// hold time, a learnings folder, base or remote that U30 fills in), the digest changes and the stored consent is void.
// The note consent (KTD10) is not stored here: it lives in the hub binding and keeps its own rules.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { atomicReplace, ensurePrivatePath, fsyncDir, info, readPrivateJson } from "../storage/fsx.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { withPilotLock } from "../storage/lock.mjs";

export const CONSENT_KINDS = Object.freeze(["repo-push", "hub-publish"]);
export const HOLD_HOURS = Object.freeze({ default: 24, min: 1, max: 168 });
// The checks every consented action of the kind runs before it acts. A change here voids every consent of the kind.
// U41 added the held queue here, so consents granted before it (when items went out at once) are void and asked for
// again: the hold is now real, and the grant dialog says so.
const RULES = Object.freeze({
  "repo-push": Object.freeze({ schemaVersion: 1, checks: Object.freeze(["bound repository", "isolation", "credential patterns", "held queue"]), learningsDir: null, base: null, remoteUrl: null }),
  "hub-publish": Object.freeze({ schemaVersion: 1, checks: Object.freeze(["joined hub binding", "lesson draft checks", "isolation", "credential patterns", "held queue"]), layout: "lessons/<lesson id>.md" })
});
export const assertKind = (kind) => {
  if (!CONSENT_KINDS.includes(kind)) throw new DevtwinError("INVALID_INPUT", "Invalid consent kind", { field: "kind", allowed: CONSENT_KINDS });
  return kind;
};
export function assertHoldHours(value) {
  if (!Number.isInteger(value) || value < HOLD_HOURS.min || value > HOLD_HOURS.max) throw new DevtwinError("INVALID_INPUT", "Hold hours must be a whole number from 1 to 168", { field: "hold-hours", min: HOLD_HOURS.min, max: HOLD_HOURS.max });
  return value;
}
// The rules a consent of this kind and hold time covers, and their digest.
export const consentRules = (kind, holdHours) => Object.freeze({ kind: assertKind(kind), holdHours: assertHoldHours(holdHours), ...RULES[kind] });
export const ruleDigestFor = (kind, holdHours) => digest(consentRules(kind, holdHours));

const consentsDir = (roots) => join(roots.stateRoot, "consents");
const targetName = (target) => createHash("sha256").update(target).digest("hex") + ".json";
export const consentPath = (roots, kind, target) => join(consentsDir(roots), assertKind(kind), targetName(target));
const lockPath = (roots) => join(roots.stateRoot, "locks", "consents.lock");
export const withConsentLock = (roots, owner, action) => withPilotLock(roots, lockPath(roots), { kind: owner }, action, { destinations: [consentsDir(roots)] });

const KEYS = ["schemaVersion", "kind", "target", "holdHours", "ruleDigest", "grantedAt"];
// A stored record is void when its shape is wrong or its rule digest is not the current one.
function voidReason(record, kind, target) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some((key) => !KEYS.includes(key)) || record.schemaVersion !== 1 || record.kind !== kind || record.target !== target) return "invalid";
  try { assertHoldHours(record.holdHours); } catch { return "invalid"; }
  return record.ruleDigest === ruleDigestFor(kind, record.holdHours) ? null : "rules-changed";
}
const view = (record, reason) => ({ kind: record.kind, target: record.target, holdHours: record.holdHours, ruleDigest: record.ruleDigest, grantedAt: record.grantedAt, valid: reason === null, ...(reason ? { voidReason: reason } : {}) });
// The consent for one target with valid and voidReason, or null when none was granted.
export async function readConsent(roots, kind, target) {
  let record;
  try { record = await readPrivateJson(consentPath(roots, kind, target), 4096); }
  catch (error) { if (error.code === "ENOENT") return null; if (error.code === "DEVTWIN_INTEGRITY") return { kind, target, valid: false, voidReason: "invalid" }; throw error; }
  const reason = voidReason(record, kind, target);
  return reason === "invalid" ? { kind, target, valid: false, voidReason: reason } : view(record, reason);
}
// A consented action calls this before it acts. No consent, or a void one, stops it at "needs consent".
export async function requireConsent(roots, kind, target) {
  const consent = await readConsent(roots, kind, target);
  if (!consent?.valid) throw new DevtwinError("APPROVAL_REQUIRED", "Needs consent: ask your developer to run consent grant --kind " + kind, { consent: kind, target, reason: consent ? consent.voidReason : "none" });
  return consent;
}
// Every stored consent, sorted by kind and then target.
export async function listConsents(roots) {
  const out = [];
  for (const kind of CONSENT_KINDS) {
    let names;
    try { names = await readdir(join(consentsDir(roots), kind)); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const name of names.filter((n) => /^[a-f0-9]{64}\.json$/.test(n)).sort()) {
      let record;
      try { record = await readPrivateJson(join(consentsDir(roots), kind, name), 4096); } catch { out.push({ kind, file: name, valid: false, voidReason: "invalid" }); continue; }
      const target = typeof record?.target === "string" ? record.target : null;
      const reason = target !== null && targetName(target) === name ? voidReason(record, kind, target) : "invalid";
      out.push(reason === "invalid" ? { kind, file: name, valid: false, voidReason: reason } : view(record, reason));
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.target ?? a.file).localeCompare(String(b.target ?? b.file)));
}
// Callers hold the consent lock.
export async function writeConsent(roots, { kind, target, holdHours }, { now = () => new Date() } = {}) {
  const path = consentPath(roots, kind, target);
  const record = { schemaVersion: 1, kind, target, holdHours: assertHoldHours(holdHours), ruleDigest: ruleDigestFor(kind, holdHours), grantedAt: now().toISOString() };
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["consents", kind]);
  await atomicReplace(path, canonicalJson(record) + "\n");
  return view(record, null);
}
export function removeConsent(roots, { kind, target }) {
  const path = consentPath(roots, kind, target);
  assertWritable(roots, [path]);
  const node = info(path);
  if (!node) return false;
  if (!node.isFile()) throw new DevtwinError("PATH_UNSAFE", "Unsafe private path", { path });
  unlinkSync(path);
  fsyncDir(join(consentsDir(roots), kind));
  return true;
}
