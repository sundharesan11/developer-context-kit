import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, chmod, stat, readdir, rm } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, runCli, treeSnapshot, packageKit } from "./helpers.mjs";
import { loadPilot, readApprovedDigest } from "../src/config/pilot.mjs";
import { applyLiveInit, applyLiveAddRepo, applyLiveSetKit } from "../src/config/live.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = async (path) => (await stat(path)).mode & 0o777;
async function pinnedKit(dir, files = { "README.md": "kit\n" }) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
async function liveHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const { kit, commit } = await pinnedKit(join(devtwin, "kit"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json"), store = join(devtwin, "store");
  // Every owner dialog (live set-kit) goes to a recording fake; no test shows a real dialog.
  const dialogs = [];
  let answer = "approved";
  const ownerDialog = async (content) => { dialogs.push(content); return answer; };
  const cli = (args, kitRoot = kit) => runCli(args, { home, env: {}, kitRoot, ownerDialog });
  const context = { home, env: {}, kitRoot: kit, ownerDialog };
  const init = async (extra = ["--agent", "claude", "--agent", "codex", "--repo", repo]) => {
    const preview = await cli(["live", "init", "--pilot", liveConfig, ...extra]);
    assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
    const applied = await cli(["live", "init", "--pilot", liveConfig, ...extra, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
    assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
    return { preview: preview.json.result, applied: applied.json.result };
  };
  return { sb, home, devtwin, kit, commit, repo, liveConfig, store, cli, context, init, dialogs, setAnswer: (value) => { answer = value; } };
}
const readConfig = async (path) => JSON.parse(await readFile(path, "utf8"));
const failed = (r, code, field) => {
  assert.equal(r.json.ok, false, JSON.stringify(r.json));
  assert.equal(r.json.error.code, code, JSON.stringify(r.json.error));
  if (field !== undefined) assert.equal(r.json.error.details.field, field, JSON.stringify(r.json.error));
};
test("live init preview writes nothing, and apply creates private folders, the live config and the approved digest", async (t) => {
  const h = await liveHome(t);
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "codex", "--agent", "claude", "--repo", h.repo]);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  const plan = preview.json.result;
  assert.equal(plan.preview, true);
  assert.match(plan.fingerprint, /^sha256:/);
  assert.deepEqual(plan.layout, { config: h.liveConfig, pilotRoot: h.store, configRoot: join(h.store, "config"), dataRoot: join(h.store, "data"), stateRoot: join(h.store, "state"), inputsRoot: join(h.store, "inputs"), kitRoot: h.kit });
  assert.deepEqual(plan.config.live, { configId: null, home: h.home, skillDirs: { claude: join(h.home, ".claude/skills"), codex: join(h.home, ".agents/skills") }, kitRoot: h.kit, kitCommit: h.commit });
  assert.deepEqual(plan.config.repos, [h.repo]);
  assert.deepEqual(plan.config.agentHomes, []);
  const applied = await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude", "--agent", "codex", "--repo", h.repo, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  const written = await readConfig(h.liveConfig);
  assert.match(written.live.configId, /^cfg_[0-9a-f]{16}$/);
  assert.equal(applied.json.result.configId, written.live.configId);
  assert.deepEqual({ ...written, live: { ...written.live, configId: null } }, plan.config);
  assert.equal(await mode(h.liveConfig), 0o600);
  assert.equal(await mode(h.devtwin), 0o700);
  for (const dir of ["", "config", "data", "state", "inputs"]) assert.equal(await mode(join(h.store, dir)), 0o700, dir);
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: written.live.configId, digest: pilot.digest });
  assert.equal(applied.json.result.digest, pilot.digest);
  const doctor = await h.cli(["doctor", "--pilot", h.liveConfig]);
  assert.equal(doctor.json.ok, true, JSON.stringify(doctor.json.error));
});
test("live init refuses missing or stale fingerprints, unknown agents and a running kit that is not pinned", async (t) => {
  const h = await liveHome(t);
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]);
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude", "--apply"]), "DEVTWIN_PLAN_REQUIRED");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "codex", "--apply", "--plan-fingerprint", preview.json.result.fingerprint]), "DEVTWIN_PLAN_MISMATCH");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude", "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)]), "DEVTWIN_PLAN_MISMATCH");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "gemini"]), "DEVTWIN_INVALID_INPUT", "agent");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig]), "DEVTWIN_INVALID_INPUT", "agent");
  failed(await h.cli(["live", "init", "--pilot", "relative/live.json", "--agent", "claude"]), "DEVTWIN_GATE_REQUIRED", "pilot");
  assert.equal((await h.cli(["live", "init", "--pilot", h.liveConfig, "--pilot", h.liveConfig, "--agent", "claude"])).json.error.code, "DEVTWIN_USAGE");
  assert.equal((await h.cli(["live", "init", "--pilot", h.liveConfig, "--config-root", h.store, "--agent", "claude"])).json.error.code, "DEVTWIN_USAGE");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"], REPO_ROOT), "DEVTWIN_GATE_REQUIRED");
  assert.equal(await treeSnapshot(h.home), before);
  await mkdir(join(h.kit, "src"));
  await writeFile(join(h.kit, "src/dirty.mjs"), "x");
  const dirty = await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]);
  failed(dirty, "DEVTWIN_GATE_REQUIRED", "live.kitCommit");
  assert.equal(dirty.json.error.details.reason, "dirty");
  assert.deepEqual(await readdir(h.devtwin), ["kit"]);
});
test("live init refuses a live config folder that is not private and never changes its mode", async (t) => {
  const h = await liveHome(t);
  for (const bits of [0o755, 0o750]) {
    await chmod(h.devtwin, bits);
    failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]), "DEVTWIN_PATH_UNSAFE", "configDir");
    assert.equal(await mode(h.devtwin), bits);
  }
  failed(await h.cli(["live", "init", "--pilot", join(h.sb, "missing/live.json"), "--agent", "claude"]), "DEVTWIN_PATH_UNSAFE", "configDir");
  assert.deepEqual(await readdir(h.devtwin), ["kit"]);
});
test("live init refuses an existing non-empty store without a live config and an existing live config", async (t) => {
  const h = await liveHome(t);
  await mkdir(join(h.store, "config"), { recursive: true, mode: 0o700 });
  await chmod(h.store, 0o700);
  await writeFile(join(h.store, "config/user.json"), "{}", { mode: 0o600 });
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]), "DEVTWIN_CONFLICT", "pilotRoot");
  await rm(join(h.store, "config"), { recursive: true });
  const { applied } = await h.init(["--agent", "claude"]);
  const again = await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]);
  failed(again, "DEVTWIN_CONFLICT", "pilot");
  assert.equal((await readConfig(h.liveConfig)).live.configId, applied.configId);
});
test("live add-repo appends one repository through preview and approval and keeps the config ID", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const beacon = await makeRepo(join(h.sb, "work/beacon"), { "README.md": "# Beacon\n" });
  const comet = await makeRepo(join(h.sb, "work/comet"), { "README.md": "# Comet\n" });
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", beacon]);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  assert.equal(preview.json.result.repo, beacon);
  assert.deepEqual(preview.json.result.repos, { from: [h.repo], to: [h.repo, beacon].sort() });
  assert.equal(preview.json.result.configId, applied.configId);
  failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", comet, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]), "DEVTWIN_PLAN_MISMATCH");
  failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", beacon, "--apply"]), "DEVTWIN_PLAN_REQUIRED");
  assert.equal(await treeSnapshot(h.home), before);
  const done = await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", beacon, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  const written = await readConfig(h.liveConfig);
  assert.deepEqual(written.repos, [h.repo, beacon].sort());
  assert.equal(written.live.configId, applied.configId);
  assert.equal(await mode(h.liveConfig), 0o600);
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  assert.notEqual(pilot.digest, applied.digest);
  failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", beacon]), "DEVTWIN_INVALID_INPUT", "repo");
  failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig]), "DEVTWIN_INVALID_INPUT", "repo");
  // A stale preview made before another approved change no longer applies.
  const stale = await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", comet]);
  const delta = await makeRepo(join(h.sb, "work/delta"), { "README.md": "# Delta\n" });
  const other = await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", delta]);
  assert.equal((await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", delta, "--apply", "--plan-fingerprint", other.json.result.fingerprint])).json.ok, true);
  failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", comet, "--apply", "--plan-fingerprint", stale.json.result.fingerprint]), "DEVTWIN_PLAN_MISMATCH");
});
test("live set-kit from a clean detached new kit at the requested commit rewrites the kit and keeps the config ID", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const next = await pinnedKit(join(h.devtwin, "kit-next"), { "README.md": "kit next\n" });
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  assert.deepEqual(preview.json.result.kit, { from: { kitRoot: h.kit, kitCommit: h.commit, kitId: "git:" + h.commit }, to: { kitRoot: next.kit, kitCommit: next.commit, kitId: "git:" + next.commit } });
  assert.equal(preview.json.result.configId, applied.configId);
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit, "--apply", "--plan-fingerprint", "sha256:" + "1".repeat(64)], next.kit), "DEVTWIN_PLAN_MISMATCH");
  const done = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], next.kit);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  assert.equal(h.dialogs.length, 1, "one owner dialog, after the fingerprint check");
  const written = await readConfig(h.liveConfig);
  assert.deepEqual([written.live.kitRoot, written.live.kitCommit, written.live.configId], [next.kit, next.commit, applied.configId]);
  const pilot = await loadPilot(h.liveConfig, { ...h.context, kitRoot: next.kit });
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  const oldKit = await h.cli(["doctor", "--pilot", h.liveConfig], h.kit);
  failed(oldKit, "DEVTWIN_GATE_REQUIRED", "live.kitRoot");
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig], next.kit)).json.ok, true);
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit), "DEVTWIN_INVALID_INPUT", "commit");
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", "main"], next.kit), "DEVTWIN_INVALID_INPUT", "commit");
});
test("live set-kit from a kit with local changes or at a commit other than the requested one is refused", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const next = await pinnedKit(join(h.devtwin, "kit-next"), { "README.md": "kit next\n" });
  await writeFile(join(next.kit, "README.md"), "changed\n");
  const dirty = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit);
  failed(dirty, "DEVTWIN_GATE_REQUIRED", "live.kitCommit");
  assert.equal(dirty.json.error.details.reason, "dirty");
  await fixtureGit(next.kit, ["checkout", "-q", "--", "README.md"]);
  const wrong = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", h.commit], next.kit);
  failed(wrong, "DEVTWIN_GATE_REQUIRED", "live.kitCommit");
  assert.equal(wrong.json.error.details.reason, "commit");
  await fixtureGit(next.kit, ["checkout", "-q", "main"]);
  const attached = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit);
  failed(attached, "DEVTWIN_GATE_REQUIRED", "live.kitCommit");
  assert.equal(attached.json.error.details.reason, "attached");
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], h.kit), "DEVTWIN_GATE_REQUIRED", "live.kitCommit");
  assert.equal((await readConfig(h.liveConfig)).live.kitRoot, h.kit);
});
test("live config commands refuse a repository inside the store or the kit", async (t) => {
  const h = await liveHome(t);
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude", "--repo", join(h.store, "repos/x")]), "DEVTWIN_GATE_REQUIRED", "repos");
  failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude", "--repo", join(h.kit, "inner")]), "DEVTWIN_GATE_REQUIRED", "repos");
  assert.deepEqual(await readdir(h.devtwin), ["kit"]);
  await h.init(["--agent", "claude"]);
  for (const repo of [join(h.store, "repos/x"), join(h.kit, "inner"), h.store]) failed(await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", repo]), "DEVTWIN_GATE_REQUIRED", "repos");
  const next = await pinnedKit(join(h.repo, "kit"));
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit), "DEVTWIN_GATE_REQUIRED");
});
test("live config edited by hand after approval is refused by the next live config command", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const beacon = await makeRepo(join(h.sb, "work/beacon"), { "README.md": "# Beacon\n" });
  const edited = await readConfig(h.liveConfig);
  await writeFile(h.liveConfig, JSON.stringify({ ...edited, repos: [...edited.repos, beacon].sort() }), { mode: 0o600 });
  for (const args of [["live", "add-repo", "--pilot", h.liveConfig, "--repo", beacon], ["doctor", "--pilot", h.liveConfig]]) {
    const r = await h.cli(args);
    failed(r, "DEVTWIN_GATE_REQUIRED", "live.approval");
    assert.equal(r.json.error.details.reason, "changed");
  }
  const next = await pinnedKit(join(h.devtwin, "kit-next"));
  failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit), "DEVTWIN_GATE_REQUIRED", "live.approval");
});
test("live init leaves the store ready for init and scope add through the CLI", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const scope = await h.cli(["scope", "add", "--pilot", h.liveConfig, "--scope", "acme", "--apply"]);
  assert.equal(scope.json.ok, true, JSON.stringify(scope.json.error));
  assert.deepEqual(scope.json.result, { created: true, scope: "acme" });
  const init = await h.cli(["init", "--pilot", h.liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  assert.equal(init.json.ok, true, JSON.stringify(init.json.error));
  assert.deepEqual(init.json.result, { created: true });
  assert.equal(await mode(join(h.store, "config/scopes/acme.json")), 0o600);
  assert.equal(await mode(join(h.store, "config/user.json")), 0o600);
});
test("live init from a pinned kit clone through bin/devtwin.mjs leaves a store that scope add uses", async (t) => {
  const head = (await fixtureGit(REPO_ROOT, ["rev-parse", "HEAD"])).trim();
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), kit = join(devtwin, "kit");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  await fixtureGit(devtwin, ["clone", "-q", "--no-hardlinks", REPO_ROOT, kit]);
  await fixtureGit(kit, ["checkout", "-q", "--detach", head]);
  const liveConfig = join(devtwin, "live.json");
  const run = (args) => {
    const r = spawnSync(process.execPath, [join(kit, "bin/devtwin.mjs"), ...args], { cwd: sb, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    return JSON.parse(r.stdout);
  };
  const preview = run(["live", "init", "--pilot", liveConfig, "--agent", "claude", "--agent", "codex"]);
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(preview.result.config.live.kitCommit, head);
  const applied = run(["live", "init", "--pilot", liveConfig, "--agent", "claude", "--agent", "codex", "--apply", "--plan-fingerprint", preview.result.fingerprint]);
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  const scope = run(["scope", "add", "--pilot", liveConfig, "--scope", "acme", "--apply"]);
  assert.equal(scope.ok, true, JSON.stringify(scope.error));
  assert.equal(scope.result.created, true);
  assert.equal(await mode(join(devtwin, "store/config/scopes/acme.json")), 0o600);
});
const crash = () => { throw new Error("injected crash"); };
test("live init crash after creating the store folders or recording the approval leaves a store that a retry initializes", async (t) => {
  for (const fault of ["afterRoots", "afterApproval"]) {
    const h = await liveHome(t), args = ["--agent", "claude", "--repo", h.repo];
    const preview = await h.cli(["live", "init", "--pilot", h.liveConfig, ...args]);
    const input = { configPath: h.liveConfig, agents: ["claude"], repos: [h.repo], fingerprint: preview.json.result.fingerprint };
    await assert.rejects(applyLiveInit(input, h.context, { faults: { [fault]: crash } }), /injected crash/, fault);
    assert.deepEqual((await readdir(h.devtwin)).sort(), ["kit", "store"], fault);
    assert.deepEqual((await readdir(h.store)).sort(), ["config", "data", "inputs", "state"], fault);
    assert.deepEqual((await readdir(join(h.store, "state"))).sort(), fault === "afterApproval" ? ["live", "locks"] : ["locks"], fault);
    const { applied } = await h.init(args);
    const pilot = await loadPilot(h.liveConfig, h.context);
    assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest }, fault);
    assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig])).json.ok, true, fault);
  }
});
test("live init accepts a store holding only the empty layout and an orphan approval and refuses anything else", async (t) => {
  const layout = async (h) => {
    for (const rel of ["config", "data", "inputs", "state/locks", "state/live"]) await mkdir(join(h.store, rel), { recursive: true, mode: 0o700 });
    await chmod(h.store, 0o700);
    await writeFile(join(h.store, "state/live/approved-config.json"), JSON.stringify({ schemaVersion: 1, configId: "cfg_0123456789abcdef", digest: "sha256:" + "0".repeat(64) }) + "\n", { mode: 0o600 });
  };
  for (const extra of ["stray.txt", "config/user.json", "data/x", "inputs/x", "state/other", "state/locks/live.lock", "state/live/other.json"]) {
    const h = await liveHome(t);
    await layout(h);
    await writeFile(join(h.store, extra), "x", { mode: 0o600 });
    failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]), "DEVTWIN_CONFLICT", "pilotRoot");
  }
  for (const rel of ["data", "state/live/approved-config.json"]) {
    const h = await liveHome(t);
    await layout(h);
    await rm(join(h.store, rel), { recursive: true });
    await (rel === "data" ? writeFile(join(h.store, rel), "x", { mode: 0o600 }) : mkdir(join(h.store, rel), { mode: 0o700 }));
    failed(await h.cli(["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]), "DEVTWIN_CONFLICT", "pilotRoot");
  }
  const h = await liveHome(t);
  await layout(h);
  const { applied } = await h.init(["--agent", "claude"]);
  const pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
});
test("live add-repo or set-kit crash around the live config replace leaves a live config that loads and a change that re-applies", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const [beacon, comet, delta] = await Promise.all(["beacon", "comet", "delta"].map((name) => makeRepo(join(h.sb, "work", name), { "README.md": "# " + name + "\n" })));
  const addRepo = async (repo, faults) => {
    const preview = await h.cli(["live", "add-repo", "--pilot", h.liveConfig, "--repo", repo]);
    assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
    return applyLiveAddRepo({ configPath: h.liveConfig, repo, fingerprint: preview.json.result.fingerprint }, h.context, { faults });
  };
  const doctorOk = async (kit = h.kit) => { const r = await h.cli(["doctor", "--pilot", h.liveConfig], kit); assert.equal(r.json.ok, true, JSON.stringify(r.json.error)); };
  // Crash after the approval is written and before the live config is replaced: the old live config still loads.
  await assert.rejects(addRepo(beacon, { afterApproval: crash }), /injected crash/);
  assert.deepEqual((await readConfig(h.liveConfig)).repos, [h.repo]);
  await doctorOk();
  const pending = await readApprovedDigest(await loadPilot(h.liveConfig, h.context));
  assert.equal(pending.previousDigest, applied.digest);
  await addRepo(beacon);
  assert.deepEqual((await readConfig(h.liveConfig)).repos, [h.repo, beacon].sort());
  let pilot = await loadPilot(h.liveConfig, h.context);
  assert.equal(pilot.digest, pending.digest);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  const beaconText = await readFile(h.liveConfig, "utf8"), beaconDigest = pilot.digest;
  // Crash after the live config is replaced and before the approval is rewritten: the new live config loads.
  await assert.rejects(addRepo(comet, { afterReplace: crash }), /injected crash/);
  assert.deepEqual((await readConfig(h.liveConfig)).repos, [h.repo, beacon, comet].sort());
  await doctorOk();
  pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest, previousDigest: beaconDigest });
  // The next approved change clears the leftover previous digest.
  await addRepo(delta);
  pilot = await loadPilot(h.liveConfig, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: applied.configId, digest: pilot.digest });
  // set-kit: a crash after the approval leaves the old kit running and the same preview re-applies.
  const next = await pinnedKit(join(h.devtwin, "kit-next"), { "README.md": "kit next\n" });
  const preview = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit], next.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  await assert.rejects(applyLiveSetKit({ configPath: h.liveConfig, commit: next.commit, fingerprint: preview.json.result.fingerprint }, { ...h.context, kitRoot: next.kit }, { faults: { afterApproval: crash } }), /injected crash/);
  await doctorOk(h.kit);
  const done = await h.cli(["live", "set-kit", "--pilot", h.liveConfig, "--commit", next.commit, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], next.kit);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  await doctorOk(next.kit);
  // An earlier live config is no longer approved once a change completes.
  await writeFile(h.liveConfig, beaconText);
  const stale = await h.cli(["doctor", "--pilot", h.liveConfig], h.kit);
  failed(stale, "DEVTWIN_GATE_REQUIRED", "live.approval");
  assert.equal(stale.json.error.details.reason, "changed");
});
// U45: a package kit installed under ~/.devtwin/kits, as kit install leaves it.
const pkgKit = (h, version = "0.1.0-alpha.1") => packageKit(h.home, join(h.sb, "global", version), { version });
test("live init from a package kit writes kitVersion and the full kitDigest and no kitCommit", async (t) => {
  const h = await liveHome(t);
  const pkg = await pkgKit(h);
  const args = ["live", "init", "--pilot", h.liveConfig, "--agent", "claude"];
  const preview = await h.cli(args, pkg.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  const plan = preview.json.result;
  assert.deepEqual(plan.config.live, { configId: null, home: h.home, skillDirs: { claude: join(h.home, ".claude/skills") }, kitRoot: pkg.kit, kitVersion: pkg.version, kitDigest: pkg.digest });
  assert.match(plan.config.live.kitDigest, /^[0-9a-f]{64}$/);
  assert.ok(!plan.warnings.some((w) => w.code === "KIT_NOT_SIBLING"), "a package kit under <config folder>/kits is where it belongs");
  const applied = await h.cli([...args, "--apply", "--plan-fingerprint", plan.fingerprint], pkg.kit);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  const written = await readConfig(h.liveConfig);
  assert.equal(Object.hasOwn(written.live, "kitCommit"), false);
  assert.deepEqual([written.live.kitRoot, written.live.kitVersion, written.live.kitDigest], [pkg.kit, pkg.version, pkg.digest]);
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig], pkg.kit)).json.ok, true);
  failed(await h.cli(["doctor", "--pilot", h.liveConfig], h.kit), "DEVTWIN_GATE_REQUIRED", "live.kitRoot");
});
// U46: the global command forwards live init --kit to the named kit, which then checks that it is that kit.
test("live init --kit runs only from the package kit it names", async (t) => {
  const h = await liveHome(t);
  const a = await pkgKit(h, "0.1.0-alpha.1"), b = await pkgKit(h, "0.1.0-alpha.2");
  const args = ["live", "init", "--pilot", h.liveConfig, "--agent", "claude"];
  const own = await h.cli([...args, "--kit", a.arg], a.kit);
  assert.equal(own.json.ok, true, JSON.stringify(own.json.error));
  assert.equal(own.json.result.fingerprint, (await h.cli(args, a.kit)).json.result.fingerprint, "--kit does not change the plan");
  for (const [kit, from] of [[b.arg, a.kit], [a.arg, h.kit], [a.version + "+" + b.digest, a.kit]]) {
    const r = await h.cli([...args, "--kit", kit], from);
    failed(r, "DEVTWIN_GATE_REQUIRED", "kit");
    assert.equal(r.json.error.details.reason, "running-kit");
  }
  failed(await h.cli([...args, "--kit", "0.1.0+short"], a.kit), "DEVTWIN_INVALID_INPUT", "kit");
  const applied = await h.cli([...args, "--kit", a.arg, "--apply", "--plan-fingerprint", own.json.result.fingerprint], a.kit);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  assert.equal((await readConfig(h.liveConfig)).live.kitDigest, a.digest);
});
test("live set-kit from a Git kit to a package kit shows both identities in the owner dialog, and a denied dialog changes nothing", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const pkg = await pkgKit(h);
  const args = ["live", "set-kit", "--pilot", h.liveConfig, "--kit", pkg.arg];
  const preview = await h.cli(args, pkg.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.deepEqual(preview.json.result.kit, { from: { kitRoot: h.kit, kitCommit: h.commit, kitId: "git:" + h.commit }, to: { kitRoot: pkg.kit, kitVersion: pkg.version, kitDigest: pkg.digest, kitId: pkg.kitId } });
  const text = await readFile(h.liveConfig, "utf8"), before = await treeSnapshot(h.home);
  h.setAnswer("denied");
  failed(await h.cli([...args, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], pkg.kit), "DEVTWIN_OWNER_DENIED");
  assert.equal(await readFile(h.liveConfig, "utf8"), text);
  assert.equal(await treeSnapshot(h.home), before, "a denied dialog writes nothing");
  assert.equal((await loadPilot(h.liveConfig, h.context)).digest, applied.digest);
  assert.equal(h.dialogs.length, 1);
  const { title, body } = h.dialogs[0];
  assert.equal(title, "devtwin: Change the kit devtwin runs");
  for (const part of ["git:" + h.commit.slice(0, 12), "git:" + h.commit, h.kit, "npm:" + pkg.version + "+sha256:" + pkg.digest.slice(0, 12), pkg.kitId, pkg.kit]) assert.ok(body.includes(part), part);
  assert.match(body, new RegExp("Compare the digest with the one published in the GitHub release for " + pkg.version.replace(/\./g, "\\.")));
  // A wrong fingerprint is refused before any dialog.
  failed(await h.cli([...args, "--apply", "--plan-fingerprint", "sha256:" + "1".repeat(64)], pkg.kit), "DEVTWIN_PLAN_MISMATCH");
  assert.equal(h.dialogs.length, 1);
  h.setAnswer("approved");
  const done = await h.cli([...args, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], pkg.kit);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  assert.equal(h.dialogs.length, 2);
  const written = await readConfig(h.liveConfig);
  assert.deepEqual([written.live.kitRoot, written.live.kitVersion, written.live.kitDigest, Object.hasOwn(written.live, "kitCommit"), written.live.configId], [pkg.kit, pkg.version, pkg.digest, false, applied.configId]);
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig], pkg.kit)).json.ok, true);
  failed(await h.cli(["doctor", "--pilot", h.liveConfig], h.kit), "DEVTWIN_GATE_REQUIRED", "live.kitRoot");
  // Back to the Git kit: the package fields go and the dialog has no release note.
  const back = ["live", "set-kit", "--pilot", h.liveConfig, "--commit", h.commit];
  const undo = await h.cli(back);
  assert.equal(undo.json.ok, true, JSON.stringify(undo.json.error));
  assert.equal((await h.cli([...back, "--apply", "--plan-fingerprint", undo.json.result.fingerprint])).json.ok, true);
  const reverted = await readConfig(h.liveConfig);
  assert.deepEqual([reverted.live.kitRoot, reverted.live.kitCommit, Object.hasOwn(reverted.live, "kitVersion"), Object.hasOwn(reverted.live, "kitDigest")], [h.kit, h.commit, false, false]);
  assert.doesNotMatch(h.dialogs[2].body, /GitHub release/);
});
test("live set-kit run from a kit other than the one it names is refused", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const a = await pkgKit(h, "0.1.0-alpha.1"), b = await pkgKit(h, "0.1.0-alpha.2");
  const text = await readFile(h.liveConfig, "utf8");
  const setKit = (pin, kit) => h.cli(["live", "set-kit", "--pilot", h.liveConfig, ...pin], kit);
  const gated = (r, field, reason) => { failed(r, "DEVTWIN_GATE_REQUIRED", field); assert.equal(r.json.error.details.reason, reason); };
  gated(await setKit(["--kit", a.arg], h.kit), "live.kitRoot", "outside-kits");
  gated(await setKit(["--kit", b.arg], a.kit), "live.kitVersion", "version");
  gated(await setKit(["--kit", a.version + "+" + b.digest], a.kit), "live.kitDigest", "digest");
  gated(await setKit(["--commit", h.commit], a.kit), "live.kitRoot", "not-top-level");
  for (const [pin, kit] of [[["--kit", b.arg], a.kit], [["--commit", h.commit], a.kit]]) {
    failed(await h.cli(["live", "set-kit", "--pilot", h.liveConfig, ...pin, "--apply", "--plan-fingerprint", "sha256:" + "1".repeat(64)], kit), "DEVTWIN_GATE_REQUIRED");
  }
  assert.equal(await readFile(h.liveConfig, "utf8"), text);
  assert.deepEqual(h.dialogs, []);
});
test("live set-kit takes exactly one of --commit and --kit, and --kit needs a version and the full digest", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const pkg = await pkgKit(h);
  const run = (pin, extra = []) => h.cli(["live", "set-kit", "--pilot", h.liveConfig, ...pin, ...extra], pkg.kit);
  for (const extra of [[], ["--apply", "--plan-fingerprint", "sha256:" + "1".repeat(64)]]) {
    failed(await run([], extra), "DEVTWIN_INVALID_INPUT", "kit");
    failed(await run(["--commit", h.commit, "--kit", pkg.arg], extra), "DEVTWIN_INVALID_INPUT", "kit");
    for (const bad of [pkg.version + "+" + pkg.digest.slice(0, 12), pkg.version, pkg.digest, "v" + pkg.arg, pkg.version + "+" + pkg.digest.toUpperCase(), pkg.version + "+sha256:" + pkg.digest, pkg.version + "+" + pkg.digest + "+x", "latest+" + pkg.digest]) {
      failed(await run(["--kit", bad], extra), "DEVTWIN_INVALID_INPUT", "kit");
    }
  }
  const preview = await run(["--kit", pkg.arg]);
  assert.equal((await run(["--kit", pkg.arg], ["--apply", "--plan-fingerprint", preview.json.result.fingerprint])).json.ok, true);
  // The kit already pinned is no change.
  failed(await run(["--kit", pkg.arg]), "DEVTWIN_INVALID_INPUT", "kit");
  assert.equal(h.dialogs.length, 1);
});
