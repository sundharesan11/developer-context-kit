import {lstatSync, realpathSync} from "node:fs";
import {mkdir, readdir} from "node:fs/promises";
import {join} from "node:path";
import {randomBytes} from "node:crypto";
import {assertWritable} from "../config/pilot.mjs";
import {canonicalJson, digest, sha256} from "../storage/canonical.mjs";
import {ensurePrivatePath, readPrivateBytes, writeNewFile, atomicReplace, info, fsyncDir} from "../storage/fsx.mjs";
import {withPilotLock} from "../storage/lock.mjs";
import {finalizePlan, assertFingerprint} from "../storage/plan.mjs";
import {RUN_ID} from "../storage/runs.mjs";
import {safeHome, agentsCheck, entries, roleConflict, journals, performPackageAction} from "../agents/package-files.mjs";
import {PACKAGE_LIMITS as L} from "../skill-builder/validate.mjs";
import {exact, fail, sourceOperation, loadSourcePackage, validateSourceMapping, assertSourcePackageRel} from "./package.mjs";

export const SOURCE_LAYOUTS = Object.freeze({claude: ".claude/skills", codex: ".agents/skills"});
const DECISION = /^dc_[a-z0-9_-]{8,64}$/, HASH = /^sha256:[0-9a-f]{64}$/;
const marker = ".devctx-owned.json";
const decisionId = (id) => { if (!DECISION.test(id ?? "")) fail("INVALID_ID"); return id; };
const contentResponse = (hash) => `Approved source content ${hash} with caller-supplied-unverified pin`;
function interaction(ref) { if (typeof ref !== "string" || !/^user:[A-Za-z0-9._:-]{1,120}$/.test(ref)) fail(); }
function strictNode(path, directory) {
  const st = lstatSync(path);
  if (st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== (directory ? 0o700 : 0o600) || (directory ? !st.isDirectory() : !st.isFile() || st.nlink !== 1)) fail("PATH_UNSAFE");
  return st;
}
function strictPath(root, parts) {
  let at = root; strictNode(at, true);
  for (const part of parts) { at = join(at, part); strictNode(at, true); }
  return at;
}
function decisionPath(roots, id) { return join(roots.dataRoot, "skill-sources/decisions", decisionId(id) + ".json"); }
async function readRecord(roots, id) {
  const path = decisionPath(roots, id); assertWritable(roots, [path]);
  strictPath(roots.dataRoot, ["skill-sources", "decisions"]); strictNode(path, false);
  const bytes = await readPrivateBytes(path, 131072);
  const value = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes));
  if (!value || value.schemaVersion !== 1 || value.id !== id || value.pilotDigest !== roots.pilot.digest) fail("INTEGRITY");
  const {recordHash, ...body} = value;
  if (recordHash !== digest(body)) fail("INTEGRITY");
  interaction(value.interactionRef);
  return value;
}
async function writeRecord(roots, id, body) {
  const path = decisionPath(roots, id); assertWritable(roots, [path]);
  ensurePrivatePath(roots.dataRoot, ["skill-sources", "decisions"]);
  strictPath(roots.dataRoot, ["skill-sources", "decisions"]);
  const value = {schemaVersion: 1, id, pilotDigest: roots.pilot.digest, ...body};
  const bytes = canonicalJson({...value, recordHash: digest(value)}) + "\n";
  if (Buffer.byteLength(bytes) > 131072) fail("LIMIT");
  await writeNewFile(path, bytes); fsyncDir(join(roots.dataRoot, "skill-sources/decisions"));
}
function validateStoredReview(review) {
  if (!exact(review, ["schemaVersion", "stageRunId", "sourceId", "repository", "pin", "tree", "acquisitionFingerprint", "acquisitionAssessment", "mapping", "files", "relocations", "validation", "holds", "disclosures", "packageDigest"]) || review.schemaVersion !== 1) fail("INTEGRITY");
  const {packageDigest, ...body} = review;
  if (packageDigest !== digest(body) || !HASH.test(packageDigest) || !/^stage_[0-9a-f]{32}$/.test(review.stageRunId)) fail("INTEGRITY");
  const mapping = validateSourceMapping(review.mapping);
  if (digest(mapping) !== digest(review.mapping) || !Array.isArray(review.files) || review.files.length !== mapping.files.length || !Array.isArray(review.holds) || !Array.isArray(review.disclosures)) fail("INTEGRITY");
  if (!exact(review.repository, ["owner", "name"]) || Object.values(review.repository).some((v) => typeof v !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(v))) fail("INTEGRITY");
  if (!exact(review.pin, ["sourceId", "channel", "tag", "commit"]) || review.pin.sourceId !== review.sourceId || !/^[a-z0-9-]{1,80}$/.test(review.sourceId) || !/^[0-9a-f]{40}$/.test(review.pin.commit) || !/^[0-9a-f]{40}$/.test(review.tree) || !HASH.test(review.acquisitionFingerprint)) fail("INTEGRITY");
  let total = 0;
  for (let i = 0; i < review.files.length; i++) {
    const file = review.files[i], mapped = mapping.files[i];
    if (!exact(file, ["source", "target", "size", "mode", "blob", "sha256"]) || file.source !== mapped.source || file.target !== mapped.target || !HASH.test(file.sha256) || !/^[0-9a-f]{40}$/.test(file.blob) || !["100644", "100755"].includes(file.mode) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > L.fileBytes) fail("INTEGRITY");
    assertSourcePackageRel(file.target); total += file.size;
  }
  if (total > L.totalBytes) fail("INTEGRITY");
  return review;
}
async function loadContent(roots, id, {revalidate = true} = {}) {
  const record = await readRecord(roots, id);
  if (!exact(record, ["schemaVersion", "id", "pilotDigest", "kind", "review", "interactionRef", "responseText", "recordHash"]) || record.kind !== "source-content") fail("INTEGRITY");
  const review = validateStoredReview(record.review);
  if (record.responseText !== contentResponse(review.packageDigest)) fail("INTEGRITY");
  if (!revalidate) return {record, review, files: null};
  const loaded = await loadSourcePackage(roots, {stageRunId: review.stageRunId, mapping: review.mapping});
  if (digest(loaded.review) !== digest(review)) fail("STALE_VERSION");
  return {...loaded, record};
}
function homeCheck(roots, home) {
  safeHome(roots, home);
  if (home !== realpathSync.native(home)) fail("PATH_UNSAFE");
}
function parentCheck(home, layout) {
  let at = home;
  for (const part of layout.split("/")) {
    at = join(at, part);
    if (!info(at)) break;
    strictNode(at, true);
  }
}
function targetChecks(roots, input, name) {
  homeCheck(roots, input.targetHome);
  const agents = agentsCheck(input.agents);
  if (!["install", "uninstall"].includes(input.mode)) fail();
  const selected = agents.map((a) => SOURCE_LAYOUTS[a]);
  const competing = [];
  for (const layout of [".claude/skills", ".agents/skills", ".codex/skills"]) {
    parentCheck(input.targetHome, layout);
    if (!selected.includes(layout) && info(join(input.targetHome, layout, name))) competing.push(layout);
  }
  return {agents, competing};
}
function receiptFor(review, contentDecision, runId) {
  return {schemaVersion: 3, kind: "skill-source-package", skill: review.mapping.name, sourceId: review.sourceId, repository: review.repository, pin: review.pin, stageRunId: review.stageRunId, acquisitionFingerprint: review.acquisitionFingerprint, packageDigest: review.packageDigest, contentDecision, mappingDigest: digest(review.mapping), files: Object.fromEntries(review.files.map((f) => [f.target, f.sha256])), runId};
}
async function observed(roots, dir, requested, contentDecision, mode) {
  const st = info(dir);
  if (!st) return {status: mode === "install" ? "create" : "absent"};
  if (!st.isDirectory() || st.isSymbolicLink()) return {status: "conflict"};
  if (!info(join(dir, marker))) return {status: "conflict"};
  try {
    strictNode(dir, true); strictNode(join(dir, marker), false);
    const receipt = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(await readPrivateBytes(join(dir, marker), 65536)));
    if (receipt?.schemaVersion !== 3 || receipt.kind !== "skill-source-package" || receipt.sourceId !== requested.sourceId || receipt.skill !== requested.mapping.name) return {status: "conflict"};
    if (!RUN_ID.test(receipt.runId ?? "")) fail("INTEGRITY");
    if (mode === "uninstall" && receipt.contentDecision !== contentDecision) return {status: "conflict"};
    const prior = await loadContent(roots, receipt.contentDecision, {revalidate: mode === "install"});
    if (prior.review.mapping.skillRoot !== requested.mapping.skillRoot) return {status: "conflict"};
    if (canonicalJson(receiptFor(prior.review, receipt.contentDecision, receipt.runId)) !== canonicalJson(receipt)) fail("INTEGRITY");
    const found = entries(dir, "", {strictModes: true}), keys = Object.keys(receipt.files).sort();
    const dirs = [...new Set(keys.flatMap((rel) => { const p = rel.split("/").slice(0, -1); return p.map((_, i) => p.slice(0, i + 1).join("/")); }))].sort();
    if (digest(found.filter((e) => !e.directory).map((e) => e.rel).sort()) !== digest([...keys, marker].sort()) || digest(found.filter((e) => e.directory).map((e) => e.rel).sort()) !== digest(dirs)) fail("INTEGRITY");
    for (const rel of keys) if (sha256(await readPrivateBytes(join(dir, rel), L.fileBytes)) !== receipt.files[rel]) fail("INTEGRITY");
    const hashes = Object.fromEntries(requested.files.map((f) => [f.target, f.sha256]));
    if (mode === "uninstall") return {status: "remove", receipt};
    if (roleConflict(receipt.files, hashes)) return {status: "conflict", receipt};
    return {status: receipt.packageDigest === requested.packageDigest ? "installed" : "update", receipt};
  } catch { return {status: "modified"}; }
}
function installHolds(review, agents, mode) {
  if (mode === "uninstall") return [];
  const holds = [...review.holds];
  for (const agent of agents) if (review.mapping.compatibility[agent] !== "user-reviewed-sandbox") holds.push({code: review.mapping.compatibility[agent] === "unsupported" ? "COMPATIBILITY_UNSUPPORTED" : "COMPATIBILITY_UNREVIEWED", agent});
  return holds;
}
export async function approveSourceContent(roots, input, {decisionId: id, interactionRef, responseText}) {
  return sourceOperation(async () => {
    assertWritable(roots, []); decisionId(id); interaction(interactionRef);
    const {review} = await loadSourcePackage(roots, input);
    if (input.packageDigest !== review.packageDigest || responseText !== contentResponse(review.packageDigest)) fail("STALE_VERSION");
    if (review.holds.length) fail("CONFLICT");
    await writeRecord(roots, id, {kind: "source-content", review, interactionRef, responseText});
    return {decision: id, packageDigest: review.packageDigest};
  });
}
export async function planSourceInstall(roots, input) {
  return sourceOperation(async () => {
    homeCheck(roots, input.targetHome);
    if (!["install", "uninstall"].includes(input.mode)) fail();
    const {record, review} = await loadContent(roots, input.contentDecisionId, {revalidate: input.mode === "install"});
    const {agents, competing} = targetChecks(roots, input, review.mapping.name), actions = [];
    for (const agent of agents) {
      const path = join(input.targetHome, SOURCE_LAYOUTS[agent], review.mapping.name);
      const prior = await observed(roots, path, review, input.contentDecisionId, input.mode);
      actions.push({agent, skill: review.mapping.name, path, status: competing.length ? "conflict" : prior.status, priorReceiptDigest: prior.receipt ? digest(prior.receipt) : null, files: Object.fromEntries(review.files.map((f) => [f.target, f.sha256]))});
    }
    return finalizePlan({kind: "skill-source-local", pilotDigest: roots.pilot.digest, contentDecision: input.contentDecisionId, contentDecisionDigest: digest(record), packageDigest: review.packageDigest, sourceId: review.sourceId, pin: review.pin, stageRunId: review.stageRunId, mode: input.mode, targetHome: input.targetHome, agents, layouts: SOURCE_LAYOUTS, competing, holds: installHolds(review, agents, input.mode), disclosures: review.disclosures, actions});
  });
}
function actionable(plan) {
  if (plan.holds.length || plan.actions.some((a) => !["create", "installed", "update", "remove", "absent"].includes(a.status)) || !plan.actions.some((a) => ["create", "update", "remove"].includes(a.status))) fail("CONFLICT");
}
export async function approveSourceAction(roots, input, {decisionId: id, fingerprint, interactionRef, responseText}) {
  return sourceOperation(async () => {
    decisionId(id); interaction(interactionRef);
    const plan = await planSourceInstall(roots, input); assertFingerprint(plan, fingerprint); actionable(plan);
    if (responseText !== `Approved source ${plan.mode} ${plan.fingerprint}`) fail("STALE_VERSION");
    await writeRecord(roots, id, {kind: "source-action", plan, interactionRef, responseText});
    return {decision: id, planFingerprint: plan.fingerprint};
  });
}
export async function applySourceInstall(roots, input, {decisionId: id, fingerprint, runId}, {faults = {}} = {}) {
  return sourceOperation(async () => {
    homeCheck(roots, input.targetHome); decisionId(id);
    const run = runId ?? "run_" + randomBytes(12).toString("hex");
    if (!RUN_ID.test(run)) fail("INVALID_ID");
    const consumed = join(roots.stateRoot, "skill-source-installs/consumed", id + ".json"), runPath = join(roots.stateRoot, "runs", run);
    return withPilotLock(roots, join(roots.stateRoot, "locks/install.lock"), {kind: "skill-source-install", runId: run}, async () => {
      if ((await journals(roots, input.targetHome)).incomplete.length) fail("RECOVERY_REQUIRED");
      const plan = await planSourceInstall(roots, input); assertFingerprint(plan, fingerprint); actionable(plan);
      const decision = await readRecord(roots, id);
      if (!exact(decision, ["schemaVersion", "id", "pilotDigest", "kind", "plan", "interactionRef", "responseText", "recordHash"]) || decision.kind !== "source-action" || digest(decision.plan) !== digest(plan) || decision.responseText !== `Approved source ${plan.mode} ${plan.fingerprint}`) fail("STALE_VERSION");
      if (info(runPath)) fail("CONFLICT");
      ensurePrivatePath(roots.stateRoot, ["skill-source-installs", "consumed"]); strictPath(roots.stateRoot, ["skill-source-installs", "consumed"]);
      await writeNewFile(consumed, canonicalJson({runId: run, planFingerprint: fingerprint}) + "\n"); fsyncDir(join(roots.stateRoot, "skill-source-installs/consumed"));
      await faults.afterConsume?.();
      ensurePrivatePath(roots.stateRoot, ["runs"]); strictPath(roots.stateRoot, ["runs"]);
      await mkdir(runPath, {mode: 0o700});
      const intended = plan.actions.filter((a) => ["create", "update", "remove"].includes(a.status)), journalPath = join(runPath, "journal.json");
      const journal = {schemaVersion: 1, kind: "skill-source-local", decision: id, contentDecision: input.contentDecisionId, planFingerprint: fingerprint, targetHome: input.targetHome, intended, completed: []};
      await writeNewFile(journalPath, canonicalJson(journal) + "\n"); fsyncDir(runPath);
      await faults.afterJournal?.();
      const loaded = await loadContent(roots, input.contentDecisionId, {revalidate: input.mode === "install"});
      if (digest(loaded.record) !== plan.contentDecisionDigest) fail("STALE_VERSION");
      if (digest(await readRecord(roots, id)) !== digest(decision)) fail("STALE_VERSION");
      for (const action of intended) {
        const {competing} = targetChecks(roots, input, loaded.review.mapping.name);
        const prior = await observed(roots, action.path, loaded.review, input.contentDecisionId, input.mode);
        if (competing.length || prior.status !== action.status || (prior.receipt ? digest(prior.receipt) : null) !== action.priorReceiptDigest) fail("STALE_VERSION");
        await performPackageAction(roots, action, {files: loaded.files ?? {}, priorReceipt: prior.receipt, nextReceipt: receiptFor(loaded.review, input.contentDecisionId, run), journalPath}, {faults});
        journal.completed.push(action); await atomicReplace(journalPath, canonicalJson(journal) + "\n");
        await faults.afterAction?.(action);
      }
      return {applied: true, runId: run, actions: plan.actions};
    }, {destinations: [input.targetHome, consumed, runPath]});
  });
}
export async function sourceInstallStatus(roots, input) {
  return sourceOperation(async () => {
    homeCheck(roots, input.targetHome);
    return withPilotLock(roots, join(roots.stateRoot, "locks/install.lock"), {kind: "skill-source-status"}, async () => {
      const history = await journals(roots, input.targetHome), plan = await planSourceInstall(roots, input);
      let consumed = [];
      const dir = join(roots.stateRoot, "skill-source-installs/consumed");
      if (info(dir)) { strictPath(roots.stateRoot, ["skill-source-installs", "consumed"]); consumed = (await readdir(dir)).filter((v) => DECISION.test(v.slice(0, -5)) && v.endsWith(".json")).map((v) => v.slice(0, -5)).sort(); }
      return {status: history.incomplete.length ? "RECOVERY_REQUIRED" : "ok", ...history, consumed, actions: plan.actions, planned: plan};
    }, {destinations: [input.targetHome]});
  });
}
