import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, chmod, symlink, readlink, lstat, rm, stat, utimes } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, treeSnapshot, makePilot, runCli } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, recordApprovedDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { canonicalJson, sha256 } from "../src/storage/canonical.mjs";
import { planInstall, applyInstall, installStatus, planRecovery, applyRecovery, SKILL_NAMES } from "../src/agents/install.mjs";
import { rollbackCheck } from "../src/agents/inventory.mjs";

const crash = () => { throw new Error("injected crash"); };
const kitFiles = (label, skills = SKILL_NAMES) => Object.fromEntries(skills.map((s) => [`skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: ${label} fixture.\n---\n${label} ${s}\n`]));
async function pinnedKit(dir, files) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
// A fake home with existing skill folders, a private store and a pinned kit whose skills/ are the bundled sources.
async function liveInstall(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const kitA = await pinnedKit(join(devtwin, "kit"), kitFiles("Kit A"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const obj = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [repo], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills"), codex: join(home, ".agents/skills") }, kitRoot: kitA.kit, kitCommit: kitA.commit } };
  let n = 0;
  const f = {
    sb, home, devtwin, kitA, claude: obj.live.skillDirs.claude, codex: obj.live.skillDirs.codex,
    // Approves a live config for the given kit and returns its loaded pilot and roots, as a live config command would.
    async use({ kit, commit } = kitA) {
      const path = join(devtwin, "live-" + ++n + ".json"), context = { home, env: {}, kitRoot: kit };
      await writeFile(path, JSON.stringify({ ...obj, live: { ...obj.live, kitRoot: kit, kitCommit: commit } }), { mode: 0o600 });
      await chmod(path, 0o600);
      const draft = await loadPilot(path, { ...context, liveGate: { approval: false } });
      ensureRoots(rootsFromPilot(draft));
      await recordApprovedDigest(rootsFromPilot(draft));
      const pilot = await loadPilot(path, context);
      return { pilot, roots: rootsFromPilot(pilot), commit, path, kit };
    },
    async kit(name, files) { return pinnedKit(join(devtwin, name), files); }
  };
  return f;
}
async function install(p, input, runId, options) {
  const plan = await planInstall(p.pilot, input);
  return applyInstall(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, runId }, options);
}
async function recover(p) {
  const plan = await planRecovery(p.roots, p.pilot);
  return { plan, result: await applyRecovery(p.roots, p.pilot, { fingerprint: plan.fingerprint }) };
}
const runIds = async (p) => (await readdir(join(p.roots.stateRoot, "runs")).catch(() => [])).sort();

test("live install: a foreign same-named Claude entry conflicts for Claude only and Codex proceeds", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  await mkdir(join(f.claude, "devtwin-resume"));
  await writeFile(join(f.claude, "devtwin-resume/SKILL.md"), "foreign resume\n");
  const before = await treeSnapshot(f.claude);
  const input = { agents: ["claude", "codex"], mode: "install" };
  const plan = await planInstall(p.pilot, input);
  const resume = plan.actions.find((a) => a.agent === "claude" && a.skill === "devtwin-resume");
  assert.equal(resume.status, "conflict");
  assert.equal(resume.reason, "foreign-entry");
  assert.ok(plan.actions.filter((a) => a.agent === "claude" && a.skill !== "devtwin-resume").every((a) => a.status === "blocked" && a.reason === "agent-conflict"));
  assert.ok(plan.actions.filter((a) => a.agent === "codex").every((a) => a.status === "create" && a.path.startsWith(f.codex + "/")));
  await applyInstall(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, runId: "run_ae1install" });
  assert.equal(await treeSnapshot(f.claude), before);
  assert.deepEqual((await readdir(f.codex)).sort(), [...SKILL_NAMES].sort());
  const receipt = JSON.parse(await readFile(join(f.codex, "devtwin-record/.devtwin-owned.json"), "utf8"));
  assert.equal(receipt.configId, "cfg_0123456789abcdef");
  assert.equal(receipt.runId, "run_ae1install");
  assert.equal(receipt.kitCommit, f.kitA.commit);
  assert.equal(receipt.files["SKILL.md"], sha256(await readFile(join(f.codex, "devtwin-record/SKILL.md"))));
  assert.ok((await planInstall(p.pilot, { agents: ["codex"], mode: "install" })).actions.every((a) => a.status === "installed"));
});

