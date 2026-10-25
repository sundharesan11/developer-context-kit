import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { twoScopes, makePilot, now, runCli } from "./helpers.mjs";
import { buildEnvelope, checkEnvelopeFresh, completionDraft } from "../src/agents/envelope.mjs";
import { planInstall, applyInstall, installStatus } from "../src/agents/install.mjs";
import { proposeRecord, publishProposal, readSnapshot } from "../src/records/store.mjs";
import { buildBrief } from "../src/context/brief.mjs";
import { performPackageAction } from "../src/agents/package-files.mjs";
import { existsSync } from "node:fs";
test("handoff: claude proposes, controller publishes, codex brief shows it with provenance", async (t) => {
  const s = await twoScopes(t);
  const env = await buildEnvelope(s.roots, { scope: "acme", cwd: s.atlas, taskId: "task-1", runId: "run_claude01", parentRunId: "run_parent01", deliverable: "fix", verificationCommands: ["node --test"], allowedOutputPaths: [join(s.atlas, "src")], allowedOperations: ["read", "edit-files"], constraints: [] }, { now });
  const d = completionDraft(env, { actor: "claude", lastVerifiedResult: "tests green", evidence: ["commit:" + env.worktree.head], changedFiles: ["src/a.mjs"], nextAction: "review", blockers: [] });
  assert.equal(d.draft.kind, "handoff"); assert.equal(d.draft.status, "proposed");
  const prop = await proposeRecord(s.roots, { ...d, requestId: "req_handoff01" }, { now });
  const pending = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  assert.equal(pending.records.some((r) => r.kind === "handoff"), false);
  await publishProposal(s.roots, { scope: "acme", project: "acme.atlas", proposalId: prop.proposalId }, { controller: "human", now });
  const codexView = await buildBrief(s.roots, s.pilot, { scope: "acme", cwd: s.atlas });
  const h = codexView.records.find((r) => r.kind === "handoff");
  assert.ok(h);
  assert.equal((await readSnapshot(s.roots, "acme", "acme.atlas")).records.find((r) => r.id === h.id).recordedBy.actor, "claude");
});
test("envelope rejects outputs outside worktree and publish operations; notice present", async (t) => {
  const s = await twoScopes(t);
  const base = { scope: "acme", cwd: s.atlas, taskId: "task-1", runId: "run_claude01", parentRunId: "run_parent01", deliverable: "fix", verificationCommands: [], allowedOutputPaths: [join(s.atlas, "src")], allowedOperations: ["read"], constraints: [] };
  await assert.rejects(buildEnvelope(s.roots, { ...base, allowedOutputPaths: [s.beacon] }, { now }), { code: "DEVTWIN_PATH_ESCAPE" });
  await assert.rejects(buildEnvelope(s.roots, { ...base, allowedOutputPaths: [join(s.roots.dataRoot, "x")] }, { now }), { code: "DEVTWIN_PATH_ESCAPE" });
  for (const op of ["publish", "send", "push"]) await assert.rejects(buildEnvelope(s.roots, { ...base, allowedOperations: ["read", op] }, { now }), { code: "DEVTWIN_GATE_REQUIRED" });
  const env = await buildEnvelope(s.roots, base, { now });
  assert.match(env.notice, /not an enforced capability/);
  assert.deepEqual(checkEnvelopeFresh(env, { now: () => new Date("2026-10-08T00:00:00.000Z"), head: env.worktree.head }).reasons, ["EXPIRED"]);
  assert.deepEqual(checkEnvelopeFresh(env, { now, head: "0".repeat(40) }).reasons, ["HEAD_MOVED"]);
});
test("install: preview, apply, idempotent, conflict preserved, modified preserved on uninstall", async (t) => {
  const p = await makePilot(t); const home = p.agentHomes[0];
  await mkdir(join(home, ".agents/skills/devtwin-record"), { recursive: true }); await writeFile(join(home, ".agents/skills/devtwin-record/SKILL.md"), "foreign");
  const plan = await planInstall(p.pilot, { targetHome: home, agents: ["claude", "codex"], mode: "install" });
  assert.equal(plan.actions.find((a) => a.agent === "codex" && a.skill === "devtwin-record").status, "conflict");
  await applyInstall(p.roots, p.pilot, { targetHome: home, agents: ["claude", "codex"], mode: "install" }, { fingerprint: plan.fingerprint, runId: "run_install01" });
  const again = await planInstall(p.pilot, { targetHome: home, agents: ["claude"], mode: "install" });
  assert.ok(again.actions.every((a) => a.status === "installed"));
  assert.equal(await readFile(join(home, ".agents/skills/devtwin-record/SKILL.md"), "utf8"), "foreign");
  assert.ok(existsSync(join(home, ".agents/skills/devtwin-resume/.devtwin-owned.json")));
  assert.equal(existsSync(join(home, ".codex")), false);
  const edited = join(home, ".claude/skills/devtwin-record/SKILL.md");
  await writeFile(edited, "user edited");
  const uninstall = await planInstall(p.pilot, { targetHome: home, agents: ["claude"], mode: "uninstall" });
  assert.equal(uninstall.actions.find((a) => a.skill === "devtwin-record").status, "modified");
  await applyInstall(p.roots, p.pilot, { targetHome: home, agents: ["claude"], mode: "uninstall" }, { fingerprint: uninstall.fingerprint, runId: "run_uninstall01" });
  assert.equal(await readFile(edited, "utf8"), "user edited");
  const after = await planInstall(p.pilot, { targetHome: home, agents: ["claude"], mode: "install" });
  assert.equal(after.actions.find((a) => a.skill === "devtwin-record").status, "modified");
  assert.ok(after.actions.filter((a) => a.skill !== "devtwin-record").every((a) => a.status === "create"));
  await assert.rejects(planInstall(p.pilot, { targetHome: homedir(), agents: ["claude"], mode: "install" }), { code: "DEVTWIN_GATE_REQUIRED" });
});
test("installer status reports incomplete journal without repair", async (t) => {
  const p = await makePilot(t);
  const run = join(p.stateRoot, "runs/run_partial01");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "journal.json"), JSON.stringify({ planFingerprint: "sha256:" + "0".repeat(64), intended: [{ skill: "devtwin-record" }], completed: [] }));
  const status = await installStatus(p.roots, p.pilot, { targetHome: p.agentHomes[0] });
  assert.equal(status.status, "RECOVERY_REQUIRED");
  assert.equal((await readFile(join(run, "journal.json"), "utf8")).includes("completed"), true);
});
test("bundled CLI can install, uninstall, and reinstall with unique default journal IDs", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0];
  for (const mode of ["install", "uninstall", "install"]) {
    const args = ["agents", mode, "--pilot", p.path, "--home", home, "--agent", "claude"];
    const planned = await runCli(args);
    assert.equal(planned.code, 0, JSON.stringify(planned.json));
    const result = await runCli([...args, "--apply", "--plan-fingerprint", planned.json.result.fingerprint]);
    assert.equal(result.code, 0, JSON.stringify(result.json));
  }
});
test("bundled installer refuses an existing run directory without a journal", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0], input = { targetHome: home, agents: ["claude"], mode: "install" };
  const plan = await planInstall(p.pilot, input);
  await mkdir(join(p.stateRoot, "runs/run_existing01"), { recursive: true, mode: 0o700 });
  await assert.rejects(applyInstall(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, runId: "run_existing01" }), { code: "DEVTWIN_CONFLICT" });
});
test("installer file writes are confined to the opted-in target agent home", async (t) => {
  const p = await makePilot(t), [a, b] = p.agentHomes, path = join(b, ".claude/skills/devtwin-x"), journalPath = join(p.stateRoot, "runs/run_cross001/journal.json");
  const files = { "SKILL.md": "x" }, nextReceipt = { schemaVersion: 2, files: { "SKILL.md": "x" } };
  for (const targetHome of [a, undefined]) await assert.rejects(performPackageAction(p.roots, { path, status: "create" }, { files, nextReceipt, journalPath, targetHome }), { code: "DEVTWIN_GATE_REQUIRED" });
  assert.equal(existsSync(join(b, ".claude")), false);
});
