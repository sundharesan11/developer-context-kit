import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, symlink, readdir } from "node:fs/promises";
import { makePilot, runCli } from "./helpers.mjs";
import { loadPilot, assertWritable } from "../src/config/pilot.mjs";
import { toJson } from "../src/errors.mjs";
import { listCommands, isRootFree } from "../src/cli.mjs";
test("pilot fence refuses real agent homes, configured homes, default roots and forbidden overlap", async (t) => {
  const p = await makePilot(t);
  const opts = { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} };
  const codexHome = join(p.sandbox, "configured-codex");
  await mkdir(codexHome);
  for (const bad of [join(p.fakeHome, ".claude"), join(p.fakeHome, ".local/share/devctx"), p.forbidden[0], p.fakeHome, "/"]) {
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
test("CLI: only version and help are root-free; every other route refuses without --pilot", async () => {
  const routes = listCommands();
  assert.deepEqual(routes.filter((r) => isRootFree(r)).sort(), ["help", "version"]);
  for (const route of routes.filter((r) => !isRootFree(r))) {
    const { code, json } = await runCli(route.split(" "));
    assert.equal(code, 1, route);
    assert.equal(json.error.code, "DEVCTX_GATE_REQUIRED", route);
  }
});
