import { readFileSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { mkdir, unlink, rmdir, readdir } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DevctxError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sha256, canonicalJson, digest } from "../storage/canonical.mjs";
import { readPrivateJson, readPrivateBytes, writeNewFile, atomicReplace, ensurePrivatePath, fsyncDir, info, isWithin } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { RUN_ID } from "../storage/runs.mjs";
export const AGENT_HOMES = { claude: ".claude/skills", codex: ".agents/skills" };
// Earlier releases wrote Codex skills here. Status reports leftovers; nothing ever acts on them.
export const LEGACY_HOMES = { codex: ".codex/skills" };
export const SKILL_NAMES = ["devctx-onboard", "devctx-resume", "devctx-record"];
const SKILL = "SKILL.md", RECEIPT = ".devctx-owned.json", KIND = "skill-bundled", FILE_LIMIT = 1048576;
const WRITES = ["create", "update", "remove"];
const KIT = fileURLToPath(new URL("../..", import.meta.url));
const profileOf = (pilot) => pilot.live?.profileId ?? null;
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const lockPath = (roots) => join(roots.stateRoot, "locks", "install.lock");
const entryPaths = (path) => [path, join(path, SKILL), join(path, RECEIPT)];
const receiptBytes = (receipt) => canonicalJson(receipt) + "\n";
// Live sources come from the profile's kit, which loadPilot has proven is the running kit at the pinned commit.
function source(pilot, skill) {
  const path = join(pilot.live?.kitRoot ?? KIT, "skills", skill, SKILL), st = info(path);
  if (!st?.isFile()) throw new DevctxError("INTEGRITY", "Bundled skill source missing", { skill });
  return readFileSync(path);
}
function hashOf(path) {
  const st = info(path);
  if (!st) return null;
  if (!st.isFile()) return "other";
  try { return sha256(readFileSync(path)); } catch { return "other"; }
}
// Each selected agent's skill folder and the root assertWritable takes for it. Live mode never derives either from an argument.
function skillRoots(pilot, targetHome, agents) {
  if (!Array.isArray(agents) || agents.some((a) => typeof a !== "string" || !Object.hasOwn(AGENT_HOMES, a))) throw new DevctxError("INVALID_INPUT", "Invalid installer selection");
  const chosen = [...new Set(agents)].sort();
  if (!pilot.live) {
    assertInPilot(pilot, targetHome, "agentHomes");
    if (targetHome === homedir()) throw new DevctxError("GATE_REQUIRED", "Real home refused");
    return chosen.map((agent) => ({ agent, dir: join(targetHome, AGENT_HOMES[agent]), root: targetHome }));
  }
  const home = pilot.live.home;
  if (targetHome !== undefined && targetHome !== home) throw new DevctxError("GATE_REQUIRED", "Live target must be the profile home", { field: "targetHome" });
  return chosen.map((agent) => {
    const dir = Object.hasOwn(pilot.live.skillDirs, agent) ? pilot.live.skillDirs[agent] : undefined;
    const st = typeof dir === "string" ? info(dir) : null;
    if (!st?.isDirectory() || st.isSymbolicLink()) throw new DevctxError("GATE_REQUIRED", "Live skill folder unavailable", { field: "live.skillDirs." + agent });
    if (isWithin(dir, home) && realpathSync.native(dir) !== join(realpathSync.native(home), relative(home, dir))) throw new DevctxError("GATE_REQUIRED", "Live skill folder does not resolve to the profile", { field: "live.skillDirs." + agent });
    return { agent, dir, root: dir };
  });
}
// Journals in the private store. An unreadable journal is kept as null so callers stay conservative.
async function readJournals(stateRoot) {
  let ids = [];
  try { ids = await readdir(join(stateRoot, "runs")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const found = [];
  for (const id of ids.sort()) {
    if (!RUN_ID.test(id)) continue;
    const path = join(stateRoot, "runs", id, "journal.json");
    if (!existsSync(path)) continue;
    try { found.push({ id, journal: await readPrivateJson(path) }); } catch { found.push({ id, journal: null }); }
  }
  return found;
}
const wellFormed = (id, j) => j.schemaVersion === 2 && j.runId === id && Array.isArray(j.intended) && Array.isArray(j.started) && Array.isArray(j.completed) && j.intended.every((e) => isObject(e) && WRITES.includes(e.status) && typeof e.path === "string" && typeof e.root === "string" && SKILL_NAMES.includes(e.skill));
const bundledFor = (pilot, j) => j?.kind === KIND && j.profileId === profileOf(pilot);
const finished = (j) => j.closed === true || (j.completed.length === j.intended.length && j.completed.every((e, i) => canonicalJson(e) === canonicalJson(j.intended[i])));
// Runs that block a new apply: this profile's unfinished bundled runs, unreadable journals, and in the pilot legacy unkinded ones.
async function incompleteRuns(pilot) {
  const runs = [];
  for (const { id, journal } of await readJournals(pilot.stateRoot)) {
    if (journal === null) runs.push({ id, journal });
    else if (bundledFor(pilot, journal)) { if (!wellFormed(id, journal) || !finished(journal)) runs.push({ id, journal }); }
    else if (!pilot.live && journal.kind === undefined && !(Array.isArray(journal.intended) && Array.isArray(journal.completed) && journal.completed.length >= journal.intended.length)) runs.push({ id, journal });
  }
  return runs;
}
// An entry is owned only when its receipt matches a completed journal entry for this profile at this path.
function ledger(pilot, journals) {
  const byRun = new Map(journals.filter(({ id, journal }) => bundledFor(pilot, journal) && wellFormed(id, journal)).map(({ id, journal }) => [id, journal]));
  return (receipt, path) => {
    const journal = byRun.get(receipt.runId);
    return Boolean(journal) && journal.completed.some((e) => e.path === path && ["create", "update"].includes(e.status) && canonicalJson(e.receipt) === canonicalJson(receipt));
  };
}
function receiptShape(pilot, receipt, skill) {
  return isObject(receipt) && canonicalJson(Object.keys(receipt).sort()) === canonicalJson(["files", "kind", "kitCommit", "profileId", "runId", "schemaVersion", "skill"])
    && receipt.schemaVersion === 2 && receipt.kind === KIND && receipt.skill === skill && receipt.profileId === profileOf(pilot) && RUN_ID.test(receipt.runId ?? "")
    && (receipt.kitCommit === null || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(receipt.kitCommit ?? ""))
    && isObject(receipt.files) && canonicalJson(Object.keys(receipt.files)) === canonicalJson([SKILL]) && /^sha256:[0-9a-f]{64}$/.test(receipt.files[SKILL]);
}
async function observe(pilot, owned, dir, skill, mode) {
  const st = info(dir);
  if (!st) return { status: mode === "install" ? "create" : "absent" };
  if (st.isSymbolicLink()) return { status: "conflict", reason: "symlink" };
  if (!st.isDirectory()) return { status: "conflict", reason: "not-directory" };
  const foreign = (reason) => ({ status: mode === "install" ? "conflict" : "preserve", reason });
  if (!info(join(dir, RECEIPT))) return foreign("foreign-entry");
  let receipt, rawReceipt;
  try { rawReceipt = await readPrivateBytes(join(dir, RECEIPT), FILE_LIMIT); receipt = JSON.parse(rawReceipt.toString("utf8")); } catch { return foreign("unowned-receipt"); }
  if (!receiptShape(pilot, receipt, skill) || !owned(receipt, dir)) return foreign("unowned-receipt");
  if (canonicalJson(readdirSync(dir).sort()) !== canonicalJson([RECEIPT, SKILL])) return { status: "modified", reason: "extra-files", receipt };
  let body;
  try { body = await readPrivateBytes(join(dir, SKILL), FILE_LIMIT); } catch { return { status: "modified", reason: "unsafe-file", receipt }; }
  if (sha256(body) !== receipt.files[SKILL]) return { status: "modified", reason: "edited", receipt };
  const old = { [SKILL]: sha256(body), [RECEIPT]: sha256(rawReceipt) };
  if (mode === "uninstall") return { status: "remove", receipt, old };
  return { status: receipt.files[SKILL] === sha256(source(pilot, skill)) ? "installed" : "update", receipt, old };
}
export async function planInstall(pilot, { targetHome, agents, mode = "install" }) {
  if (!["install", "uninstall"].includes(mode)) throw new DevctxError("INVALID_INPUT", "Invalid installer selection");
  const roots = skillRoots(pilot, targetHome, agents);
  const owned = ledger(pilot, await readJournals(pilot.stateRoot));
  const actions = [];
  for (const { agent, dir, root } of roots) for (const skill of SKILL_NAMES) {
    const path = join(dir, skill), seen = await observe(pilot, owned, path, skill, mode);
    actions.push({ agent, skill, path, root, status: seen.status, ...(seen.reason ? { reason: seen.reason } : {}), prior: seen.receipt ? digest(seen.receipt) : null, ...(mode === "install" ? { hash: sha256(source(pilot, skill)) } : {}) });
  }
  // Live: a conflict blocks only its own agent, and blocks all of that agent's writes.
  if (pilot.live && mode === "install") for (const { agent } of roots) {
    if (!actions.some((a) => a.agent === agent && ["conflict", "modified"].includes(a.status))) continue;
    for (const a of actions) if (a.agent === agent && ["create", "update"].includes(a.status)) Object.assign(a, { status: "blocked", reason: "agent-conflict" });
  }
  return finalizePlan({ kind: "skill-install", mode, targetHome: targetHome ?? null, profileId: profileOf(pilot), kitCommit: pilot.live?.kitCommit ?? null, agents: roots.map((r) => r.agent), actions });
}
// faults.afterFolder, afterSkill and afterReceipt are test seams that crash between the writes of one action.
async function perform(pilot, entry, bytes, faults) {
  const { path, status } = entry;
  if (status === "create") {
    if (!pilot.live) await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await mkdir(path, { mode: 0o700 });
    await faults.afterFolder?.(entry);
    await writeNewFile(join(path, SKILL), bytes.skill);
    await faults.afterSkill?.(entry);
    await writeNewFile(join(path, RECEIPT), bytes.receipt);
    fsyncDir(path);
    await faults.afterReceipt?.(entry);
  } else if (status === "update") {
    await atomicReplace(join(path, SKILL), bytes.skill);
    await faults.afterSkill?.(entry);
    await atomicReplace(join(path, RECEIPT), bytes.receipt);
    await faults.afterReceipt?.(entry);
  } else {
    await unlink(join(path, SKILL));
    await faults.afterSkill?.(entry);
    await unlink(join(path, RECEIPT));
    await faults.afterReceipt?.(entry);
    await rmdir(path);
    fsyncDir(dirname(path));
  }
}
export async function applyInstall(roots, pilot, input, { fingerprint, runId }, { faults = {} } = {}) {
  if (!RUN_ID.test(runId)) throw new DevctxError("INVALID_ID", "Invalid run ID");
  assertFingerprint(await planInstall(pilot, input), fingerprint);
  const runDir = join(roots.stateRoot, "runs", runId), journalPath = join(runDir, "journal.json");
  return withPilotLock(roots, lockPath(roots), { kind: "install", runId }, async () => {
    if ((await incompleteRuns(pilot)).length) throw new DevctxError("RECOVERY_REQUIRED", "Incomplete installer journal");
    const plan = await planInstall(pilot, input);
    assertFingerprint(plan, fingerprint);
    const intended = plan.actions.filter((a) => WRITES.includes(a.status));
    if (!intended.length) return { applied: false, actions: plan.actions };
    for (const a of intended) assertWritable(roots, [...entryPaths(a.path), journalPath], { targetHome: a.root });
    ensurePrivatePath(roots.stateRoot, ["runs"]);
    try { await mkdir(runDir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST") throw new DevctxError("CONFLICT", "Run ID already exists"); throw error; }
    const copies = ensurePrivatePath(roots.stateRoot, ["runs", runId, "copies"]);
    // Before the first target write, the run folder keeps the old and new bytes that the journal's hashes name.
    const entries = [], bytes = [];
    for (const [i, a] of intended.entries()) {
      const entry = { agent: a.agent, skill: a.skill, path: a.path, root: a.root, status: a.status, old: null, new: null, receipt: null }, own = {};
      if (a.status !== "create") {
        const skill = await readPrivateBytes(join(a.path, SKILL), FILE_LIMIT), receipt = await readPrivateBytes(join(a.path, RECEIPT), FILE_LIMIT);
        if (digest(JSON.parse(receipt.toString("utf8"))) !== a.prior) throw new DevctxError("STALE_VERSION", "Target changed during apply");
        await writeNewFile(join(copies, i + "-old-skill"), skill);
        await writeNewFile(join(copies, i + "-old-receipt"), receipt);
        entry.old = { [SKILL]: sha256(skill), [RECEIPT]: sha256(receipt) };
      }
      if (a.status !== "remove") {
        own.skill = source(pilot, a.skill);
        if (sha256(own.skill) !== a.hash) throw new DevctxError("STALE_VERSION", "Bundled source changed during apply");
        entry.receipt = { schemaVersion: 2, kind: KIND, skill: a.skill, profileId: profileOf(pilot), runId, kitCommit: pilot.live?.kitCommit ?? null, files: { [SKILL]: sha256(own.skill) } };
        own.receipt = receiptBytes(entry.receipt);
        await writeNewFile(join(copies, i + "-new-skill"), own.skill);
        await writeNewFile(join(copies, i + "-new-receipt"), own.receipt);
        entry.new = { [SKILL]: sha256(own.skill), [RECEIPT]: sha256(own.receipt) };
      }
      entries.push(entry); bytes.push(own);
    }
    fsyncDir(copies);
    const journal = { schemaVersion: 2, kind: KIND, profileId: profileOf(pilot), runId, kitCommit: pilot.live?.kitCommit ?? null, mode: plan.mode, planFingerprint: fingerprint, targetHome: plan.targetHome, intended: entries, started: [], completed: [] };
    await writeNewFile(journalPath, canonicalJson(journal) + "\n");
    for (const [i, entry] of entries.entries()) {
      assertWritable(roots, [...entryPaths(entry.path), journalPath], { targetHome: entry.root });
      if (entry.status === "remove") {
        const now = await observe(pilot, ledger(pilot, await readJournals(roots.stateRoot)), entry.path, entry.skill, "uninstall");
        if (now.status !== "remove") throw new DevctxError("CONFLICT", "Installed skill changed before removal");
      }
      journal.started.push(i);
      await atomicReplace(journalPath, canonicalJson(journal) + "\n");
      await perform(pilot, entry, bytes[i], faults);
      journal.completed.push(entry);
      await atomicReplace(journalPath, canonicalJson(journal) + "\n");
    }
    return { applied: true, runId, actions: plan.actions };
  }, { destinations: [runDir] });
}
// Recovery works from the journal and the run folder copies only, never from the current kit.
function recoveryFor(entry, copies, index) {
  const dirSt = info(entry.path), base = { agent: entry.agent, skill: entry.skill, path: entry.path, root: entry.root };
  const hold = (reason, observed = {}) => ({ ...base, op: "hold", reason, observed });
  if (dirSt && (dirSt.isSymbolicLink() || !dirSt.isDirectory())) return hold("unmatched-entry");
  const names = dirSt ? readdirSync(entry.path).sort() : [];
  const observed = Object.fromEntries([SKILL, RECEIPT].map((name) => [name, dirSt ? hashOf(join(entry.path, name)) : null]));
  if (names.some((name) => name !== SKILL && name !== RECEIPT)) return hold("unmatched-file", observed);
  const matches = (allowed) => [SKILL, RECEIPT].every((name) => allowed(name).includes(observed[name]));
  if (entry.status === "create") return matches((name) => [null, entry.new?.[name]]) ? { ...base, op: "remove-create", observed } : hold("unmatched-file", observed);
  if (entry.status === "remove") return matches((name) => [null, entry.old?.[name]]) ? { ...base, op: "finish-remove", observed } : hold("unmatched-file", observed);
  if (!dirSt || !matches((name) => [entry.old?.[name], entry.new?.[name]])) return hold("unmatched-file", observed);
  for (const [name, kind] of [[SKILL, "skill"], [RECEIPT, "receipt"]]) if (hashOf(join(copies, index + "-new-" + kind)) !== entry.new[name]) return hold("copy-mismatch", observed);
  return { ...base, op: "complete-update", observed };
}
export async function planRecovery(roots, pilot) {
  assertWritable(roots, []);
  const actions = [], unstarted = [], runs = [];
  for (const { id, journal } of await incompleteRuns(pilot)) {
    runs.push(id);
    if (journal === null || !bundledFor(pilot, journal) || !wellFormed(id, journal)) { actions.push({ runId: id, index: null, op: "hold", reason: "unreadable-journal" }); continue; }
    const copies = join(roots.stateRoot, "runs", id, "copies");
    for (const [index, entry] of journal.intended.entries()) {
      if (index < journal.completed.length) continue;
      if (!journal.started.includes(index)) { unstarted.push({ runId: id, index, skill: entry.skill, path: entry.path }); continue; }
      actions.push({ runId: id, index, ...recoveryFor(entry, copies, index) });
    }
  }
  return finalizePlan({ kind: "skill-install-recovery", profileId: profileOf(pilot), runs, actions, unstarted });
}
export async function applyRecovery(roots, pilot, { fingerprint }) {
  assertFingerprint(await planRecovery(roots, pilot), fingerprint);
  return withPilotLock(roots, lockPath(roots), { kind: "install-recovery" }, async () => {
    const plan = await planRecovery(roots, pilot);
    assertFingerprint(plan, fingerprint);
    const journals = new Map((await readJournals(roots.stateRoot)).filter(({ id }) => plan.runs.includes(id)).map(({ id, journal }) => [id, journal]));
    for (const action of plan.actions) {
      if (action.op === "hold") continue;
      const journal = journals.get(action.runId), entry = journal.intended[action.index];
      assertWritable(roots, entryPaths(entry.path), { targetHome: entry.root });
      if (action.op === "complete-update") {
        const copies = join(roots.stateRoot, "runs", action.runId, "copies");
        for (const [name, kind] of [[SKILL, "skill"], [RECEIPT, "receipt"]]) {
          if (hashOf(join(entry.path, name)) === entry.new[name]) continue;
          const body = await readPrivateBytes(join(copies, action.index + "-new-" + kind), FILE_LIMIT);
          if (sha256(body) !== entry.new[name]) throw new DevctxError("INTEGRITY", "Run folder copy changed");
          await atomicReplace(join(entry.path, name), body);
        }
        journal.completed.push(entry);
      } else if (info(entry.path)) {
        for (const name of [SKILL, RECEIPT]) if (info(join(entry.path, name))) await unlink(join(entry.path, name));
        await rmdir(entry.path);
        fsyncDir(dirname(entry.path));
      }
    }
    const closed = [];
    for (const id of plan.runs) {
      const journal = journals.get(id);
      if (!journal || plan.actions.some((a) => a.runId === id && a.op === "hold")) continue;
      const path = join(roots.stateRoot, "runs", id, "journal.json");
      assertWritable(roots, [path]);
      journal.closed = true;
      journal.recovery = { planFingerprint: fingerprint, actions: plan.actions.filter((a) => a.runId === id).map((a) => ({ index: a.index, op: a.op })) };
      await atomicReplace(path, canonicalJson(journal) + "\n");
      closed.push(id);
    }
    return { applied: true, closed, held: plan.actions.filter((a) => a.op === "hold"), actions: plan.actions };
  }, { destinations: [join(roots.stateRoot, "runs")] });
}
function legacyEntries(home) {
  const found = [];
  for (const [agent, rel] of Object.entries(LEGACY_HOMES)) {
    const dir = join(home, rel), st = info(dir);
    if (!st?.isDirectory() || st.isSymbolicLink()) continue;
    for (const name of readdirSync(dir).sort()) if (name.startsWith("devctx-")) found.push({ agent, skill: name, path: join(dir, name) });
  }
  return found;
}
export async function installStatus(roots, pilot, { targetHome }) {
  if (!pilot.live) assertInPilot(pilot, targetHome, "agentHomes");
  let incomplete;
  if (pilot.live) incomplete = (await incompleteRuns(pilot)).map((r) => r.id);
  else {
    incomplete = [];
    for (const { id, journal: j } of await readJournals(roots.stateRoot)) {
      if (j?.kind === KIND && j.closed === true) continue;
      if (j === null || !Array.isArray(j.intended) || !Array.isArray(j.completed) || j.completed.length < j.intended.length) incomplete.push(id);
    }
  }
  const agents = pilot.live ? Object.keys(pilot.live.skillDirs).filter((a) => Object.hasOwn(AGENT_HOMES, a)).sort() : ["claude", "codex"];
  const plans = await Promise.all(agents.map((agent) => planInstall(pilot, { targetHome, agents: [agent], mode: "install" })));
  return { status: incomplete.length ? "RECOVERY_REQUIRED" : "ok", incomplete, actions: plans.flatMap((plan) => plan.actions), legacy: legacyEntries(pilot.live?.home ?? targetHome) };
}