test("live install leaves a foreign symlink entry and 0755 parents byte- and mode-identical", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  const elsewhere = join(f.sb, "elsewhere-skill");
  await mkdir(elsewhere); await writeFile(join(elsewhere, "SKILL.md"), "elsewhere\n");
  await symlink(elsewhere, join(f.claude, "other-skill"));
  await chmod(join(f.home, ".claude"), 0o755); await chmod(f.claude, 0o755);
  const modes = async () => [(await stat(join(f.home, ".claude"))).mode, (await stat(f.claude)).mode];
  const beforeModes = await modes(), beforeLink = await lstat(join(f.claude, "other-skill")), beforeTarget = await treeSnapshot(elsewhere);
  await install(p, { agents: ["claude"], mode: "install" }, "run_symlink01");
  assert.deepEqual(await modes(), beforeModes);
  const afterLink = await lstat(join(f.claude, "other-skill"));
  assert.equal(afterLink.isSymbolicLink(), true);
  assert.equal(await readlink(join(f.claude, "other-skill")), elsewhere);
  assert.deepEqual([afterLink.mode, afterLink.mtimeMs, afterLink.ino], [beforeLink.mode, beforeLink.mtimeMs, beforeLink.ino]);
  assert.equal(await treeSnapshot(elsewhere), beforeTarget);
  assert.ok(SKILL_NAMES.every((s) => existsSync(join(f.claude, s, "SKILL.md"))));
});

test("live --agent codex alone installs only into .agents/skills", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  const plan = await planInstall(p.pilot, { agents: ["codex"], mode: "install" });
  assert.deepEqual([...new Set(plan.actions.map((a) => a.agent))], ["codex"]);
  await applyInstall(p.roots, p.pilot, { agents: ["codex"], mode: "install" }, { fingerprint: plan.fingerprint, runId: "run_codexonly1" });
  assert.deepEqual((await readdir(f.codex)).sort(), [...SKILL_NAMES].sort());
  assert.deepEqual(await readdir(f.claude), []);
  assert.equal(existsSync(join(f.home, ".codex")), false);
});

test("live install refuses a target other than the live config's skill folder and never creates one", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  for (const targetHome of [f.sb, join(f.home, ".claude"), f.claude]) await assert.rejects(planInstall(p.pilot, { targetHome, agents: ["claude"], mode: "install" }), { code: "DEVTWIN_GATE_REQUIRED" });
  assert.equal((await planInstall(p.pilot, { targetHome: f.home, agents: ["claude"], mode: "install" })).actions.length, SKILL_NAMES.length);
  const plan = await planInstall(p.pilot, { agents: ["codex"], mode: "install" });
  await rm(f.codex, { recursive: true });
  await assert.rejects(applyInstall(p.roots, p.pilot, { agents: ["codex"], mode: "install" }, { fingerprint: plan.fingerprint, runId: "run_nofolder1" }));
  assert.equal(existsSync(f.codex), false);
});

test("live crash after folder, SKILL.md or receipt requires an approved recovery before the next apply", async (t) => {
  for (const fault of ["afterFolder", "afterSkill", "afterReceipt"]) {
    const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
    await assert.rejects(install(p, input, "run_crash" + fault.toLowerCase(), { faults: { [fault]: crash } }), /injected crash/);
    const status = await installStatus(p.roots, p.pilot, {});
    assert.equal(status.status, "RECOVERY_REQUIRED", fault);
    assert.deepEqual(status.incomplete, ["run_crash" + fault.toLowerCase()]);
    await assert.rejects(install(p, input, "run_blocked01"), { code: "DEVTWIN_RECOVERY_REQUIRED" });
    const plan = await planRecovery(p.roots, p.pilot);
    assert.deepEqual(plan.actions.map((a) => [a.skill, a.op]), [["devtwin-onboard", "remove-create"]], fault);
    await assert.rejects(applyRecovery(p.roots, p.pilot, { fingerprint: "sha256:" + "0".repeat(64) }), { code: "DEVTWIN_PLAN_MISMATCH" });
    await applyRecovery(p.roots, p.pilot, { fingerprint: plan.fingerprint });
    assert.equal(existsSync(join(f.claude, "devtwin-onboard")), false);
    assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
    await install(p, input, "run_after" + fault.toLowerCase());
    assert.ok((await planInstall(p.pilot, input)).actions.every((a) => a.status === "installed"));
  }
});

