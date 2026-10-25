import { dirname, join, relative } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { loadScope } from "../config/store.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { checkNode, ensurePrivatePath, fsyncDir, info, writeNewFile } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { assertNoSensitive } from "../records/redact.mjs";
export const DRAFT_LIMIT = 32768;
// R18: this route stores a draft and nothing else; only routing's connect draft keeps a draft sendable later.
export const DRAFT_NOTE = "Saved privately only; nothing is sent, posted or scheduled. A draft saved here cannot be sent by routing later; use routing's connect draft when the scope has a bound account.";
export const draftLockPath = (roots) => join(roots.stateRoot, "locks", "drafts.lock");
// The body file must lie inside inputsRoot and is read through the approved-source reader, as record body files are.
async function readBody(pilot, path) {
  if (typeof path !== "string" || !path) throw new DevtwinError("INVALID_INPUT", "Body file required", { field: "body-file" });
  assertInPilot(pilot, dirname(path), "inputsRoot");
  const read = await readApprovedSource(pilot.inputsRoot, relative(pilot.inputsRoot, path));
  if (read.skipped || Buffer.byteLength(read.text) > DRAFT_LIMIT) throw new DevtwinError("INVALID_INPUT", "Body file unavailable", { field: "body-file" });
  if (!read.text.trim()) throw new DevtwinError("INVALID_INPUT", "Body file is empty", { field: "body-file" });
  assertNoSensitive(read.text);
  return read.text;
}
async function buildDraft(roots, { scope, bodyFile }) {
  if (scope !== undefined) await loadScope(roots, scope);
  const body = await readBody(roots.pilot, bodyFile);
  const bodyHash = sha256(body);
  const segments = [...(scope === undefined ? [] : ["scopes", scope]), "drafts"];
  const name = "draft-" + bodyHash.slice(7, 31) + ".md";
  const plan = finalizePlan({ preview: true, kind: "draft", scope: scope ?? null, destination: { root: "dataRoot", path: [...segments, name].join("/") }, bodyHash, bytes: Buffer.byteLength(body), sendable: false, note: DRAFT_NOTE });
  return { plan, body, segments, dir: join(roots.dataRoot, ...segments), path: join(roots.dataRoot, ...segments, name) };
}
export async function planDraft(roots, input) {
  const { plan, dir, path } = await buildDraft(roots, input);
  assertWritable(roots, [dir, path]);
  return plan;
}
export async function applyDraft(roots, input, { fingerprint } = {}) {
  if (!fingerprint) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  const { dir, path } = await buildDraft(roots, input);
  return withPilotLock(roots, draftLockPath(roots), { kind: "draft-save" }, async () => {
    const checked = await buildDraft(roots, input);
    assertFingerprint(checked.plan, fingerprint);
    // The lock guards the destination computed before it; a body that changed in between names another one.
    if (checked.path !== path) throw new DevtwinError("SOURCE_CHANGED", "Body changed before write");
    if (info(path)) throw new DevtwinError("CONFLICT", "Draft already exists", { destination: checked.plan.destination });
    ensurePrivatePath(roots.dataRoot, checked.segments);
    await writeNewFile(path, checked.body);
    fsyncDir(dir);
    if ((checkNode(info(path), path).mode & 0o777) !== 0o600) throw new DevtwinError("INTEGRITY", "Written draft failed verification");
    const { scope, destination, bodyHash, bytes } = checked.plan;
    return { kind: "draft", scope, destination, bodyHash, bytes, sendable: false, note: DRAFT_NOTE };
  }, { destinations: [dir, path] });
}
