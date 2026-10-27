import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, lstat, chmod } from "node:fs/promises";
import { makePilot, runCli, sandbox, makeRepo, fixtureGit, now } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, recordApprovedDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { planHooks, applyHooks, hookStatus, expectedEntries, hookContext, hookCommand, CODEX_TRUST_NOTE } from "../src/agents/hooks-install.mjs";
import { planInstall, applyInstall, installStatus, planRecovery, applyRecovery } from "../src/agents/install.mjs";
import { rollbackCheck } from "../src/agents/inventory.mjs";
import { receiptPath } from "../src/hooks/receipt.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const crash = () => { throw new Error("injected crash"); };
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const lint = { matcher: "Bash", hooks: [{ type: "command", command: "example-lint --check" }] };
const lookalike = { hooks: [{ type: "command", command: 'node "/opt/kit/bin/devtwin.mjs" hook --event session-start --agent claude --pilot "/other/live.json"' }] };
// A disposable pilot whose first fake agent home has Claude and Codex folders approved as hook targets.
async function hookPilot(t, { settings } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0];
  const paths = { settings: join(home, ".claude/settings.json"), codex: join(home, ".codex/hooks.json") };
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  if (settings !== undefined) await writeFile(paths.settings, settings, { mode: 0o644 });
  const path = await p.with({ writeClasses: { hookTargets: [paths.settings, paths.codex] } });
  const pilot = await loadPilot(path, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
  return { ...p, home, paths, path, pilot, roots: rootsFromPilot(pilot) };
}
const input = (h, agents = ["claude", "codex"], mode = "install") => ({ targetHome: h.home, agents, mode, kitRoot: KIT });
async function hooks(h, agents, mode, runId, options) {
  const plan = await planHooks(h.pilot, input(h, agents, mode));
  return { plan, result: await applyHooks(h.roots, h.pilot, input(h, agents, mode), { fingerprint: plan.fingerprint, runId, now: now() }, options) };
}
const cli = async (h, args) => {
  const out = await runCli([...args, "--pilot", h.path, "--home", h.home]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  return out.json.result;
};

test("hook install on a fixture home adds only devtwin hook entries and uninstall removes only them", async (t) => {
  const original = json({ model: "example", hooks: { PreToolUse: [lint], SessionStart: [lookalike] } });
  const h = await hookPilot(t, { settings: original });
  const context = hookContext(h.pilot, KIT), claude = expectedEntries("claude", context), codex = expectedEntries("codex", context);
  assert.equal(claude.PreToolUse[0].hooks[0].command, 'node "' + KIT + '/bin/devtwin.mjs" hook --event pre-tool --agent claude --pilot "' + realpathSync(h.path) + '"');
  assert.equal(claude.PreToolUse[0].matcher, "Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep|Bash");
  assert.deepEqual(Object.keys(claude), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PreCompact", "Stop"]);
  assert.deepEqual(Object.keys(codex), ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"]);
  assert.deepEqual([codex.PreToolUse[0].matcher, codex.PostToolUse[0].matcher], ["^(apply_patch|Bash)$", "^Bash$"]);
  // Without --hooks the installer previews skills exactly as before.
  assert.equal((await cli(h, ["agents", "install", "--agent", "claude"])).kind, "skill-install");
  const args = ["agents", "install", "--hooks", "--agent", "claude", "--agent", "codex"];
  const preview = await cli(h, args);
  assert.equal(preview.kind, "hook-install");
  assert.deepEqual(preview.actions.map((a) => [a.agent, a.status]), [["claude", "update"], ["codex", "create"]]);
  assert.deepEqual(preview.actions[0].foreign, [{ event: "SessionStart", index: 0, reason: "devtwin-like-entry" }]);
  assert.deepEqual(preview.actions[0].changes, Object.entries(claude).map(([event, [entry]]) => ({ event, op: "add", entry })));
  assert.equal(preview.receipt, receiptPath(h.stateRoot));
  assert.deepEqual(preview.notes, [CODEX_TRUST_NOTE]);
  assert.equal(await readFile(h.paths.settings, "utf8"), original, "preview writes nothing");
  const applied = await cli(h, [...args, "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.equal(applied.applied, true);
  const settings = JSON.parse(await readFile(h.paths.settings, "utf8"));
  assert.deepEqual(settings, { model: "example", hooks: { PreToolUse: [lint, ...claude.PreToolUse], SessionStart: [lookalike, ...claude.SessionStart], UserPromptSubmit: claude.UserPromptSubmit, PreCompact: claude.PreCompact, Stop: claude.Stop } });
  assert.equal((await lstat(h.paths.settings)).mode & 0o777, 0o644);
  assert.deepEqual(JSON.parse(await readFile(h.paths.codex, "utf8")), { hooks: codex });
  assert.equal((await lstat(h.paths.codex)).mode & 0o777, 0o600);
  // Install writes the kit receipt; nothing lands in the skill folders.
  assert.equal(applied.receipt, receiptPath(h.stateRoot));
  assert.equal(JSON.parse(await readFile(receiptPath(h.stateRoot), "utf8")).pilotPath, realpathSync(h.path));
  assert.equal(existsSync(join(h.home, ".claude/skills")), false);
  const again = await cli(h, args);
  assert.deepEqual(again.actions.map((a) => a.status), ["installed", "installed"]);
  const status = (await cli(h, ["agents", "status"])).hooks;
  assert.deepEqual(status.agents.map((a) => [a.agent, a.status]), [["claude", "installed"], ["codex", "installed"]]);
  assert.equal(status.receipt, "ok");
  assert.deepEqual(status.notes, [CODEX_TRUST_NOTE]);
  const removeArgs = ["agents", "uninstall", "--hooks", "--agent", "claude", "--agent", "codex"];
  const removal = await cli(h, removeArgs);
  assert.deepEqual(removal.actions.map((a) => a.status), ["remove", "remove"]);
  assert.equal(removal.receipt, null);
  await cli(h, [...removeArgs, "--apply", "--plan-fingerprint", removal.fingerprint]);
  assert.equal(await readFile(h.paths.settings, "utf8"), original, "foreign entries and layout are byte-identical");
  assert.equal(await readFile(h.paths.codex, "utf8"), "{}\n");
  assert.deepEqual((await cli(h, removeArgs)).actions.map((a) => a.status), ["absent", "absent"]);
});

// A live config with approved hook targets, rewritten in place at one path, as a kit update keeps the config file.
async function liveHooks(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".codex"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const paths = { settings: join(home, ".claude/settings.json"), codex: join(home, ".codex/hooks.json") };
  const path = join(devtwin, "live.json"), context = { home, env: {}, kitRoot: kit };
  const obj = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills") }, kitRoot: kit, kitCommit: null }, writeClasses: { hookTargets: [paths.settings, paths.codex] } };
  const use = async () => {
    const kitCommit = (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim();
    await writeFile(path, JSON.stringify({ ...obj, live: { ...obj.live, kitCommit } }), { mode: 0o600 });
    await chmod(path, 0o600);
    const draft = await loadPilot(path, { ...context, liveGate: { approval: false } });
    ensureRoots(rootsFromPilot(draft));
    await recordApprovedDigest(rootsFromPilot(draft));
    const pilot = await loadPilot(path, context);
    return { pilot, roots: rootsFromPilot(pilot), kitCommit };
  };
  return { home, kit, paths, path, use };
}

test("re-running hook install after a kit update leaves the hook lines unchanged", async (t) => {
  const f = await liveHooks(t), a = await f.use();
  const lin = { agents: ["claude", "codex"], mode: "install", kitRoot: f.kit };
  const plan = await planHooks(a.pilot, lin);
  assert.deepEqual(plan.actions.map((x) => x.status), ["create", "create"]);
  await applyHooks(a.roots, a.pilot, lin, { fingerprint: plan.fingerprint, runId: "run_livehook01", now: now() });
  const before = [await readFile(f.paths.settings), await readFile(f.paths.codex)];
  assert.ok(before[0].toString().includes(JSON.stringify('node "' + f.kit + '/bin/devtwin.mjs" hook --event pre-tool --agent claude --pilot "' + f.path + '"').slice(1, -1)), before[0].toString());
  // The kit moves to a new commit in the same clone and the live config is re-approved for it.
  await writeFile(join(f.kit, "CHANGELOG.md"), "update\n");
  await fixtureGit(f.kit, ["add", "-A"]);
  await fixtureGit(f.kit, ["commit", "-q", "-m", "kit update"]);
  const b = await f.use();
  assert.notEqual(b.kitCommit, a.kitCommit);
  const replan = await planHooks(b.pilot, lin);
  assert.deepEqual(replan.actions.map((x) => x.status), ["installed", "installed"]);
  const result = await applyHooks(b.roots, b.pilot, lin, { fingerprint: replan.fingerprint, runId: "run_livehook02", now: now() });
  assert.equal(result.applied, false);
  assert.deepEqual([await readFile(f.paths.settings), await readFile(f.paths.codex)], before);
  assert.equal(JSON.parse(await readFile(receiptPath(b.roots.stateRoot), "utf8")).kitCommit, b.kitCommit, "install refreshes the receipt");
  assert.equal(existsSync(join(b.roots.stateRoot, "runs/run_livehook02")), false);
  // A target outside the approved classes is blocked, never written.
  const unapproved = await planHooks({ ...b.pilot, writeClasses: undefined }, lin).catch((e) => e);
  assert.ok(unapproved.code === "DEVTWIN_GATE_REQUIRED" || unapproved.actions.every((x) => x.status === "blocked"));
});

test("a settings file with a foreign devtwin-like hook entry is not adopted", async (t) => {
  const h0 = await hookPilot(t);
  const exact = expectedEntries("claude", hookContext(h0.pilot, KIT));
  const original = json({ hooks: { PreToolUse: [...exact.PreToolUse], SessionStart: [lookalike] } });
  await writeFile(h0.paths.settings, original, { mode: 0o644 });
  const h = h0;
  const plan = await planHooks(h.pilot, input(h));
  const claude = plan.actions.find((a) => a.agent === "claude");
  assert.deepEqual([claude.status, claude.reason], ["conflict", "foreign-entry"]);
  assert.equal(claude.events.find((e) => e.event === "PreToolUse").status, "foreign-entry");
  assert.equal(plan.actions.find((a) => a.agent === "codex").status, "create");
  await applyHooks(h.roots, h.pilot, input(h), { fingerprint: plan.fingerprint, runId: "run_foreign01", now: now() });
  assert.equal(await readFile(h.paths.settings, "utf8"), original);
  assert.ok(existsSync(h.paths.codex));
  // Uninstall never removes the copy devtwin did not write, and status reports it.
  const removal = await planHooks(h.pilot, input(h, ["claude"], "uninstall"));
  assert.equal(removal.actions[0].status, "absent");
  assert.equal((await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT })).agents[0].status, "foreign-entry");
  assert.equal(hookCommand({ kitRoot: "/k", pilotPath: "/p.json", event: "pre-tool", agent: "codex" }), 'node "/k/bin/devtwin.mjs" hook --event pre-tool --agent codex --pilot "/p.json"');
});

test("agents status reports a removed hook as missing and an edited one as modified", async (t) => {
  const h = await hookPilot(t, { settings: json({ model: "example" }) });
  await hooks(h, ["claude"], "install", "run_status001");
  const settings = JSON.parse(await readFile(h.paths.settings, "utf8"));
  delete settings.hooks.PreCompact;
  await writeFile(h.paths.settings, json(settings));
  let status = (await cli(h, ["agents", "status"])).hooks.agents.find((a) => a.agent === "claude");
  assert.equal(status.status, "partial");
  assert.equal(status.events.find((e) => e.event === "PreCompact").status, "missing");
  assert.ok(status.events.filter((e) => e.event !== "PreCompact").every((e) => e.status === "installed"));
  // The Codex file does not exist yet: every Codex event is missing, and status gives the trust note.
  const codex = (await cli(h, ["agents", "status"])).hooks;
  assert.equal(codex.agents.find((a) => a.agent === "codex").status, "missing");
  assert.ok(codex.notes.some((n) => n.code === "CODEX_HOOK_TRUST"));
  settings.hooks.PreToolUse[0].matcher = "Bash";
  await writeFile(h.paths.settings, json(settings));
  status = (await cli(h, ["agents", "status"])).hooks.agents.find((a) => a.agent === "claude");
  assert.equal(status.status, "modified");
  assert.equal(status.events.find((e) => e.event === "PreToolUse").status, "modified");
  const plan = await planHooks(h.pilot, input(h, ["claude"]));
  assert.deepEqual([plan.actions[0].status, plan.actions[0].reason], ["conflict", "modified"]);
  // Uninstall removes the untouched entries and keeps the edited one.
  const { result } = await hooks(h, ["claude"], "uninstall", "run_status002");
  assert.equal(result.applied, true);
  assert.deepEqual(JSON.parse(await readFile(h.paths.settings, "utf8")), { model: "example", hooks: { PreToolUse: [settings.hooks.PreToolUse[0]] } });
});

// U33 (KTD32): the Stop entry is new; every earlier entry keeps its bytes, so an install made before it only adds Stop.
test("hook install shows the new Stop entry and keeps the PreCompact entry byte-identical", async (t) => {
  const h = await hookPilot(t, { settings: json({ model: "example" }) });
  const context = hookContext(h.pilot, KIT), pilotPath = realpathSync(h.path);
  const line = (event, agent) => 'node "' + KIT + '/bin/devtwin.mjs" hook --event ' + event + " --agent " + agent + ' --pilot "' + pilotPath + '"';
  for (const agent of ["claude", "codex"]) {
    const expected = expectedEntries(agent, context);
    assert.equal(JSON.stringify(expected.PreCompact), JSON.stringify([{ hooks: [{ type: "command", command: line("pre-compact", agent), timeout: 10 }] }]), agent);
    assert.equal(JSON.stringify(expected.Stop), JSON.stringify([{ hooks: [{ type: "command", command: line("stop", agent), timeout: 10 }] }]), agent);
  }
  await hooks(h, ["claude", "codex"], "install", "run_stop0001");
  const claude = expectedEntries("claude", context);
  const settings = JSON.parse(await readFile(h.paths.settings, "utf8"));
  assert.deepEqual(settings.hooks.Stop, claude.Stop);
  assert.equal(JSON.stringify(settings.hooks.PreCompact), JSON.stringify(claude.PreCompact));
  assert.deepEqual(JSON.parse(await readFile(h.paths.codex, "utf8")).hooks.Stop, expectedEntries("codex", context).Stop);
  // An install without Stop (as one made before U33) reports it missing until the hooks are installed again.
  delete settings.hooks.Stop;
  await writeFile(h.paths.settings, json(settings));
  const before = await readFile(h.paths.settings, "utf8");
  const status = (await cli(h, ["agents", "status"])).hooks.agents.find((a) => a.agent === "claude");
  assert.equal(status.status, "partial");
  assert.deepEqual(status.events.filter((e) => e.status !== "installed").map((e) => [e.event, e.status]), [["Stop", "missing"]]);
  const { plan } = await hooks(h, ["claude"], "install", "run_stop0002");
  assert.deepEqual(plan.actions[0].changes, [{ event: "Stop", op: "add", entry: claude.Stop[0] }]);
  const after = await readFile(h.paths.settings, "utf8");
  // Every byte up to the end of the PreCompact list is unchanged; Stop follows it.
  assert.ok(after.startsWith(before.slice(0, before.lastIndexOf("]") + 1) + ",\n    \"Stop\": ["), "earlier entries keep their bytes");
  assert.deepEqual(JSON.parse(after).hooks.Stop, claude.Stop);
});

test("hook install journal, recovery and rollback-check stay consistent", async (t) => {
  const h = await hookPilot(t, { settings: json({ hooks: { PreToolUse: [lint] } }) });
  await assert.rejects(hooks(h, ["claude", "codex"], "install", "run_hookcrash1", { faults: { afterEdit: crash } }), /injected crash/);
  const journal = JSON.parse(await readFile(join(h.stateRoot, "runs/run_hookcrash1/journal.json"), "utf8"));
  assert.deepEqual([journal.kind, journal.started, journal.completed], ["hook-bundled", [0], []]);
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "RECOVERY_REQUIRED");
  await assert.rejects(hooks(h, ["codex"], "install", "run_hookblock1"), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  const skills = await planInstall(h.pilot, { targetHome: h.home, agents: ["claude"], mode: "install" });
  await assert.rejects(applyInstall(h.roots, h.pilot, { targetHome: h.home, agents: ["claude"], mode: "install" }, { fingerprint: skills.fingerprint, runId: "run_skillblk1" }), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  const recovery = await planRecovery(h.roots, h.pilot);
  assert.deepEqual(recovery.actions.map((a) => [a.hook, a.agent, a.op]), [[true, "claude", "hook-complete"]]);
  assert.deepEqual(recovery.unstarted.map((u) => [u.hook, u.agent]), [[true, "codex"]]);
  const recovered = await applyRecovery(h.roots, h.pilot, { fingerprint: recovery.fingerprint });
  assert.deepEqual(recovered.closed, ["run_hookcrash1"]);
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "ok");
  // The recovered edit is devtwin's: the next install finishes only Codex.
  const next = await planHooks(h.pilot, input(h));
  assert.deepEqual(next.actions.map((a) => a.status), ["installed", "create"]);
  await applyHooks(h.roots, h.pilot, input(h), { fingerprint: next.fingerprint, runId: "run_hookfull1", now: now() });
  await assert.rejects(rollbackCheck(h.roots, h.pilot, { runId: "run_hookcrash1" }), (e) => e.code === "DEVTWIN_ROLLBACK_MISMATCH" && e.details.files.every((f) => f.devtwin.length > 0));
  await hooks(h, ["claude", "codex"], "uninstall", "run_hookrm001");
  const check = await runCli(["agents", "rollback-check", "--pilot", h.path, "--run-id", "run_hookcrash1"]);
  assert.equal(check.code, 0, JSON.stringify(check.json));
  assert.equal(check.json.result.status, "ok");
  assert.ok(check.json.result.files.every((f) => f.devtwin.length === 0 && f.foreign.length === 0));
  // Skill installs and hook installs share the run folder and never block each other once finished.
  await applyInstall(h.roots, h.pilot, { targetHome: h.home, agents: ["claude"], mode: "install" }, { fingerprint: skills.fingerprint, runId: "run_skillok01" });
  assert.equal((await installStatus(h.roots, h.pilot, { targetHome: h.home })).status, "ok");
});
