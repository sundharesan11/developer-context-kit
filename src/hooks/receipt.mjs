import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertKit, assertWritable, pilotDigest } from "../config/pilot.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace } from "../storage/fsx.mjs";
import { kitId, kitIdentity, parseKitId } from "../kit/identity.mjs";
import { readManifest } from "../kit/manifest.mjs";
// U7: the kit-verification receipt (KTD6). `hook verify` writes it after the full pilot load, which in live mode
// includes the kit checks. The hook trusts it in place of that load, so a hook call runs no Git and no fence check.
// Shape: { schemaVersion: 2, pilotPath, pilotSha256, kitRoot, kitId, kitCommit, verifiedAt, ttlSeconds }. U43: kitId is
// git:<sha> or npm:<version>+sha256:<digest> (src/kit/identity.mjs), null for a disposable pilot; kitCommit is the Git
// commit or null, kept for readers of schema 1. A schema 1 receipt (kitCommit only, from a Git kit) still reads.
// pilotSha256 is the SHA-256 of the pilot file bytes, so any edit to the config makes the receipt stale.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// U27 (KTD35): 30 days by default; the session start renews it while the confirmed paths match (renewReceipt).
export const RECEIPT_TTL_SECONDS = 30 * 24 * 3600;
const MAX_TTL_SECONDS = 30 * 24 * 3600, MAX_PILOT_BYTES = 65536, SKEW_MS = 5 * 60 * 1000;
export const receiptPath = (stateRoot) => join(stateRoot, "hooks", "kit-receipt.json");
export function runningKit(kitRoot) { return realpathSync(kitRoot ?? KIT); }
export function readPilotBytes(path) {
  const bytes = readFileSync(path);
  if (bytes.length > MAX_PILOT_BYTES) throw new DevtwinError("LIMIT", "Pilot file exceeds limit");
  return bytes;
}
// Called from the `hook verify` route after loadPilot passed. The bytes on disk must still be the config that loaded.
export async function writeKitReceipt(roots, { pilotPath, kitRoot, now = new Date(), ttlSeconds = RECEIPT_TTL_SECONDS } = {}) {
  const pilot = roots.pilot, real = realpathSync(pilotPath), bytes = readPilotBytes(real);
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { throw new DevtwinError("CONFLICT", "Pilot changed during verification"); }
  if (pilotDigest(parsed) !== pilot.digest) throw new DevtwinError("CONFLICT", "Pilot changed during verification");
  const path = receiptPath(roots.stateRoot);
  assertWritable(roots, [dirname(path), path]);
  ensurePrivatePath(roots.stateRoot, ["hooks"]);
  const receipt = { schemaVersion: 2, pilotPath: real, pilotSha256: sha256(bytes), kitRoot: runningKit(kitRoot), kitId: pilot.live ? kitId(kitIdentity(pilot.live)) : null, kitCommit: pilot.live?.kitCommit ?? null, verifiedAt: now.toISOString(), ttlSeconds };
  await atomicReplace(path, JSON.stringify(receipt) + "\n");
  return { path, ...receipt };
}
// The kit a receipt names, or null for none. Schema 1 holds only kitCommit; schema 2 holds a full kitId.
function receiptKit(receipt) {
  if (receipt?.schemaVersion === 1) return receipt.kitCommit === null ? null : { kind: "git", commit: receipt.kitCommit };
  if (receipt?.schemaVersion === 2) return receipt.kitId === null ? null : parseKitId(receipt.kitId);
  throw new DevtwinError("INTEGRITY", "Receipt schema unknown");
}
// The reason the receipt is not usable, or null when it is. Any read problem is a reason, never a throw.
export async function receiptProblem(stateRoot, { pilotPath, pilotBytes, kitRoot, now }) {
  let receipt;
  try { receipt = await readPrivateJson(receiptPath(stateRoot), 4096); }
  catch (error) { return error.code === "ENOENT" ? "missing" : "invalid"; }
  let kit;
  try { kit = receiptKit(receipt); } catch { return "invalid"; }
  if (typeof receipt.verifiedAt !== "string" || !Number.isInteger(receipt.ttlSeconds) || receipt.ttlSeconds < 1 || receipt.ttlSeconds > MAX_TTL_SECONDS) return "invalid";
  if (receipt.pilotPath !== pilotPath || receipt.pilotSha256 !== sha256(pilotBytes)) return "pilot-changed";
  const at = Date.parse(receipt.verifiedAt), age = now.getTime() - at;
  if (!Number.isFinite(at) || age < -SKEW_MS || age > receipt.ttlSeconds * 1000) return "expired";
  let root;
  try { root = runningKit(kitRoot); } catch { return "kit-changed"; }
  if (receipt.kitRoot !== root) return "kit-changed";
  // A live Git kit runs detached at its commit, so .git/HEAD holds the commit itself; a package kit's manifest holds its
  // version and digest. One small read, no Git process and no digest: `hook verify` did the full check.
  try {
    if (kit?.kind === "git" && readFileSync(join(root, ".git", "HEAD"), "utf8").trim() !== kit.commit) return "kit-changed";
    if (kit?.kind === "package") { const m = readManifest(root); if (m.version !== kit.version || m.digest !== kit.digest) return "kit-changed"; }
  } catch { return "kit-changed"; }
  return null;
}
// U27 (KTD35): the session start's renewal. It runs only after receiptProblem found the receipt usable and the confirmed
// paths match, so every field but verifiedAt is still true; it moves verifiedAt to now with no pilot load and no lock.
// Returns the receipt's expiry before renewal, for the near-expiry warning when renewal is not allowed.
export async function receiptExpiry(stateRoot) {
  try {
    const receipt = await readPrivateJson(receiptPath(stateRoot), 4096);
    const at = Date.parse(receipt.verifiedAt);
    return Number.isFinite(at) && Number.isInteger(receipt.ttlSeconds) ? new Date(at + receipt.ttlSeconds * 1000) : null;
  } catch { return null; }
}
// U48: the fast path above reads only a package kit's manifest. Before a renewal extends the receipt, the running
// package kit gets the full kit gate (files, digest, owner, modes, kits folder). Its folder sits in <home>/.devtwin/kits,
// where hook verify checked it, so the home comes from the path. False when it fails; a Git kit has no extra check.
export async function kitVerifies(stateRoot, kitRoot) {
  try {
    const kit = receiptKit(await readPrivateJson(receiptPath(stateRoot), 4096));
    if (kit?.kind === "package") { const root = runningKit(kitRoot); assertKit(root, kit, { home: dirname(dirname(dirname(root))) }); }
    return true;
  } catch { return false; }
}
export async function renewReceipt(stateRoot, now) {
  const path = receiptPath(stateRoot), receipt = await readPrivateJson(path, 4096);
  await atomicReplace(path, JSON.stringify({ ...receipt, verifiedAt: now.toISOString() }) + "\n");
}
