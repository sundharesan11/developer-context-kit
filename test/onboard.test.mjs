import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, readdir, rename } from "node:fs/promises";
import { onboardFixture, now, treeSnapshot } from "./helpers.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { requireCommittedProject } from "../src/records/store.mjs";
import { readRegistry } from "../src/config/registry.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { toJson } from "../src/errors.mjs";
for (const point of ["afterBundles", "afterBinding", "afterManifest"]) {
  test(`crash ${point}: project invisible, identical retry commits once`, async (t) => {
    const s = await onboardFixture(t);
    await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now, faults: { [point]: () => { throw new Error("crash"); } } }));
    await assert.rejects(requireCommittedProject(s.roots, "acme", "acme.atlas"), { code: "DEVCTX_PROJECT_UNBOUND" });
    assert.equal((await readRegistry(s.roots)).value.operations.length, 0);
    const ok = await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
    assert.equal(ok.replayed, false);
    assert.equal((await readRegistry(s.roots)).value.operations.length, 1);
    assert.equal(ok.bundles.length, s.plan.bundles.length);
    assert.ok(s.plan.bundles.length >= 2);
  });
}
test("crash after registry publish: retry reconstructs the same receipt without republishing", async (t) => {
  const s = await onboardFixture(t);
  const opts = { fingerprint: s.plan.fingerprint, now };
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { ...opts, faults: { afterRegistry: () => { throw new Error("crash"); } } }));
  const gen = (await readRegistry(s.roots)).value.generation;
  await writeFile(join(s.repo, "README.md"), "# Atlas\nEdited after commit.\n");
  const second = await applyOnboard(s.roots, s.pilot, s.input, opts);
  const third = await applyOnboard(s.roots, s.pilot, s.input, opts);
  assert.equal(second.replayed, true);
  assert.deepEqual(third, second);
  assert.equal(second.committedGeneration, gen);
  assert.equal((await readRegistry(s.roots)).value.generation, gen);
  assert.equal((await readRegistry(s.roots)).value.operations.length, 1);
  assert.equal(second.bundles.length, s.plan.bundles.length);
  await requireCommittedProject(s.roots, "acme", "acme.atlas");
});
test("reused request id with a changed payload conflicts, before or after commit", async (t) => {
  const s = await onboardFixture(t);
  const changed = { ...s.input, environments: ["staging", "prod"] };
  const ok = await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  assert.equal(ok.replayed, false);
  const before = await readRegistry(s.roots);
  await assert.rejects(applyOnboard(s.roots, s.pilot, changed, { fingerprint: s.plan.fingerprint, now }), { code: "DEVCTX_CONFLICT" });
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { fingerprint: "sha256:" + "0".repeat(64), now }), { code: "DEVCTX_PLAN_MISMATCH" });
  assert.equal((await readRegistry(s.roots)).sha, before.sha);
});
test("orphan staging from a failed unapplied bundle is a recovery report, never deleted or published", async (t) => {
  const s = await onboardFixture(t);
  const opts = { fingerprint: s.plan.fingerprint, now };
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { ...opts, faults: { beforeRename: () => { throw new Error("crash"); } } }));
  const err = await applyOnboard(s.roots, s.pilot, s.input, opts).catch((e) => e);
  assert.equal(err.code, "DEVCTX_RECOVERY_REQUIRED");
  assert.equal(err.details.staging.length, 1);
  assert.equal((await readRegistry(s.roots)).value.operations.length, 0);
  assert.equal((await readdir(join(s.roots.dataRoot, "scopes/acme/projects/acme.atlas/staging"))).length, 1);
  await assert.rejects(requireCommittedProject(s.roots, "acme", "acme.atlas"), { code: "DEVCTX_PROJECT_UNBOUND" });
});
test("missing bundle after commit yields RECOVERY_REQUIRED, never a short read", async (t) => {
  const s = await onboardFixture(t);
  const r = await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const recs = join(s.roots.dataRoot, "scopes/acme/projects/acme.atlas/records");
  await rename(join(recs, r.bundles[0].id), join(s.roots.dataRoot, "moved-away"));
  await assert.rejects(requireCommittedProject(s.roots, "acme", "acme.atlas"), { code: "DEVCTX_RECOVERY_REQUIRED" });
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now }), { code: "DEVCTX_RECOVERY_REQUIRED" });
});
test("same worktree under another scope is BINDING_CONFLICT without naming it", async (t) => {
  const s = await onboardFixture(t);
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  await applyScopeAdd(s.roots, { scope: "globex", hubs: [], policies: [] });
  const err = await planOnboard(s.roots, s.pilot, { ...s.input, scope: "globex", project: "globex.atlas", requestId: "req_globex001" }).catch((e) => e);
  assert.equal(err.code, "DEVCTX_BINDING_CONFLICT");
  assert.ok(!JSON.stringify(toJson(err)).includes("acme"));
});
test("source mutated between preview and apply is refused; nothing published; repo has only the edit", async (t) => {
  const s = await onboardFixture(t);
  await writeFile(join(s.repo, "README.md"), "# Atlas\nChanged.\n");
  const edited = await treeSnapshot(s.repo);
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now }), (e) => ["DEVCTX_SOURCE_CHANGED", "DEVCTX_PLAN_MISMATCH"].includes(e.code));
  assert.equal((await readRegistry(s.roots)).value.operations.length, 0);
  assert.equal(await treeSnapshot(s.repo), edited);
});
test("direct onboarding without pilot leaves registry and locks unchanged", async (t) => {
  const s = await onboardFixture(t);
  const bare = { configRoot: s.roots.configRoot, dataRoot: s.roots.dataRoot, stateRoot: s.roots.stateRoot };
  const before = await readRegistry(s.roots);
  await assert.rejects(applyOnboard(bare, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now }), { code: "DEVCTX_GATE_REQUIRED" });
  assert.equal((await readRegistry(s.roots)).sha, before.sha);
  assert.deepEqual(await readdir(join(s.roots.stateRoot, "locks")), []);
});
