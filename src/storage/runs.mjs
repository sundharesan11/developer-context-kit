import { join } from "node:path";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath, writeNewFile, fsyncDir, readPrivateJson, atomicReplace } from "./fsx.mjs";
import { canonicalJson } from "./canonical.mjs";
import { DevtwinError } from "../errors.mjs";
export const RUN_ID = /^run_[a-z0-9_-]{6,64}$/;
export async function writeRunReceipt(roots, runId, receipt) {
  if (!RUN_ID.test(runId)) throw new DevtwinError("INVALID_ID", "Invalid run ID");
  const path = join(roots.stateRoot, "runs", runId, "receipt.json");
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["runs", runId]);
  assertWritable(roots, [path]);
  await writeNewFile(path, JSON.stringify(receipt) + "\n");
  fsyncDir(join(roots.stateRoot, "runs", runId));
  fsyncDir(join(roots.stateRoot, "runs"));
  return path;
}
// Replay path: writes a receipt lost to a crash after publication; an existing receipt must match exactly. A receipt torn by a hard kill (empty or unparseable) is replaced with the one reconstructed from the published operation; one that parses but differs needs recovery.
export async function ensureRunReceipt(roots, runId, receipt) {
  try { return await writeRunReceipt(roots, runId, receipt); }
  catch (error) {
    if (error.code !== "DEVTWIN_CONFLICT") throw error;
    const path = join(roots.stateRoot, "runs", runId, "receipt.json");
    let existing;
    try { existing = await readPrivateJson(path); }
    catch (readError) {
      if (readError.code !== "DEVTWIN_INTEGRITY") throw readError;
      assertWritable(roots, [path]);
      await atomicReplace(path, JSON.stringify(receipt) + "\n");
      return path;
    }
    if (canonicalJson(existing) !== canonicalJson(receipt)) throw new DevtwinError("RECOVERY_REQUIRED", "Run receipt differs from published operation");
    return path;
  }
}
