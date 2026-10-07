import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, readdir } from "node:fs/promises";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readRegistry } from "../config/registry.mjs";
import { readBindingVersion, readManifest } from "../config/store.mjs";
import { readPrivateJson, readPrivateText, writeNewFile, ensurePrivatePath, fsyncDir } from "../storage/fsx.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { recordIdFor, assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { buildRecord, validateRecord, recordHash } from "./schema.mjs";
const dirFor = (roots, scope, project) => join(roots.dataRoot, "scopes", scope, "projects", project);
const recDir = (roots, scope, project, id) => join(dirFor(roots, scope, project), "records", id);
const recovery = () => new DevctxError("RECOVERY_REQUIRED", "Incomplete committed project");
async function readBundle(roots, scope, project, id) {
  try {
    const dir = recDir(roots, scope, project, id);
    const record = validateRecord(await readPrivateJson(join(dir, "record.json")));
    const body = await readPrivateText(join(dir, "body.md"), 32768);
    if (record.id !== id || record.scope !== scope || record.project !== project || sha256(body) !== record.bodyHash || Buffer.byteLength(body) !== record.bodyBytes) throw new DevctxError("INTEGRITY", "Bundle mismatch");
    return { record, body };
  } catch (error) { if (error.code === "ENOENT") throw new DevctxError("INTEGRITY", "Bundle missing"); throw error; }
}
export async function requireCommittedProject(roots, scope, project) {
  assertScopeId(scope); assertProjectId(project, scope);
  const { value } = await readRegistry(roots);
  const entry = value.bindings.find((x) => x.scope === scope && x.project === project);
  if (!entry) throw new DevctxError("PROJECT_UNBOUND", "Project unbound");
  const op = value.operations.find((x) => x.operationId === entry.operationId);
  if (!op || op.manifestHash !== entry.manifestHash) throw recovery();
  let binding, manifest;
  try {
    binding = await readBindingVersion(roots, entry);
    manifest = await readManifest(roots, scope, project, entry.operationId, entry.manifestHash);
    if (manifest.bindingHash !== entry.bindingHash || manifest.operationId !== op.operationId) throw recovery();
    for (const bundle of manifest.bundles) {
      const { record, body } = await readBundle(roots, scope, project, bundle.id);
      if (recordHash(record) !== bundle.recordHash || sha256(body) !== bundle.bodyHash) throw recovery();
    }
  } catch { throw recovery(); }
  return { binding, manifest, entry, registry: value };
}
export async function commitBundle(roots, input, { now = () => new Date(), faults = {} } = {}) {
  const { scope, project, requestId, recordedBy, draft, operationId = null, supersedes = [] } = input;
  if (!REQUEST_ID.test(requestId)) throw new DevctxError("INVALID_ID", "Invalid request ID");
  const id = recordIdFor({ scope, project, requestId });
  const base = dirFor(roots, scope, project);
  const stage = join(base, "staging", id), dest = recDir(roots, scope, project, id);
  assertWritable(roots, [stage, dest]);
  const requestHash = digest({ scope, project, requestId, recordedBy, draft, supersedes });
  if (existsSync(dest)) {
    const { record } = await readBundle(roots, scope, project, id);
    if (record.requestHash !== requestHash) throw new DevctxError("CONFLICT", "Request ID reused");
    return { recordId: id, recordHash: recordHash(record), created: false };
  }
  if (existsSync(stage)) throw new DevctxError("RECOVERY_REQUIRED", "Orphan staging retained", { staging: [id] });
  const record = buildRecord({ scope, project, requestId, requestHash, operationId, recordedBy, draft, supersedes }, { now });
  assertWritable(roots, [stage, dest]);
  ensurePrivatePath(roots.dataRoot, ["scopes", scope, "projects", project, "staging"]);
  ensurePrivatePath(roots.dataRoot, ["scopes", scope, "projects", project, "records"]);
  await mkdir(stage, { mode: 0o700 });
  await writeNewFile(join(stage, "body.md"), draft.body);
  await writeNewFile(join(stage, "record.json"), canonicalJson(record) + "\n");
  fsyncDir(stage);
  if (faults.beforeRename) await faults.beforeRename();
  assertWritable(roots, [stage, dest]);
  await rename(stage, dest);
  fsyncDir(join(base, "records"));
  return { recordId: id, recordHash: recordHash(record), created: true, bodyHash: record.bodyHash };
}
export async function readSnapshot(roots, scope, project) {
  const committed = await requireCommittedProject(roots, scope, project);
  const directory = join(dirFor(roots, scope, project), "records");
  let ids;
  try { ids = (await readdir(directory)).sort(); } catch (error) { if (error.code === "ENOENT") ids = []; else throw error; }
  const records = [], corrupt = [];
  let hiddenUncommitted = 0;
  const published = new Set(committed.registry.operations.map((op) => op.operationId));
  for (const id of ids) {
    try {
      const { record, body } = await readBundle(roots, scope, project, id);
      if (record.operationId && !published.has(record.operationId)) { hiddenUncommitted++; continue; }
      records.push({ ...record, body, recordHash: recordHash(record), effective: record.status, supersededBy: [] });
    } catch { corrupt.push({ id, code: "DEVCTX_INTEGRITY" }); }
  }
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) for (const id of r.supersedes) {
    const predecessor = byId.get(id);
    if (predecessor) { predecessor.effective = "superseded"; predecessor.supersededBy.push(r.id); }
  }
  return { records, corrupt, hiddenUncommitted };
}
export async function addRecord(roots, input, options = {}) {
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-add" }, async () => {
    await requireCommittedProject(roots, input.scope, input.project);
    return commitBundle(roots, input, options);
  }, { destinations: [path] });
}
export async function supersedeRecord(roots, input, options = {}) {
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-supersede" }, async () => {
    const snap = await readSnapshot(roots, input.scope, input.project);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length !== input.expectHashes?.length) throw new DevctxError("INVALID_INPUT", "Targets and hashes required");
    for (let i = 0; i < input.targets.length; i++) {
      const target = snap.records.find((r) => r.id === input.targets[i]);
      if (!target || target.effective === "superseded" || target.recordHash !== input.expectHashes[i]) throw new DevctxError("STALE_VERSION", "Target changed");
    }
    return commitBundle(roots, { ...input, supersedes: input.targets }, options);
  }, { destinations: [path] });
}
export async function previewRecord(roots, input) {
  await requireCommittedProject(roots, input.scope, input.project);
  return { preview: true, recordId: recordIdFor(input), scope: input.scope, project: input.project };
}
export async function proposeRecord(roots, input, { now = () => new Date() } = {}) {
  const proposalId = "prop_" + digest(input).slice(7, 31);
  const path = join(dirFor(roots, input.scope, input.project), "proposals", proposalId + ".json");
  assertWritable(roots, [path]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-propose" }, async () => {
    await requireCommittedProject(roots, input.scope, input.project);
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.dataRoot, ["scopes", input.scope, "projects", input.project, "proposals"]);
    if (!existsSync(path)) await writeNewFile(path, canonicalJson({ schemaVersion: 1, proposalId, input, createdAt: now().toISOString(), review: "unreviewed" }) + "\n");
    return { proposalId, path };
  }, { destinations: [path] });
}
export async function publishProposal(roots, { scope, project, proposalId, review }, { controller, now = () => new Date() } = {}) {
  if (!controller) throw new DevctxError("APPROVAL_REQUIRED", "Controller required");
  const path = join(dirFor(roots, scope, project), "proposals", proposalId + ".json");
  const proposal = await readPrivateJson(path);
  return addRecord(roots, { ...proposal.input, scope, project, draft: { ...proposal.input.draft, status: "observed", review: review ?? proposal.input.draft.review } }, { now });
}
export { recordHash };
