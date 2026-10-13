import { join } from "node:path";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath, writeNewFile, fsyncDir, readPrivateJson } from "./fsx.mjs";
import { canonicalJson } from "./canonical.mjs";
import { DevctxError } from "../errors.mjs";
export const RUN_ID = /^run_[a-z0-9_-]{6,64}$/;
export async function writeRunReceipt(roots, runId, receipt) {
  if (!RUN_ID.test(runId)) throw new DevctxError("INVALID_ID", "Invalid run ID");
  const path = join(roots.stateRoot, "runs", runId, "receipt.json");
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["runs", runId]);
  assertWritable(roots, [path]);
  await writeNewFile(path, JSON.stringify(receipt) + "\n");
  fsyncDir(join(roots.stateRoot, "runs", runId));
  fsyncDir(join(roots.stateRoot, "runs"));
  return path;
}
// Replay path: writes a receipt lost to a crash after publication; an existing receipt must match exactly.
export async function ensureRunReceipt(roots, runId, receipt) {
  try { return await writeRunReceipt(roots, runId, receipt); }
  catch (error) {
    if (error.code !== "DEVCTX_CONFLICT") throw error;
    const path = join(roots.stateRoot, "runs", runId, "receipt.json");
    if (canonicalJson(await readPrivateJson(path)) !== canonicalJson(receipt)) throw new DevctxError("RECOVERY_REQUIRED", "Run receipt differs from published operation");
    return path;
  }
}
