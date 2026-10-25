import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertWritable, pilotDigest } from "../config/pilot.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace } from "../storage/fsx.mjs";
// U7: the kit-verification receipt (KTD6). `hook verify` writes it after the full pilot load, which in live mode
// includes the kit checks. The hook trusts it in place of that load, so a hook call runs no Git and no fence check.
// Shape: { schemaVersion: 1, pilotPath, pilotSha256, kitRoot, kitCommit, verifiedAt, ttlSeconds }.
// pilotSha256 is the SHA-256 of the pilot file bytes, so any edit to the config makes the receipt stale.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const RECEIPT_TTL_SECONDS = 7 * 24 * 3600;
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
  const receipt = { schemaVersion: 1, pilotPath: real, pilotSha256: sha256(bytes), kitRoot: runningKit(kitRoot), kitCommit: pilot.live?.kitCommit ?? null, verifiedAt: now.toISOString(), ttlSeconds };
  await atomicReplace(path, JSON.stringify(receipt) + "\n");
  return { path, ...receipt };
}
// The reason the receipt is not usable, or null when it is. Any read problem is a reason, never a throw.
export async function receiptProblem(stateRoot, { pilotPath, pilotBytes, kitRoot, now }) {
  let receipt;
  try { receipt = await readPrivateJson(receiptPath(stateRoot), 4096); }
  catch (error) { return error.code === "ENOENT" ? "missing" : "invalid"; }
  if (receipt?.schemaVersion !== 1 || typeof receipt.verifiedAt !== "string" || !Number.isInteger(receipt.ttlSeconds) || receipt.ttlSeconds < 1 || receipt.ttlSeconds > MAX_TTL_SECONDS) return "invalid";
  if (receipt.pilotPath !== pilotPath || receipt.pilotSha256 !== sha256(pilotBytes)) return "pilot-changed";
  const at = Date.parse(receipt.verifiedAt), age = now.getTime() - at;
  if (!Number.isFinite(at) || age < -SKEW_MS || age > receipt.ttlSeconds * 1000) return "expired";
  let kit;
  try { kit = runningKit(kitRoot); } catch { return "kit-changed"; }
  if (receipt.kitRoot !== kit) return "kit-changed";
  // A live kit runs detached at its commit, so .git/HEAD holds the commit itself. One small read, no Git process.
  if (receipt.kitCommit !== null) {
    try { if (readFileSync(join(kit, ".git", "HEAD"), "utf8").trim() !== receipt.kitCommit) return "kit-changed"; }
    catch { return "kit-changed"; }
  }
  return null;
}
