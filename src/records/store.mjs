import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, readdir } from "node:fs/promises";
import { DevctxError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readRegistry } from "../config/registry.mjs";
import { readBindingVersion, readManifest } from "../config/store.mjs";
import { readPrivateJson, readPrivateText, writeNewFile, ensurePrivatePath, fsyncDir, safeJoin } from "../storage/fsx.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { recordIdFor, assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { buildRecord, validateRecord, validateDraft, recordHash } from "./schema.mjs";
import { assertNoSensitive, findForbiddenFields } from "./redact.mjs";
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
  const entry = value.bindings.filter((x) => x.scope === scope && x.project === project).reduce((latest, x) => !latest || x.bindingVersion > latest.bindingVersion ? x : latest, null);
  if (!entry) throw new DevctxError("PROJECT_UNBOUND", "Project unbound");
  const op = value.operations.find((x) => x.operationId === entry.operationId);
  if (!op || op.manifestHash !== entry.manifestHash) throw recovery();
  let binding, manifest;
  try {
    binding = await readBindingVersion(roots, entry);
    manifest = await readManifest(roots, scope, project, entry.operationId, entry.manifestHash);
    if (manifest.bindingHash !== entry.bindingHash || manifest.operationId !== op.operationId) throw recovery();
    await verifyManifestBundles(roots, scope, project, manifest);
  } catch { throw recovery(); }
  return { binding, manifest, entry, registry: value };
}
export async function verifyManifestBundles(roots, scope, project, manifest) {
  try {
    for (const bundle of manifest.bundles) {
      const { record, body } = await readBundle(roots, scope, project, bundle.id);
      if (recordHash(record) !== bundle.recordHash || sha256(body) !== bundle.bodyHash || record.operationId !== manifest.operationId) throw recovery();
    }
  } catch { throw recovery(); }
}
function assertPublicInput(input) {
  if (!input || Object.keys(input).some((key) => !["scope", "project", "requestId", "recordedBy", "draft", "operationId"].includes(key))) throw new DevctxError("INVALID_INPUT", "Unexpected record field");
}
export async function commitBundle(roots, input, options = {}) {
  assertPublicInput(input);
  if (Object.keys(options).some((key) => !["now", "faults"].includes(key))) throw new DevctxError("INVALID_INPUT", "Unexpected bundle option");
  return commitBundleInternal(roots, input, options);
}
async function commitBundleInternal(roots, input, { now = () => new Date(), faults = {}, supersedes = [] } = {}) {
  const { scope, project, requestId, recordedBy, draft, operationId = null } = input;
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
  assertPublicInput(input);
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-add" }, async () => {
    await requireCommittedProject(roots, input.scope, input.project);
    return commitBundle(roots, input, options);
  }, { destinations: [path] });
}
export async function supersedeRecord(roots, input, options = {}) {
  if (!input || Object.keys(input).some((key) => !["scope", "project", "requestId", "recordedBy", "draft", "targets", "expectHashes"].includes(key))) throw new DevctxError("INVALID_INPUT", "Unexpected supersession field");
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-supersede" }, async () => {
    const snap = await readSnapshot(roots, input.scope, input.project);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length !== input.expectHashes?.length) throw new DevctxError("INVALID_INPUT", "Targets and hashes required");
    for (let i = 0; i < input.targets.length; i++) {
      const target = snap.records.find((r) => r.id === input.targets[i]);
      if (!target || target.effective === "superseded" || target.recordHash !== input.expectHashes[i]) throw new DevctxError("STALE_VERSION", "Target changed");
    }
    return commitBundleInternal(roots, input, { ...options, supersedes: input.targets });
  }, { destinations: [path] });
}
export async function previewRecord(roots, input) {
  await requireCommittedProject(roots, input.scope, input.project);
  return { preview: true, recordId: recordIdFor(input), scope: input.scope, project: input.project };
}
export async function proposeRecord(roots, input, { now = () => new Date() } = {}) {
  assertPublicInput(input);
  if (input.operationId !== undefined) throw new DevctxError("INVALID_INPUT", "Proposal cannot name operation");
  assertScopeId(input.scope); assertProjectId(input.project, input.scope);
  if (!REQUEST_ID.test(input.requestId)) throw new DevctxError("INVALID_ID", "Invalid request ID");
  validateDraft(input.draft, { recordedBy: input.recordedBy });
  if (Object.keys(input.recordedBy).some((key) => !["actor", "runId"].includes(key))) throw new DevctxError("INVALID_INPUT", "Unexpected recorder field");
  const clean = { scope: input.scope, project: input.project, requestId: input.requestId, recordedBy: input.recordedBy, draft: input.draft };
  if (findForbiddenFields(clean).length) throw new DevctxError("INVALID_INPUT", "Forbidden proposal field");
  assertNoSensitive(canonicalJson(clean));
  const proposalId = "prop_" + digest(clean).slice(7, 31);
  const path = join(dirFor(roots, input.scope, input.project), "proposals", proposalId + ".json");
  assertWritable(roots, [path]);
  return withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-propose" }, async () => {
    await requireCommittedProject(roots, input.scope, input.project);
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.dataRoot, ["scopes", input.scope, "projects", input.project, "proposals"]);
    if (!existsSync(path)) await writeNewFile(path, canonicalJson({ schemaVersion: 1, proposalId, input: clean, createdAt: now().toISOString(), review: "unreviewed" }) + "\n");
    return { proposalId, path };
  }, { destinations: [path] });
}
export async function publishProposal(roots, { scope, project, proposalId, review }, { controller, now = () => new Date() } = {}) {
  if (!controller) throw new DevctxError("APPROVAL_REQUIRED", "Controller required");
  assertScopeId(scope); assertProjectId(project, scope);
  if (!/^prop_[a-f0-9]{24}$/.test(proposalId ?? "")) throw new DevctxError("INVALID_ID", "Invalid proposal ID");
  const path = safeJoin(dirFor(roots, scope, project), "proposals", proposalId + ".json");
  const proposal = await readPrivateJson(path);
  if (proposal.input?.scope !== scope || proposal.input?.project !== project) throw new DevctxError("CONFLICT", "Proposal belongs to another project");
  assertPublicInput(proposal.input);
  return addRecord(roots, { ...proposal.input, scope, project, draft: { ...proposal.input.draft, status: "observed", review: review ?? proposal.input.draft.review } }, { now });
}
export { recordHash };