test("live crash mid-update recovers from the journal's hashes after an approved kit change", async (t) => {
  const f = await liveInstall(t), a = await f.use(), input = { agents: ["claude"], mode: "install" };
  await install(a, input, "run_kitainst1");
  const b = await f.use(await f.kit("kit-b", kitFiles("Kit B")));
  assert.ok((await planInstall(b.pilot, input)).actions.every((x) => x.status === "update"));
  await assert.rejects(install(b, input, "run_kitbupd01", { faults: { afterSkill: crash } }), /injected crash/);
  const c = await f.use(await f.kit("kit-c", kitFiles("Kit C")));
  const { plan } = await recover(c);
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op]), [["devtwin-onboard", "complete-update"]]);
  const onboard = join(f.claude, "devtwin-onboard");
  assert.match(await readFile(join(onboard, "SKILL.md"), "utf8"), /Kit B devtwin-onboard/);
  const receipt = JSON.parse(await readFile(join(onboard, ".devtwin-owned.json"), "utf8"));
  assert.deepEqual([receipt.runId, receipt.kitCommit], ["run_kitbupd01", b.commit]);
  assert.equal((await installStatus(c.roots, c.pilot, {})).status, "ok");
  const next = await planInstall(c.pilot, input);
  assert.ok(next.actions.every((x) => x.status === "update"));
  await applyInstall(c.roots, c.pilot, input, { fingerprint: next.fingerprint, runId: "run_kitcupd01" });
  assert.match(await readFile(join(onboard, "SKILL.md"), "utf8"), /Kit C devtwin-onboard/);
});

test("live recovery leaves a started entry holding a file that matches neither journal hash", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await assert.rejects(install(p, input, "run_holdcase1", { faults: { afterFolder: crash } }), /injected crash/);
  const stray = join(f.claude, "devtwin-onboard/SKILL.md");
  await writeFile(stray, "someone else's bytes\n");
  const { plan } = await recover(p);
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op, x.reason]), [["devtwin-onboard", "hold", "unmatched-file"]]);
  assert.equal(await readFile(stray, "utf8"), "someone else's bytes\n");
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "RECOVERY_REQUIRED");
  await rm(stray);
  await recover(p);
  assert.equal(existsSync(join(f.claude, "devtwin-onboard")), false);
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
});

test("live forged receipts without a matching journal or naming extra or traversal files are foreign", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await install(p, input, "run_genuine01");
  const genuine = JSON.parse(await readFile(join(f.claude, "devtwin-record/.devtwin-owned.json"), "utf8"));
  const body = await readFile(join(f.claude, "devtwin-record/SKILL.md"));
  const forge = async (name, receipt, files = {}) => {
    const dir = join(f.codex, name);
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), body, { mode: 0o600 });
    for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content, { mode: 0o600 });
    await writeFile(join(dir, ".devtwin-owned.json"), canonicalJson(receipt) + "\n", { mode: 0o600 });
  };
  await forge("devtwin-record", { ...genuine, skill: "devtwin-record", runId: "run_nojournal1" });
  await forge("devtwin-resume", { ...genuine, skill: "devtwin-resume", files: { "SKILL.md": genuine.files["SKILL.md"], "extra.md": sha256("x") } }, { "extra.md": "x" });
  await forge("devtwin-onboard", { ...genuine, skill: "devtwin-onboard", files: { "SKILL.md": genuine.files["SKILL.md"], "../escape.md": sha256("x") } });
  // A forged completed journal entry that matches the extra-file receipt still does not make it owned.
  const run = join(p.roots.stateRoot, "runs/run_forgedjrnl1");
  await mkdir(run, { mode: 0o700 });
  const extra = JSON.parse(await readFile(join(f.codex, "devtwin-resume/.devtwin-owned.json"), "utf8"));
  const receipt = { ...extra, runId: "run_forgedjrnl1" };
  const action = { agent: "codex", skill: "devtwin-resume", path: join(f.codex, "devtwin-resume"), root: f.codex, status: "create", old: null, new: { "SKILL.md": genuine.files["SKILL.md"], ".devtwin-owned.json": sha256(canonicalJson(receipt) + "\n") }, receipt };
  await writeFile(join(f.codex, "devtwin-resume/.devtwin-owned.json"), canonicalJson(receipt) + "\n");
  await writeFile(join(run, "journal.json"), canonicalJson({ schemaVersion: 2, kind: "skill-bundled", configId: "cfg_0123456789abcdef", runId: "run_forgedjrnl1", kitCommit: f.kitA.commit, mode: "install", planFingerprint: "sha256:" + "0".repeat(64), targetHome: null, intended: [action], started: [0], completed: [action] }) + "\n", { mode: 0o600 });
  const plan = await planInstall(p.pilot, { agents: ["codex"], mode: "install" });
  // devtwin-capture is not forged: the forged entries' conflicts block its create for this agent.
  assert.ok(plan.actions.filter((x) => x.skill !== "devtwin-capture").every((x) => x.status === "conflict" && x.reason === "unowned-receipt"), JSON.stringify(plan.actions));
  assert.deepEqual(plan.actions.filter((x) => x.skill === "devtwin-capture").map((x) => [x.status, x.reason]), [["blocked", "agent-conflict"]]);
  const uninstall = await planInstall(p.pilot, { agents: ["codex"], mode: "uninstall" });
  assert.ok(uninstall.actions.filter((x) => x.skill !== "devtwin-capture").every((x) => x.status === "preserve"));
  const before = await treeSnapshot(f.codex);
  await applyInstall(p.roots, p.pilot, { agents: ["codex"], mode: "uninstall" }, { fingerprint: uninstall.fingerprint, runId: "run_forgedun01" });
  assert.equal(await treeSnapshot(f.codex), before);
});

