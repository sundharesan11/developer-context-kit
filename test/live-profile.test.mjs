import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, assertWritable, recordApprovedDigest, pilotDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { toJson } from "../src/errors.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refused = (field, code = "DEVCTX_GATE_REQUIRED") => (e) => e.code === code && (field === undefined || e.details.field === field);
async function pinnedKit(dir, files = { "README.md": "kit\n" }) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
async function liveFixture(t, { env = {}, kit } = {}) {
  const sb = await sandbox(t), home = join(sb, "home"), devctx = join(home, ".devctx"), store = join(devctx, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const pinned = kit ?? await pinnedKit(join(devctx, "kit"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const storeAt = (root) => ({ pilotRoot: root, configRoot: join(root, "config"), dataRoot: join(root, "data"), stateRoot: join(root, "state"), inputsRoot: join(root, "inputs") });
  const obj = { schemaVersion: 1, ...storeAt(store), agentHomes: [], repos: [repo], forbidden: [], live: { profileId: "prof_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills"), codex: join(home, ".agents/skills") }, kitRoot: pinned.kit, kitCommit: pinned.commit } };
  const context = { home, env, kitRoot: pinned.kit };
  let n = 0;
  const f = {
    sb, home, devctx, store, repo, obj, context, storeAt, kit: pinned.kit, kitCommit: pinned.commit,
    claudeSkills: obj.live.skillDirs.claude, codexSkills: obj.live.skillDirs.codex,
    async write(patch = {}, live = {}, { dir = devctx, mode = 0o600 } = {}) {
      const path = join(dir, "live-" + ++n + ".json"), body = { ...obj, ...patch, live: live === null ? undefined : { ...obj.live, ...live } };
      await writeFile(path, JSON.stringify(body), { mode });
      await chmod(path, mode);
      return path;
    },
    async approve(path, ctx = context) {
      const pilot = await loadPilot(path, { ...ctx, liveGate: { approval: false } });
      const roots = rootsFromPilot(pilot);
      ensureRoots(roots);
      await recordApprovedDigest(roots);
      return path;
    },
    async approved(patch, live, ctx) { return f.approve(await f.write(patch, live), ctx); }
  };
  return f;
}
test("live profile validates a real store, existing skill folders and a repository outside the store", async (t) => {
  const f = await liveFixture(t);
  const pilot = await loadPilot(await f.approved(), f.context);
  assert.deepEqual(pilot.live.skillDirs, { claude: f.claudeSkills, codex: f.codexSkills });
  assert.deepEqual(pilot.repos, [f.repo]);
  assert.deepEqual(pilot.warnings, []);
  assert.equal(pilot.digest, pilotDigest(f.obj));
  assert.notEqual(pilotDigest(f.obj), pilotDigest({ ...f.obj, live: undefined }));
});
test("live profile paths without a live block are refused exactly as a disposable pilot", async (t) => {
  const f = await liveFixture(t);
  await assert.rejects(loadPilot(await f.write({}, null), f.context), refused("repos"));
  await assert.rejects(loadPilot(await f.write({ repos: [], agentHomes: [f.home] }, null), f.context), refused("agentHomes"));
});
test("live profile refuses unlisted, parent, codex-home and missing skill folders", async (t) => {
  const f = await liveFixture(t);
  await mkdir(join(f.home, "other/skills"), { recursive: true });
  await mkdir(join(f.home, ".codex/skills"), { recursive: true });
  for (const [skillDirs, field] of [[{ claude: join(f.home, "other/skills") }, "claude"], [{ claude: join(f.home, ".claude") }, "claude"], [{ codex: join(f.home, ".codex/skills") }, "codex"], [{ codex: f.claudeSkills }, "codex"], [{ claude: f.codexSkills }, "claude"], [{ gemini: join(f.home, ".gemini/skills") }, "gemini"]]) {
    await assert.rejects(loadPilot(await f.write({}, { skillDirs }), f.context), refused("live.skillDirs." + field), JSON.stringify(skillDirs));
  }
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: {} }), f.context), refused("live.skillDirs"));
  await assert.rejects(loadPilot(await f.write({ agentHomes: [join(f.store, "homes/claude")] }), f.context), refused("agentHomes"));
  await assert.rejects(loadPilot(await f.write({}, { home: join(f.sb, "elsewhere") }), f.context), refused("live.home"));
  await assert.rejects(loadPilot(await f.write({}, { extra: true }), f.context), refused("live"));
  await assert.rejects(loadPilot(await f.write({}, { kitCommit: "main" }), f.context), refused("live"));
  const path = await f.approved();
  await assert.rejects(loadPilot(path, { ...f.context, home: join(f.sb, "other-home") }), refused("live.home"));
  await rm(f.codexSkills, { recursive: true });
  await assert.rejects(loadPilot(path, f.context), refused("live.skillDirs.codex"));
  assert.equal((await loadPilot(await f.approved({}, { skillDirs: { claude: f.claudeSkills } }), f.context)).live.skillDirs.codex, undefined);
});
test("live profile refuses a store or profile in a Git worktree, a nested or in-store kit, and repositories inside the store or kit", async (t) => {
  const f = await liveFixture(t);
  const outer = await makeRepo(join(f.sb, "outer"), { "README.md": "outer\n" });
  await mkdir(join(outer, "store"), { mode: 0o700 });
  await assert.rejects(loadPilot(await f.write(f.storeAt(join(outer, "store"))), f.context), refused("pilotRoot"));
  await assert.rejects(loadPilot(await f.write({}, {}, { dir: outer }), f.context), refused("pilot"));
  const nested = await pinnedKit(join(outer, "kit"));
  await assert.rejects(loadPilot(await f.write({}, { kitRoot: nested.kit, kitCommit: nested.commit }), { ...f.context, kitRoot: nested.kit }), refused("live.kitRoot"));
  const inStore = await pinnedKit(join(f.store, "kit"));
  await assert.rejects(loadPilot(await f.write({}, { kitRoot: inStore.kit, kitCommit: inStore.commit }), f.context), refused("live.kitRoot"));
  await assert.rejects(loadPilot(await f.write({}, { kitRoot: inStore.kit, kitCommit: inStore.commit }), { ...f.context, kitRoot: inStore.kit }), refused("live.kitRoot"));
  await mkdir(join(f.kit, "sub"));
  await assert.rejects(loadPilot(await f.write({}, { kitRoot: join(f.kit, "sub") }), { ...f.context, kitRoot: join(f.kit, "sub") }), refused("live.kitRoot"));
  await assert.rejects(loadPilot(await f.write({ repos: [join(f.store, "repos/x")] }), f.context), refused("repos"));
  await assert.rejects(loadPilot(await f.write({ repos: [join(f.kit, "inner")] }), f.context), refused("repos"));
  await assert.rejects(loadPilot(await f.write({ repos: [f.home] }), f.context), refused("repos"));
  await assert.rejects(loadPilot(await f.write({ repos: [f.claudeSkills] }), f.context), refused("repos"));
});
test("live kit at the top level of its own clone validates", async (t) => {
  const origin = await makeRepo(join(await sandbox(t), "origin"), { "README.md": "kit\n" });
  const parent = await sandbox(t), clone = join(parent, "kit");
  await fixtureGit(parent, ["clone", "-q", origin, clone]);
  const commit = (await fixtureGit(clone, ["rev-parse", "HEAD"])).trim();
  await fixtureGit(clone, ["checkout", "-q", "--detach", commit]);
  const f = await liveFixture(t, { kit: { kit: clone, commit } });
  assert.equal((await loadPilot(await f.approved(), f.context)).live.kitRoot, clone);
  const worktree = join(parent, "linked");
  await fixtureGit(clone, ["worktree", "add", "-q", "--detach", worktree, commit]);
  await assert.rejects(loadPilot(await f.write({}, { kitRoot: worktree }), { ...f.context, kitRoot: worktree }), refused("live.kitRoot"));
});
test("live profile refuses a symlinked .claude ancestor with PATH_UNSAFE", async (t) => {
  const f = await liveFixture(t);
  const real = join(f.sb, "real-claude");
  await mkdir(join(real, "skills"), { recursive: true });
  await rm(join(f.home, ".claude"), { recursive: true });
  await symlink(real, join(f.home, ".claude"));
  await assert.rejects(loadPilot(await f.write(), f.context), refused("live.skillDirs.claude", "DEVCTX_PATH_UNSAFE"));
});
test("live CLAUDE_CONFIG_DIR requires the Claude skill folder inside it and CODEX_HOME only warns", async (t) => {
  const f = await liveFixture(t);
  const config = join(f.sb, "claude-config"), codexHome = join(f.sb, "codex-home");
  await mkdir(join(config, "skills"), { recursive: true });
  await mkdir(join(codexHome, "skills"), { recursive: true });
  const withConfig = { ...f.context, env: { CLAUDE_CONFIG_DIR: config } };
  await assert.rejects(loadPilot(await f.write(), withConfig), refused("live.skillDirs.claude"));
  const pilot = await loadPilot(await f.approved({}, { skillDirs: { claude: join(config, "skills"), codex: f.codexSkills } }, withConfig), withConfig);
  assert.equal(pilot.live.skillDirs.claude, join(config, "skills"));
  const withCodex = { ...f.context, env: { CODEX_HOME: codexHome } };
  const warned = await loadPilot(await f.approved({}, {}, withCodex), withCodex);
  assert.deepEqual(warned.warnings, [{ code: "CODEX_HOME_IGNORED" }]);
  assert.equal(warned.live.skillDirs.codex, f.codexSkills);
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: { codex: join(codexHome, "skills") } }), withCodex), refused("live.skillDirs.codex"));
});
test("live running kit at another path fails with GATE_REQUIRED naming the kit", async (t) => {
  const f = await liveFixture(t);
  const path = await f.approved();
  for (const context of [{ ...f.context, kitRoot: REPO_ROOT }, { home: f.home, env: {} }]) {
    const error = await loadPilot(path, context).catch((e) => e);
    assert.equal(error.code, "DEVCTX_GATE_REQUIRED");
    assert.equal(error.details.field, "live.kitRoot");
    assert.equal(error.details.reason, "running-kit");
    assert.ok(!JSON.stringify(toJson(error)).includes(f.sb));
  }
});
test("live kit at another commit, attached to a branch, or with local changes fails with GATE_REQUIRED", async (t) => {
  const f = await liveFixture(t);
  const path = await f.approved();
  await writeFile(join(f.kit, "untracked.txt"), "x");
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.kitCommit")(e) && e.details.reason === "dirty");
  await fixtureGit(f.kit, ["add", "-A"]);
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.kitCommit")(e) && e.details.reason === "dirty");
  await fixtureGit(f.kit, ["commit", "-q", "-m", "drift"]);
  const drift = (await fixtureGit(f.kit, ["rev-parse", "HEAD"])).trim();
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.kitCommit")(e) && e.details.reason === "commit");
  await fixtureGit(f.kit, ["checkout", "-q", "main"]);
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.kitCommit")(e) && e.details.reason === "attached");
  await fixtureGit(f.kit, ["checkout", "-q", "--detach", f.kitCommit]);
  assert.ok(await loadPilot(path, f.context));
  await fixtureGit(f.kit, ["checkout", "-q", "--detach", drift]);
  assert.ok(await loadPilot(path, { ...f.context, liveGate: { kit: { kitRoot: f.kit, kitCommit: drift } } }));
  await assert.rejects(loadPilot(path, { ...f.context, liveGate: { kit: { kitRoot: f.kit, kitCommit: f.kitCommit } } }), refused("live.kitCommit"));
});
test("live profile edited after approval, unapproved, or not private fails", async (t) => {
  const f = await liveFixture(t);
  await assert.rejects(loadPilot(await f.write(), f.context), (e) => refused("live.approval")(e) && e.details.reason === "unapproved");
  const path = await f.approved();
  assert.ok(await loadPilot(path, f.context));
  await writeFile(path, JSON.stringify({ ...f.obj, forbidden: [join(f.sb, "work/other")] }), { mode: 0o600 });
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.approval")(e) && e.details.reason === "changed");
  await writeFile(path, JSON.stringify({ ...f.obj, live: { ...f.obj.live, profileId: "prof_fedcba9876543210" } }), { mode: 0o600 });
  await assert.rejects(loadPilot(path, f.context), refused("live.approval"));
  await writeFile(path, JSON.stringify(f.obj), { mode: 0o600 });
  assert.ok(await loadPilot(path, f.context));
  await chmod(path, 0o644);
  await assert.rejects(loadPilot(path, f.context), { code: "DEVCTX_PATH_UNSAFE" });
});
test("live skill folder inside a listed repository is refused", async (t) => {
  const f = await liveFixture(t);
  await mkdir(join(f.repo, ".claude/skills"), { recursive: true });
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: { claude: join(f.repo, ".claude/skills"), codex: f.codexSkills } }), f.context), refused("live.skillDirs.claude"));
  const context = { ...f.context, env: { CLAUDE_CONFIG_DIR: join(f.repo, ".claude") } };
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: { claude: join(f.repo, ".claude/skills"), codex: f.codexSkills } }), context), refused("repos"));});
test("live assertWritable takes only devctx entries inside a named skill folder", async (t) => {
  const f = await liveFixture(t);
  const pilot = await loadPilot(await f.approved(), f.context), roots = rootsFromPilot(pilot);
  assert.doesNotThrow(() => assertWritable(roots, [join(f.claudeSkills, "devctx-resume"), join(f.claudeSkills, "devctx-resume/SKILL.md"), join(pilot.stateRoot, "runs/x")], { targetHome: f.claudeSkills }));
  for (const destination of [f.claudeSkills, join(f.claudeSkills, "foreign"), join(f.claudeSkills, "foreign/devctx-x"), join(f.codexSkills, "devctx-resume"), join(f.home, ".claude/settings.json")]) {
    await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [destination], { targetHome: f.claudeSkills })), refused("destination"));
  }
  for (const targetHome of [f.home, join(f.home, ".claude"), join(f.home, ".codex/skills")]) await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [join(targetHome, "devctx-x")], { targetHome })), refused("targetHome"));
  await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [join(f.claudeSkills, "devctx-resume")])), refused("destination"));
});
test("live kit clone of the committed HEAD runs devctx from a pinned detached checkout", async (t) => {
  const head = (await fixtureGit(REPO_ROOT, ["rev-parse", "HEAD"])).trim();
  const parent = await sandbox(t), clone = join(parent, "kit");
  await fixtureGit(parent, ["clone", "-q", "--no-hardlinks", REPO_ROOT, clone]);
  await fixtureGit(clone, ["checkout", "-q", "--detach", head]);
  const f = await liveFixture(t, { kit: { kit: clone, commit: head } });
  const path = await f.approved();
  const run = (kit) => {
    const r = spawnSync(process.execPath, [join(kit, "bin/devctx.mjs"), "doctor", "--pilot", path], { cwd: f.sb, encoding: "utf8", env: { PATH: process.env.PATH, HOME: f.home } });
    return JSON.parse(r.stdout);
  };
  const ok = run(clone);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.command, "doctor");
  const mismatch = run(REPO_ROOT);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "DEVCTX_GATE_REQUIRED");
  assert.equal(mismatch.error.details.field, "live.kitRoot");
});
