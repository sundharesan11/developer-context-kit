import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir, chmod, writeFile, readFile, access } from "node:fs/promises";
import { committedProject, draft, now, runCli } from "./helpers.mjs";
import { addRecord, commitBundle, supersedeRecord, readSnapshot, proposeRecord, publishProposal } from "../src/records/store.mjs";
import { recordIdFor, operationIdFor } from "../src/identity/ids.mjs";
import { buildPortableHandoff } from "../src/handoff/portable.mjs";
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
  await assert.rejects(access(join(roots.dataRoot, "scopes/acme/projects/acme.atlas/records", recordIdFor(draft({ requestId: "req_nopilot01" })))));
});
const recPath = (roots, id) => join(roots.dataRoot, "scopes/acme/projects/acme.atlas/records", id, "record.json");
async function plant(roots, id, mutate) {
  const path = recPath(roots, id), record = JSON.parse(await readFile(path, "utf8"));
  mutate(record);
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify(record));
}
test("U5 public record APIs refuse caller operation ids including edited proposals", async (t) => {
  const { roots } = await committedProject(t);
  const claimed = operationIdFor({ scope: "acme", project: "acme.atlas", requestId: "req_onboard01" });
  await assert.rejects(addRecord(roots, { ...draft({ requestId: "req_opclaim01" }), operationId: claimed }, { now }), { code: "DEVCTX_INVALID_INPUT" });
  await assert.rejects(commitBundle(roots, { ...draft({ requestId: "req_opclaim02" }), operationId: "op_" + "1".repeat(24) }, { now }), { code: "DEVCTX_INVALID_INPUT" });
  const p = await proposeRecord(roots, draft({ requestId: "req_opclaim03" }), { now });
  const raw = JSON.parse(await readFile(p.path, "utf8"));
  raw.input.operationId = claimed;
  await chmod(p.path, 0o600);
  await writeFile(p.path, JSON.stringify(raw));
  await assert.rejects(publishProposal(roots, { scope: "acme", project: "acme.atlas", proposalId: p.proposalId }, { controller: "human", now }), { code: "DEVCTX_INVALID_INPUT" });
  for (const requestId of ["req_opclaim01", "req_opclaim02", "req_opclaim03"]) await assert.rejects(access(join(roots.dataRoot, "scopes/acme/projects/acme.atlas/records", recordIdFor(draft({ requestId })))));
});
test("U5 planted operation claims, bad supersession and mismatched ids are corrupt not trusted", async (t) => {
  const { roots } = await committedProject(t);
  const before = (await readSnapshot(roots, "acme", "acme.atlas")).records;
  const ids = {};
  for (const name of ["claim", "self", "cyclea", "cycleb", "keep", "other", "mismatch", "missing", "malformed", "tria", "trib", "tric"]) ids[name] = (await addRecord(roots, draft({ requestId: "req_u5" + name.padEnd(8, "0") }), { now })).recordId;
  await plant(roots, ids.claim, (r) => { r.operationId = operationIdFor({ scope: "acme", project: "acme.atlas", requestId: "req_onboard01" }); });
  await plant(roots, ids.self, (r) => { r.supersedes = [ids.self]; });
  await plant(roots, ids.cyclea, (r) => { r.supersedes = [ids.cycleb, ids.keep]; });
  await plant(roots, ids.cycleb, (r) => { r.supersedes = [ids.cyclea]; });
  await plant(roots, ids.tria, (r) => { r.supersedes = [ids.tric, ids.trib]; });
  await plant(roots, ids.trib, (r) => { r.supersedes = [ids.tric]; });
  await plant(roots, ids.tric, (r) => { r.supersedes = [ids.tria]; });
  await plant(roots, ids.mismatch, (r) => { r.requestId = "req_otherreq01"; });
  await plant(roots, ids.missing, (r) => { delete r.supersedes; });
  await plant(roots, ids.malformed, (r) => { r.supersedes = ids.keep; });
  const snap = await readSnapshot(roots, "acme", "acme.atlas");
  const bad = ["claim", "self", "cyclea", "cycleb", "mismatch", "missing", "malformed", "tria", "trib", "tric"].map((n) => ids[n]).sort();
  assert.deepEqual(snap.corrupt.map((c) => c.id).sort(), bad);
  assert.ok(snap.corrupt.every((c) => c.code === "DEVCTX_INTEGRITY"));
  for (const id of bad) assert.equal(snap.records.some((r) => r.id === id), false);
  for (const name of ["keep", "other"]) assert.equal(snap.records.find((r) => r.id === ids[name]).effective, "observed");
  for (const r of before) assert.equal(snap.records.find((x) => x.id === r.id).effective, r.effective);
});
test("U5 handoff export refuses a corrupt snapshot naming the record id", async (t) => {
  const s = await committedProject(t);
  const good = await addRecord(s.roots, draft({ requestId: "req_u5handoff1" }), { now });
  const bad = await addRecord(s.roots, draft({ requestId: "req_u5handoff2" }), { now });
  await plant(s.roots, bad.recordId, (r) => { r.supersedes = [bad.recordId]; });
  await assert.rejects(buildPortableHandoff(s.roots, s.pilot, { scope: "acme", cwd: s.repo, recordIds: [good.recordId], asOf: "2026-10-09T00:00:00.000Z" }), (e) => e.code === "DEVCTX_INTEGRITY" && e.message.includes(bad.recordId) && e.details.records.includes(bad.recordId));
});

test("record add reads a valid body file inside inputsRoot", async (t) => {
  const { roots, pilot, scope, project } = await committedProject(t);
  const file = join(pilot.inputsRoot, "record-body.md");
  await writeFile(file, "The billing API retries failed webhooks twice.\n");
  const args = ["record", "add", "--pilot", pilot.path, "--scope", scope, "--project", project, "--kind", "fact", "--title", "Webhook retries", "--request-id", "req_bodyfile01", "--body-file", file];
  const preview = await runCli(args);
  assert.equal(preview.code, 0, JSON.stringify(preview.json));
  const applied = await runCli([...args, "--apply"]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  const stored = (await readSnapshot(roots, scope, project)).records.find((r) => r.requestId === "req_bodyfile01");
  assert.ok(JSON.stringify(stored).includes("retries failed webhooks"), JSON.stringify(stored));
  // A body file outside inputsRoot is still refused.
  const outside = await runCli([...args.slice(0, -1), join(pilot.pilotRoot, "..", "outside-forbidden", "body.md")]);
  assert.equal(outside.json.error.code, "DEVCTX_GATE_REQUIRED");
});