test("live uninstall plans and applies from receipts and journals with the kit skills folder removed", async (t) => {
  const f = await liveInstall(t), a = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await install(a, input, "run_preremove1");
  const bare = await f.use(await f.kit("kit-bare", { "README.md": "no skills\n" }));
  await assert.rejects(planInstall(bare.pilot, input));
  const uninstall = await planInstall(bare.pilot, { ...input, mode: "uninstall" });
  assert.ok(uninstall.actions.every((x) => x.status === "remove"));
  await applyInstall(bare.roots, bare.pilot, { ...input, mode: "uninstall" }, { fingerprint: uninstall.fingerprint, runId: "run_bareuninst" });
  assert.deepEqual([await readdir(f.claude), await readdir(f.codex)], [[], []]);
});

test("live AE5: after an approved kit change uninstall and reinstall succeed", async (t) => {
  const f = await liveInstall(t), a = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await install(a, input, "run_ae5kita01");
  const b = await f.use(await f.kit("kit-b", kitFiles("Kit B")));
  await install(b, { ...input, mode: "uninstall" }, "run_ae5uninst1");
  assert.deepEqual([await readdir(f.claude), await readdir(f.codex)], [[], []]);
  await install(b, input, "run_ae5reinst1");
  const receipt = JSON.parse(await readFile(join(f.claude, "devtwin-resume/.devtwin-owned.json"), "utf8"));
  assert.equal(receipt.kitCommit, b.commit);
  assert.match(await readFile(join(f.codex, "devtwin-resume/SKILL.md"), "utf8"), /Kit B devtwin-resume/);
});

test("live re-running install on an installed folder is a no-op with no journal", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await install(p, input, "run_firstinst1");
  const runs = await runIds(p), before = [await treeSnapshot(f.claude), await treeSnapshot(f.codex)];
  const result = await install(p, input, "run_secondins1");
  assert.equal(result.applied, false);
  assert.deepEqual(await runIds(p), runs);
  assert.deepEqual([await treeSnapshot(f.claude), await treeSnapshot(f.codex)], before);
});

test("live status lists leftover bundled entries under the old .codex/skills without acting on them", async (t) => {
  const f = await liveInstall(t), p = await f.use(), legacy = join(f.home, ".codex/skills");
  await mkdir(join(legacy, "devtwin-resume"), { recursive: true });
  await writeFile(join(legacy, "devtwin-resume/SKILL.md"), "old copy\n");
  await mkdir(join(legacy, "someone-else"));
  const before = await treeSnapshot(join(f.home, ".codex"));
  const status = await installStatus(p.roots, p.pilot, {});
  assert.deepEqual(status.legacy, [{ agent: "codex", skill: "devtwin-resume", path: join(legacy, "devtwin-resume") }]);
  assert.equal(await treeSnapshot(join(f.home, ".codex")), before);
});

test("bundled CLI recover previews and applies an approved recovery plan", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0], input = { targetHome: home, agents: ["claude"], mode: "install" };
  const plan = await planInstall(p.pilot, input);
  await assert.rejects(applyInstall(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, runId: "run_clicrash01" }, { faults: { afterReceipt: crash } }), /injected crash/);
  const preview = await runCli(["agents", "recover", "--pilot", p.path]);
  assert.equal(preview.code, 0, JSON.stringify(preview.json));
  assert.deepEqual(preview.json.result.actions.map((a) => a.op), ["remove-create"]);
  const applied = await runCli(["agents", "recover", "--pilot", p.path, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal(existsSync(join(home, ".claude/skills/devtwin-onboard")), false);
  assert.equal((await installStatus(p.roots, p.pilot, { targetHome: home })).status, "ok");
});

