import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { checkNode, ensurePrivatePath, fsyncDir, info, readPrivateBytes, writeNewFile } from "../storage/fsx.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { buildPortableHandoff, HANDOFF_LIMITS } from "./portable.mjs";
import { handoffError } from "./privacy.mjs";

function checkParents(roots, parent) {
  let at = roots.dataRoot;
  while (true) {
    const node = info(at);
    if (!node || !node.isDirectory() || node.isSymbolicLink() || node.uid !== process.getuid() || node.mode & 0o022 || realpathSync(at) !== at) throw new DevctxError("PATH_UNSAFE", "Unsafe export ancestor");
    if (at === roots.pilot.pilotRoot) break;
    const next = dirname(at);
    if (next === at) throw new DevctxError("GATE_REQUIRED", "Export ancestor outside pilot");
    at = next;
  }
  const data = checkNode(info(roots.dataRoot), roots.dataRoot, { directory: true });
  if ((data.mode & 0o777) !== 0o700) throw new DevctxError("PATH_UNSAFE", "Private dataRoot must be 0700");
  at = roots.dataRoot;
  for (const segment of relative(roots.dataRoot, parent).split("/")) {
    at = join(at, segment);
    const node = info(at);
    if (!node) break;
    checkNode(node, at, { directory: true });
    if ((node.mode & 0o777) !== 0o700 || realpathSync(at) !== at) throw new DevctxError("PATH_UNSAFE", "Unsafe export directory");
  }
}
function preflight(roots, model, out) {
  const parent = join(roots.dataRoot, "exports", "handoffs", model.scope, model.project);
  if (typeof out !== "string" || !isAbsolute(out) || resolve(out) !== out || dirname(out) !== parent || !/^[a-z0-9][a-z0-9._-]{0,63}\.handoff\.md$/.test(basename(out))) throw new DevctxError("GATE_REQUIRED", "Output must be a named project handoff export");
  assertWritable(roots, [parent]);
  checkParents(roots, parent);
  if (info(out)) throw new DevctxError("CONFLICT", "Output already exists");
  assertWritable(roots, [out]);
  return parent;
}

export async function exportHandoff(roots, pilot, input, { faults = {} } = {}) {
  try {
    if (!input || Object.keys(input).some((key) => !["scope", "cwd", "recordIds", "asOf", "out"].includes(key))) throw new DevctxError("INVALID_INPUT", "Unexpected export input");
    const { out, ...selection } = input;
    const built = await buildPortableHandoff(roots, pilot, selection);
    const parent = preflight(roots, built.model, out);
    if (faults.beforeRecheck) await faults.beforeRecheck();
    const checked = await buildPortableHandoff(roots, pilot, selection);
    if (checked.fileHash !== built.fileHash) throw new DevctxError("SOURCE_CHANGED", "Evidence changed before publication");
    preflight(roots, built.model, out);
    ensurePrivatePath(roots.dataRoot, ["exports", "handoffs", built.model.scope, built.model.project]);
    preflight(roots, built.model, out);
    await writeNewFile(out, built.markdown);
    fsyncDir(parent);
    checkParents(roots, parent);
    const node = checkNode(info(out), out);
    if ((node.mode & 0o777) !== 0o600 || sha256(await readPrivateBytes(out, HANDOFF_LIMITS.maxBytes)) !== built.fileHash) throw new DevctxError("INTEGRITY", "Written packet failed verification");
    return { scope: built.model.scope, project: built.model.project, asOf: built.model.asOf,
      records: built.model.records.map(({ id, recordHash }) => ({ id, recordHash })),
      packetHash: built.packetHash, fileHash: built.fileHash, bytes: built.bytes,
      output: relative(roots.dataRoot, out), publication: "not-approved" };
  } catch (error) { throw handoffError(error); }
}
