import { join } from "node:path";
import { assertWritable } from "../config/pilot.mjs";
import { ensurePrivatePath, writeNewFile } from "./fsx.mjs";
import { DevctxError } from "../errors.mjs";
export const RUN_ID = /^run_[a-z0-9_-]{6,64}$/;
export async function writeRunReceipt(roots, runId, receipt) {
  if (!RUN_ID.test(runId)) throw new DevctxError("INVALID_ID", "Invalid run ID");
  const path = join(roots.stateRoot, "runs", runId, "receipt.json");
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.stateRoot, ["runs", runId]);
  assertWritable(roots, [path]);
  await writeNewFile(path, JSON.stringify(receipt) + "\n");
  return path;
}
