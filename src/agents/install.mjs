import { readFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { mkdir, readFile, unlink, rmdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { DevctxError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { sha256, canonicalJson } from "../storage/canonical.mjs";
import { readPrivateJson, writeNewFile, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { RUN_ID } from "../storage/runs.mjs";
export const AGENT_HOMES = { claude: ".claude/skills", codex: ".codex/skills" };
export const SKILL_NAMES = ["devctx-onboard", "devctx-resume", "devctx-record"];
const kit = fileURLToPath(new URL("../..", import.meta.url));
function source(skill) { return readFileSync(join(kit, "skills", skill, "SKILL.md"), "utf8"); }
function statusFor(dir, skill, mode) {
  if (!existsSync(dir)) return mode === "install" ? "create" : "absent";
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) return "conflict";
  const ownerFile = join(dir, ".devctx-owned.json"), skillFile = join(dir, "SKILL.md");
  if (!existsSync(ownerFile)) return mode === "install" ? "conflict" : "preserve";
  try {
    if (lstatSync(ownerFile).isSymbolicLink() || lstatSync(skillFile).isSymbolicLink()) return "conflict";
    const owned = JSON.parse(readFileSync(ownerFile, "utf8"));
    if (owned.skill !== skill || owned.files?.["SKILL.md"] !== sha256(readFileSync(skillFile))) return "modified";
    if (readdirSync(dir).some((name) => name !== "SKILL.md" && name !== ".devctx-owned.json")) return "modified";
    if (mode === "uninstall") return "remove";
    return owned.version === "0.0.0-local" && readFileSync(skillFile, "utf8") === source(skill) ? "installed" : "update";
  } catch { return "conflict"; }
}
export async function planInstall(pilot, { targetHome, agents, mode = "install" }) {
  assertInPilot(pilot, targetHome, "agentHomes");
  if (targetHome === homedir()) throw new DevctxError("GATE_REQUIRED", "Real home refused");
  if (!["install", "uninstall"].includes(mode) || !Array.isArray(agents) || agents.some((a) => !AGENT_HOMES[a])) throw new DevctxError("INVALID_INPUT", "Invalid installer selection");
  const actions = [];
  for (const agent of [...new Set(agents)].sort()) for (const skill of SKILL_NAMES) {
    const path = join(targetHome, AGENT_HOMES[agent], skill);
    actions.push({ agent, skill, path, status: statusFor(path, skill, mode), hash: sha256(source(skill)) });
  }
  return finalizePlan({ kind: "skill-install", mode, targetHome, agents: [...new Set(agents)].sort(), actions });
}
export async function applyInstall(roots, pilot, input, { fingerprint, runId }) {
  if (!RUN_ID.test(runId)) throw new DevctxError("INVALID_ID", "Invalid run ID");
  const plan = await planInstall(pilot, input);
  assertFingerprint(plan, fingerprint);
  assertInPilot(pilot, input.targetHome, "agentHomes");
  const journalPath = join(roots.stateRoot, "runs", runId, "journal.json");
  const allPaths = [journalPath, ...plan.actions.flatMap((a) => [a.path, join(a.path, "SKILL.md"), join(a.path, ".devctx-owned.json")])];
  assertWritable(roots, allPaths);
  return withPilotLock(roots, join(roots.stateRoot, "locks", "install.lock"), { kind: "install", runId }, async () => {
    assertWritable(roots, allPaths);
    ensurePrivatePath(roots.stateRoot, ["runs", runId]);
    const intended = plan.actions.filter((a) => ["create", "update", "remove"].includes(a.status)).map((a) => ({ agent: a.agent, skill: a.skill, status: a.status, path: a.path }));
    const journal = { planFingerprint: fingerprint, intended, completed: [] };
    await writeNewFile(journalPath, canonicalJson(journal) + "\n");
    for (const action of intended) {
      assertWritable(roots, [action.path, join(action.path, "SKILL.md"), join(action.path, ".devctx-owned.json"), journalPath]);
      if (action.status === "create") {
        await mkdir(dirname(action.path), { recursive: true, mode: 0o700 });
        await mkdir(action.path, { mode: 0o700 });
        await writeNewFile(join(action.path, "SKILL.md"), source(action.skill));
        await writeNewFile(join(action.path, ".devctx-owned.json"), canonicalJson({ schemaVersion: 1, skill: action.skill, version: "0.0.0-local", files: { "SKILL.md": sha256(source(action.skill)) }, runId }) + "\n");
      } else if (action.status === "update") {
        await atomicReplace(join(action.path, "SKILL.md"), source(action.skill));
        await atomicReplace(join(action.path, ".devctx-owned.json"), canonicalJson({ schemaVersion: 1, skill: action.skill, version: "0.0.0-local", files: { "SKILL.md": sha256(source(action.skill)) }, runId }) + "\n");
      } else {
        if (statusFor(action.path, action.skill, "uninstall") !== "remove") throw new DevctxError("CONFLICT", "Installed skill changed before removal");
        await unlink(join(action.path, "SKILL.md"));
        await unlink(join(action.path, ".devctx-owned.json"));
        await rmdir(action.path);
      }
      journal.completed.push(action);
      await atomicReplace(journalPath, canonicalJson(journal) + "\n");
    }
    return { applied: true, actions: plan.actions };
  }, { destinations: allPaths });
}
export async function installStatus(roots, pilot, { targetHome }) {
  assertInPilot(pilot, targetHome, "agentHomes");
  const runsRoot = join(roots.stateRoot, "runs");
  let runs = [];
  try { runs = await readdir(runsRoot); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const incomplete = [];
  for (const run of runs) {
    const path = join(runsRoot, run, "journal.json");
    if (!existsSync(path)) continue;
    try {
      const journal = await readPrivateJson(path);
      if (!Array.isArray(journal.intended) || !Array.isArray(journal.completed) || journal.completed.length < journal.intended.length) incomplete.push(run);
    } catch { incomplete.push(run); }
  }
  const plans = await Promise.all(["claude", "codex"].map((agent) => planInstall(pilot, { targetHome, agents: [agent], mode: "install" })));
  return { status: incomplete.length ? "RECOVERY_REQUIRED" : "ok", incomplete, actions: plans.flatMap((plan) => plan.actions) };
}