// Foreign trees in both skill folders: a nested directory, a plain file, a symlinked directory tree and a foreign devtwin-* file.
async function foreignTrees(f) {
  const outside = join(f.sb, "outside-tree");
  await mkdir(join(outside, "deep/a/b"), { recursive: true });
  await writeFile(join(outside, "deep/a/b/buried-secret.md"), "outside\n");
  for (const dir of [f.claude, f.codex]) {
    await mkdir(join(dir, "team-skill/references"), { recursive: true });
    await writeFile(join(dir, "team-skill/SKILL.md"), "team\n");
    await writeFile(join(dir, "team-skill/references/notes.md"), "notes\n");
    await writeFile(join(dir, "README.txt"), "folder readme\n");
    await symlink(outside, join(dir, "linked-tree"));
    await writeFile(join(dir, "devtwin-notes.md"), "a foreign devtwin-named file\n");
  }
  return outside;
}
const foreignHashes = async (f, outside) => Promise.all([f.claude, f.codex].flatMap((dir) => [treeSnapshot(join(dir, "team-skill")), readFile(join(dir, "README.txt"), "utf8"), readlink(join(dir, "linked-tree"))]).concat([treeSnapshot(outside)]));
const check = (f, p, runId) => runCli(["agents", "rollback-check", "--pilot", p.path, "--run-id", runId], { home: f.home, env: {}, kitRoot: p.kit });
const inventoryOf = async (p, runId) => JSON.parse(await readFile(join(p.roots.stateRoot, "runs", runId, "inventory.json"), "utf8"));

test("live AE2: install then uninstall of both agents passes the rollback check and leaves foreign trees unchanged", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  const outside = await foreignTrees(f), before = await foreignHashes(f, outside);
  const tops = [(await readdir(f.claude)).sort(), (await readdir(f.codex)).sort()];
  await install(p, input, "run_ae2install");
  await install(p, { ...input, mode: "uninstall" }, "run_ae2uninst1");
  assert.deepEqual(await foreignHashes(f, outside), before);
  assert.deepEqual([(await readdir(f.claude)).sort(), (await readdir(f.codex)).sort()], tops);
  const result = await rollbackCheck(p.roots, p.pilot, { runId: "run_ae2install" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.folders.map((x) => [x.agent, x.dir, x.existedBefore, x.devtwin.length, x.foreign.length]), [["claude", f.claude, true, 0, 0], ["codex", f.codex, true, 0, 0]]);
  const cli = await check(f, p, "run_ae2install");
  assert.equal(cli.code, 0, JSON.stringify(cli.json));
  assert.equal(cli.json.result.status, "ok");
  // The uninstall run records its own inventory, taken before its first write.
  const uninstallInventory = await inventoryOf(p, "run_ae2uninst1");
  assert.equal(uninstallInventory.mode, "uninstall");
  assert.ok(uninstallInventory.folders.every((x) => SKILL_NAMES.every((s) => x.devtwin.some((r) => r.path === s + "/SKILL.md"))));
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_ae2uninst1" }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_neverran01" }), { code: "DEVTWIN_NOT_FOUND" });
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "../escape" }), { code: "DEVTWIN_INVALID_ID" });
});

test("live rollback check fails on a leftover or missing devtwin entry after uninstall", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await foreignTrees(f);
  await install(p, input, "run_leftover01");
  await install(p, { ...input, mode: "uninstall" }, "run_leftunin01");
  await writeFile(join(f.claude, "devtwin-leftover.md"), "left behind\n");
  await rm(join(f.codex, "devtwin-notes.md"));
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_leftover01" }), (error) => {
    assert.equal(error.code, "DEVTWIN_ROLLBACK_MISMATCH");
    const [claude, codex] = error.details.folders;
    assert.deepEqual(claude.devtwin.map((x) => [x.path, x.change]), [["devtwin-leftover.md", "added"]]);
    assert.deepEqual(codex.devtwin.map((x) => [x.path, x.change]), [["devtwin-notes.md", "removed"]]);
    return true;
  });
  const cli = await check(f, p, "run_leftover01");
  assert.equal(cli.code, 1);
  assert.equal(cli.json.ok, false);
  assert.equal(cli.json.error.code, "DEVTWIN_ROLLBACK_MISMATCH");
});

