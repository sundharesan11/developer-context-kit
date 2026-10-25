import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable, assertInPilot } from "./pilot.mjs";
import { assertScopeId, assertProjectId, assertActorRef } from "../identity/ids.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { readPrivateJson, readPrivateText, writeNewFile, ensurePrivateDir, ensurePrivatePath, fsyncDir } from "../storage/fsx.mjs";
import { withPilotLock, registryLockPath, scopeLockPath } from "../storage/lock.mjs";
import { assertNoSensitive } from "../records/redact.mjs";
import { gitQuery } from "../identity/git.mjs";
import { deepestExisting } from "./roots.mjs";
const invalid = () => { throw new DevtwinError("INVALID_INPUT", "Invalid configuration"); };
export function validatePreferences(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.keys(value).some((key) => !["explanationStyle", "diagrams", "notes"].includes(key))) invalid();
  if (value.explanationStyle !== undefined && !["concise", "detailed"].includes(value.explanationStyle)) invalid();
  if (value.diagrams !== undefined && !["prefer", "avoid", "neutral"].includes(value.diagrams)) invalid();
  if (value.notes !== undefined) {
    if (!Array.isArray(value.notes) || value.notes.length > 10 || value.notes.some((n) => typeof n !== "string" || n.length > 200 || /[\r\n]/.test(n))) invalid();
    for (const note of value.notes) assertNoSensitive(note);
  }
  if (Buffer.byteLength(canonicalJson(value)) > 2048) invalid();
  return value;
}
export async function planInit(roots, input = {}) {
  validatePreferences(input.preferences ?? {});
  return { preview: true, destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot] };
}
export async function applyInit(roots, { actorRefs = [], preferences = {}, now = () => new Date() } = {}) {
  validatePreferences(preferences);
  actorRefs.forEach(assertActorRef);
  const userPath = join(roots.configRoot, "user.json"), registryPath = join(roots.configRoot, "registry.json");
  for (const root of [roots.configRoot, roots.dataRoot, roots.stateRoot]) {
    if (gitQuery(deepestExisting(root), ["rev-parse", "--is-inside-work-tree"], { notRepo: true }).stdout.trim() === "true") throw new DevtwinError("PATH_UNSAFE", "Private roots inside Git worktree");
  }
  assertWritable(roots, [roots.configRoot, roots.dataRoot, roots.stateRoot, userPath, registryPath]);
  return withPilotLock(roots, registryLockPath(roots), { kind: "init" }, async () => {
    assertWritable(roots, [roots.configRoot, roots.dataRoot, roots.stateRoot, userPath, registryPath]);
    for (const path of [roots.configRoot, roots.dataRoot, roots.stateRoot]) ensurePrivateDir(path);
    if (existsSync(userPath) !== existsSync(registryPath)) throw new DevtwinError("RECOVERY_REQUIRED", "Partial initialization");
    if (existsSync(userPath)) {
      const old = await readPrivateJson(userPath);
      if (canonicalJson({ actorRefs: old.actorRefs, preferences: old.preferences }) !== canonicalJson({ actorRefs, preferences })) throw new DevtwinError("CONFLICT", "Initialization differs");
      return { created: false };
    }
    await writeNewFile(userPath, canonicalJson({ schemaVersion: 1, actorRefs, preferences, createdAt: now().toISOString() }) + "\n");
    await writeNewFile(registryPath, canonicalJson({ schemaVersion: 1, generation: 0, bindings: [], operations: [] }) + "\n");
    fsyncDir(roots.configRoot);
    return { created: true };
  }, { destinations: [roots.configRoot, roots.dataRoot, roots.stateRoot, userPath, registryPath] });
}
export function parseHub(text, pilot) {
  const match = /^([a-z][a-z0-9-]*)=local-dir:(\/[^:]+)(?::([a-z,\-]+))?$/.exec(text ?? "");
  if (!match) invalid();
  assertInPilot(pilot, match[2], "inputsRoot");
  return { id: match[1], kind: "local-dir", path: match[2], purposes: match[3] ? match[3].split(",") : [] };
}
export function parsePolicy(text) {
  const match = /^(pol_[a-z0-9-]{3,40})=([a-z][a-z0-9-]*):([^:]+)(?::(required))?$/.exec(text ?? "");
  if (!match) invalid();
  assertSourceRel(match[3]);
  if (isDeniedRel(match[3])) invalid();
  return { id: match[1], hubId: match[2], rel: match[3], required: Boolean(match[4]) };
}
export async function planScopeAdd(roots, input) { assertScopeId(input.scope); return { preview: true, scope: input.scope }; }
export async function applyScopeAdd(roots, { scope, displayName, hubs = [], policies = [], now = () => new Date() }) {
  assertScopeId(scope);
  if (policies.some((policy) => !hubs.some((hub) => hub.id === policy.hubId))) invalid();
  for (const hub of hubs) assertInPilot(roots.pilot, hub.path, "inputsRoot");
  const path = join(roots.configRoot, "scopes", scope + ".json");
  assertWritable(roots, [path]);
  return withPilotLock(roots, scopeLockPath(roots, scope), { kind: "scope-add" }, async () => {
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.configRoot, ["scopes"]);
    const desired = { schemaVersion: 1, id: scope, displayName: displayName ?? scope, hubs, policies, accounts: [], createdAt: now().toISOString() };
    if (existsSync(path)) {
      const old = await readPrivateJson(path);
      if (canonicalJson({ ...old, createdAt: null }) !== canonicalJson({ ...desired, createdAt: null })) throw new DevtwinError("CONFLICT", "Scope differs");
      return { created: false, scope };
    }
    await writeNewFile(path, canonicalJson(desired) + "\n");
    fsyncDir(join(roots.configRoot, "scopes"));
    return { created: true, scope };
  }, { destinations: [path] });
}
export async function loadScope(roots, scope) {
  assertScopeId(scope);
  try { return await readPrivateJson(join(roots.configRoot, "scopes", scope + ".json")); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("SCOPE_UNKNOWN", "Scope unknown"); throw error; }
}
export function bindingPath(roots, scope, project, version) {
  assertScopeId(scope); assertProjectId(project, scope);
  return join(roots.configRoot, "projects", scope, project, "v" + version + ".json");
}
export async function writeBindingVersion(roots, binding) {
  const path = bindingPath(roots, binding.scope, binding.project, binding.version);
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.configRoot, ["projects", binding.scope, binding.project]);
  const content = canonicalJson(binding) + "\n", hash = sha256(content);
  if (existsSync(path)) {
    if (await readPrivateText(path) === content) return hash;
    throw new DevtwinError("RECOVERY_REQUIRED", "Binding conflict");
  }
  await writeNewFile(path, content); fsyncDir(join(roots.configRoot, "projects", binding.scope, binding.project)); return hash;
}
export async function readBindingVersion(roots, entry) {
  const path = bindingPath(roots, entry.scope, entry.project, entry.bindingVersion);
  let text;
  try { text = await readPrivateText(path); } catch { throw new DevtwinError("RECOVERY_REQUIRED", "Binding unavailable"); }
  if (sha256(text) !== entry.bindingHash) throw new DevtwinError("RECOVERY_REQUIRED", "Binding hash mismatch");
  return JSON.parse(text);
}
export async function readBindingByHash(roots, scope, project, expectedHash) {
  const dir = join(roots.configRoot, "projects", scope, project);
  let names;
  try { names = await readdir(dir); } catch { throw new DevtwinError("RECOVERY_REQUIRED", "Historical binding unavailable"); }
  for (const name of names) {
    const match = /^v([1-9][0-9]*)\.json$/.exec(name);
    if (!match) continue;
    let text;
    try { text = await readPrivateText(join(dir, name)); } catch { continue; }
    if (sha256(text) !== expectedHash) continue;
    try {
      const binding = JSON.parse(text);
      if (binding.scope === scope && binding.project === project && binding.version === Number(match[1])) return binding;
    } catch { /* A matching hash still needs a valid binding. */ }
  }
  throw new DevtwinError("RECOVERY_REQUIRED", "Historical binding unavailable");
}
export function manifestPath(roots, scope, project, operationId) { assertProjectId(project, scope); return join(roots.dataRoot, "scopes", scope, "projects", project, "operations", operationId + ".json"); }
export async function writeManifest(roots, manifest) {
  const path = manifestPath(roots, manifest.scope, manifest.project, manifest.operationId);
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.dataRoot, ["scopes", manifest.scope, "projects", manifest.project, "operations"]);
  const text = canonicalJson(manifest) + "\n", hash = sha256(text);
  if (existsSync(path)) {
    if (await readPrivateText(path) === text) return hash;
    throw new DevtwinError("RECOVERY_REQUIRED", "Manifest conflict");
  }
  await writeNewFile(path, text); fsyncDir(join(roots.dataRoot, "scopes", manifest.scope, "projects", manifest.project, "operations")); return hash;
}
export async function readManifest(roots, scope, project, operationId, expectHash) {
  let text;
  try { text = await readPrivateText(manifestPath(roots, scope, project, operationId)); } catch { throw new DevtwinError("RECOVERY_REQUIRED", "Manifest unavailable"); }
  if (sha256(text) !== expectHash) throw new DevtwinError("RECOVERY_REQUIRED", "Manifest hash mismatch");
  return JSON.parse(text);
}
