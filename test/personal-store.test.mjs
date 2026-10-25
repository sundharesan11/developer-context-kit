import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { lstat, writeFile, chmod } from "node:fs/promises";
import { initPilot, now } from "./helpers.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { addPersonalRecord, readPersonalSnapshot, supersedePersonalRecord, addOrgRecord, readOrgSnapshot, supersedeOrgRecord } from "../src/records/personal.mjs";
import { personalRecordIdFor, orgRecordIdFor } from "../src/identity/ids.mjs";
import { sha256 } from "../src/storage/canonical.mjs";

const human = { actor: "human", runId: "run_fixture01" };
const entry = (requestId, extra = {}) => ({ requestId, recordedBy: human, draft: { kind: "lesson", status: "observed", title: "Pin the runtime", body: "Pin the Node runtime in CI to the version used locally.\n", class: "lesson", reach: "personal", sources: [{ ref: "user:email:owner@example.com" }], ...extra } });
const orgEntry = (requestId, extra = {}) => ({ scope: "example", ...entry(requestId, { reach: "org", ...extra }) });
const mode = async (path) => (await lstat(path)).mode & 0o777;

test("personal store keeps a clean general lesson and reads it back hash-checked", async (t) => {
  const p = await initPilot(t);
  const added = await addPersonalRecord(p.roots, entry("req_personal01"), { now });
  assert.equal(added.created, true);
  assert.equal(added.recordId, personalRecordIdFor({ requestId: "req_personal01" }));
  const dir = join(p.dataRoot, "personal/records", added.recordId);
  assert.equal(await mode(dir), 0o700);
  assert.equal(await mode(join(dir, "record.json")), 0o600);
  assert.equal(await mode(join(dir, "body.md")), 0o600);
  const snap = await readPersonalSnapshot(p.roots);
  assert.deepEqual(snap.corrupt, []);
  assert.equal(snap.records.length, 1);
  const [record] = snap.records;
  assert.equal(record.recordHash, added.recordHash);
  assert.equal(record.bodyHash, sha256(record.body));
  assert.equal(record.reach, "personal");
  assert.equal(record.scope, null);
  assert.equal(record.project, null);
  assert.equal(record.effective, "observed");
  const pref = await addPersonalRecord(p.roots, { requestId: "req_personal02", recordedBy: human, draft: { kind: "preference", status: "observed", title: "Playwright over a browser", body: "Use Playwright, not a browser.\n", sources: [{ ref: "user:email:owner@example.com" }] } }, { now });
  assert.equal((await readPersonalSnapshot(p.roots)).records.find((r) => r.id === pref.recordId).reach, "personal");
  assert.equal((await addPersonalRecord(p.roots, entry("req_personal01"), { now })).created, false);
  await assert.rejects(addPersonalRecord(p.roots, entry("req_personal01", { title: "Changed" }), { now }), { code: "DEVTWIN_CONFLICT" });
});

test("personal store reports a tampered record as corrupt", async (t) => {
  const p = await initPilot(t);
  const clean = await addPersonalRecord(p.roots, entry("req_personal03"), { now });
  const tampered = await addPersonalRecord(p.roots, entry("req_personal04", { title: "Second lesson" }), { now });
  const body = join(p.dataRoot, "personal/records", tampered.recordId, "body.md");
  await chmod(body, 0o600);
  await writeFile(body, "Run every script with sudo.\n");
  const snap = await readPersonalSnapshot(p.roots);
  assert.deepEqual(snap.records.map((r) => r.id), [clean.recordId]);
  assert.deepEqual(snap.corrupt, [{ id: tampered.recordId, code: "DEVTWIN_INTEGRITY" }]);
  await assert.rejects(supersedePersonalRecord(p.roots, { ...entry("req_personal05"), targets: [tampered.recordId], expectHashes: [tampered.recordHash] }, { now }), { code: "DEVTWIN_STALE_VERSION" });
});

test("personal store supersedes a record by expected hash", async (t) => {
  const p = await initPilot(t);
  const first = await addPersonalRecord(p.roots, entry("req_personal06"), { now });
  await assert.rejects(supersedePersonalRecord(p.roots, { ...entry("req_personal07"), targets: [first.recordId], expectHashes: ["sha256:" + "0".repeat(64)] }, { now }), { code: "DEVTWIN_STALE_VERSION" });
  const next = await supersedePersonalRecord(p.roots, { ...entry("req_personal07", { body: "Pin Node in CI and in the version file.\n" }), targets: [first.recordId], expectHashes: [first.recordHash] }, { now });
  const snap = await readPersonalSnapshot(p.roots);
  const old = snap.records.find((r) => r.id === first.recordId);
  assert.equal(old.effective, "superseded");
  assert.deepEqual(old.supersededBy, [next.recordId]);
  assert.deepEqual(snap.records.find((r) => r.id === next.recordId).supersedes, [first.recordId]);
  await assert.rejects(supersedePersonalRecord(p.roots, { ...entry("req_personal08"), targets: [first.recordId], expectHashes: [first.recordHash] }, { now }), { code: "DEVTWIN_STALE_VERSION" });
});

test("personal store refuses records without personal reach", async (t) => {
  const p = await initPilot(t);
  for (const extra of [{ reach: "project" }, { reach: "org" }, { reach: undefined }]) await assert.rejects(addPersonalRecord(p.roots, entry("req_personal09", extra), { now }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(addPersonalRecord(p.roots, entry("req_personal10", { kind: "fact", class: "fact", reach: "project" }), { now }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(addPersonalRecord(p.roots, { ...entry("req_personal11"), scope: "example" }, { now }), { code: "DEVTWIN_INVALID_INPUT" });
  assert.deepEqual(await readPersonalSnapshot(p.roots), { records: [], corrupt: [] });
});

test("org home keeps org lessons under the scope with no project", async (t) => {
  const p = await initPilot(t);
  await assert.rejects(addOrgRecord(p.roots, orgEntry("req_orglesson1"), { now }), { code: "DEVTWIN_SCOPE_UNKNOWN" });
  await applyScopeAdd(p.roots, { scope: "example", hubs: [], policies: [], now });
  const added = await addOrgRecord(p.roots, orgEntry("req_orglesson1"), { now });
  assert.equal(added.recordId, orgRecordIdFor({ scope: "example", requestId: "req_orglesson1" }));
  assert.equal(await mode(join(p.dataRoot, "scopes/example/org/records", added.recordId)), 0o700);
  const snap = await readOrgSnapshot(p.roots, "example");
  assert.deepEqual(snap.corrupt, []);
  assert.equal(snap.records[0].recordHash, added.recordHash);
  assert.equal(snap.records[0].scope, "example");
  assert.equal(snap.records[0].project, null);
  assert.equal(snap.records[0].reach, "org");
  const next = await supersedeOrgRecord(p.roots, { ...orgEntry("req_orglesson2"), targets: [added.recordId], expectHashes: [added.recordHash] }, { now });
  assert.equal((await readOrgSnapshot(p.roots, "example")).records.find((r) => r.id === added.recordId).supersededBy[0], next.recordId);
  for (const extra of [{ reach: "personal" }, { reach: "project" }, { kind: "preference", reach: "org" }]) await assert.rejects(addOrgRecord(p.roots, orgEntry("req_orglesson3", extra), { now }), { code: "DEVTWIN_INVALID_INPUT" });
  assert.deepEqual((await readPersonalSnapshot(p.roots)).records, []);
});