test("live rollback check lists a foreign top-level file edited after install with timestamps and passes", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await foreignTrees(f);
  await install(p, input, "run_foreign001");
  await writeFile(join(f.claude, "README.txt"), "edited by the owner\n");
  // Whole seconds: a millisecond time can read back a fraction off through utimes on some Node versions.
  const later = new Date(Math.floor(Date.now() / 1000) * 1000 + 60000);
  await utimes(join(f.claude, "README.txt"), later, later);
  await install(p, { ...input, mode: "uninstall" }, "run_foreignun1");
  const result = await rollbackCheck(p.roots, p.pilot, { runId: "run_foreign001" });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.folders.map((x) => x.agent), ["claude"]);
  assert.equal(result.folders[0].foreign.length, 1);
  const [change] = result.folders[0].foreign;
  assert.deepEqual([change.name, change.change], ["README.txt", "changed"]);
  assert.equal(change.now.mtime, later.toISOString());
  assert.notEqual(change.before.mtime, change.now.mtime);
});

test("live inventory of a folder with over 150 foreign entries and symlinked trees records top-level entries only", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  const outside = await foreignTrees(f);
  for (let i = 0; i < 150; i++) await writeFile(join(f.claude, `foreign-${String(i).padStart(3, "0")}.md`), "x" + i + "\n");
  for (let i = 0; i < 5; i++) await symlink(outside, join(f.claude, `linked-${i}`));
  await symlink(outside, join(f.claude, "devtwin-linked"));
  const top = (await readdir(f.claude)).length;
  await install(p, { agents: ["claude"], mode: "install" }, "run_wide00001");
  const inventory = await inventoryOf(p, "run_wide00001");
  const [claude] = inventory.folders;
  assert.equal(claude.existed, true);
  assert.equal(claude.entries.length + new Set(claude.devtwin.map((r) => r.path.split("/")[0])).size, top);
  assert.ok(claude.entries.length > 150);
  assert.deepEqual(claude.devtwin.map((r) => [r.path, r.type]), [["devtwin-linked", "link"], ["devtwin-notes.md", "file"]]);
  assert.equal(claude.entries.find((e) => e.name === "linked-0").link, outside);
  assert.equal(JSON.stringify(inventory).includes("buried-secret"), false);
  assert.equal(JSON.stringify(inventory).includes("references"), false);
});

test("live rollback check makes no writes to the store or the skill folders", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await foreignTrees(f);
  await install(p, input, "run_nowrite001");
  const snap = () => Promise.all([treeSnapshot(p.pilot.pilotRoot), treeSnapshot(f.devtwin), treeSnapshot(f.claude), treeSnapshot(f.codex)]);
  // Checked while installed, when it fails, and again after uninstall, when it passes.
  let before = await snap();
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_nowrite001" }), { code: "DEVTWIN_ROLLBACK_MISMATCH" });
  assert.equal((await check(f, p, "run_nowrite001")).code, 1);
  assert.deepEqual(await snap(), before);
  await install(p, { ...input, mode: "uninstall" }, "run_nowriteun1");
  before = await snap();
  assert.equal((await rollbackCheck(p.roots, p.pilot, { runId: "run_nowrite001" })).status, "ok");
  assert.equal((await check(f, p, "run_nowrite001")).code, 0);
  assert.deepEqual(await snap(), before);
});

test("live inventory is written before the first copy or target write", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await foreignTrees(f);
  const before = [await treeSnapshot(f.claude), await treeSnapshot(f.codex)];
  await assert.rejects(install(p, input, "run_invfault1", { faults: { afterInventory: crash } }), /injected crash/);
  const inventory = await inventoryOf(p, "run_invfault1");
  assert.deepEqual([inventory.runId, inventory.mode, inventory.folders.map((x) => x.agent)], ["run_invfault1", "install", ["claude", "codex"]]);
  assert.deepEqual(await readdir(join(p.roots.stateRoot, "runs/run_invfault1")), ["inventory.json"]);
  assert.deepEqual([await treeSnapshot(f.claude), await treeSnapshot(f.codex)], before);
  await install(p, input, "run_invafter1");
  assert.ok((await planInstall(p.pilot, input)).actions.every((a) => a.status === "installed"));
});

test("help lists agents rollback-check", async () => {
  const help = await runCli(["help"]);
  assert.ok(help.json.result.commands.includes("agents rollback-check"));
});

