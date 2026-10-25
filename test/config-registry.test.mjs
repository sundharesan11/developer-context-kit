import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, stat, readFile, mkdir } from "node:fs/promises";
import { makePilot, initPilot, runCli, now } from "./helpers.mjs";
import { applyInit, applyScopeAdd, parseHub, parsePolicy } from "../src/config/store.mjs";
import { readRegistry, publishRegistry } from "../src/config/registry.mjs";
test("init preview writes nothing; apply creates private layout; idempotent", async (t) => {
  const p = await makePilot(t);
  assert.equal((await runCli(["init", "--pilot", p.path])).json.result.preview, true);
  await assert.rejects(access(p.configRoot));
  await runCli(["init", "--apply", "--pilot", p.path]);
  assert.equal((await stat(join(p.configRoot, "registry.json"))).mode & 0o777, 0o600);
  assert.equal((await runCli(["init", "--apply", "--pilot", p.path])).json.result.created, false);
});
test("registry publish requires the expected generation", async (t) => {
  const { roots } = await initPilot(t);
  const { value } = await readRegistry(roots);
  await publishRegistry(roots, { ...value, generation: 1 }, { expectGeneration: 0 });
  await assert.rejects(publishRegistry(roots, { ...value, generation: 1 }, { expectGeneration: 0 }), { code: "DEVTWIN_STALE_VERSION" });
  assert.equal((await readRegistry(roots)).value.generation, 1);
});
test("mutating library calls refuse roots that are not pilot-bound", async (t) => {
  const p = await makePilot(t);
  const bare = { configRoot: p.configRoot, dataRoot: p.dataRoot, stateRoot: p.stateRoot };
  await assert.rejects(applyInit(bare, { actorRefs: [], preferences: {}, now }), { code: "DEVTWIN_GATE_REQUIRED" });
  await assert.rejects(access(p.configRoot));
  const ip = await initPilot(t);
  await assert.rejects(applyScopeAdd({ configRoot: ip.configRoot, dataRoot: ip.dataRoot, stateRoot: ip.stateRoot }, { scope: "acme", hubs: [], policies: [] }), { code: "DEVTWIN_GATE_REQUIRED" });
  await assert.rejects(access(join(ip.configRoot, "scopes/acme.json")));
});
test("preferences are validated and stored separately; scope policies must name a listed hub", async (t) => {
  const p = await makePilot(t);
  await assert.rejects(applyInit(p.roots, { actorRefs: [], preferences: { clientName: "x" }, now }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(applyInit(p.roots, { actorRefs: [], preferences: { notes: ["x".repeat(201)] }, now }), { code: "DEVTWIN_INVALID_INPUT" });
  await applyInit(p.roots, { actorRefs: [], preferences: { diagrams: "prefer" }, now });
  assert.deepEqual(JSON.parse(await readFile(join(p.configRoot, "user.json"), "utf8")).preferences, { diagrams: "prefer" });
  await mkdir(join(p.inputsRoot, "hub"));
  const hubs = [parseHub(`eng=local-dir:${join(p.inputsRoot, "hub")}`, p.pilot)];
  await assert.rejects(applyScopeAdd(p.roots, { scope: "acme", hubs, policies: [parsePolicy("pol_review=other:REVIEW.md:required")] }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(Promise.resolve().then(() => parseHub(`eng=local-dir:${p.forbidden[0]}`, p.pilot)), { code: "DEVTWIN_GATE_REQUIRED" });
});
