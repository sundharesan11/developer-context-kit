import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, symlink, writeFile, access, realpath } from "node:fs/promises";
import { sandbox, makePilot, makeRepo, fixtureGit, treeSnapshot, runCli } from "./helpers.mjs";
import { isWithin } from "../src/storage/fsx.mjs";
import { loadPilot, rootsFromPilot, assertWritable } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { operationIdFor, recordIdFor } from "../src/identity/ids.mjs";
import { digest, canonicalJson } from "../src/storage/canonical.mjs";
import { locateWorktree, stripCredentials } from "../src/identity/git.mjs";
import { scanRepository } from "../src/onboarding/scan.mjs";
import { onboardRequest, finalizePlan, assertFingerprint, checkPreconditions } from "../src/storage/plan.mjs";
test("F1 pilot fence rejects dot-prefixed, symlink and case aliases of protected homes", async (t) => {
  const p = await makePilot(t);
  assert.equal(isWithin("/a/..b", "/a"), true);
  assert.equal(isWithin("/a/../b", "/a"), false);
  await mkdir(join(p.fakeHome, ".claude"));
  await assert.rejects(loadPilot(await p.with({ pilotRoot: join(p.fakeHome, ".claude", "..pilot") }), { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.protected === "real-claude-home");
  const target = join(p.sandbox, "real-claude"); await mkdir(target);
  const symlinkHome = join(p.sandbox, "home-link"); await mkdir(symlinkHome);
  await symlink(target, join(symlinkHome, ".claude"));
  await assert.rejects(loadPilot(await p.with({ pilotRoot: join(target, "pilot") }), { home: symlinkHome, kitRoot: "/nonexistent-kit", env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.protected === "real-claude-home");
  const context = { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} };
  const protectedClaude = (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.protected === "real-claude-home";
  await assert.rejects(loadPilot(await p.with({ pilotRoot: join(p.fakeHome, ".claude") }), context), protectedClaude);
  const upperHome = join(p.fakeHome, ".CLAUDE"), upperRoot = join(upperHome, "p");
  const casePilot = await p.with({
    pilotRoot: upperRoot,
    configRoot: join(upperRoot, "config"), dataRoot: join(upperRoot, "data"),
    stateRoot: join(upperRoot, "state"), inputsRoot: join(upperRoot, "inputs"),
    agentHomes: [join(upperRoot, "homes/claude"), join(upperRoot, "homes/codex")],
    repos: [join(upperRoot, "repos/atlas"), join(upperRoot, "repos/beacon")]
  });
  // Darwin conservatively folds case; a distinct spelling on Linux is not an alias.
  if (process.platform === "darwin") {
    await assert.rejects(loadPilot(casePilot, context), protectedClaude);
  } else {
    await assert.rejects(access(upperHome), { code: "ENOENT" }, "fixture requires a case-sensitive filesystem");
    const loaded = await loadPilot(casePilot, context);
    assert.equal(loaded.pilotRoot, upperRoot);
    for (const path of [loaded.configRoot, loaded.dataRoot, loaded.stateRoot, loaded.inputsRoot, ...loaded.agentHomes, ...loaded.repos]) {
      assert.ok(isWithin(path, upperRoot) && !isWithin(path, join(p.fakeHome, ".claude")), path);
    }
    await assert.rejects(access(upperHome), { code: "ENOENT" }, "validation must not create directories");
  }
});
test("F2 operation ids use canonical digest and reject missing inputs", () => {
  const x = { scope: "acme", project: "acme.atlas", requestId: "req_fixture01" };
  assert.equal(operationIdFor(x), "op_" + digest(x).slice(7, 31));
  assert.throws(() => operationIdFor({ ...x, requestId: undefined }), { code: "DEVTWIN_INVALID_ID" });
  assert.throws(() => recordIdFor({ ...x, scope: undefined }), { code: "DEVTWIN_INVALID_ID" });
});
test("F3 Git probe refuses configured clean filter without executing it", async (t) => {
  const dir = await sandbox(t), canary = join(dir, "RAN");
  const repo = await makeRepo(join(dir, "r"), { ".gitattributes": "* filter=canary\n", "a.txt": "a" });
  await fixtureGit(repo, ["config", "filter.canary.clean", "touch " + canary]);
  await writeFile(join(repo, "a.txt"), "b");
  const before = await treeSnapshot(repo);
  await assert.rejects(locateWorktree(repo), { code: "DEVTWIN_PATH_UNSAFE" });
  await assert.rejects(access(canary));
  assert.equal(await treeSnapshot(repo), before);
});
test("F4 and F11 pilot rejects unknown keys and malformed shapes at load", async (t) => {
  const p = await makePilot(t);
  await assert.rejects(loadPilot(await p.with({ note: "extra" }), { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "note");
  for (const patch of [{ pilotRoot: null }, { configRoot: 17 }, { agentHomes: "x" }, { repos: [17] }]) {
    await assert.rejects(loadPilot(await p.with(patch), { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), { code: "DEVTWIN_GATE_REQUIRED" });
  }
  const nullPath = join(p.sandbox, "null-pilot.json"); await writeFile(nullPath, "null");
  await assert.rejects(loadPilot(nullPath, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), { code: "DEVTWIN_GATE_REQUIRED" });
});
test("F5 canonical JSON rejects object classes and cycles", () => {
  for (const value of [new Date(0), new Map(), new Set(), Buffer.from("x")]) assert.throws(() => canonicalJson({ value }), { code: "DEVTWIN_INVALID_INPUT" });
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "DEVTWIN_INVALID_INPUT" });
});
test("F6 malformed URL never retains remote userinfo", () => {
  const remote = "https://" + ["u", "p"].join(":") + "@bad host/x";
  assert.ok(!stripCredentials(remote).includes("u:p"));
});
test("F7 and F8 bare Git is unsafe and linked subdirectories resolve the common directory", async (t) => {
  const dir = await sandbox(t), bare = join(dir, "bare");
  await mkdir(bare); await fixtureGit(bare, ["init", "--bare", "-q"]);
  await assert.rejects(locateWorktree(bare), { code: "DEVTWIN_PATH_UNSAFE" });
  const repo = await makeRepo(join(dir, "r"), { "a": "a" });
  await assert.rejects(locateWorktree(join(repo, ".git")), { code: "DEVTWIN_PATH_UNSAFE" });
  await fixtureGit(repo, ["worktree", "add", "-q", join(dir, "wt"), "-b", "feature"]);
  await mkdir(join(dir, "wt", "sub"));
  const loc = await locateWorktree(join(dir, "wt", "sub"));
  assert.equal(loc.commonDir, await realpath(join(repo, ".git")));
});
test("F9 onboarding rejects an enclosing repository root", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "r"), { "a": "a" });
  await mkdir(join(repo, "nested"));
  await assert.rejects(scanRepository({ repo: join(repo, "nested"), approvedDocs: [] }), { code: "DEVTWIN_INVALID_INPUT" });
});
test("F10 CLI accepts equals-form pilot flag", async (t) => {
  const p = await makePilot(t);
  const result = await runCli(["doctor", "--pilot=" + p.path]);
  assert.equal(result.code, 0);
});
test("F12 ensureRoots requires pilot before creating roots", async (t) => {
  const p = await makePilot(t);
  const bare = { configRoot: p.configRoot, dataRoot: p.dataRoot, stateRoot: p.stateRoot };
  assert.throws(() => ensureRoots(bare), { code: "DEVTWIN_GATE_REQUIRED" });
  await assert.rejects(access(p.configRoot));
});
test("F13 request and fingerprint helpers reject malformed or changed content", () => {
  const x = { scope: "acme", project: "acme.atlas", repo: "/p/repos/atlas", approvedDocs: ["a.md", "a.md"], expectedRemotes: [], environments: [], actorRefs: [], accept: [] };
  assert.deepEqual(onboardRequest(x).approvedDocs, ["a.md"]);
  assert.equal(onboardRequest(x).accept, "none");
  assert.throws(() => onboardRequest({ ...x, approvedDocs: "a.md" }), { code: "DEVTWIN_INVALID_INPUT" });
  const plan = finalizePlan({ kind: "x", writes: [1] });
  plan.writes.push(2);
  assert.throws(() => assertFingerprint(plan, plan.fingerprint), { code: "DEVTWIN_PLAN_MISMATCH" });
});
