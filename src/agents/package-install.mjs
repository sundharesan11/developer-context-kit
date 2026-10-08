import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, readdir, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { DevctxError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { validateRoot } from "../config/roots.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { ensurePrivatePath, readPrivateJson, readPrivateBytes, writeNewFile, atomicReplace, fsyncDir, info, isWithin } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { RUN_ID } from "../storage/runs.mjs";
import { assertPackageRel, PACKAGE_LIMITS, VALIDATOR_VERSION } from "../skill-builder/validate.mjs";
import { loadLocalRevision, loadLocalDecision } from "../skill-builder/workspace.mjs";
import { AGENT_HOMES, SKILL_NAMES } from "./install.mjs";

const marker = ".devctx-owned.json";
const receiptKeys = ["schemaVersion", "kind", "skill", "version", "audience", "workspace", "revision", "packageDigest", "files", "runId"].sort();
function safeHome(roots, targetHome) {
  assertWritable(roots, []);
  if (typeof targetHome !== "string") throw new DevctxError("INVALID_INPUT", "Target home required");
  const pilot = roots.pilot;
  assertInPilot(pilot, targetHome, "agentHomes");
  let real;
  try { real = realpathSync.native(targetHome); }
  catch (error) { if (error.code === "ENOENT") throw new DevctxError("GATE_REQUIRED", "Pilot agent home unavailable"); throw error; }
  const home = realpathSync.native(homedir());
  if (isWithin(real, home) || isWithin(home, real)) throw new DevctxError("GATE_REQUIRED", "Real home refused");
  return pilot;
}
function selectionCheck(selection) {
  if (selection?.audience !== "personal" || selection.scope || selection.project || !/^ws_[a-z0-9_-]{8,64}$/.test(selection.workspace ?? "")) throw new DevctxError("GATE_REQUIRED", "Only personal workspaces can be installed");
}
function agentsCheck(agents) {
  if (!Array.isArray(agents) || !agents.length || agents.some((a) => typeof a !== "string" || !Object.hasOwn(AGENT_HOMES, a))) throw new DevctxError("INVALID_INPUT", "Invalid agent selection");
  return [...new Set(agents)].sort();
}
function checkAgentParents(targetHome, agent) {
  const parts = AGENT_HOMES[agent].split("/");
  let at = targetHome;
  for (const part of parts) {
    at = join(at, part);
    const st = info(at);
    if (st && (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077))) throw new DevctxError("PATH_UNSAFE", "Unsafe agent skill directory");
  }
}
function entries(dir, prefix = "") {
  const result = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? prefix + "/" + name : name, path = join(dir, name), st = lstatSync(path);
    if (st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o077) || (st.isFile() && st.nlink !== 1)) throw new DevctxError("PATH_UNSAFE", "Unsafe installed entry");
    if (st.isDirectory()) { result.push({ rel, directory: true }); result.push(...entries(path, rel)); }
    else if (st.isFile()) result.push({ rel, directory: false });
    else throw new DevctxError("PATH_UNSAFE", "Unsafe installed entry");
  }
  return result;
}
async function observed(dir, manifest, workspace, mode) {
  if (!info(dir)) return { status: mode === "install" ? "create" : "absent" };
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) return { status: "conflict" };
  if (st.uid !== process.getuid() || (st.mode & 0o077)) return { status: "modified" };
  if (!info(join(dir, marker))) return { status: "conflict" };
  let receipt;
  try { receipt = await readPrivateJson(join(dir, marker)); }
  catch { return { status: "modified" }; }
  if (receipt?.schemaVersion !== 2 || (receipt.workspace && receipt.workspace !== workspace)) return { status: "conflict" };
  try {
    if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(receiptKeys) || receipt.kind !== "skill-package" || receipt.skill !== manifest.name || receipt.skill !== dir.split("/").at(-1) || receipt.audience !== "personal" || receipt.workspace !== workspace || receipt.version !== "0.0.0-local" || !RUN_ID.test(receipt.runId) || !/^sha256:[0-9a-f]{64}$/.test(receipt.packageDigest) || !/^rv_[a-z0-9_-]{8,64}$/.test(receipt.revision) || !receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files)) throw new Error("receipt");
    const keys = Object.keys(receipt.files).sort();
    if (!keys.includes("SKILL.md") || keys.length > PACKAGE_LIMITS.files || keys.some((rel) => { assertPackageRel(rel); return !/^sha256:[0-9a-f]{64}$/.test(receipt.files[rel]); })) throw new Error("files");
    const found = entries(dir);
    if (found.filter((e) => e.directory).length > 32) throw new Error("directory limit");
    const foundFiles = found.filter((e) => !e.directory).map((e) => e.rel).sort();
    if (JSON.stringify(foundFiles) !== JSON.stringify([...keys, marker].sort())) throw new Error("inventory");
    const expectedDirs = new Set(keys.flatMap((rel) => { const parts = rel.split("/").slice(0, -1); return parts.map((_, i) => parts.slice(0, i + 1).join("/")); }));
    if (JSON.stringify(found.filter((e) => e.directory).map((e) => e.rel).sort()) !== JSON.stringify([...expectedDirs].sort())) throw new Error("directories");
    let total = 0;
    for (const rel of keys) {
      const body = await readPrivateBytes(join(dir, ...rel.split("/")), PACKAGE_LIMITS.fileBytes);
      total += body.length;
      if (total > PACKAGE_LIMITS.totalBytes || sha256(body) !== receipt.files[rel]) throw new Error("hash or size");
    }
  } catch { return { status: "modified" }; }
  if (mode === "uninstall") return { status: receipt.revision === manifest.revision && receipt.packageDigest === manifest.packageDigest ? "remove" : "conflict", receipt };
  return { status: receipt.revision === manifest.revision && receipt.packageDigest === manifest.packageDigest ? "installed" : "update", receipt };
}
function fileHashes(files) { return Object.fromEntries(Object.keys(files).sort().map((rel) => [rel, sha256(files[rel])])); }
function roleConflict(oldFiles, newFiles) {
  return Object.keys(oldFiles).some((oldRel) => Object.keys(newFiles).some((newRel) => oldRel.startsWith(newRel + "/") || newRel.startsWith(oldRel + "/")));
}
export async function planPackageInstall(roots, selection, { revisionId, contentDecisionId, targetHome, agents, mode }) {
  selectionCheck(selection); const pilot = safeHome(roots, targetHome);
  if (!["install", "uninstall"].includes(mode) || (mode === "install" ? !contentDecisionId : !!contentDecisionId)) throw new DevctxError("INVALID_INPUT", "Invalid local action");
  const chosen = agentsCheck(agents);
  const { manifest, files, validation } = await loadLocalRevision(roots, selection, revisionId, { requireValidation: mode === "install" });
  if (SKILL_NAMES.includes(manifest.name) || manifest.name.startsWith("devctx-")) throw new DevctxError("CONFLICT", "Bundled skill name reserved");
  if (mode === "install") {
    const content = await loadLocalDecision(roots, selection, contentDecisionId, "approve-content");
    if (content.revision !== revisionId || content.packageDigest !== manifest.packageDigest || content.personalGenericNonConfidential !== true || content.responseText !== `Approved content ${manifest.packageDigest} as personal generic non-confidential`) throw new DevctxError("STALE_VERSION", "Content approval stale");
  }
  const hashes = fileHashes(files), actions = [];
  for (const agent of chosen) {
    checkAgentParents(targetHome, agent);
    const path = join(targetHome, AGENT_HOMES[agent], manifest.name);
    validateRoot(path, "target");
    const prior = await observed(path, manifest, selection.workspace, mode);
    const { receipt } = prior;
    const status = prior.status === "update" && roleConflict(receipt.files, hashes) ? "conflict" : prior.status;
    actions.push({ agent, skill: manifest.name, path, status, priorReceiptDigest: receipt ? digest(receipt) : null, files: hashes });
  }
  return finalizePlan({ kind: "skill-package-local", mode, audience: "personal", workspace: selection.workspace, revision: revisionId, packageDigest: manifest.packageDigest, contentDecision: contentDecisionId ?? null, validatorVersion: validation?.validatorVersion ?? null, validationDigest: validation ? digest(validation) : null, helpers: validation?.helpers ?? null, targetHome, agents: chosen, actions });
}
async function journals(roots, targetHome) {
  const runs = join(roots.stateRoot, "runs"), incomplete = [], reviewed = [];
  let ids = []; try { ids = await readdir(runs); } catch (e) { if (e.code !== "ENOENT") throw e; }
  for (const id of ids) {
    if (!RUN_ID.test(id)) continue;
    const path = join(runs, id, "journal.json"), moved = join(runs, id, "reviewed", "journal.json");
    if (existsSync(moved)) {
      try { const j = await readPrivateJson(moved); if (!j.targetHome || j.targetHome === targetHome) reviewed.push(id); }
      catch { reviewed.push(id); }
    }
    if (!existsSync(path)) continue;
    try {
      const j = await readPrivateJson(path);
      if (j.targetHome && j.targetHome !== targetHome) continue;
      if (!Array.isArray(j.intended) || !Array.isArray(j.completed) || j.completed.length > j.intended.length || j.completed.length < j.intended.length || j.completed.some((action, i) => canonicalJson(action) !== canonicalJson(j.intended[i])) || (j.kind === "skill-package-local" && (j.schemaVersion !== 1 || !/^ws_[a-z0-9_-]{8,64}$/.test(j.workspace ?? "") || !/^dc_[a-z0-9_-]{8,64}$/.test(j.decision ?? "")))) incomplete.push(id);
    } catch { incomplete.push(id); }
  }
  return { incomplete, reviewed };
}
async function writeFiles(dir, files, replace = false) {
  const touchedDirs = new Set([dir]);
  for (const rel of Object.keys(files).sort()) {
    const parts = rel.split("/");
    if (parts.length > 1) {
      ensurePrivatePath(dir, parts.slice(0, -1));
      for (let i = 1; i < parts.length; i++) touchedDirs.add(join(dir, ...parts.slice(0, i)));
    }
    const path = join(dir, ...parts);
    if (replace && info(path)) await atomicReplace(path, files[rel]); else await writeNewFile(path, files[rel]);
  }
  for (const path of [...touchedDirs].sort((a, b) => b.length - a.length)) fsyncDir(path);
}
async function removeFiles(dir, rels) {
  for (const rel of rels) await unlink(join(dir, ...rel.split("/")));
  const dirs = new Set(rels.flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }));
  for (const rel of [...dirs].sort((a, b) => b.length - a.length)) {
    try { await rmdir(join(dir, ...rel.split("/"))); }
    catch (error) { if (error.code !== "ENOTEMPTY") throw error; }
  }
}
export async function applyPackageInstall(roots, selection, input, { fingerprint, decisionId, runId }, { faults = {} } = {}) {
  selectionCheck(selection); safeHome(roots, input.targetHome);
  const id = runId ?? "run_" + randomBytes(12).toString("hex");
  const lock = join(roots.stateRoot, "locks", "install.lock"), runs = join(roots.stateRoot, "runs"), consumed = join(roots.stateRoot, "skill-installs", "consumed", selection.workspace, decisionId + ".json");
  return withPilotLock(roots, lock, { kind: "skill-package-install", runId: id }, async () => {
    if (!RUN_ID.test(id)) throw new DevctxError("INVALID_ID", "Invalid run ID");
    if ((await journals(roots, input.targetHome)).incomplete.length) throw new DevctxError("RECOVERY_REQUIRED", "Incomplete installer journal");
    const plan = await planPackageInstall(roots, selection, input);
    assertFingerprint(plan, fingerprint);
    if (plan.actions.some((a) => !["create", "update", "remove", "installed", "absent"].includes(a.status)) || !plan.actions.some((a) => ["create", "update", "remove"].includes(a.status))) throw new DevctxError("CONFLICT", "No safe local action");
    const decision = await loadLocalDecision(roots, selection, decisionId, `approve-local-${plan.mode}`);
    if (decision.planFingerprint !== plan.fingerprint || decision.revision !== plan.revision || decision.packageDigest !== plan.packageDigest || decision.contentDecision !== plan.contentDecision || decision.targetHome !== plan.targetHome || JSON.stringify(decision.agents) !== JSON.stringify(plan.agents) || decision.responseText !== `Approved ${plan.mode} ${plan.fingerprint}`) throw new DevctxError("STALE_VERSION", "Local approval stale");
    if (info(join(runs, id))) throw new DevctxError("CONFLICT", "Run ID already exists");
    ensurePrivatePath(roots.stateRoot, ["skill-installs", "consumed", selection.workspace]);
    await writeNewFile(consumed, canonicalJson({ runId: id, planFingerprint: fingerprint }) + "\n");
    if (faults.afterConsume) await faults.afterConsume();
    ensurePrivatePath(roots.stateRoot, ["runs"]);
    await mkdir(join(runs, id), { mode: 0o700 });
    const intended = plan.actions.filter((a) => ["create", "update", "remove"].includes(a.status));
    const journalPath = join(runs, id, "journal.json");
    const journal = { schemaVersion: 1, kind: "skill-package-local", workspace: selection.workspace, decision: decisionId, planFingerprint: fingerprint, targetHome: plan.targetHome, intended, completed: [] };
    await writeNewFile(journalPath, canonicalJson(journal) + "\n");
    if (faults.afterJournal) await faults.afterJournal();
    const { manifest, files, validation } = await loadLocalRevision(roots, selection, plan.revision, { requireValidation: plan.mode === "install" });
    const reloadedHashes = fileHashes(files);
    if (manifest.packageDigest !== plan.packageDigest || (validation ? digest(validation) : null) !== plan.validationDigest || intended.some((action) => canonicalJson(action.files) !== canonicalJson(reloadedHashes))) throw new DevctxError("STALE_VERSION", "Revision changed during apply");
    for (const action of intended) {
      assertWritable(roots, [action.path, journalPath]);
      const prior = await observed(action.path, manifest, selection.workspace, plan.mode);
      if (prior.status !== action.status || (prior.receipt ? digest(prior.receipt) : null) !== action.priorReceiptDigest) throw new DevctxError("STALE_VERSION", "Target changed during apply");
      if (action.status === "create") {
        await mkdir(dirname(action.path), { recursive: true, mode: 0o700 });
        await mkdir(action.path, { mode: 0o700 });
        await writeFiles(action.path, files);
        if (faults.beforeReceipt) await faults.beforeReceipt(action);
        await writeNewFile(join(action.path, marker), canonicalJson({ schemaVersion: 2, kind: "skill-package", skill: manifest.name, version: "0.0.0-local", audience: "personal", workspace: selection.workspace, revision: plan.revision, packageDigest: plan.packageDigest, files: fileHashes(files), runId: id }) + "\n");
        fsyncDir(action.path);
      } else if (action.status === "update") {
        await writeFiles(action.path, files, true);
        const removed = Object.keys(prior.receipt.files).filter((rel) => !Object.hasOwn(files, rel));
        if (removed.length) await removeFiles(action.path, removed);
        if (faults.beforeReceipt) await faults.beforeReceipt(action);
        await atomicReplace(join(action.path, marker), canonicalJson({ schemaVersion: 2, kind: "skill-package", skill: manifest.name, version: "0.0.0-local", audience: "personal", workspace: selection.workspace, revision: plan.revision, packageDigest: plan.packageDigest, files: fileHashes(files), runId: id }) + "\n");
      } else {
        for (const rel of Object.keys(prior.receipt.files)) if (sha256(await readPrivateBytes(join(action.path, ...rel.split("/")), PACKAGE_LIMITS.fileBytes)) !== prior.receipt.files[rel]) throw new DevctxError("CONFLICT", "Installed skill changed");
        for (const rel of Object.keys(prior.receipt.files)) await unlink(join(action.path, ...rel.split("/")));
        if (faults.beforeReceipt) await faults.beforeReceipt(action);
        await unlink(join(action.path, marker));
        const dirs = new Set(Object.keys(prior.receipt.files).flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }));
        for (const rel of [...dirs].sort((a, b) => b.length - a.length)) await rmdir(join(action.path, ...rel.split("/")));
        await rmdir(action.path);
      }
      journal.completed.push(action);
      await atomicReplace(journalPath, canonicalJson(journal) + "\n");
    }
    return { applied: true, runId: id, actions: plan.actions };
  }, { destinations: [input.targetHome, consumed, join(runs, id)] });
}
export async function packageInstallStatus(roots, selection, input) {
  selectionCheck(selection); safeHome(roots, input.targetHome);
  if (!["install", "uninstall"].includes(input.mode) || (input.mode === "uninstall" && input.contentDecisionId)) throw new DevctxError("INVALID_INPUT", "Invalid local status selection");
  const lock = join(roots.stateRoot, "locks", "install.lock");
  return withPilotLock(roots, lock, { kind: "skill-package-status" }, async () => {
    const history = await journals(roots, input.targetHome);
    const { manifest } = await loadLocalRevision(roots, selection, input.revisionId, { requireValidation: false });
    const agents = agentsCheck(input.agents), actions = [];
    for (const agent of agents) {
      const path = join(input.targetHome, AGENT_HOMES[agent], manifest.name);
      actions.push({ agent, skill: manifest.name, path, status: (await observed(path, manifest, selection.workspace, input.mode ?? "install")).status });
    }
    const markers = join(roots.stateRoot, "skill-installs", "consumed", selection.workspace);
    let consumed = []; try { consumed = (await readdir(markers)).filter((x) => /^dc_[a-z0-9_-]{8,64}\.json$/.test(x)).map((x) => x.slice(0, -5)).sort(); } catch (e) { if (e.code !== "ENOENT") throw e; }
    let planned = null;
    if (input.contentDecisionId) {
      const decision = await loadLocalDecision(roots, selection, input.contentDecisionId, "approve-content");
      if (decision.revision !== input.revisionId || decision.packageDigest !== manifest.packageDigest || decision.personalGenericNonConfidential !== true || decision.responseText !== `Approved content ${manifest.packageDigest} as personal generic non-confidential`) throw new DevctxError("STALE_VERSION", "Content approval stale");
      planned = await planPackageInstall(roots, selection, input);
    }
    return { status: history.incomplete.length ? "RECOVERY_REQUIRED" : "ok", ...history, consumed, actions, planned };
  }, { destinations: [input.targetHome] });
}
