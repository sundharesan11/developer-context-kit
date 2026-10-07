import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DevctxError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { readRegistry, findByPath, publishRegistry } from "../config/registry.mjs";
import { loadScope, bindingPath, writeBindingVersion, readBindingVersion, readBindingByHash, manifestPath, writeManifest, readManifest } from "../config/store.mjs";
import { withPilotLock, registryLockPath, scopeLockPath } from "../storage/lock.mjs";
import { onboardRequest, requestHashFor, deterministicRequestId, finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sourceIdentity } from "../storage/source-read.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { digest, sha256, canonicalJson } from "../storage/canonical.mjs";
import { recordIdFor, operationIdFor, assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { scanRepository } from "./scan.mjs";
import { deriveCandidates } from "./candidates.mjs";
import { renderProfile } from "./profile.mjs";
import { commitBundle, verifyManifestBundles } from "../records/store.mjs";
import { writeRunReceipt } from "../storage/runs.mjs";
const template = readFileSync(fileURLToPath(new URL("../../templates/client-profile.md", import.meta.url)), "utf8");
const conflict = () => new DevctxError("BINDING_CONFLICT", "Worktree bound elsewhere", { reason: "bound elsewhere" });
function requestFor(input) {
  assertScopeId(input.scope); assertProjectId(input.project, input.scope);
  const request = onboardRequest(input);
  return { request, requestHash: requestHashFor(request), requestId: input.requestId ?? deterministicRequestId("onboard", request) };
}
function briefBody(plan) {
  return renderProfile(template, {
    brief: plan.candidates.find((c) => c.kind === "brief")?.body ?? "Unknown",
    objectives: "Unknown until recorded",
    hubs: "None selected",
    repository: plan.root,
    commands: plan.candidates.filter((c) => c.kind === "command").map((c) => c.body).join("\n") || "Unknown",
    environments: plan.candidates.filter((c) => c.kind === "environment").map((c) => c.title).join(", ") || "Unknown",
    contacts: "Unknown until recorded",
    facts: plan.candidates.filter((c) => c.kind === "fact").map((c) => c.body).join("\n") || "Unknown",
    unknowns: plan.unknowns.join("\n"),
    handoffs: "None"
  });
}
function selectedCandidates(plan) {
  const accept = plan.accept;
  return accept === "all" ? plan.candidates : accept === "none" ? [] : plan.candidates.filter((c) => accept.includes(c.cid));
}
function draftsFor(plan) {
  const brief = { kind: "brief", status: "observed", title: "Client profile", body: briefBody(plan), sources: plan.candidates.find((c) => c.kind === "brief")?.sources ?? [], applicability: { level: "project" }, review: null };
  return [{ id: recordIdFor({ scope: plan.scope, project: plan.project, requestId: plan.requestId }), requestId: plan.requestId, draft: brief }, ...selectedCandidates(plan).map((c) => {
    const requestId = "req_" + digest({ requestId: plan.requestId, cid: c.cid }).slice(7, 31);
    return { id: recordIdFor({ scope: plan.scope, project: plan.project, requestId }), requestId, draft: { kind: c.kind, status: "observed", title: c.title, body: c.body, sources: c.sources, applicability: { level: "project" }, review: null } };
  })];
}
export async function planOnboard(roots, pilot, input) {
  const { requestHash, requestId } = requestFor(input);
  assertInPilot(pilot, input.repo, "repos");
  await loadScope(roots, input.scope);
  const registry = (await readRegistry(roots)).value;
  const existing = findByPath(registry, input.repo);
  if (existing && (existing.scope !== input.scope || existing.project !== input.project)) throw conflict();
  const scan = await scanRepository({ repo: input.repo, approvedDocs: input.approvedDocs ?? [] });
  const derived = deriveCandidates(scan, { expectedRemotes: input.expectedRemotes ?? [], environments: input.environments ?? [] });
  const approvedSources = scan.sources.filter((s) => !s.skipped).map(sourceIdentity);
  const projectEntries = registry.bindings.filter((b) => b.scope === input.scope && b.project === input.project);
  if (projectEntries.some((b) => b.commonDir !== scan.location.commonDir)) throw new DevctxError("BINDING_CONFLICT", "Project belongs to another repository");
  const latest = projectEntries.reduce((a, b) => !a || b.bindingVersion > a.bindingVersion ? b : a, null);
  const previous = latest ? await readBindingVersion(roots, latest) : null;
  const versionDir = join(roots.configRoot, "projects", input.scope, input.project);
  const diskVersions = existsSync(versionDir) ? readdirSync(versionDir).map((name) => /^v([1-9][0-9]*)\.json$/.exec(name)).filter(Boolean).map((match) => Number(match[1])) : [];
  const newRoot = { path: scan.location.root, commonDir: scan.location.commonDir, kind: scan.location.kind };
  const rootsList = [...(previous?.roots ?? []).filter((r) => r.path !== newRoot.path), newRoot];
  const bindingBase = { schemaVersion: 1, scope: input.scope, project: input.project, roots: rootsList, remotes: scan.location.remotes.map((r) => ({ ...r, role: "evidence" })), approvedSources, expectedRemotes: input.expectedRemotes ?? [], actorRefs: input.actorRefs ?? [], environments: input.environments ?? [] };
  let version = Math.max(0, ...diskVersions, ...projectEntries.map((b) => b.bindingVersion)) + 1;
  if (diskVersions.length && Math.max(...diskVersions) > Math.max(0, ...projectEntries.map((b) => b.bindingVersion))) {
    const candidateVersion = Math.max(...diskVersions);
    try {
      const orphan = await readPrivateJson(bindingPath(roots, input.scope, input.project, candidateVersion));
      const { createdAt, version: ignored, ...orphanBase } = orphan;
      if (canonicalJson(orphanBase) === canonicalJson(bindingBase)) version = candidateVersion;
    } catch { /* A damaged orphan cannot be reused. */ }
  }
  const binding = { ...bindingBase, version };
  const plan = { kind: "onboard", pilotDigest: pilot.digest, scope: input.scope, project: input.project, requestId, requestHash, root: scan.location.root, binding, sourceBindings: approvedSources, head: scan.location.head, bundles: [], candidates: derived.candidates, unknowns: derived.unknowns, conflicts: derived.conflicts, registryGeneration: registry.generation, repoWrites: [], accept: input.accept ?? "none" };
  plan.bundles = draftsFor(plan).map((x) => ({ id: x.id, kind: x.draft.kind, title: x.draft.title, bodyHash: sha256(x.draft.body) }));
  return finalizePlan(plan);
}
export function onboardReceipt(operationEntry, manifest) {
  return { operationId: operationEntry.operationId, requestId: operationEntry.requestId, scope: operationEntry.scope, project: operationEntry.project, manifestHash: operationEntry.manifestHash, bindingHash: manifest.bindingHash, bundles: manifest.bundles.map((b) => ({ id: b.id, recordHash: b.recordHash })), committedGeneration: operationEntry.generation };
}
export async function applyOnboard(roots, pilot, input, { fingerprint, now = () => new Date(), faults = {} } = {}) {
  const { requestHash, requestId } = requestFor(input);
  assertInPilot(pilot, input.repo, "repos");
  assertWritable(roots, [registryLockPath(roots), scopeLockPath(roots, input.scope), roots.configRoot, roots.dataRoot, roots.stateRoot]);
  return withPilotLock(roots, registryLockPath(roots), { kind: "onboard", requestId }, async () => withPilotLock(roots, scopeLockPath(roots, input.scope), { kind: "onboard", requestId }, async () => {
    const registry = (await readRegistry(roots)).value;
    const published = registry.operations.find((x) => x.requestId === requestId);
    if (published) {
      if (published.scope !== input.scope || published.project !== input.project || published.requestHash !== requestHash) throw new DevctxError("CONFLICT", "Request ID reused");
      if (fingerprint !== published.planFingerprint) throw new DevctxError("PLAN_MISMATCH", "Published plan differs");
      const manifest = await readManifest(roots, input.scope, input.project, published.operationId, published.manifestHash);
      if (manifest.requestHash !== requestHash || manifest.planFingerprint !== published.planFingerprint || manifest.operationId !== published.operationId) throw new DevctxError("RECOVERY_REQUIRED", "Published operation mismatch");
      await readBindingByHash(roots, input.scope, input.project, manifest.bindingHash);
      await verifyManifestBundles(roots, input.scope, input.project, manifest);
      return { ...onboardReceipt(published, manifest), replayed: true };
    }
    const plan = await planOnboard(roots, pilot, { ...input, requestId });
    assertFingerprint(plan, fingerprint);
    if (plan.conflicts.some((c) => c.blocking)) throw new DevctxError("CONFLICT", "Blocking onboarding conflict");
    const existing = findByPath(registry, input.repo);
    if (existing && (existing.scope !== input.scope || existing.project !== input.project)) throw conflict();
    const operationId = operationIdFor({ scope: input.scope, project: input.project, requestId });
    const bindPath = bindingPath(roots, input.scope, input.project, plan.binding.version);
    const manPath = manifestPath(roots, input.scope, input.project, operationId);
    const exact = [join(roots.configRoot, "registry.json"), bindPath, manPath, ...plan.bundles.flatMap((b) => [join(roots.dataRoot, "scopes", input.scope, "projects", input.project, "staging", b.id), join(roots.dataRoot, "scopes", input.scope, "projects", input.project, "records", b.id)])];
    assertWritable(roots, exact);
    const bundles = [];
    for (const item of draftsFor(plan)) {
      const result = await commitBundle(roots, { scope: input.scope, project: input.project, requestId: item.requestId, recordedBy: { actor: "human", runId: "run_onboard0001" }, draft: item.draft, operationId }, { now, faults: { beforeRename: faults.beforeRename } });
      bundles.push({ id: result.recordId, recordHash: result.recordHash, bodyHash: result.bodyHash ?? plan.bundles.find((b) => b.id === result.recordId).bodyHash });
    }
    if (faults.afterBundles) await faults.afterBundles();
    let createdAt = now().toISOString();
    if (existsSync(bindPath)) createdAt = (await readPrivateJson(bindPath)).createdAt;
    const bindingHash = await writeBindingVersion(roots, { ...plan.binding, createdAt });
    if (faults.afterBinding) await faults.afterBinding();
    const manifest = { schemaVersion: 1, operationId, kind: "onboard", requestId, requestHash, scope: input.scope, project: input.project, bindingHash, planFingerprint: fingerprint, bundles };
    const manifestHash = await writeManifest(roots, manifest);
    if (faults.afterManifest) await faults.afterManifest();
    const generation = registry.generation + 1;
    const entry = { operationId, requestId, requestHash, scope: input.scope, project: input.project, manifestHash, planFingerprint: fingerprint, generation };
    const bindingEntry = { path: input.repo, commonDir: plan.binding.roots.find((r) => r.path === input.repo).commonDir, scope: input.scope, project: input.project, bindingVersion: plan.binding.version, bindingHash, operationId, manifestHash };
    await publishRegistry(roots, { ...registry, generation, bindings: [...registry.bindings.filter((b) => b.path !== input.repo), bindingEntry], operations: [...registry.operations, entry] }, { expectGeneration: registry.generation });
    if (faults.afterRegistry) await faults.afterRegistry();
    await writeRunReceipt(roots, "run_" + operationId.slice(3), onboardReceipt(entry, manifest));
    return { ...onboardReceipt(entry, manifest), replayed: false };
  }, { destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot] }), { destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot] });
}
