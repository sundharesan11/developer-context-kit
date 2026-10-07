import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, chmod, writeFile, readFile, access } from "node:fs/promises";
import { committedProject, draft, now, runCli } from "./helpers.mjs";
import { addRecord, supersedeRecord, readSnapshot } from "../src/records/store.mjs";
test("idempotent add; reused request id with different content conflicts", async (t) => {
  const { roots } = await committedProject(t);
  const input = draft({ requestId: "req_test0001", body: "Uses PostgreSQL 16" });
  const a = await addRecord(roots, input, { now });
  assert.deepEqual((await addRecord(roots, input, { now })).recordId, a.recordId);
  await assert.rejects(addRecord(roots, { ...input, draft: { ...input.draft, body: "x" } }, { now }), { code: "DEVCTX_CONFLICT" });
});
test("crash before rename leaves invisible staging that blocks, never deletes", async (t) => {
  const { roots } = await committedProject(t);
  const input = draft({ requestId: "req_crash0001" });
  await assert.rejects(addRecord(roots, input, { now, faults: { beforeRename: () => { throw new Error("crash"); } } }));
  assert.equal((await readSnapshot(roots, "acme", "acme.atlas")).records.some((r) => r.requestId === "req_crash0001"), false);
  await assert.rejects(addRecord(roots, input, { now }), { code: "DEVCTX_RECOVERY_REQUIRED" });
  assert.equal((await readdir(join(roots.dataRoot, "scopes/acme/projects/acme.atlas/staging"))).length, 1);
});
test("supersession preserves history; double supersede is stale; confirm needs reviewer", async (t) => {
  const { roots } = await committedProject(t);
  const r1 = await addRecord(roots, draft({ requestId: "req_s0000001" }), { now });
  await assert.rejects(supersedeRecord(roots, { ...draft({ requestId: "req_s0000002", status: "confirmed" }), targets: [r1.recordId], expectHashes: [r1.recordHash] }, { now }), { code: "DEVCTX_APPROVAL_REQUIRED" });
  const r2 = await supersedeRecord(roots, { ...draft({ requestId: "req_s0000003", status: "confirmed", review: { reviewer: "email:owner@example.com" } }), targets: [r1.recordId], expectHashes: [r1.recordHash] }, { now });
  const snap = await readSnapshot(roots, "acme", "acme.atlas");
  assert.equal(snap.records.find((r) => r.id === r1.recordId).effective, "superseded");
  assert.deepEqual(snap.records.find((r) => r.id === r2.recordId).supersedes, [r1.recordId]);
  await assert.rejects(supersedeRecord(roots, { ...draft({ requestId: "req_s0000004" }), targets: [r1.recordId], expectHashes: [r1.recordHash] }, { now }), { code: "DEVCTX_STALE_VERSION" });
});
test("tampered body is reported corrupt and excluded", async (t) => {
  const { roots } = await committedProject(t);
  const r = await addRecord(roots, draft({ requestId: "req_tamper001", body: "original" }), { now });
  const body = join(roots.dataRoot, "scopes/acme/projects/acme.atlas/records", r.recordId, "body.md");
  await chmod(body, 0o600);
  await writeFile(body, "tampered");
  const snap = await readSnapshot(roots, "acme", "acme.atlas");
  assert.equal(snap.records.some((x) => x.id === r.recordId), false);
  assert.deepEqual(snap.corrupt, [{ id: r.recordId, code: "DEVCTX_INTEGRITY" }]);
});
test("record refs and body files cannot reach denied or out-of-fence paths", async (t) => {
  const { roots, pilot } = await committedProject(t);
  const bad = draft({ requestId: "req_badref001" });
  bad.draft.sources = [{ ref: "file:config/.env.local", sha256: "sha256:" + "0".repeat(64) }];
  await assert.rejects(addRecord(roots, bad, { now }), { code: "DEVCTX_INVALID_INPUT" });
  const outside = join(pilot.pilotRoot, "..", "outside-forbidden", "body.md");
  const res = await runCli(["record", "add", "--pilot", pilot.path, "--scope", "acme", "--project", "acme.atlas", "--kind", "fact", "--title", "x", "--body-file", outside]);
  assert.equal(res.json.error.code, "DEVCTX_GATE_REQUIRED");
});
test("direct record mutation without pilot leaves registry and locks unchanged", async (t) => {
  const { roots } = await committedProject(t);
  const before = await readFile(join(roots.configRoot, "registry.json"));
  const bare = { configRoot: roots.configRoot, dataRoot: roots.dataRoot, stateRoot: roots.stateRoot };
  await assert.rejects(addRecord(bare, draft({ requestId: "req_nopilot01" }), { now }), { code: "DEVCTX_GATE_REQUIRED" });
  assert.deepEqual(await readFile(join(roots.configRoot, "registry.json")), before);
  await assert.rejects(access(join(roots.stateRoot, "locks", "acme.lock")));
  await assert.rejects(access(join(roots.dataRoot, "scopes/acme/projects/acme.atlas/records", "req_nopilot01")));
});
