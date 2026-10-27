import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readRegistry } from "../config/registry.mjs";
import { readBindingVersion, readManifest } from "../config/store.mjs";
import { readPrivateJson, readPrivateText, writeNewFile, ensurePrivatePath, fsyncDir, safeJoin } from "../storage/fsx.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { recordIdFor, assertScopeId, assertProjectId, RECORD_ID } from "../identity/ids.mjs";
import { buildRecord, validateRecord, validateDraft, recordHash, assertProjectReach } from "./schema.mjs";
import { assertNoSensitive, findForbiddenFields } from "./redact.mjs";
const dirFor = (roots, scope, project) => join(roots.dataRoot, "scopes", scope, "projects", project);
const recDir = (roots, scope, project, id) => join(dirFor(roots, scope, project), "records", id);
// U37: where a record lands, so the audit log can tell whether an entry's write landed.
export const projectRecordFile = (roots, scope, project, id) => join(recDir(roots, scope, project, id), "record.json");
const recovery = () => new DevtwinError("RECOVERY_REQUIRED", "Incomplete committed project");
async function readBundle(roots, scope, project, id) {
  try {
    const dir = recDir(roots, scope, project, id);
    const record = validateRecord(await readPrivateJson(join(dir, "record.json")));
    const body = await readPrivateText(join(dir, "body.md"), 32768);
    if (record.id !== id || recordIdFor({ scope, project, requestId: record.requestId }) !== id || record.scope !== scope || record.project !== project || sha256(body) !== record.bodyHash || Buffer.byteLength(body) !== record.bodyBytes) throw new DevtwinError("INTEGRITY", "Bundle mismatch");
    return { record, body };
  } catch (error) { if (error.code === "ENOENT") throw new DevtwinError("INTEGRITY", "Bundle missing"); throw error; }
}
export async function requireCommittedProject(roots, scope, project) {
  assertScopeId(scope); assertProjectId(project, scope);
  const { value } = await readRegistry(roots);
  const entry = value.bindings.filter((x) => x.scope === scope && x.project === project).reduce((latest, x) => !latest || x.bindingVersion > latest.bindingVersion ? x : latest, null);
  if (!entry) throw new DevtwinError("PROJECT_UNBOUND", "Project unbound");
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
const INPUT_KEYS = ["scope", "project", "requestId", "recordedBy", "draft"];
function assertPublicInput(input) {
  if (!input || Object.keys(input).some((key) => !INPUT_KEYS.includes(key))) throw new DevtwinError("INVALID_INPUT", "Unexpected record field");
}
function assertBundleOptions(options) {
  if (Object.keys(options).some((key) => !["now", "faults", "retraction"].includes(key))) throw new DevtwinError("INVALID_INPUT", "Unexpected bundle option");
}
export async function commitBundle(roots, input, options = {}) {
  assertPublicInput(input); assertBundleOptions(options);
  return commitBundleInternal(roots, input, options);
}
// Onboarding only: the sole path that may stamp a record with an operation ID (and, for the client profile, supersede retired auto records). readSnapshot trusts the claim only if that operation's manifest lists the record.
export async function commitOnboardingBundle(roots, input, options = {}) {
  if (!input || Object.keys(input).some((key) => ![...INPUT_KEYS, "operationId"].includes(key)) || !/^op_[a-f0-9]{24}$/.test(input.operationId ?? "")) throw new DevtwinError("INVALID_INPUT", "Unexpected record field");
  const { supersedes = [], ...rest } = options;
  if (!Array.isArray(supersedes) || supersedes.some((x) => typeof x !== "string" || !RECORD_ID.test(x)) || canonicalJson(supersedes) !== canonicalJson([...new Set(supersedes)].sort())) throw new DevtwinError("INVALID_INPUT", "Invalid onboarding supersession");
  assertBundleOptions(rest);
  return commitBundleInternal(roots, input, { ...rest, supersedes });
}
// retraction: true lets the draft be a retraction; only undo passes it (src/audit/undo.mjs).
async function commitBundleInternal(roots, input, { now = () => new Date(), faults = {}, supersedes = [], retraction = false } = {}) {
  const { scope, project, requestId, recordedBy, draft, operationId = null } = input;
  if (!REQUEST_ID.test(requestId)) throw new DevtwinError("INVALID_ID", "Invalid request ID");
  const id = recordIdFor({ scope, project, requestId });
  const base = dirFor(roots, scope, project);
  const stage = join(base, "staging", id), dest = recDir(roots, scope, project, id);
  assertWritable(roots, [stage, dest]);
  const requestHash = digest({ scope, project, requestId, recordedBy, draft, supersedes });
  if (existsSync(dest)) {
    const { record } = await readBundle(roots, scope, project, id);
    if (record.requestHash !== requestHash) throw new DevtwinError("CONFLICT", "Request ID reused");
    return { recordId: id, recordHash: recordHash(record), created: false };
  }
  if (existsSync(stage)) throw new DevtwinError("RECOVERY_REQUIRED", "Orphan staging retained", { staging: [id] });
  const record = buildRecord({ scope, project, requestId, requestHash, operationId, recordedBy, draft, supersedes }, { now, retraction });
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
// Map of published operation ID -> (record ID -> record hash) from that operation's manifest; other projects' operations list nothing here.
async function operationBundles(roots, scope, project, operations) {
  const claims = new Map();
  for (const op of operations) {
    const listed = new Map();
    claims.set(op.operationId, listed);
    if (op.scope !== scope || op.project !== project) continue;
    try { for (const b of (await readManifest(roots, scope, project, op.operationId, op.manifestHash)).bundles) listed.set(b.id, b.recordHash); } catch { /* An unreadable manifest vouches for no record. */ }
  }
  return claims;
}
// Records that can reach themselves through supersession among present records (self-reference is rejected earlier).
function cycleMembers(records) {
  const edges = new Map(records.map((r) => [r.id, r.supersedes])), cyclic = new Set();
  for (const id of edges.keys()) {
    const seen = new Set(), queue = [...edges.get(id)];
    while (queue.length) {
      const next = queue.pop();
      if (next === id) { cyclic.add(id); break; }
      if (seen.has(next) || !edges.has(next)) continue;
      seen.add(next); queue.push(...edges.get(next));
    }
  }
  return cyclic;
}
export async function readSnapshot(roots, scope, project) {
  const committed = await requireCommittedProject(roots, scope, project);
  const directory = join(dirFor(roots, scope, project), "records");
  let ids;
  try { ids = (await readdir(directory)).sort(); } catch (error) { if (error.code === "ENOENT") ids = []; else throw error; }
  const corrupt = [];
  let hiddenUncommitted = 0;
  const published = new Set(committed.registry.operations.map((op) => op.operationId));
  const claims = await operationBundles(roots, scope, project, committed.registry.operations);
  const candidates = [];
  for (const id of ids) {
    try {
      const { record, body } = await readBundle(roots, scope, project, id);
      if (record.operationId && !published.has(record.operationId)) { hiddenUncommitted++; continue; }
      const hash = recordHash(record);
      if (record.operationId && claims.get(record.operationId)?.get(id) !== hash) throw new DevtwinError("INTEGRITY", "Unlisted operation claim");
      assertSupersedesShape(record);
      candidates.push({ ...record, body, recordHash: hash, effective: record.status, supersededBy: [] });
    } catch { corrupt.push({ id, code: "DEVTWIN_INTEGRITY" }); }
  }
  return { ...resolveSupersession(candidates, corrupt), hiddenUncommitted };
}
// supersedes must list distinct record IDs other than the record's own.
export function assertSupersedesShape(record) {
  if (!Array.isArray(record.supersedes) || record.supersedes.some((x) => typeof x !== "string" || !RECORD_ID.test(x) || x === record.id) || new Set(record.supersedes).size !== record.supersedes.length) throw new DevtwinError("INTEGRITY", "Invalid supersession");
}
// Shared by the project, personal and org readers. Cycle members join corrupt; the rest get effective and supersededBy.
export function resolveSupersession(candidates, corrupt = []) {
  const records = [], cyclic = cycleMembers(candidates);
  for (const r of candidates) if (cyclic.has(r.id)) corrupt.push({ id: r.id, code: "DEVTWIN_INTEGRITY" }); else records.push(r);
  corrupt.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) for (const id of r.supersedes) {
    const predecessor = byId.get(id);
    if (predecessor) { predecessor.effective = "superseded"; predecessor.supersededBy.push(r.id); }
  }
  return { records, corrupt };
}
// U31 (KTD30): after a record write, the project's session summary is rebuilt under the scope lock, once this write
// has released it. The summary is a cache, so its failure never fails the write (src/context/summary.mjs).
async function afterWrite(roots, input, options, result) {
  const { refreshSummaries } = await import("../context/summary.mjs");
  await refreshSummaries(roots, input.scope, input.project, options.now ? { now: options.now } : {});
  return result;
}
export async function addRecord(roots, input, options = {}) {
  assertPublicInput(input);
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return afterWrite(roots, input, options, await withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-add" }, async () => {
    await requireCommittedProject(roots, input.scope, input.project);
    return commitBundle(roots, input, options);
  }, { destinations: [path] }));
}
export async function supersedeRecord(roots, input, options = {}) {
  if (!input || Object.keys(input).some((key) => !["scope", "project", "requestId", "recordedBy", "draft", "targets", "expectHashes"].includes(key))) throw new DevtwinError("INVALID_INPUT", "Unexpected supersession field");
  const path = recDir(roots, input.scope, input.project, recordIdFor(input));
  assertWritable(roots, [path, scopeLockPath(roots, input.scope)]);
  return afterWrite(roots, input, options, await withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "record-supersede" }, async () => {
    const snap = await readSnapshot(roots, input.scope, input.project);
    if (!Array.isArray(input.targets) || input.targets.length === 0 || input.targets.length !== input.expectHashes?.length) throw new DevtwinError("INVALID_INPUT", "Targets and hashes required");
    for (let i = 0; i < input.targets.length; i++) {
      const target = snap.records.find((r) => r.id === input.targets[i]);
      if (!target || target.effective === "superseded" || target.recordHash !== input.expectHashes[i]) throw new DevtwinError("STALE_VERSION", "Target changed");
    }
    return commitBundleInternal(roots, input, { ...options, supersedes: input.targets });
  }, { destinations: [path] }));
}
export async function previewRecord(roots, input) {
  await requireCommittedProject(roots, input.scope, input.project);
  return { preview: true, recordId: recordIdFor(input), scope: input.scope, project: input.project };
}
export async function proposeRecord(roots, input, { now = () => new Date() } = {}) {
  assertPublicInput(input);
  if (input.operationId !== undefined) throw new DevtwinError("INVALID_INPUT", "Proposal cannot name operation");
  assertScopeId(input.scope); assertProjectId(input.project, input.scope);
  if (!REQUEST_ID.test(input.requestId)) throw new DevtwinError("INVALID_ID", "Invalid request ID");
  validateDraft(input.draft, { recordedBy: input.recordedBy });
  assertProjectReach(input.draft);
  if (Object.keys(input.recordedBy).some((key) => !["actor", "runId"].includes(key))) throw new DevtwinError("INVALID_INPUT", "Unexpected recorder field");
  const clean = { scope: input.scope, project: input.project, requestId: input.requestId, recordedBy: input.recordedBy, draft: input.draft };
  if (findForbiddenFields(clean).length) throw new DevtwinError("INVALID_INPUT", "Forbidden proposal field");
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
  if (!controller) throw new DevtwinError("APPROVAL_REQUIRED", "Controller required");
  assertScopeId(scope); assertProjectId(project, scope);
  if (!/^prop_[a-f0-9]{24}$/.test(proposalId ?? "")) throw new DevtwinError("INVALID_ID", "Invalid proposal ID");
  const path = safeJoin(dirFor(roots, scope, project), "proposals", proposalId + ".json");
  const proposal = await readPrivateJson(path);
  if (proposal.input?.scope !== scope || proposal.input?.project !== project) throw new DevtwinError("CONFLICT", "Proposal belongs to another project");
  assertPublicInput(proposal.input);
  return addRecord(roots, { ...proposal.input, scope, project, draft: { ...proposal.input.draft, status: "observed", review: review ?? proposal.input.draft.review } }, { now });
}
export { recordHash };
