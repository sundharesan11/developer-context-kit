import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, chmod, stat, readdir, rm } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, runCli, treeSnapshot } from "./helpers.mjs";
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
  const sb = await sandbox(t), home = join(sb, "home"), devctx = join(home, ".devctx");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devctx);
  await chmod(devctx, 0o700);
  const { kit, commit } = await pinnedKit(join(devctx, "kit"));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const profile = join(devctx, "live.json"), store = join(devctx, "store");
  const cli = (args, kitRoot = kit) => runCli(args, { home, env: {}, kitRoot });
  const context = { home, env: {}, kitRoot: kit };
  const init = async (extra = ["--agent", "claude", "--agent", "codex", "--repo", repo]) => {
    const preview = await cli(["live", "init", "--pilot", profile, ...extra]);
    assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
    const applied = await cli(["live", "init", "--pilot", profile, ...extra, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
    assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
    return { preview: preview.json.result, applied: applied.json.result };
  };
  return { sb, home, devctx, kit, commit, repo, profile, store, cli, context, init };
}
const profileOf = async (path) => JSON.parse(await readFile(path, "utf8"));
const failed = (r, code, field) => {
  assert.equal(r.json.ok, false, JSON.stringify(r.json));
  assert.equal(r.json.error.code, code, JSON.stringify(r.json.error));
  if (field !== undefined) assert.equal(r.json.error.details.field, field, JSON.stringify(r.json.error));
};
test("live init preview writes nothing, and apply creates private folders, the profile and the approved digest", async (t) => {
  const h = await liveHome(t);
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "init", "--pilot", h.profile, "--agent", "codex", "--agent", "claude", "--repo", h.repo]);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  const plan = preview.json.result;
  assert.equal(plan.preview, true);
  assert.match(plan.fingerprint, /^sha256:/);
  assert.deepEqual(plan.layout, { profile: h.profile, pilotRoot: h.store, configRoot: join(h.store, "config"), dataRoot: join(h.store, "data"), stateRoot: join(h.store, "state"), inputsRoot: join(h.store, "inputs"), kitRoot: h.kit });
  assert.deepEqual(plan.profile.live, { profileId: null, home: h.home, skillDirs: { claude: join(h.home, ".claude/skills"), codex: join(h.home, ".agents/skills") }, kitRoot: h.kit, kitCommit: h.commit });
  assert.deepEqual(plan.profile.repos, [h.repo]);
  assert.deepEqual(plan.profile.agentHomes, []);
  const applied = await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude", "--agent", "codex", "--repo", h.repo, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  const written = await profileOf(h.profile);
  assert.match(written.live.profileId, /^prof_[0-9a-f]{16}$/);
  assert.equal(applied.json.result.profileId, written.live.profileId);
  assert.deepEqual({ ...written, live: { ...written.live, profileId: null } }, plan.profile);
  assert.equal(await mode(h.profile), 0o600);
  assert.equal(await mode(h.devctx), 0o700);
  for (const dir of ["", "config", "data", "state", "inputs"]) assert.equal(await mode(join(h.store, dir)), 0o700, dir);
  const pilot = await loadPilot(h.profile, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: written.live.profileId, digest: pilot.digest });
  assert.equal(applied.json.result.digest, pilot.digest);
  const doctor = await h.cli(["doctor", "--pilot", h.profile]);
  assert.equal(doctor.json.ok, true, JSON.stringify(doctor.json.error));
});
test("live init refuses missing or stale fingerprints, unknown agents and a running kit that is not pinned", async (t) => {
  const h = await liveHome(t);
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]);
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude", "--apply"]), "DEVCTX_PLAN_REQUIRED");
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "codex", "--apply", "--plan-fingerprint", preview.json.result.fingerprint]), "DEVCTX_PLAN_MISMATCH");
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude", "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)]), "DEVCTX_PLAN_MISMATCH");
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "gemini"]), "DEVCTX_INVALID_INPUT", "agent");
  failed(await h.cli(["live", "init", "--pilot", h.profile]), "DEVCTX_INVALID_INPUT", "agent");
  failed(await h.cli(["live", "init", "--pilot", "relative/live.json", "--agent", "claude"]), "DEVCTX_GATE_REQUIRED", "pilot");
  assert.equal((await h.cli(["live", "init", "--pilot", h.profile, "--pilot", h.profile, "--agent", "claude"])).json.error.code, "DEVCTX_USAGE");
  assert.equal((await h.cli(["live", "init", "--pilot", h.profile, "--config-root", h.store, "--agent", "claude"])).json.error.code, "DEVCTX_USAGE");
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"], REPO_ROOT), "DEVCTX_GATE_REQUIRED");
  assert.equal(await treeSnapshot(h.home), before);
  await mkdir(join(h.kit, "src"));
  await writeFile(join(h.kit, "src/dirty.mjs"), "x");
  const dirty = await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]);
  failed(dirty, "DEVCTX_GATE_REQUIRED", "live.kitCommit");
  assert.equal(dirty.json.error.details.reason, "dirty");
  assert.deepEqual(await readdir(h.devctx), ["kit"]);
});
test("live init refuses a profile folder that is not private and never changes its mode", async (t) => {
  const h = await liveHome(t);
  for (const bits of [0o755, 0o750]) {
    await chmod(h.devctx, bits);
    failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]), "DEVCTX_PATH_UNSAFE", "profileDir");
    assert.equal(await mode(h.devctx), bits);
  }
  failed(await h.cli(["live", "init", "--pilot", join(h.sb, "missing/live.json"), "--agent", "claude"]), "DEVCTX_PATH_UNSAFE", "profileDir");
  assert.deepEqual(await readdir(h.devctx), ["kit"]);
});
test("live init refuses an existing non-empty store without a profile and an existing profile", async (t) => {
  const h = await liveHome(t);
  await mkdir(join(h.store, "config"), { recursive: true, mode: 0o700 });
  await chmod(h.store, 0o700);
  await writeFile(join(h.store, "config/user.json"), "{}", { mode: 0o600 });
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]), "DEVCTX_CONFLICT", "pilotRoot");
  await rm(join(h.store, "config"), { recursive: true });
  const { applied } = await h.init(["--agent", "claude"]);
  const again = await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]);
  failed(again, "DEVCTX_CONFLICT", "pilot");
  assert.equal((await profileOf(h.profile)).live.profileId, applied.profileId);
});
test("live add-repo appends one repository through preview and approval and keeps the profile ID", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const beacon = await makeRepo(join(h.sb, "work/beacon"), { "README.md": "# Beacon\n" });
  const comet = await makeRepo(join(h.sb, "work/comet"), { "README.md": "# Comet\n" });
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", beacon]);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  assert.equal(preview.json.result.repo, beacon);
  assert.deepEqual(preview.json.result.repos, { from: [h.repo], to: [h.repo, beacon].sort() });
  assert.equal(preview.json.result.profileId, applied.profileId);
  failed(await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", comet, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]), "DEVCTX_PLAN_MISMATCH");
  failed(await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", beacon, "--apply"]), "DEVCTX_PLAN_REQUIRED");
  assert.equal(await treeSnapshot(h.home), before);
  const done = await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", beacon, "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  const written = await profileOf(h.profile);
  assert.deepEqual(written.repos, [h.repo, beacon].sort());
  assert.equal(written.live.profileId, applied.profileId);
  assert.equal(await mode(h.profile), 0o600);
  const pilot = await loadPilot(h.profile, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest });
  assert.notEqual(pilot.digest, applied.digest);
  failed(await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", beacon]), "DEVCTX_INVALID_INPUT", "repo");
  failed(await h.cli(["live", "add-repo", "--pilot", h.profile]), "DEVCTX_INVALID_INPUT", "repo");
  // A stale preview made before another approved change no longer applies.
  const stale = await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", comet]);
  const delta = await makeRepo(join(h.sb, "work/delta"), { "README.md": "# Delta\n" });
  const other = await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", delta]);
  assert.equal((await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", delta, "--apply", "--plan-fingerprint", other.json.result.fingerprint])).json.ok, true);
  failed(await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", comet, "--apply", "--plan-fingerprint", stale.json.result.fingerprint]), "DEVCTX_PLAN_MISMATCH");
});
test("live set-kit from a clean detached new kit at the requested commit rewrites the kit and keeps the profile ID", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const next = await pinnedKit(join(h.devctx, "kit-next"), { "README.md": "kit next\n" });
  const before = await treeSnapshot(h.home);
  const preview = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  assert.equal(await treeSnapshot(h.home), before);
  assert.deepEqual(preview.json.result.kit, { from: { kitRoot: h.kit, kitCommit: h.commit }, to: { kitRoot: next.kit, kitCommit: next.commit } });
  assert.equal(preview.json.result.profileId, applied.profileId);
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit, "--apply", "--plan-fingerprint", "sha256:" + "1".repeat(64)], next.kit), "DEVCTX_PLAN_MISMATCH");
  const done = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], next.kit);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  const written = await profileOf(h.profile);
  assert.deepEqual([written.live.kitRoot, written.live.kitCommit, written.live.profileId], [next.kit, next.commit, applied.profileId]);
  const pilot = await loadPilot(h.profile, { ...h.context, kitRoot: next.kit });
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest });
  const oldKit = await h.cli(["doctor", "--pilot", h.profile], h.kit);
  failed(oldKit, "DEVCTX_GATE_REQUIRED", "live.kitRoot");
  assert.equal((await h.cli(["doctor", "--pilot", h.profile], next.kit)).json.ok, true);
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit), "DEVCTX_INVALID_INPUT", "commit");
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", "main"], next.kit), "DEVCTX_INVALID_INPUT", "commit");
});
test("live set-kit from a kit with local changes or at a commit other than the requested one is refused", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const next = await pinnedKit(join(h.devctx, "kit-next"), { "README.md": "kit next\n" });
  await writeFile(join(next.kit, "README.md"), "changed\n");
  const dirty = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit);
  failed(dirty, "DEVCTX_GATE_REQUIRED", "live.kitCommit");
  assert.equal(dirty.json.error.details.reason, "dirty");
  await fixtureGit(next.kit, ["checkout", "-q", "--", "README.md"]);
  const wrong = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", h.commit], next.kit);
  failed(wrong, "DEVCTX_GATE_REQUIRED", "live.kitCommit");
  assert.equal(wrong.json.error.details.reason, "commit");
  await fixtureGit(next.kit, ["checkout", "-q", "main"]);
  const attached = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit);
  failed(attached, "DEVCTX_GATE_REQUIRED", "live.kitCommit");
  assert.equal(attached.json.error.details.reason, "attached");
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], h.kit), "DEVCTX_GATE_REQUIRED", "live.kitCommit");
  assert.equal((await profileOf(h.profile)).live.kitRoot, h.kit);
});
test("live profile commands refuse a repository inside the store or the kit", async (t) => {
  const h = await liveHome(t);
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude", "--repo", join(h.store, "repos/x")]), "DEVCTX_GATE_REQUIRED", "repos");
  failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude", "--repo", join(h.kit, "inner")]), "DEVCTX_GATE_REQUIRED", "repos");
  assert.deepEqual(await readdir(h.devctx), ["kit"]);
  await h.init(["--agent", "claude"]);
  for (const repo of [join(h.store, "repos/x"), join(h.kit, "inner"), h.store]) failed(await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", repo]), "DEVCTX_GATE_REQUIRED", "repos");
  const next = await pinnedKit(join(h.repo, "kit"));
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit), "DEVCTX_GATE_REQUIRED");
});
test("live profile edited by hand after approval is refused by the next profile command", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const beacon = await makeRepo(join(h.sb, "work/beacon"), { "README.md": "# Beacon\n" });
  const edited = await profileOf(h.profile);
  await writeFile(h.profile, JSON.stringify({ ...edited, repos: [...edited.repos, beacon].sort() }), { mode: 0o600 });
  for (const args of [["live", "add-repo", "--pilot", h.profile, "--repo", beacon], ["doctor", "--pilot", h.profile]]) {
    const r = await h.cli(args);
    failed(r, "DEVCTX_GATE_REQUIRED", "live.approval");
    assert.equal(r.json.error.details.reason, "changed");
  }
  const next = await pinnedKit(join(h.devctx, "kit-next"));
  failed(await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit), "DEVCTX_GATE_REQUIRED", "live.approval");
});
test("live init leaves the store ready for init and scope add through the CLI", async (t) => {
  const h = await liveHome(t);
  await h.init();
  const scope = await h.cli(["scope", "add", "--pilot", h.profile, "--scope", "acme", "--apply"]);
  assert.equal(scope.json.ok, true, JSON.stringify(scope.json.error));
  assert.deepEqual(scope.json.result, { created: true, scope: "acme" });
  const init = await h.cli(["init", "--pilot", h.profile, "--actor", "email:owner@example.com", "--apply"]);
  assert.equal(init.json.ok, true, JSON.stringify(init.json.error));
  assert.deepEqual(init.json.result, { created: true });
  assert.equal(await mode(join(h.store, "config/scopes/acme.json")), 0o600);
  assert.equal(await mode(join(h.store, "config/user.json")), 0o600);
});
test("live init from a pinned kit clone through bin/devctx.mjs leaves a store that scope add uses", async (t) => {
  const head = (await fixtureGit(REPO_ROOT, ["rev-parse", "HEAD"])).trim();
  const sb = await sandbox(t), home = join(sb, "home"), devctx = join(home, ".devctx"), kit = join(devctx, "kit");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devctx);
  await chmod(devctx, 0o700);
  await fixtureGit(devctx, ["clone", "-q", "--no-hardlinks", REPO_ROOT, kit]);
  await fixtureGit(kit, ["checkout", "-q", "--detach", head]);
  const profile = join(devctx, "live.json");
  const run = (args) => {
    const r = spawnSync(process.execPath, [join(kit, "bin/devctx.mjs"), ...args], { cwd: sb, encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
    return JSON.parse(r.stdout);
  };
  const preview = run(["live", "init", "--pilot", profile, "--agent", "claude", "--agent", "codex"]);
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(preview.result.profile.live.kitCommit, head);
  const applied = run(["live", "init", "--pilot", profile, "--agent", "claude", "--agent", "codex", "--apply", "--plan-fingerprint", preview.result.fingerprint]);
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  const scope = run(["scope", "add", "--pilot", profile, "--scope", "acme", "--apply"]);
  assert.equal(scope.ok, true, JSON.stringify(scope.error));
  assert.equal(scope.result.created, true);
  assert.equal(await mode(join(devctx, "store/config/scopes/acme.json")), 0o600);
});
const crash = () => { throw new Error("injected crash"); };
test("live init crash after creating the store folders or recording the approval leaves a store that a retry initializes", async (t) => {
  for (const fault of ["afterRoots", "afterApproval"]) {
    const h = await liveHome(t), args = ["--agent", "claude", "--repo", h.repo];
    const preview = await h.cli(["live", "init", "--pilot", h.profile, ...args]);
    const input = { profilePath: h.profile, agents: ["claude"], repos: [h.repo], fingerprint: preview.json.result.fingerprint };
    await assert.rejects(applyLiveInit(input, h.context, { faults: { [fault]: crash } }), /injected crash/, fault);
    assert.deepEqual((await readdir(h.devctx)).sort(), ["kit", "store"], fault);
    assert.deepEqual((await readdir(h.store)).sort(), ["config", "data", "inputs", "state"], fault);
    assert.deepEqual((await readdir(join(h.store, "state"))).sort(), fault === "afterApproval" ? ["live", "locks"] : ["locks"], fault);
    const { applied } = await h.init(args);
    const pilot = await loadPilot(h.profile, h.context);
    assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest }, fault);
    assert.equal((await h.cli(["doctor", "--pilot", h.profile])).json.ok, true, fault);
  }
});
test("live init accepts a store holding only the empty layout and an orphan approval and refuses anything else", async (t) => {
  const layout = async (h) => {
    for (const rel of ["config", "data", "inputs", "state/locks", "state/live"]) await mkdir(join(h.store, rel), { recursive: true, mode: 0o700 });
    await chmod(h.store, 0o700);
    await writeFile(join(h.store, "state/live/approved-profile.json"), JSON.stringify({ schemaVersion: 1, profileId: "prof_0123456789abcdef", digest: "sha256:" + "0".repeat(64) }) + "\n", { mode: 0o600 });
  };
  for (const extra of ["stray.txt", "config/user.json", "data/x", "inputs/x", "state/other", "state/locks/live.lock", "state/live/other.json"]) {
    const h = await liveHome(t);
    await layout(h);
    await writeFile(join(h.store, extra), "x", { mode: 0o600 });
    failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]), "DEVCTX_CONFLICT", "pilotRoot");
  }
  for (const rel of ["data", "state/live/approved-profile.json"]) {
    const h = await liveHome(t);
    await layout(h);
    await rm(join(h.store, rel), { recursive: true });
    await (rel === "data" ? writeFile(join(h.store, rel), "x", { mode: 0o600 }) : mkdir(join(h.store, rel), { mode: 0o700 }));
    failed(await h.cli(["live", "init", "--pilot", h.profile, "--agent", "claude"]), "DEVCTX_CONFLICT", "pilotRoot");
  }
  const h = await liveHome(t);
  await layout(h);
  const { applied } = await h.init(["--agent", "claude"]);
  const pilot = await loadPilot(h.profile, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest });
});
test("live add-repo or set-kit crash around the profile replace leaves a profile that loads and a change that re-applies", async (t) => {
  const h = await liveHome(t);
  const { applied } = await h.init();
  const [beacon, comet, delta] = await Promise.all(["beacon", "comet", "delta"].map((name) => makeRepo(join(h.sb, "work", name), { "README.md": "# " + name + "\n" })));
  const addRepo = async (repo, faults) => {
    const preview = await h.cli(["live", "add-repo", "--pilot", h.profile, "--repo", repo]);
    assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
    return applyLiveAddRepo({ profilePath: h.profile, repo, fingerprint: preview.json.result.fingerprint }, h.context, { faults });
  };
  const doctorOk = async (kit = h.kit) => { const r = await h.cli(["doctor", "--pilot", h.profile], kit); assert.equal(r.json.ok, true, JSON.stringify(r.json.error)); };
  // Crash after the approval is written and before the profile is replaced: the old profile still loads.
  await assert.rejects(addRepo(beacon, { afterApproval: crash }), /injected crash/);
  assert.deepEqual((await profileOf(h.profile)).repos, [h.repo]);
  await doctorOk();
  const pending = await readApprovedDigest(await loadPilot(h.profile, h.context));
  assert.equal(pending.previousDigest, applied.digest);
  await addRepo(beacon);
  assert.deepEqual((await profileOf(h.profile)).repos, [h.repo, beacon].sort());
  let pilot = await loadPilot(h.profile, h.context);
  assert.equal(pilot.digest, pending.digest);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest });
  const beaconText = await readFile(h.profile, "utf8"), beaconDigest = pilot.digest;
  // Crash after the profile is replaced and before the approval is rewritten: the new profile loads.
  await assert.rejects(addRepo(comet, { afterReplace: crash }), /injected crash/);
  assert.deepEqual((await profileOf(h.profile)).repos, [h.repo, beacon, comet].sort());
  await doctorOk();
  pilot = await loadPilot(h.profile, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest, previousDigest: beaconDigest });
  // The next approved change clears the leftover previous digest.
  await addRepo(delta);
  pilot = await loadPilot(h.profile, h.context);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, profileId: applied.profileId, digest: pilot.digest });
  // set-kit: a crash after the approval leaves the old kit running and the same preview re-applies.
  const next = await pinnedKit(join(h.devctx, "kit-next"), { "README.md": "kit next\n" });
  const preview = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit], next.kit);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json.error));
  await assert.rejects(applyLiveSetKit({ profilePath: h.profile, commit: next.commit, fingerprint: preview.json.result.fingerprint }, { ...h.context, kitRoot: next.kit }, { faults: { afterApproval: crash } }), /injected crash/);
  await doctorOk(h.kit);
  const done = await h.cli(["live", "set-kit", "--pilot", h.profile, "--commit", next.commit, "--apply", "--plan-fingerprint", preview.json.result.fingerprint], next.kit);
  assert.equal(done.json.ok, true, JSON.stringify(done.json.error));
  await doctorOk(next.kit);
  // An earlier profile is no longer approved once a change completes.
  await writeFile(h.profile, beaconText);
  const stale = await h.cli(["doctor", "--pilot", h.profile], h.kit);
  failed(stale, "DEVCTX_GATE_REQUIRED", "live.approval");
  assert.equal(stale.json.error.details.reason, "changed");
});
