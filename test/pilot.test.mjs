import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, symlink, readdir, chmod } from "node:fs/promises";
import { makePilot, runCli } from "./helpers.mjs";
import { loadPilot, assertWritable, pilotDigest } from "../src/config/pilot.mjs";
import { digest as digestOf } from "../src/storage/canonical.mjs";
import { toJson } from "../src/errors.mjs";
import { withPilotLock, registryLockPath, scopeLockPath } from "../src/storage/lock.mjs";
import { listCommands, isRootFree } from "../src/cli.mjs";
test("pilot fence refuses real agent homes, configured homes, default roots and forbidden overlap", async (t) => {
  const p = await makePilot(t);
  const opts = { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} };
  const codexHome = join(p.sandbox, "configured-codex");
  await mkdir(codexHome);
  for (const bad of [join(p.fakeHome, ".claude"), join(p.fakeHome, ".gemini"), join(p.fakeHome, ".cursor"), join(p.fakeHome, ".commandcode"), join(p.fakeHome, ".local/share/devctx"), p.forbidden[0], p.fakeHome, "/"]) {
    await assert.rejects(loadPilot(await p.with({ pilotRoot: bad }), opts), (e) => e.code === "DEVCTX_GATE_REQUIRED" && e.details.field === "pilotRoot");
  }
  const err = await loadPilot(await p.with({ pilotRoot: codexHome }), { ...opts, env: { CODEX_HOME: codexHome } }).catch((e) => e);
  assert.equal(err.code, "DEVCTX_GATE_REQUIRED");
  assert.equal(err.details.protected, "CODEX_HOME");
  assert.ok(!JSON.stringify(toJson(err)).includes(codexHome));
  await assert.rejects(loadPilot(await p.with({ forbidden: [join(p.pilot.pilotRoot, "repos")] }), opts), { code: "DEVCTX_GATE_REQUIRED" });
  await assert.rejects(loadPilot(await p.with({ dataRoot: p.configRoot }), opts), { code: "DEVCTX_GATE_REQUIRED" });
  await assert.rejects(loadPilot(await p.with({ configRoot: join(p.sandbox, "outside-config") }), opts), { code: "DEVCTX_GATE_REQUIRED" });
});
test("assertWritable rechecks the fence at write time; escaped member is refused", async (t) => {
  const p = await makePilot(t);
  await assert.rejects(Promise.resolve().then(() => assertWritable({ configRoot: p.configRoot, dataRoot: p.dataRoot, stateRoot: p.stateRoot }, [p.configRoot])), { code: "DEVCTX_GATE_REQUIRED" });
  await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, [join(p.sandbox, "outside-forbidden", "x")])), { code: "DEVCTX_GATE_REQUIRED" });
  const outside = join(p.sandbox, "escape-target");
  await mkdir(outside);
  await symlink(outside, p.dataRoot);
  await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, [join(p.dataRoot, "scopes")])), (e) => ["DEVCTX_GATE_REQUIRED", "DEVCTX_PATH_UNSAFE"].includes(e.code));
  assert.deepEqual(await readdir(outside), []);
});
test("assertWritable refuses agent-home destinations without an explicit installer target", async (t) => {
  const p = await makePilot(t), [home] = p.agentHomes, inside = join(home, ".claude/skills/x");
  for (const destinations of [[home], [inside], [p.dataRoot, inside]]) {
    await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, destinations)), (e) => e.code === "DEVCTX_GATE_REQUIRED" && e.details.field === "destination");
    await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, destinations, {})), { code: "DEVCTX_GATE_REQUIRED" });
  }
  let called = false;
  for (const lock of [registryLockPath(p.roots), scopeLockPath(p.roots, "acme")]) await assert.rejects(withPilotLock(p.roots, lock, { kind: "record-add" }, async () => { called = true; }, { destinations: [p.dataRoot, inside] }), { code: "DEVCTX_GATE_REQUIRED" });
  assert.equal(called, false);
  assert.doesNotThrow(() => assertWritable(p.roots, [p.configRoot, join(p.dataRoot, "exports/handoffs/x"), join(p.stateRoot, "runs/run_x/journal.json")]));
});
test("assertWritable installer target permits only its own listed agent home", async (t) => {
  const p = await makePilot(t), [a, b] = p.agentHomes;
  assert.doesNotThrow(() => assertWritable(p.roots, [join(a, ".claude/skills/x"), join(p.stateRoot, "runs/run_x/journal.json"), join(p.stateRoot, "skill-installs/consumed/x.json")], { targetHome: a }));
  await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, [join(b, ".claude/skills/x")], { targetHome: a })), (e) => e.code === "DEVCTX_GATE_REQUIRED" && e.details.field === "destination");
  for (const targetHome of [join(a, ".claude"), join(p.pilot.pilotRoot, "homes/other"), p.fakeHome, p.dataRoot, a + "/", null, 17]) await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, [join(a, "x")], { targetHome })), { code: "DEVCTX_GATE_REQUIRED" });
  let called = false;
  await assert.rejects(withPilotLock(p.roots, join(p.stateRoot, "locks/install.lock"), { kind: "install" }, async () => { called = true; }, { destinations: [b], targetHome: a }), { code: "DEVCTX_GATE_REQUIRED" });
  assert.equal(called, false);
  assert.equal(await withPilotLock(p.roots, join(p.stateRoot, "locks/install.lock"), { kind: "install" }, async () => "ok", { destinations: [a], targetHome: a }), "ok");
});
test("disposable pilot digest and fence are unchanged by the optional live block", async (t) => {
  const p = await makePilot(t);
  const { path, digest: value, _context, warnings, ...raw } = p.pilot;
  assert.equal(value, digestOf(Object.fromEntries(["schemaVersion", "pilotRoot", "configRoot", "dataRoot", "stateRoot", "inputsRoot", "agentHomes", "repos", "forbidden"].map((key) => [key, raw[key]]))));
  assert.equal(pilotDigest(raw), value);
  assert.deepEqual(warnings, []);
  assert.equal(raw.live, undefined);
  const nullLive = await p.with({ live: null });
  await assert.rejects(loadPilot(nullLive, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), { code: "DEVCTX_PATH_UNSAFE" });
  await chmod(nullLive, 0o600);
  await assert.rejects(loadPilot(nullLive, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }), (e) => e.code === "DEVCTX_GATE_REQUIRED" && e.details.field === "live");
  await assert.rejects(Promise.resolve().then(() => assertWritable(p.roots, [join(p.agentHomes[0], ".claude/skills/devctx-x")], { targetHome: join(p.agentHomes[0], ".claude/skills") })), (e) => e.code === "DEVCTX_GATE_REQUIRED" && e.details.field === "targetHome");
});
test("CLI: only version, help, and skill source reads are root-free; every other route requires --pilot", async () => {
  const routes = listCommands();
  assert.deepEqual(routes.filter((r) => isRootFree(r)).sort(), ["help", "skill-sources catalog", "skill-sources check", "skill-sources preview", "version"]);
  for (const route of routes.filter((r) => !isRootFree(r))) {
    const { code, json } = await runCli(route.split(" "));
    assert.equal(code, 1, route);
    assert.equal(json.error.code, "DEVCTX_GATE_REQUIRED", route);
  }
});
