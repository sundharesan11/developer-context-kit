import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, chmod, symlink, readlink, lstat, rm, stat } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, treeSnapshot, makePilot, runCli } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, recordApprovedDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { canonicalJson, sha256 } from "../src/storage/canonical.mjs";
import { planInstall, applyInstall, installStatus, planRecovery, applyRecovery, SKILL_NAMES } from "../src/agents/install.mjs";

const crash = () => { throw new Error("injected crash"); };
const kitFiles = (label, skills = SKILL_NAMES) => Object.fromEntries(skills.map((s) => [`skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: ${label} fixture.\n---\n${label} ${s}\n`]));
async function pinnedKit(dir, files) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
// A fake home with existing skill folders, a private store and a pinned kit whose skills/ are the bundled sources.
async function liveInstall(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devctx = join(home, ".devctx"), store = join(devctx, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const kitA = await pinnedKit(join(devctx, "kit"), kitFiles("Kit A"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const obj = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [repo], forbidden: [], live: { profileId: "prof_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills"), codex: join(home, ".agents/skills") }, kitRoot: kitA.kit, kitCommit: kitA.commit } };
  let n = 0;
  const f = {
    sb, home, devctx, kitA, claude: obj.live.skillDirs.claude, codex: obj.live.skillDirs.codex,
    // Approves a profile for the given kit and returns its loaded pilot and roots, as a profile command would.
    async use({ kit, commit } = kitA) {
      const path = join(devctx, "live-" + ++n + ".json"), context = { home, env: {}, kitRoot: kit };
      await writeFile(path, JSON.stringify({ ...obj, live: { ...obj.live, kitRoot: kit, kitCommit: commit } }), { mode: 0o600 });
      await chmod(path, 0o600);
      const draft = await loadPilot(path, { ...context, liveGate: { approval: false } });
      ensureRoots(rootsFromPilot(draft));
      await recordApprovedDigest(rootsFromPilot(draft));
      const pilot = await loadPilot(path, context);
      return { pilot, roots: rootsFromPilot(pilot), commit };
    },
    async kit(name, files) { return pinnedKit(join(devctx, name), files); }
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
  await mkdir(join(f.claude, "devctx-resume"));
  await writeFile(join(f.claude, "devctx-resume/SKILL.md"), "foreign resume\n");
  const before = await treeSnapshot(f.claude);
  const input = { agents: ["claude", "codex"], mode: "install" };
  const plan = await planInstall(p.pilot, input);
  const resume = plan.actions.find((a) => a.agent === "claude" && a.skill === "devctx-resume");
  assert.equal(resume.status, "conflict");
  assert.equal(resume.reason, "foreign-entry");
  assert.ok(plan.actions.filter((a) => a.agent === "claude" && a.skill !== "devctx-resume").every((a) => a.status === "blocked" && a.reason === "agent-conflict"));
  assert.ok(plan.actions.filter((a) => a.agent === "codex").every((a) => a.status === "create" && a.path.startsWith(f.codex + "/")));
  await applyInstall(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, runId: "run_ae1install" });
  assert.equal(await treeSnapshot(f.claude), before);
  assert.deepEqual((await readdir(f.codex)).sort(), [...SKILL_NAMES].sort());
  const receipt = JSON.parse(await readFile(join(f.codex, "devctx-record/.devctx-owned.json"), "utf8"));
  assert.equal(receipt.profileId, "prof_0123456789abcdef");
  assert.equal(receipt.runId, "run_ae1install");
  assert.equal(receipt.kitCommit, f.kitA.commit);
  assert.equal(receipt.files["SKILL.md"], sha256(await readFile(join(f.codex, "devctx-record/SKILL.md"))));
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

test("live install refuses a target other than the profile's skill folder and never creates one", async (t) => {
  const f = await liveInstall(t), p = await f.use();
  for (const targetHome of [f.sb, join(f.home, ".claude"), f.claude]) await assert.rejects(planInstall(p.pilot, { targetHome, agents: ["claude"], mode: "install" }), { code: "DEVCTX_GATE_REQUIRED" });
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
    await assert.rejects(install(p, input, "run_blocked01"), { code: "DEVCTX_RECOVERY_REQUIRED" });
    const plan = await planRecovery(p.roots, p.pilot);
    assert.deepEqual(plan.actions.map((a) => [a.skill, a.op]), [["devctx-onboard", "remove-create"]], fault);
    await assert.rejects(applyRecovery(p.roots, p.pilot, { fingerprint: "sha256:" + "0".repeat(64) }), { code: "DEVCTX_PLAN_MISMATCH" });
    await applyRecovery(p.roots, p.pilot, { fingerprint: plan.fingerprint });
    assert.equal(existsSync(join(f.claude, "devctx-onboard")), false);
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
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op]), [["devctx-onboard", "complete-update"]]);
  const onboard = join(f.claude, "devctx-onboard");
  assert.match(await readFile(join(onboard, "SKILL.md"), "utf8"), /Kit B devctx-onboard/);
  const receipt = JSON.parse(await readFile(join(onboard, ".devctx-owned.json"), "utf8"));
  assert.deepEqual([receipt.runId, receipt.kitCommit], ["run_kitbupd01", b.commit]);
  assert.equal((await installStatus(c.roots, c.pilot, {})).status, "ok");
  const next = await planInstall(c.pilot, input);
  assert.ok(next.actions.every((x) => x.status === "update"));
  await applyInstall(c.roots, c.pilot, input, { fingerprint: next.fingerprint, runId: "run_kitcupd01" });
  assert.match(await readFile(join(onboard, "SKILL.md"), "utf8"), /Kit C devctx-onboard/);
});

