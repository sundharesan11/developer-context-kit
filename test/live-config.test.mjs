import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, rm, symlink, chmod } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, assertWritable, recordApprovedDigest, pilotDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { toJson } from "../src/errors.mjs";
import { writeManifest } from "../src/kit/manifest.mjs";
import { kitId } from "../src/kit/identity.mjs";
import { writeKitReceipt, receiptProblem, readPilotBytes } from "../src/hooks/receipt.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const refused = (field, code = "DEVTWIN_GATE_REQUIRED") => (e) => e.code === code && (field === undefined || e.details.field === field);
async function pinnedKit(dir, files = { "README.md": "kit\n" }) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
async function liveFixture(t, { env = {}, kit } = {}) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const pinned = kit ?? await pinnedKit(join(devtwin, "kit"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const storeAt = (root) => ({ pilotRoot: root, configRoot: join(root, "config"), dataRoot: join(root, "data"), stateRoot: join(root, "state"), inputsRoot: join(root, "inputs") });
  const obj = { schemaVersion: 1, ...storeAt(store), agentHomes: [], repos: [repo], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills"), codex: join(home, ".agents/skills") }, kitRoot: pinned.kit, kitCommit: pinned.commit } };
  const context = { home, env, kitRoot: pinned.kit };
  let n = 0;
  const f = {
    sb, home, devtwin, store, repo, obj, context, storeAt, kit: pinned.kit, kitCommit: pinned.commit,
    claudeSkills: obj.live.skillDirs.claude, codexSkills: obj.live.skillDirs.codex,
    async write(patch = {}, live = {}, { dir = devtwin, mode = 0o600 } = {}) {
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
test("live config validates a real store, existing skill folders and a repository outside the store", async (t) => {
  const f = await liveFixture(t);
  const pilot = await loadPilot(await f.approved(), f.context);
  assert.deepEqual(pilot.live.skillDirs, { claude: f.claudeSkills, codex: f.codexSkills });
  assert.deepEqual(pilot.repos, [f.repo]);
  assert.deepEqual(pilot.warnings, []);
  assert.equal(pilot.digest, pilotDigest(f.obj));
  assert.notEqual(pilotDigest(f.obj), pilotDigest({ ...f.obj, live: undefined }));
});
test("live config paths without a live block are refused exactly as a disposable pilot", async (t) => {
  const f = await liveFixture(t);
  await assert.rejects(loadPilot(await f.write({}, null), f.context), refused("repos"));
  await assert.rejects(loadPilot(await f.write({ repos: [], agentHomes: [f.home] }, null), f.context), refused("agentHomes"));
});
test("live config refuses unlisted, parent, codex-home and missing skill folders", async (t) => {
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
test("live config refuses a store or live config in a Git worktree, a nested or in-store kit, and repositories inside the store or kit", async (t) => {
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
test("live config refuses a symlinked .claude ancestor with PATH_UNSAFE", async (t) => {
  const f = await liveFixture(t);
  const real = join(f.sb, "real-claude");
  await mkdir(join(real, "skills"), { recursive: true });
  await rm(join(f.home, ".claude"), { recursive: true });
  await symlink(real, join(f.home, ".claude"));
  await assert.rejects(loadPilot(await f.write(), f.context), refused("live.skillDirs.claude", "DEVTWIN_PATH_UNSAFE"));
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
    assert.equal(error.code, "DEVTWIN_GATE_REQUIRED");
    assert.equal(error.details.field, "live.kitRoot");
    assert.equal(error.details.reason, "running-kit");
    assert.ok(!JSON.stringify(toJson(error)).includes(f.sb));
  }
});
test("live kit at another commit, attached to a branch, or with local changes fails with GATE_REQUIRED", async (t) => {
  const f = await liveFixture(t);
  const path = await f.approved();
  await mkdir(join(f.kit, "src"));
  await writeFile(join(f.kit, "src/untracked.mjs"), "x");
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
test("live config edited after approval, unapproved, or not private fails", async (t) => {
  const f = await liveFixture(t);
  await assert.rejects(loadPilot(await f.write(), f.context), (e) => refused("live.approval")(e) && e.details.reason === "unapproved");
  const path = await f.approved();
  assert.ok(await loadPilot(path, f.context));
  await writeFile(path, JSON.stringify({ ...f.obj, forbidden: [join(f.sb, "work/other")] }), { mode: 0o600 });
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.approval")(e) && e.details.reason === "changed");
  await writeFile(path, JSON.stringify({ ...f.obj, live: { ...f.obj.live, configId: "cfg_fedcba9876543210" } }), { mode: 0o600 });
  await assert.rejects(loadPilot(path, f.context), refused("live.approval"));
  await writeFile(path, JSON.stringify(f.obj), { mode: 0o600 });
  assert.ok(await loadPilot(path, f.context));
  await chmod(path, 0o644);
  await assert.rejects(loadPilot(path, f.context), { code: "DEVTWIN_PATH_UNSAFE" });
});
test("live skill folder inside a listed repository is refused", async (t) => {
  const f = await liveFixture(t);
  await mkdir(join(f.repo, ".claude/skills"), { recursive: true });
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: { claude: join(f.repo, ".claude/skills"), codex: f.codexSkills } }), f.context), refused("live.skillDirs.claude"));
  const context = { ...f.context, env: { CLAUDE_CONFIG_DIR: join(f.repo, ".claude") } };
  await assert.rejects(loadPilot(await f.write({}, { skillDirs: { claude: join(f.repo, ".claude/skills"), codex: f.codexSkills } }), context), refused("repos"));});
test("live assertWritable takes only devtwin entries inside a named skill folder", async (t) => {
  const f = await liveFixture(t);
  const pilot = await loadPilot(await f.approved(), f.context), roots = rootsFromPilot(pilot);
  assert.doesNotThrow(() => assertWritable(roots, [join(f.claudeSkills, "devtwin-resume"), join(f.claudeSkills, "devtwin-resume/SKILL.md"), join(pilot.stateRoot, "runs/x")], { targetHome: f.claudeSkills }));
  for (const destination of [f.claudeSkills, join(f.claudeSkills, "foreign"), join(f.claudeSkills, "foreign/devtwin-x"), join(f.codexSkills, "devtwin-resume"), join(f.home, ".claude/settings.json")]) {
    await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [destination], { targetHome: f.claudeSkills })), refused("destination"));
  }
  for (const targetHome of [f.home, join(f.home, ".claude"), join(f.home, ".codex/skills")]) await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [join(targetHome, "devtwin-x")], { targetHome })), refused("targetHome"));
  await assert.rejects(Promise.resolve().then(() => assertWritable(roots, [join(f.claudeSkills, "devtwin-resume")])), refused("destination"));
});
test("live kit clone of the committed HEAD runs devtwin from a pinned detached checkout", async (t) => {
  const head = (await fixtureGit(REPO_ROOT, ["rev-parse", "HEAD"])).trim();
  const parent = await sandbox(t), clone = join(parent, "kit");
  await fixtureGit(parent, ["clone", "-q", "--no-hardlinks", REPO_ROOT, clone]);
  await fixtureGit(clone, ["checkout", "-q", "--detach", head]);
  const f = await liveFixture(t, { kit: { kit: clone, commit: head } });
  const path = await f.approved();
  const run = (kit) => {
    const r = spawnSync(process.execPath, [join(kit, "bin/devtwin.mjs"), "doctor", "--pilot", path], { cwd: f.sb, encoding: "utf8", env: { PATH: process.env.PATH, HOME: f.home } });
    return JSON.parse(r.stdout);
  };
  const ok = run(clone);
  assert.equal(ok.ok, true, JSON.stringify(ok.error));
  assert.equal(ok.command, "doctor");
  const mismatch = run(REPO_ROOT);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(mismatch.error.details.field, "live.kitRoot");
});
test("live kit tolerates stray files outside its code paths and refuses untracked, ignored or changed code", async (t) => {
  const sb = await sandbox(t);
  const kit = await pinnedKit(join(sb, "home/.devtwin/kit"), { "README.md": "kit\n", ".gitignore": "*.local.mjs\nnode_modules/\n", "src/a.mjs": "export {};\n", "docs/x.md": "doc\n" });
  const f = await liveFixture(t, { kit });
  const path = await f.approved();
  const dirty = (e) => refused("live.kitCommit")(e) && e.details.reason === "dirty";
  await writeFile(join(f.kit, ".DS_Store"), "x");
  await writeFile(join(f.kit, "docs/.DS_Store"), "x");
  await mkdir(join(f.kit, "node_modules/pkg"), { recursive: true });
  await writeFile(join(f.kit, "node_modules/pkg/index.js"), "x");
  assert.ok(await loadPilot(path, f.context));
  for (const rel of ["src/new.mjs", "src/a.local.mjs", "src/sub/deep.local.mjs", "bin/extra.mjs", "skills/x/SKILL.md", "scripts/s.mjs", "schemas/s.json", "catalog/c.json", "package.json"]) {
    await mkdir(dirname(join(f.kit, rel)), { recursive: true });
    await writeFile(join(f.kit, rel), "x");
    await assert.rejects(loadPilot(path, f.context), dirty, rel);
    await rm(join(f.kit, rel));
  }
  assert.ok(await loadPilot(path, f.context));
  await writeFile(join(f.kit, "docs/x.md"), "changed\n");
  await assert.rejects(loadPilot(path, f.context), dirty);
  await fixtureGit(f.kit, ["checkout", "-q", "--", "docs/x.md"]);
  assert.ok(await loadPilot(path, f.context));
});
// U43: a package kit as `kit install` (U44) leaves it: under <home>/.devtwin/kits, folders 0500, files 0400.
async function packageKit(home, version = "0.1.0-alpha.1") {
  const kits = join(home, ".devtwin/kits"), kit = join(kits, "kit-" + version);
  for (const [rel, text] of [["package.json", JSON.stringify({ name: "devtwin", version })], ["bin/devtwin.mjs", "#!/usr/bin/env node\n"], ["src/a.mjs", "export {};\n"]]) {
    await mkdir(dirname(join(kit, rel)), { recursive: true, mode: 0o700 });
    await writeFile(join(kit, rel), text);
  }
  await chmod(kits, 0o700);
  await chmod(join(kit, "bin/devtwin.mjs"), 0o755);
  const manifest = await writeManifest(kit, { sourceCommit: null });
  const lock = async (dir) => { for (const e of await readdir(dir, { withFileTypes: true })) { if (e.isDirectory()) await lock(join(dir, e.name)); else await chmod(join(dir, e.name), e.name === "devtwin.mjs" ? 0o500 : 0o400); } await chmod(dir, 0o500); };
  await lock(kit);
  return { kit, version, digest: manifest.digest };
}
test("live config holds exactly one kit form: kitCommit, or kitVersion with a full kitDigest", async (t) => {
  const f = await liveFixture(t);
  const pkg = { kitVersion: "0.1.0-alpha.1", kitDigest: "d".repeat(64) };
  for (const live of [{ ...pkg }, { kitDigest: pkg.kitDigest }, { kitCommit: undefined }, { kitCommit: undefined, kitVersion: pkg.kitVersion }, { kitCommit: undefined, kitDigest: pkg.kitDigest }, { kitCommit: undefined, ...pkg, kitDigest: "d".repeat(12) }, { kitCommit: undefined, ...pkg, kitDigest: "sha256:" + "d".repeat(64) }, { kitCommit: undefined, ...pkg, kitVersion: "1.0" }, { kitCommit: undefined, ...pkg, kitVersion: "1.0.0+build" }]) {
    await assert.rejects(loadPilot(await f.write({}, live), f.context), refused("live"), JSON.stringify(live));
  }
});
test("live package kit under the kits folder validates, gets a kitId receipt and fails after a changed byte", async (t) => {
  const f = await liveFixture(t);
  const pkg = await packageKit(f.home), context = { ...f.context, kitRoot: pkg.kit };
  const path = await f.approved({}, { kitRoot: pkg.kit, kitCommit: undefined, kitVersion: pkg.version, kitDigest: pkg.digest }, context);
  const pilot = await loadPilot(path, context);
  assert.equal(pilot.live.kitDigest, pkg.digest);
  assert.equal(pilot.live.kitCommit, undefined);
  const receipt = await writeKitReceipt(rootsFromPilot(pilot), { pilotPath: path, kitRoot: pkg.kit });
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.kitId, kitId({ kind: "package", version: pkg.version, digest: pkg.digest }));
  assert.equal(await receiptProblem(pilot.stateRoot, { pilotPath: path, pilotBytes: readPilotBytes(path), kitRoot: pkg.kit, now: new Date() }), null);
  await assert.rejects(loadPilot(path, f.context), (e) => refused("live.kitRoot")(e) && e.details.reason === "running-kit");
  const file = join(pkg.kit, "src/a.mjs");
  await chmod(file, 0o600);
  await writeFile(file, (await readFile(file, "utf8")) + " ");
  await chmod(file, 0o400);
  await assert.rejects(loadPilot(path, context), (e) => refused("live.kitRoot")(e) && e.details.reason === "digest");
});
