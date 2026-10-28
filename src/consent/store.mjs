// U36 (KTD39): standing consents, one per kind and target, at stateRoot/consents/<kind>/<sha256 of target>.json
// (folders 0700, files 0600, atomic replace under the consent lock). A consent lets agents and jobs run a consented
// action for that target with no owner dialog (src/policy/tiers.mjs).
//   repo-push    target: the real path of a bound repository root; push a learning branch to it
//   hub-publish  target: a scope with a hub binding; publish a lesson to its hub
// Each record keeps the rule digest of the rules it was granted under. When the rules change (another check, another
// hold time, or for a repository its learnings folder, base or remote URL), the digest changes and the stored consent
// is void. The note consent (KTD10) is not stored here: it lives in the hub binding and keeps its own rules.
// U30 (KTD29, KTD39): a repo-push record also keeps remoteUrl, the repository's push URL when the consent was granted
// (credentials removed, null when the repository had no origin). A push goes to that URL only. The digest covers it and
// the project's current learnings folder and base (src/projects/commands.mjs), so `project set` voids the consent.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { atomicReplace, ensurePrivatePath, fsyncDir, info, readPrivateJson } from "../storage/fsx.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { learningsFor, DEFAULT_LEARNINGS_DIR, DEFAULT_LEARNINGS_BASE } from "../projects/commands.mjs";

export const CONSENT_KINDS = Object.freeze(["repo-push", "hub-publish"]);
export const HOLD_HOURS = Object.freeze({ default: 24, min: 1, max: 168 });
// The checks every consented action of the kind runs before it acts. A change here voids every consent of the kind.
// U41 added the held queue here, so consents granted before it (when items went out at once) are void and asked for
// again: the hold is now real, and the grant dialog says so. U30 filled in the repository rules, which voided the
// repo-push consents granted before it.
const RULES = Object.freeze({
  "repo-push": Object.freeze({ schemaVersion: 2, checks: Object.freeze(["bound repository", "repoLearnings approval", "recorded Git identity", "isolation", "credential patterns", "held queue", "push URL matches", "SSH only, never forced"]),
    template: "<learnings dir>/<slug>.md with title, date, category: lesson, tags and source: devtwin <record id>, on a new branch devtwin/learning-<id>" }),
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
// The repository part of a repo-push rule set: the effective learnings folder and base ref, and the recorded URL.
export const repoPushParams = ({ learningsDir = null, learningsBase = null, remoteUrl = null } = {}) => ({ learningsDir: learningsDir ?? DEFAULT_LEARNINGS_DIR, learningsBase: learningsBase ?? DEFAULT_LEARNINGS_BASE, remoteUrl: remoteUrl ?? null });
// The rules a consent of this kind and hold time covers, and their digest. params is the repository part (repo-push).
export const consentRules = (kind, holdHours, params) => Object.freeze({ kind: assertKind(kind), holdHours: assertHoldHours(holdHours), ...RULES[kind], ...(kind === "repo-push" ? repoPushParams(params) : {}) });
export const ruleDigestFor = (kind, holdHours, params) => digest(consentRules(kind, holdHours, params));
// The repository part for a target now: its project's learnings settings, and the given recorded URL. An unbound
// repository has no settings, so its consent cannot match.
export async function consentParams(roots, kind, target, remoteUrl = null) {
  if (kind !== "repo-push") return undefined;
  let learnings;
  try { learnings = await learningsFor(roots, target); } catch (error) { if (error.code !== "ENOENT") throw error; learnings = null; }
  return learnings ? { learningsDir: learnings.learningsDir, learningsBase: learnings.learningsBase, remoteUrl } : { learningsDir: "(unbound)", learningsBase: null, remoteUrl };
}
// True when a repo-push consent stays valid under other learnings settings ({ learningsDir, learningsBase }).
export const repoConsentWouldHold = (consent, settings) => consent.ruleDigest === ruleDigestFor("repo-push", consent.holdHours, { ...settings, remoteUrl: consent.remoteUrl ?? null });

const consentsDir = (roots) => join(roots.stateRoot, "consents");
const targetName = (target) => createHash("sha256").update(target).digest("hex") + ".json";
export const consentPath = (roots, kind, target) => join(consentsDir(roots), assertKind(kind), targetName(target));
const lockPath = (roots) => join(roots.stateRoot, "locks", "consents.lock");
export const withConsentLock = (roots, owner, action) => withPilotLock(roots, lockPath(roots), { kind: owner }, action, { destinations: [consentsDir(roots)] });

const KEYS = ["schemaVersion", "kind", "target", "holdHours", "ruleDigest", "grantedAt", "remoteUrl"];
const URL_TEXT = (value) => value === null || (typeof value === "string" && value.length > 0 && value.length <= 2048 && !/[\s\p{Cc}\p{Cf}=]/u.test(value));
// A stored record is void when its shape is wrong or its rule digest is not the current one.
async function voidReason(roots, record, kind, target) {
  if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).some((key) => !KEYS.includes(key)) || record.schemaVersion !== 1 || record.kind !== kind || record.target !== target) return "invalid";
  if (kind === "repo-push" ? !Object.hasOwn(record, "remoteUrl") || !URL_TEXT(record.remoteUrl) : Object.hasOwn(record, "remoteUrl")) return "invalid";
  try { assertHoldHours(record.holdHours); } catch { return "invalid"; }
  return record.ruleDigest === ruleDigestFor(kind, record.holdHours, await consentParams(roots, kind, target, record.remoteUrl)) ? null : "rules-changed";
}
const view = (record, reason) => ({ kind: record.kind, target: record.target, holdHours: record.holdHours, ruleDigest: record.ruleDigest, grantedAt: record.grantedAt, ...(record.kind === "repo-push" ? { remoteUrl: record.remoteUrl } : {}), valid: reason === null, ...(reason ? { voidReason: reason } : {}) });
// The consent for one target with valid and voidReason, or null when none was granted.
export async function readConsent(roots, kind, target) {
  let record;
  try { record = await readPrivateJson(consentPath(roots, kind, target), 4096); }
  catch (error) { if (error.code === "ENOENT") return null; if (error.code === "DEVTWIN_INTEGRITY") return { kind, target, valid: false, voidReason: "invalid" }; throw error; }
  const reason = await voidReason(roots, record, kind, target);
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
      const reason = target !== null && targetName(target) === name ? await voidReason(roots, record, kind, target) : "invalid";
      out.push(reason === "invalid" ? { kind, file: name, valid: false, voidReason: reason } : view(record, reason));
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || String(a.target ?? a.file).localeCompare(String(b.target ?? b.file)));
}
// Callers hold the consent lock. remoteUrl is the recorded push URL of a repo-push target.
export async function writeConsent(roots, { kind, target, holdHours, remoteUrl = null }, { now = () => new Date() } = {}) {
  const path = consentPath(roots, kind, target);
  if (kind === "repo-push" && !URL_TEXT(remoteUrl)) throw new DevtwinError("INVALID_INPUT", "Invalid remote URL", { field: "remoteUrl" });
  const record = { schemaVersion: 1, kind, target, holdHours: assertHoldHours(holdHours), ruleDigest: ruleDigestFor(kind, holdHours, await consentParams(roots, kind, target, remoteUrl)), grantedAt: now().toISOString(), ...(kind === "repo-push" ? { remoteUrl } : {}) };
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