test("live recovery leaves a started entry holding a file that matches neither journal hash", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await assert.rejects(install(p, input, "run_holdcase1", { faults: { afterFolder: crash } }), /injected crash/);
  const stray = join(f.claude, "devctx-onboard/SKILL.md");
  await writeFile(stray, "someone else's bytes\n");
  const { plan } = await recover(p);
  assert.deepEqual(plan.actions.map((x) => [x.skill, x.op, x.reason]), [["devctx-onboard", "hold", "unmatched-file"]]);
  assert.equal(await readFile(stray, "utf8"), "someone else's bytes\n");
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "RECOVERY_REQUIRED");
  await rm(stray);
  await recover(p);
  assert.equal(existsSync(join(f.claude, "devctx-onboard")), false);
  assert.equal((await installStatus(p.roots, p.pilot, {})).status, "ok");
});

test("live forged receipts without a matching journal or naming extra or traversal files are foreign", async (t) => {
  const f = await liveInstall(t), p = await f.use(), input = { agents: ["claude"], mode: "install" };
  await install(p, input, "run_genuine01");
  const genuine = JSON.parse(await readFile(join(f.claude, "devctx-record/.devctx-owned.json"), "utf8"));
  const body = await readFile(join(f.claude, "devctx-record/SKILL.md"));
  const forge = async (name, receipt, files = {}) => {
    const dir = join(f.codex, name);
    await mkdir(dir);
    await writeFile(join(dir, "SKILL.md"), body, { mode: 0o600 });
    for (const [rel, content] of Object.entries(files)) await writeFile(join(dir, rel), content, { mode: 0o600 });
    await writeFile(join(dir, ".devctx-owned.json"), canonicalJson(receipt) + "\n", { mode: 0o600 });
  };
  await forge("devctx-record", { ...genuine, skill: "devctx-record", runId: "run_nojournal1" });
  await forge("devctx-resume", { ...genuine, skill: "devctx-resume", files: { "SKILL.md": genuine.files["SKILL.md"], "extra.md": sha256("x") } }, { "extra.md": "x" });
  await forge("devctx-onboard", { ...genuine, skill: "devctx-onboard", files: { "SKILL.md": genuine.files["SKILL.md"], "../escape.md": sha256("x") } });
  // A forged completed journal entry that matches the extra-file receipt still does not make it owned.
  const run = join(p.roots.stateRoot, "runs/run_forgedjrnl1");
  await mkdir(run, { mode: 0o700 });
  const extra = JSON.parse(await readFile(join(f.codex, "devctx-resume/.devctx-owned.json"), "utf8"));
  const receipt = { ...extra, runId: "run_forgedjrnl1" };
  const action = { agent: "codex", skill: "devctx-resume", path: join(f.codex, "devctx-resume"), root: f.codex, status: "create", old: null, new: { "SKILL.md": genuine.files["SKILL.md"], ".devctx-owned.json": sha256(canonicalJson(receipt) + "\n") }, receipt };
  await writeFile(join(f.codex, "devctx-resume/.devctx-owned.json"), canonicalJson(receipt) + "\n");
  await writeFile(join(run, "journal.json"), canonicalJson({ schemaVersion: 2, kind: "skill-bundled", profileId: "prof_0123456789abcdef", runId: "run_forgedjrnl1", kitCommit: f.kitA.commit, mode: "install", planFingerprint: "sha256:" + "0".repeat(64), targetHome: null, intended: [action], started: [0], completed: [action] }) + "\n", { mode: 0o600 });
  const plan = await planInstall(p.pilot, { agents: ["codex"], mode: "install" });
  assert.ok(plan.actions.every((x) => x.status === "conflict" && x.reason === "unowned-receipt"), JSON.stringify(plan.actions));
  const uninstall = await planInstall(p.pilot, { agents: ["codex"], mode: "uninstall" });
  assert.ok(uninstall.actions.every((x) => x.status === "preserve"));
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
  const receipt = JSON.parse(await readFile(join(f.claude, "devctx-resume/.devctx-owned.json"), "utf8"));
  assert.equal(receipt.kitCommit, b.commit);
  assert.match(await readFile(join(f.codex, "devctx-resume/SKILL.md"), "utf8"), /Kit B devctx-resume/);
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
  await mkdir(join(legacy, "devctx-resume"), { recursive: true });
  await writeFile(join(legacy, "devctx-resume/SKILL.md"), "old copy\n");
  await mkdir(join(legacy, "someone-else"));
  const before = await treeSnapshot(join(f.home, ".codex"));
  const status = await installStatus(p.roots, p.pilot, {});
  assert.deepEqual(status.legacy, [{ agent: "codex", skill: "devctx-resume", path: join(legacy, "devctx-resume") }]);
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
  assert.equal(existsSync(join(home, ".claude/skills/devctx-onboard")), false);
  assert.equal((await installStatus(p.roots, p.pilot, { targetHome: home })).status, "ok");
});
