import { existsSync, lstatSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DevctxError } from "../errors.mjs";
import { assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { assertWritable, assertInPilot } from "../config/pilot.mjs";
import { loadScope } from "../config/store.mjs";
import { readRegistry } from "../config/registry.mjs";
import { safeJoin, ensurePrivatePath, readPrivateJson, readPrivateText, writeNewFile, fsyncDir, checkNode, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { validateRoot } from "../config/roots.mjs";
import { assertNoSensitive, findForbiddenFields } from "../records/redact.mjs";
import { assertPackageRel, parseFrontmatter, validatePackage, VALIDATOR_VERSION, PACKAGE_LIMITS, SKILL_NAME } from "./validate.mjs";

const IDS = { workspace: /^ws_[a-z0-9_-]{8,64}$/, requirements: /^rq_[a-z0-9_-]{8,64}$/, design: /^ds_[a-z0-9_-]{8,64}$/, decision: /^dc_[a-z0-9_-]{8,64}$/, revision: /^rv_[a-z0-9_-]{8,64}$/ };
function needId(kind, id) { if (typeof id !== "string" || !IDS[kind].test(id)) throw new DevctxError("INVALID_ID", "Invalid skill-builder identifier"); return id; }
function exact(value, fields) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw new DevctxError("INVALID_INPUT", "Invalid skill-builder data"); }
function nonempty(value, max = 2048) { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"); }
function strings(value, max = 12) { return Array.isArray(value) && value.length <= max && value.every((x) => nonempty(x, 1024)); }
function scopeParts({ audience, scope, project, workspace }) {
  needId("workspace", workspace);
  if (audience === "personal" && !scope && !project) return ["personal", "skill-workspaces", workspace];
  if (audience === "company" && scope && !project) { assertScopeId(scope); return ["scopes", scope, "skill-workspaces", workspace]; }
  if (audience === "project" && scope && project) { assertScopeId(scope); assertProjectId(project, scope); return ["scopes", scope, "projects", project, "skill-workspaces", workspace]; }
  throw new DevctxError("INVALID_INPUT", "Invalid skill audience or scope");
}
export function workspacePath(roots, selection) { return safeJoin(roots.dataRoot, ...scopeParts(selection)); }
async function membership(roots, selection) {
  if (selection.audience === "personal") return;
  await loadScope(roots, selection.scope);
  if (selection.audience === "project" && !(await readRegistry(roots)).value.bindings.some((b) => b.scope === selection.scope && b.project === selection.project)) throw new DevctxError("NOT_FOUND", "Project is not registered in this pilot");
}
async function locked(roots, destinations, action) {
  const lock = join(roots.stateRoot, "locks", "skill-builder.lock");
  assertWritable(roots, [lock, ...destinations]);
  return withPilotLock(roots, lock, { kind: "skill-builder" }, action, { destinations });
}
function workspaceExists(path) { if (!info(path)) throw new DevctxError("NOT_FOUND", "Skill workspace unavailable"); checkNode(info(path), path, { directory: true }); }
function privateJson(value) { if (findForbiddenFields(value).length) throw new DevctxError("INVALID_INPUT", "Forbidden metadata field"); assertNoSensitive(canonicalJson(value)); return canonicalJson(value) + "\n"; }
async function namedJson(path) { const value = await readPrivateJson(path); if (!value || value.schemaVersion !== 1) throw new DevctxError("INTEGRITY", "Unsupported skill-builder record"); return value; }
function jsonPath(base, kind, id) { return safeJoin(base, kind, needId(kind === "requirements" ? "requirements" : kind === "designs" ? "design" : "decision", id) + ".json"); }
async function inputJson(pilot, path) {
  if (typeof path !== "string") throw new DevctxError("INVALID_INPUT", "Input file required");
  assertInPilot(pilot, dirname(path), "inputsRoot");
  const read = await readApprovedSource(pilot.inputsRoot, relative(pilot.inputsRoot, path));
  if (read.skipped || !read.utf8Valid || read.size > PACKAGE_LIMITS.fileBytes) throw new DevctxError("INVALID_INPUT", "Input file unavailable");
  if (lstatSync(path).nlink !== 1) throw new DevctxError("PATH_UNSAFE", "Linked input refused");
  let value; try { value = JSON.parse(read.text); } catch { throw new DevctxError("INVALID_INPUT", "Invalid JSON input"); }
  privateJson(value);
  return value;
}
export async function createWorkspace(roots, selection) {
  const path = workspacePath(roots, selection);
  return locked(roots, [path], async () => {
    await membership(roots, selection);
    if (existsSync(path)) throw new DevctxError("CONFLICT", "Skill workspace exists");
    const parts = scopeParts(selection);
    ensurePrivatePath(roots.dataRoot, parts);
    const meta = { schemaVersion: 1, audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace };
    await writeNewFile(join(path, "workspace.json"), privateJson(meta));
    return { audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace };
  });
}
async function base(roots, selection) {
  const path = workspacePath(roots, selection);
  await membership(roots, selection);
  validateRoot(path, "workspace");
  workspaceExists(path);
  const meta = await namedJson(join(path, "workspace.json"));
  if (meta.audience !== selection.audience || meta.scope !== (selection.scope ?? null) || meta.project !== (selection.project ?? null) || meta.workspace !== selection.workspace) throw new DevctxError("INTEGRITY", "Workspace scope mismatch");
  return path;
}
function validateRequirements(value) {
  exact(value, ["goal", "success", "examples", "negativeExample", "inputs", "permittedTools", "forbiddenTools", "permittedContext", "forbiddenContext", "supportedAgents", "output", "failure", "destination", "unknowns"]);
  if (!["goal", "success", "negativeExample", "output", "failure", "destination"].every((k) => nonempty(value[k])) || !strings(value.examples) || value.examples.length === 0 || !["inputs", "permittedTools", "forbiddenTools", "permittedContext", "forbiddenContext", "supportedAgents", "unknowns"].every((k) => strings(value[k]))) throw new DevctxError("INVALID_INPUT", "Incomplete requirements");
}
function validateDesign(value) {
  exact(value, ["name", "description", "workflow", "outputs", "dependencies", "tests", "tree", "destinations", "reuse"]);
  if (!SKILL_NAME.test(value.name ?? "") || value.name.length > 64 || !nonempty(value.description, 1024) || !nonempty(value.reuse) || !["workflow", "outputs", "dependencies", "tests", "tree", "destinations"].every((k) => strings(value[k])) || !value.workflow.length || !value.outputs.length || !value.tree.includes("SKILL.md")) throw new DevctxError("INVALID_INPUT", "Incomplete skill design");
}
export async function recordRequirements(roots, selection, id, inputPath) {
  needId("requirements", id);
  assertWritable(roots, []);
  const value = await inputJson(roots.pilot, inputPath); validateRequirements(value);
  const path = workspacePath(roots, selection), dest = jsonPath(path, "requirements", id);
  return locked(roots, [dest], async () => { await base(roots, selection); ensurePrivatePath(path, ["requirements"]); const record = { schemaVersion: 1, audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace, id, ...value }; await writeNewFile(dest, privateJson(record)); return { requirements: id, digest: digest(record) }; });
}
export async function recordDesign(roots, selection, requirementsId, designId, inputPath) {
  needId("requirements", requirementsId); needId("design", designId);
  assertWritable(roots, []);
  const value = await inputJson(roots.pilot, inputPath); validateDesign(value);
  const path = workspacePath(roots, selection), dest = jsonPath(path, "designs", designId);
  return locked(roots, [dest], async () => { await base(roots, selection); const req = await namedJson(jsonPath(path, "requirements", requirementsId)); ensurePrivatePath(path, ["designs"]); const record = { schemaVersion: 1, audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace, id: designId, requirements: requirementsId, requirementsDigest: digest(req), ...value }; await writeNewFile(dest, privateJson(record)); return { design: designId, digest: digest(record), requirementsDigest: record.requirementsDigest }; });
}
export async function approveDesign(roots, selection, designId, decisionId, interactionRef, responseText) {
  needId("design", designId); needId("decision", decisionId);
  const path = workspacePath(roots, selection), dest = jsonPath(path, "decisions", decisionId);
  return locked(roots, [dest], async () => {
    await base(roots, selection);
    const design = await namedJson(jsonPath(path, "designs", designId));
    const req = await namedJson(jsonPath(path, "requirements", design.requirements));
    if (design.requirementsDigest !== digest(req)) throw new DevctxError("STALE_VERSION", "Design requirements changed");
    const designDigest = digest(design);
    if (typeof interactionRef !== "string" || !/^user:[A-Za-z0-9._:-]{1,120}$/.test(interactionRef) || responseText !== "Approved " + designDigest) throw new DevctxError("APPROVAL_REQUIRED", "Canonical design approval evidence required");
    ensurePrivatePath(path, ["decisions"]);
    const record = { schemaVersion: 1, action: "approve-design", audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace, id: decisionId, design: designId, designDigest, interactionRef, responseText };
    await writeNewFile(dest, privateJson(record));
    return { decision: decisionId, design: designId, designDigest };
  });
}

function walk(root, { privateMode = false } = {}) {
  const files = [];
  let directories = 0;
  function visit(path, rel, depth) {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || st.nlink < 1 || (privateMode && st.uid !== process.getuid())) throw new DevctxError("PATH_UNSAFE", "Unsafe package path");
    if (st.isDirectory()) {
      directories++;
      if (directories > 32) throw new DevctxError("LIMIT", "Package directory limit exceeded");
      if (rel) assertPackageRel(rel + "/placeholder.txt");
      if (depth >= PACKAGE_LIMITS.depth) throw new DevctxError("LIMIT", "Package depth exceeded");
      for (const name of readdirSync(path).sort()) visit(join(path, name), rel ? rel + "/" + name : name, depth + 1);
    } else if (st.isFile() && st.nlink === 1) {
      assertPackageRel(rel);
      if (st.size > PACKAGE_LIMITS.fileBytes || files.length >= PACKAGE_LIMITS.files) throw new DevctxError("LIMIT", "Package file limit exceeded");
      files.push(rel);
    } else throw new DevctxError("PATH_UNSAFE", "Non-regular or linked package entry");
  }
  visit(root, "", 0);
  return files.sort();
}
async function intake(pilot, candidate) {
  assertInPilot(pilot, candidate, "inputsRoot");
  const paths = walk(candidate), files = {};
  let total = 0;
  for (const rel of paths) {
    const read = await readApprovedSource(pilot.inputsRoot, relative(pilot.inputsRoot, join(candidate, rel)));
    if (read.skipped || !read.utf8Valid) throw new DevctxError("PATH_UNSAFE", "Package source unavailable or invalid UTF-8");
    total += read.size;
    if (total > PACKAGE_LIMITS.totalBytes || lstatSync(join(candidate, rel)).nlink !== 1) throw new DevctxError("LIMIT", "Package size or linked source refused");
    assertNoSensitive(read.text);
    files[rel] = read.text;
  }
  if (!Object.hasOwn(files, "SKILL.md")) throw new DevctxError("INVALID_INPUT", "SKILL.md required");
  return files;
}
async function approved(path, requirementsId, designId, decisionId) {
  const design = await namedJson(jsonPath(path, "designs", designId));
  const req = await namedJson(jsonPath(path, "requirements", requirementsId));
  const decision = await namedJson(jsonPath(path, "decisions", decisionId));
  if (design.requirements !== requirementsId || design.requirementsDigest !== digest(req) || decision.action !== "approve-design" || decision.design !== designId || decision.designDigest !== digest(design) || decision.responseText !== "Approved " + decision.designDigest || [req, design, decision].some((item) => item.audience !== req.audience || item.scope !== req.scope || item.project !== req.project || item.workspace !== req.workspace)) throw new DevctxError("STALE_VERSION", "Design approval is stale");
  return { design, decision };
}
export async function createDraft(roots, selection, { requirementsId, designId, decisionId, revisionId, candidate }, { faults = {} } = {}) {
  needId("requirements", requirementsId); needId("design", designId); needId("decision", decisionId); needId("revision", revisionId);
  assertWritable(roots, []);
  const files = await intake(roots.pilot, candidate);
  const path = workspacePath(roots, selection), staging = safeJoin(path, "staging", revisionId), final = safeJoin(path, "drafts", revisionId);
  const destinations = [staging, final, join(staging, "manifest.json")];
  return locked(roots, destinations, async () => {
    await base(roots, selection);
    const { design, decision } = await approved(path, requirementsId, designId, decisionId);
    if (existsSync(staging) || existsSync(final)) throw new DevctxError("CONFLICT", "Revision ID exists or has incomplete staging");
    if (design.name !== parseFrontmatter(files["SKILL.md"], { nameOnly: true }).meta.name) throw new DevctxError("INVALID_INPUT", "Package name differs from approved design");
    ensurePrivatePath(path, ["staging", revisionId, design.name]);
    ensurePrivatePath(path, ["drafts"]);
    const entries = [];
    for (const rel of Object.keys(files).sort()) {
      const parts = rel.split("/"); if (parts.length > 1) ensurePrivatePath(join(staging, design.name), parts.slice(0, -1));
      const file = join(staging, design.name, ...parts);
      assertWritable(roots, [file]);
      await writeNewFile(file, files[rel]); entries.push({ path: rel, sha256: sha256(files[rel]) });
    }
    for (const entry of entries) {
      const staged = join(staging, design.name, ...entry.path.split("/"));
      if (sha256(await readPrivateText(staged, PACKAGE_LIMITS.fileBytes)) !== entry.sha256) throw new DevctxError("INTEGRITY", "Staged package changed");
    }
    if (faults.afterFiles) await faults.afterFiles();
    const manifest = { schemaVersion: 1, audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace, revision: revisionId, name: design.name, design: designId, designDigest: digest(design), decision: decisionId, decisionDigest: digest(decision), files: entries };
    manifest.packageDigest = digest(manifest);
    await writeNewFile(join(staging, "manifest.json"), privateJson(manifest));
    fsyncDir(staging);
    renameSync(staging, final); fsyncDir(join(path, "drafts"));
    return { revision: revisionId, packageDigest: manifest.packageDigest, files: entries.length };
  });
}
async function revision(roots, selection, revisionId) {
  needId("revision", revisionId);
  const path = await base(roots, selection), dir = safeJoin(path, "drafts", revisionId);
  validateRoot(dir, "revision");
  const manifest = await namedJson(join(dir, "manifest.json"));
  const { packageDigest, ...content } = manifest;
  if (packageDigest !== digest(content) || manifest.workspace !== selection.workspace || manifest.audience !== selection.audience || manifest.scope !== (selection.scope ?? null) || manifest.project !== (selection.project ?? null)) throw new DevctxError("INTEGRITY", "Revision manifest mismatch");
  if (!Array.isArray(manifest.files) || manifest.files.length > PACKAGE_LIMITS.files || manifest.files.some((f) => typeof f?.path !== "string" || typeof f?.sha256 !== "string")) throw new DevctxError("INTEGRITY", "Revision manifest inventory invalid");
  if (!SKILL_NAME.test(manifest.name ?? "") || manifest.name.length > 64) throw new DevctxError("INTEGRITY", "Revision package name invalid");
  const paths = walk(join(dir, manifest.name), { privateMode: true });
  if (JSON.stringify(paths) !== JSON.stringify(manifest.files.map((f) => f.path).sort())) throw new DevctxError("INTEGRITY", "Revision file inventory changed");
  const files = {};
  for (const entry of manifest.files) {
    const text = await readPrivateText(join(dir, manifest.name, ...entry.path.split("/")), PACKAGE_LIMITS.fileBytes);
    if (sha256(text) !== entry.sha256) throw new DevctxError("INTEGRITY", "Revision package changed");
    files[entry.path] = text;
  }
  return { path, manifest, files };
}
export async function validateDraft(roots, selection, revisionId) {
  const path = workspacePath(roots, selection), dest = safeJoin(path, "validations", revisionId, VALIDATOR_VERSION + ".json");
  return locked(roots, [dest], async () => {
    const { manifest, files } = await revision(roots, selection, revisionId);
    let result;
    try { result = validatePackage(files, manifest.name); }
    catch (error) { if (!(error instanceof DevctxError) || !["DEVCTX_INVALID_INPUT", "DEVCTX_LIMIT", "DEVCTX_PATH_ESCAPE"].includes(error.code)) throw error; result = { valid: false, name: manifest.name, files: Object.keys(files).length, missing: [], unchecked: [], helpers: Object.keys(files).some((p) => p.startsWith("scripts/")) ? "unverified" : "none", findings: [{ code: error.code, message: error.message }] }; }
    const record = { schemaVersion: 1, revision: revisionId, packageDigest: manifest.packageDigest, validatorVersion: VALIDATOR_VERSION, ...result };
    ensurePrivatePath(path, ["validations", revisionId]);
    await writeNewFile(dest, privateJson(record));
    return record;
  });
}
function localSelection(selection) {
  if (selection.audience !== "personal" || selection.scope || selection.project) throw new DevctxError("GATE_REQUIRED", "Only personal generic packages can be installed");
}
export async function loadLocalRevision(roots, selection, revisionId, { requireValidation = true } = {}) {
  assertWritable(roots, []);
  localSelection(selection);
  const { path, manifest, files } = await revision(roots, selection, revisionId);
  let validation = null;
  if (requireValidation) {
    validation = await namedJson(safeJoin(path, "validations", revisionId, VALIDATOR_VERSION + ".json"));
    const current = validatePackage(files, manifest.name);
    if (validation.revision !== revisionId || validation.packageDigest !== manifest.packageDigest || validation.validatorVersion !== VALIDATOR_VERSION || validation.valid !== true || current.valid !== true || current.helpers !== validation.helpers || JSON.stringify(current.unchecked) !== JSON.stringify(validation.unchecked)) throw new DevctxError("STALE_VERSION", "Validation receipt is stale");
  }
  return { manifest, files, validation };
}
export async function loadLocalDecision(roots, selection, decisionId, expectedAction) {
  assertWritable(roots, []); localSelection(selection); needId("decision", decisionId);
  const path = await base(roots, selection);
  const value = await namedJson(jsonPath(path, "decisions", decisionId));
  const common = ["schemaVersion", "action", "audience", "scope", "project", "workspace", "id", "revision", "packageDigest", "interactionRef", "responseText"];
  const fields = expectedAction === "approve-content" ? [...common, "personalGenericNonConfidential"] : ["approve-local-install", "approve-local-uninstall"].includes(expectedAction) ? [...common, "contentDecision", "targetHome", "agents", "planFingerprint"] : [];
  if (!fields.length || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(fields.sort()) || !/^user:[A-Za-z0-9._:-]{1,120}$/.test(value.interactionRef ?? "")) throw new DevctxError("INTEGRITY", "Malformed local decision");
  if (value.id !== decisionId || value.workspace !== selection.workspace || value.audience !== "personal" || value.scope !== null || value.project !== null || value.action !== expectedAction) throw new DevctxError("INTEGRITY", "Local decision mismatch");
  return value;
}
export async function approveContent(roots, selection, revisionId, decisionId, interactionRef, responseText) {
  assertWritable(roots, []); localSelection(selection); needId("decision", decisionId);
  const path = workspacePath(roots, selection), dest = jsonPath(path, "decisions", decisionId);
  return locked(roots, [dest], async () => {
    const { manifest } = await loadLocalRevision(roots, selection, revisionId);
    if (!/^user:[A-Za-z0-9._:-]{1,120}$/.test(interactionRef ?? "") || responseText !== `Approved content ${manifest.packageDigest} as personal generic non-confidential`) throw new DevctxError("APPROVAL_REQUIRED", "Canonical content approval evidence required");
    ensurePrivatePath(path, ["decisions"]);
    const record = { schemaVersion: 1, action: "approve-content", audience: "personal", scope: null, project: null, workspace: selection.workspace, id: decisionId, revision: revisionId, packageDigest: manifest.packageDigest, personalGenericNonConfidential: true, interactionRef, responseText };
    await writeNewFile(dest, privateJson(record));
    return { decision: decisionId, revision: revisionId, packageDigest: manifest.packageDigest };
  });
}
export async function approveLocalAction(roots, selection, plan, decisionId, interactionRef, responseText) {
  assertWritable(roots, []); localSelection(selection); needId("decision", decisionId);
  const path = workspacePath(roots, selection), dest = jsonPath(path, "decisions", decisionId);
  return locked(roots, [dest], async () => {
    if (plan.kind !== "skill-package-local" || plan.workspace !== selection.workspace || !["install", "uninstall"].includes(plan.mode) || !/^user:[A-Za-z0-9._:-]{1,120}$/.test(interactionRef ?? "") || responseText !== `Approved ${plan.mode} ${plan.fingerprint}`) throw new DevctxError("APPROVAL_REQUIRED", "Canonical local approval evidence required");
    if (plan.actions.some((a) => !["create", "update", "remove", "installed", "absent"].includes(a.status)) || !plan.actions.some((a) => ["create", "update", "remove"].includes(a.status))) throw new DevctxError("CONFLICT", "No safe local action to approve");
    ensurePrivatePath(path, ["decisions"]);
    const record = { schemaVersion: 1, action: `approve-local-${plan.mode}`, audience: "personal", scope: null, project: null, workspace: selection.workspace, id: decisionId, revision: plan.revision, packageDigest: plan.packageDigest, contentDecision: plan.contentDecision, targetHome: plan.targetHome, agents: plan.agents, planFingerprint: plan.fingerprint, interactionRef, responseText };
    await writeNewFile(dest, privateJson(record));
    return { decision: decisionId, planFingerprint: plan.fingerprint };
  });
}
function names(path, expression) { if (!existsSync(path)) return []; checkNode(info(path), path, { directory: true }); return readdirSync(path).filter((name) => expression.test(name)).sort(); }
export async function showWorkspace(roots, selection) {
  const path = await base(roots, selection);
  const cleanNames = (dir, regex) => names(join(path, dir), regex).map((name) => name.slice(0, -5));
  const requirements = cleanNames("requirements", /^rq_[a-z0-9_-]{8,64}\.json$/), designs = cleanNames("designs", /^ds_[a-z0-9_-]{8,64}\.json$/), decisions = cleanNames("decisions", /^dc_[a-z0-9_-]{8,64}\.json$/), staging = names(join(path, "staging"), IDS.revision);
  const revisions = [];
  for (const id of names(join(path, "drafts"), IDS.revision)) {
    if (!info(join(path, "drafts", id, "manifest.json"))) { revisions.push({ id, status: "incomplete", validation: "none" }); continue; }
    try {
      const { manifest } = await revision(roots, selection, id);
      const validationPath = safeJoin(path, "validations", id, VALIDATOR_VERSION + ".json");
      let validation = "none";
      if (info(validationPath)) {
        try { const receipt = await namedJson(validationPath); validation = receipt.packageDigest === manifest.packageDigest ? receipt.valid ? "valid" : "invalid" : "stale"; }
        catch { validation = "stale"; }
      }
      revisions.push({ id, packageDigest: manifest.packageDigest, status: "intact", validation });
    } catch { revisions.push({ id, status: "tampered", validation: "stale" }); }
  }
  return { audience: selection.audience, scope: selection.scope ?? null, project: selection.project ?? null, workspace: selection.workspace, requirements, designs, decisions, revisions, staging };
}