test("live recovery persists a completed update in a run that also holds an entry, and an approved release closes the hold", async (t) => {
  const f = await liveInstall(t), a = await f.use(), input = { agents: ["claude"], mode: "install" };
  await install(a, input, "run_mixbase01");
  const b = await f.use(await f.kit("kit-b", kitFiles("Kit B")));
  await assert.rejects(install(b, input, "run_mixupd001", { faults: { afterSkill: crash } }), /injected crash/);
  // A second started entry that was never written still matches its old hashes, so recovery completes it from the copies.
  const journalPath = join(b.roots.stateRoot, "runs/run_mixupd001/journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.started.push(1);
  await writeFile(journalPath, canonicalJson(journal) + "\n");
  await writeFile(join(f.claude, "devtwin-onboard/SKILL.md"), "someone else's bytes\n");
  const { plan, result } = await recover(b);
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op]), [["devtwin-onboard", "hold"], ["devtwin-resume", "complete-update"]]);
  assert.deepEqual(result.closed, []);
  assert.match(await readFile(join(f.claude, "devtwin-resume/SKILL.md"), "utf8"), /Kit B devtwin-resume/);
  const persisted = JSON.parse(await readFile(journalPath, "utf8"));
  assert.ok(persisted.completed.some((e) => e.skill === "devtwin-resume"));
  assert.notEqual(persisted.closed, true);
  assert.deepEqual((await planRecovery(b.roots, b.pilot)).actions.map((x) => [x.skill, x.op]), [["devtwin-onboard", "hold"]]);
  const preview = await planRecovery(b.roots, b.pilot, { release: true });
  assert.equal(preview.release, true);
  assert.deepEqual(preview.actions.map((x) => [x.skill, x.op, x.reason]), [["devtwin-onboard", "hold", "unmatched-file"]]);
  await assert.rejects(applyRecovery(b.roots, b.pilot, { fingerprint: preview.fingerprint }), { code: "DEVTWIN_PLAN_MISMATCH" });
  const released = await applyRecovery(b.roots, b.pilot, { fingerprint: preview.fingerprint, release: true });
  assert.deepEqual(released.closed, ["run_mixupd001"]);
  assert.equal(await readFile(join(f.claude, "devtwin-onboard/SKILL.md"), "utf8"), "someone else's bytes\n");
  assert.equal((await installStatus(b.roots, b.pilot, {})).status, "ok");
  // The completed update is owned: uninstall removes it, and the held entry is left in place.
  const uninstall = await planInstall(b.pilot, { ...input, mode: "uninstall" });
  assert.deepEqual(uninstall.actions.map((x) => [x.skill, x.status]), [["devtwin-onboard", "modified"], ["devtwin-resume", "remove"], ["devtwin-record", "remove"], ["devtwin-capture", "remove"]]);
  await applyInstall(b.roots, b.pilot, { ...input, mode: "uninstall" }, { fingerprint: uninstall.fingerprint, runId: "run_mixunin01" });
  assert.deepEqual(await readdir(f.claude), ["devtwin-onboard"]);
});

