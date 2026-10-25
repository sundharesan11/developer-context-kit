import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
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
import { commitOnboardingBundle, verifyManifestBundles, readSnapshot } from "../records/store.mjs";
import { writeRunReceipt, ensureRunReceipt } from "../storage/runs.mjs";
const template = readFileSync(fileURLToPath(new URL("../../templates/client-profile.md", import.meta.url)), "utf8");
const PROFILE_TITLE = "Client profile";
const conflict = () => new DevtwinError("BINDING_CONFLICT", "Worktree bound elsewhere", { reason: "bound elsewhere" });
function requestFor(input) {
  assertScopeId(input.scope); assertProjectId(input.project, input.scope);
  if (![undefined, true, false].includes(input.keepPrevious)) throw new DevtwinError("INVALID_INPUT", "Invalid keep-previous flag");
  const request = { ...onboardRequest(input), ...(input.keepPrevious ? { keepPrevious: true } : {}) };
  return { request, requestHash: requestHashFor(request), requestId: input.requestId ?? deterministicRequestId("onboard", request) };
}
function briefBody(plan) {
  return renderProfile(template, {
    brief: plan.candidates.find((c) => c.kind === "brief")?.body ?? "Unknown",
    objectives: "Unknown until recorded",
    hubs: "None selected",
    repository: plan.project,
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
  const brief = { kind: "brief", status: "observed", title: PROFILE_TITLE, body: briefBody(plan), sources: plan.candidates.find((c) => c.kind === "brief")?.sources ?? [], applicability: { level: "project" }, review: null };
  return [{ id: recordIdFor({ scope: plan.scope, project: plan.project, requestId: plan.requestId }), requestId: plan.requestId, draft: brief, supersedes: plan.retire.map((r) => r.id) }, ...selectedCandidates(plan).map((c) => {
    const requestId = "req_" + digest({ requestId: plan.requestId, cid: c.cid }).slice(7, 31);
    return { id: recordIdFor({ scope: plan.scope, project: plan.project, requestId }), requestId, draft: { kind: c.kind, status: "observed", title: c.title, body: c.body, sources: c.sources, applicability: { level: "project" }, review: null } };
  })];
}
// Worktree path of a published onboarding. Legacy operations carry no path: use the current binding entry, else the operation's own binding version, whose last root is the worktree that onboarding added. Unreadable history is skipped.
async function operationPath(roots, registry, op) {
  if (op.path) return op.path;
  const bound = registry.bindings.find((b) => b.operationId === op.operationId);
  if (bound) return bound.path;
  try {
    const manifest = await readManifest(roots, op.scope, op.project, op.operationId, op.manifestHash);
    return (await readBindingByHash(roots, op.scope, op.project, manifest.bindingHash)).roots?.at(-1)?.path;
  } catch { return undefined; }
}
// Auto records from earlier published onboardings of this worktree path that the new plan re-creates (same kind and title), unless already superseded (by anyone, so user targets are kept). readSnapshot has already dropped corrupt records and unlisted operation claims.
async function retireList(roots, registry, input, recreated) {
  const earlier = new Set();
  for (const op of registry.operations) if (op.scope === input.scope && op.project === input.project && (await operationPath(roots, registry, op)) === input.repo) earlier.add(op.operationId);
  if (!earlier.size) return [];
  const { records } = await readSnapshot(roots, input.scope, input.project).catch((error) => {
    if (error.code === "DEVTWIN_RECOVERY_REQUIRED") throw new DevtwinError("RECOVERY_REQUIRED", error.message, { ...error.details, remedy: "repair the project records, or re-run project onboard with --keep-previous to skip retiring earlier records" });
    throw error;
  });
  return records.filter((r) => earlier.has(r.operationId) && recreated.has(canonicalJson([r.kind, r.title])) && r.effective !== "superseded").map((r) => ({ id: r.id, recordHash: r.recordHash })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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
  if (projectEntries.some((b) => b.commonDir !== scan.location.commonDir)) throw new DevtwinError("BINDING_CONFLICT", "Project belongs to another repository");
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
  const plan = { kind: "onboard", pilotDigest: pilot.digest, scope: input.scope, project: input.project, requestId, requestHash, root: scan.location.root, binding, sourceBindings: approvedSources, head: scan.location.head, bundles: [], candidates: derived.candidates, unknowns: derived.unknowns, conflicts: derived.conflicts, registryGeneration: registry.generation, repoWrites: [], accept: input.accept ?? "none", retire: [] };
  if (!input.keepPrevious) plan.retire = await retireList(roots, registry, input, new Set([["brief", PROFILE_TITLE], ...selectedCandidates(plan).map((c) => [c.kind, c.title])].map((x) => canonicalJson(x))));
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
      if (published.scope !== input.scope || published.project !== input.project || published.requestHash !== requestHash) throw new DevtwinError("CONFLICT", "Request ID reused");
      if (fingerprint !== published.planFingerprint) throw new DevtwinError("PLAN_MISMATCH", "Published plan differs");
      const manifest = await readManifest(roots, input.scope, input.project, published.operationId, published.manifestHash);
      if (manifest.requestHash !== requestHash || manifest.planFingerprint !== published.planFingerprint || manifest.operationId !== published.operationId) throw new DevtwinError("RECOVERY_REQUIRED", "Published operation mismatch");
      await readBindingByHash(roots, input.scope, input.project, manifest.bindingHash);
      await verifyManifestBundles(roots, input.scope, input.project, manifest);
      const receipt = onboardReceipt(published, manifest);
      await ensureRunReceipt(roots, "run_" + published.operationId.slice(3), receipt);
      return { ...receipt, replayed: true };
    }
    const plan = await planOnboard(roots, pilot, { ...input, requestId });
    assertFingerprint(plan, fingerprint);
    if (plan.conflicts.some((c) => c.blocking)) throw new DevtwinError("CONFLICT", "Blocking onboarding conflict");
    const existing = findByPath(registry, input.repo);
    if (existing && (existing.scope !== input.scope || existing.project !== input.project)) throw conflict();
    const operationId = operationIdFor({ scope: input.scope, project: input.project, requestId });
    const bindPath = bindingPath(roots, input.scope, input.project, plan.binding.version);
    const manPath = manifestPath(roots, input.scope, input.project, operationId);
    const exact = [join(roots.configRoot, "registry.json"), bindPath, manPath, ...plan.bundles.flatMap((b) => [join(roots.dataRoot, "scopes", input.scope, "projects", input.project, "staging", b.id), join(roots.dataRoot, "scopes", input.scope, "projects", input.project, "records", b.id)])];
    assertWritable(roots, exact);
    const bundles = [];
    for (const item of draftsFor(plan)) {
      const result = await commitOnboardingBundle(roots, { scope: input.scope, project: input.project, requestId: item.requestId, recordedBy: { actor: "human", runId: "run_onboard0001" }, draft: item.draft, operationId }, { now, faults: { beforeRename: faults.beforeRename }, supersedes: item.supersedes ?? [] }).catch((error) => {
        if (error.code === "DEVTWIN_CONFLICT") throw new DevtwinError("CONFLICT", "Staged onboarding differs from current plan", { reason: "staged-bundle-changed", remedy: "re-run project onboard with a new --request-id" });
        throw error;
      });
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
    const entry = { operationId, requestId, requestHash, scope: input.scope, project: input.project, path: input.repo, manifestHash, planFingerprint: fingerprint, generation };
    const bindingEntry = { path: input.repo, commonDir: plan.binding.roots.find((r) => r.path === input.repo).commonDir, scope: input.scope, project: input.project, bindingVersion: plan.binding.version, bindingHash, operationId, manifestHash };
    await publishRegistry(roots, { ...registry, generation, bindings: [...registry.bindings.filter((b) => b.path !== input.repo), bindingEntry], operations: [...registry.operations, entry] }, { expectGeneration: registry.generation });
    if (faults.afterRegistry) await faults.afterRegistry();
    await writeRunReceipt(roots, "run_" + operationId.slice(3), onboardReceipt(entry, manifest));
    return { ...onboardReceipt(entry, manifest), replayed: false };
  }, { destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot] }), { destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot] });
}
