import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { deepestExisting } from "../config/roots.mjs";
import { gitQuery } from "../identity/git.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { readPrivateText, writeNewFile, atomicReplace, ensurePrivatePath, fsyncDir } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { validateProfile, PROFILE_CAP } from "./validate.mjs";
export { PROFILE_CAP };
const REVISION = /^v([1-9][0-9]*)\.json$/;
const REMEDY = "keep private roots out of Git; to version the profile, copy or export it into a separate private repository or dotfiles manager (see https://github.com/sundharesan11/devtwin/blob/main/docs/HARNESS.md)";
export const profileDir = (roots) => join(roots.configRoot, "profile");
export const profileLockPath = (roots) => join(roots.stateRoot, "locks", "profile.lock");
const currentPath = (roots) => join(profileDir(roots), "current.json");
const revisionPath = (roots, generation) => join(profileDir(roots), "v" + generation + ".json");
const recovery = (message, details = {}) => { throw new DevtwinError("RECOVERY_REQUIRED", message, details); };
function assertOutsideGit(roots) {
  if (gitQuery(deepestExisting(roots.configRoot), ["rev-parse", "--is-inside-work-tree"], { notRepo: true }).stdout.trim() === "true") throw new DevtwinError("PATH_UNSAFE", "Private roots inside Git worktree", { remedy: REMEDY });
}
async function readText(path) {
  try { return await readPrivateText(path, 65536); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function readPointer(roots) {
  const text = await readText(currentPath(roots));
  if (text === null) return { generation: 0, revisionHash: null };
  let pointer;
  try { pointer = JSON.parse(text); } catch { recovery("Profile pointer unreadable"); }
  if (pointer?.schemaVersion !== 1 || !Number.isInteger(pointer.generation) || pointer.generation < 1 || typeof pointer.revisionHash !== "string") recovery("Profile pointer invalid");
  return { generation: pointer.generation, revisionHash: pointer.revisionHash };
}
async function revisionText(roots, generation, expectHash) {
  const text = await readText(revisionPath(roots, generation));
  if (text === null) recovery("Profile revision unavailable", { generation });
  if (expectHash && sha256(text) !== expectHash) recovery("Profile revision hash mismatch", { generation });
  return text;
}
function parseRevision(text, generation) {
  let value;
  try { value = JSON.parse(text); } catch { recovery("Profile revision unreadable", { generation }); }
  if (value?.schemaVersion !== 1 || value.generation !== generation) recovery("Profile revision invalid", { generation });
  return value;
}
// The pointer names the current revision; a revision newer than the pointer is an interrupted apply and is never reused.
async function readState(roots) {
  const base = await readPointer(roots);
  let names = [];
  try { names = await readdir(profileDir(roots)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const orphans = names.map((name) => REVISION.exec(name)).filter(Boolean).map((match) => Number(match[1])).filter((generation) => generation > base.generation);
  if (orphans.length) recovery("Interrupted profile apply", { generation: Math.max(...orphans), current: base.generation });
  if (base.generation) await revisionText(roots, base.generation, base.revisionHash);
  return base;
}
const buildPlan = (roots, profile, base) => finalizePlan({ preview: true, kind: "profile", destination: profileDir(roots), base, next: { generation: base.generation + 1 }, profile, size: Buffer.byteLength(canonicalJson(profile)), cap: PROFILE_CAP });
export async function readProfile(roots) {
  const base = await readPointer(roots);
  if (!base.generation) return { ...base, profile: null };
  const revision = parseRevision(await revisionText(roots, base.generation, base.revisionHash), base.generation);
  return { ...base, profile: revision.profile, createdAt: revision.createdAt };
}
export async function readProfileRevision(roots, generation) {
  if (!Number.isInteger(generation) || generation < 1) throw new DevtwinError("INVALID_INPUT", "Invalid profile generation");
  const text = await revisionText(roots, generation);
  const revision = parseRevision(text, generation);
  return { generation, revisionHash: sha256(text), profile: revision.profile, createdAt: revision.createdAt };
}
export async function planProfile(roots, { profile } = {}) {
  validateProfile(profile);
  assertOutsideGit(roots);
  return buildPlan(roots, profile, await readState(roots));
}
// A fingerprint that matches an earlier base is stale; one that matches no base is a mismatch.
async function assertCurrentPlan(roots, plan, profile, fingerprint) {
  if (!fingerprint || fingerprint === plan.fingerprint) return assertFingerprint(plan, fingerprint);
  for (let generation = 0; generation < plan.base.generation; generation++) {
    const revisionHash = generation ? sha256(await revisionText(roots, generation)) : null;
    if (buildPlan(roots, profile, { generation, revisionHash }).fingerprint === fingerprint) throw new DevtwinError("STALE_VERSION", "Profile changed since preview", { base: generation, current: plan.base.generation });
  }
  assertFingerprint(plan, fingerprint);
}
// For callers that derive the profile from its base (CLI flags over the current profile): finds the earlier
// base whose derived plan has this fingerprint, so a moved base reports STALE_VERSION instead of a mismatch.
export async function findStaleBase(roots, derive, fingerprint) {
  const { generation: current } = await readPointer(roots);
  for (let generation = 0; generation < current; generation++) {
    let profile = null, revisionHash = null;
    if (generation) { const text = await revisionText(roots, generation); revisionHash = sha256(text); profile = parseRevision(text, generation).profile; }
    let candidate;
    try { candidate = derive(profile); } catch { continue; }
    if (buildPlan(roots, candidate, { generation, revisionHash }).fingerprint === fingerprint) return { base: generation, current };
  }
  return null;
}
// faults.afterRevision is a test seam for a crash after the revision is written and before the pointer is published.
export async function applyProfile(roots, { profile, fingerprint } = {}, { now = () => new Date(), faults = {} } = {}) {
  validateProfile(profile);
  assertOutsideGit(roots);
  const destinations = [profileDir(roots), currentPath(roots)];
  assertWritable(roots, destinations);
  return withPilotLock(roots, profileLockPath(roots), { kind: "profile-apply" }, async () => {
    const base = await readState(roots);
    const plan = buildPlan(roots, profile, base);
    await assertCurrentPlan(roots, plan, profile, fingerprint);
    const generation = plan.next.generation, path = revisionPath(roots, generation);
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.configRoot, ["profile"]);
    const text = canonicalJson({ schemaVersion: 1, generation, baseRevisionHash: base.revisionHash, profile, createdAt: now().toISOString() }) + "\n";
    await writeNewFile(path, text);
    fsyncDir(profileDir(roots));
    await faults.afterRevision?.();
    const revisionHash = sha256(text);
    await atomicReplace(currentPath(roots), canonicalJson({ schemaVersion: 1, generation, revisionHash }) + "\n");
    return { generation, revisionHash, destination: profileDir(roots) };
  }, { destinations });
}