test("live truncated journal is held as unreadable until an approved release closes it, and the preview writes nothing", async (t) => {
  const f = await liveInstall(t), p = await f.use(), codex = { agents: ["codex"], mode: "install" };
  await assert.rejects(install(p, { agents: ["claude"], mode: "install" }, "run_torn00001", { faults: { afterReceipt: crash } }), /injected crash/);
  const journalPath = join(p.roots.stateRoot, "runs/run_torn00001/journal.json"), torn = (await readFile(journalPath)).subarray(0, 40);
  await writeFile(journalPath, torn);
  await assert.rejects(install(p, codex, "run_blocked02"), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  const { plan, result } = await recover(p);
  assert.deepEqual(plan.actions.map((x) => [x.runId, x.op, x.reason, x.journalHash]), [["run_torn00001", "hold", "unreadable-journal", sha256(torn)]]);
  assert.deepEqual(result.closed, []);
  const cli = (args) => runCli(["agents", "recover", "--pilot", p.path, "--release", ...args], { home: f.home, env: {}, kitRoot: p.kit });
  const snap = () => Promise.all([treeSnapshot(p.roots.stateRoot), treeSnapshot(f.claude), treeSnapshot(f.codex)]);
  const before = await snap();
  const preview = await cli([]);
  assert.equal(preview.code, 0, JSON.stringify(preview.json));
  assert.equal(preview.json.result.release, true);
  assert.deepEqual(preview.json.result.actions.map((x) => [x.runId, x.reason]), [["run_torn00001", "unreadable-journal"]]);
  assert.deepEqual(await snap(), before);
  const applied = await cli(["--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.result.closed, ["run_torn00001"]);
  assert.deepEqual(await readFile(join(p.roots.stateRoot, "runs/run_torn00001/journal.released.json")), torn);
  assert.ok(existsSync(join(f.claude, "devtwin-onboard/SKILL.md")));
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
  assert.equal((await install(p, codex, "run_aftertorn1")).applied, true);
  assert.deepEqual((await planInstall(p.pilot, { agents: ["claude"], mode: "install" })).actions.filter((x) => x.skill === "devtwin-onboard").map((x) => [x.status, x.reason]), [["conflict", "unowned-receipt"]]);
});

test("live recovery holds a started create without a created marker and leaves a foreign folder untouched", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await assert.rejects(install(p, input, "run_nomarker1", { faults: { beforeFolder: crash } }), /injected crash/);
  const journal = JSON.parse(await readFile(join(p.roots.stateRoot, "runs/run_nomarker1/journal.json"), "utf8"));
  assert.deepEqual([journal.started, journal.created ?? []], [[0], []]);
  const foreign = join(f.claude, "devtwin-onboard");
  await mkdir(foreign);
  const before = await lstat(foreign);
  const { plan } = await recover(p);
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op, x.reason]), [["devtwin-onboard", "hold", "uncreated-entry"]]);
  assert.equal((await lstat(foreign)).ino, before.ino);
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "RECOVERY_REQUIRED");
  await rm(foreign, { recursive: true });
  const after = await recover(p);
  assert.deepEqual(after.plan.actions.map((x) => [x.skill, x.op, x.present]), [["devtwin-onboard", "remove-create", false]]);
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
  // A crash just after the folder is made records the marker, so that folder is removed.
  await assert.rejects(install(p, input, "run_marker001", { faults: { afterFolder: crash } }), /injected crash/);
  assert.deepEqual(JSON.parse(await readFile(join(p.roots.stateRoot, "runs/run_marker001/journal.json"), "utf8")).created, [0]);
  assert.deepEqual((await recover(p)).plan.actions.map((x) => [x.op, x.present]), [["remove-create", true]]);
  assert.equal(existsSync(foreign), false);
});

test("live crash during uninstall finishes the remove through an approved recovery", async (t) => {
  for (const fault of ["afterSkill", "afterReceipt"]) {
    const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
    await install(p, input, "run_uninbase01");
    await assert.rejects(install(p, { ...input, mode: "uninstall" }, "run_unincrash1", { faults: { [fault]: crash } }), /injected crash/);
    assert.equal((await installStatus(p.roots, p.pilot, {})).status, "RECOVERY_REQUIRED", fault);
    await assert.rejects(install(p, { ...input, mode: "uninstall" }, "run_uninblock1"), { code: "DEVTWIN_RECOVERY_REQUIRED" });
    const { plan, result } = await recover(p);
    assert.deepEqual(plan.actions.map((x) => [x.skill, x.op]), [["devtwin-onboard", "finish-remove"]], fault);
    assert.deepEqual(result.closed, ["run_unincrash1"]);
    assert.equal(existsSync(join(f.claude, "devtwin-onboard")), false);
    assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
    await install(p, { ...input, mode: "uninstall" }, "run_uninagain1");
    assert.deepEqual(await readdir(f.claude), []);
  }
});

test("live rollback check refuses an uninstall run, an inventory of another live config and a folder replaced by a file", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude", "codex"], mode: "install" };
  await install(p, input, "run_guardins1");
  await install(p, { ...input, mode: "uninstall" }, "run_guardun01");
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_guardun01" }), { code: "DEVTWIN_INVALID_INPUT" });
  const path = join(p.roots.stateRoot, "runs/run_guardins1/inventory.json"), original = await readFile(path);
  await writeFile(path, canonicalJson({ ...JSON.parse(original.toString("utf8")), configId: "cfg_fedcba9876543210" }) + "\n");
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_guardins1" }), { code: "DEVTWIN_GATE_REQUIRED" });
  await writeFile(path, original);
  assert.equal((await rollbackCheck(p.roots, p.pilot, { runId: "run_guardins1" })).status, "ok");
  await rm(f.codex, { recursive: true });
  await writeFile(f.codex, "not a folder\n");
  await assert.rejects(rollbackCheck(p.roots, p.pilot, { runId: "run_guardins1" }), (error) => {
    assert.equal(error.code, "DEVTWIN_ROLLBACK_MISMATCH");
    assert.deepEqual(error.details.folders.map((x) => [x.agent, x.folder.now]), [["claude", "dir"], ["codex", "file"]]);
    return true;
  });
});

test("help lists locks release", async () => {
  const help = await runCli(["help"]);
  assert.ok(help.json.result.commands.includes("locks release"));
});
