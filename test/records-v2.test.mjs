import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { onboardFixture, draftFor, now } from "./helpers.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord, readSnapshot, proposeRecord } from "../src/records/store.mjs";
import { buildBrief } from "../src/context/brief.mjs";
import { validateDraft, buildRecord, validateRecord } from "../src/records/schema.mjs";
import { recordIdFor, personalRecordIdFor, orgRecordIdFor, RECORD_ID } from "../src/identity/ids.mjs";
import { portableRecord } from "../src/handoff/privacy.mjs";
import { canonicalJson, sha256 } from "../src/storage/canonical.mjs";

const SCOPE = "example", PROJECT = "example.atlas";
const human = { actor: "human", runId: "run_fixture01" };
const draft = (opts) => draftFor(SCOPE, PROJECT, opts);
async function committedProject(t) {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  return s;
}
const lessonInput = (requestId, extra = {}) => {
  const input = draft({ requestId, kind: "lesson", body: "Run migrations before seeding the test database.\n" });
  input.draft = { ...input.draft, title: "Migrations before seeds", class: "lesson", reach: "project", match: { paths: ["db/migrations/**", "scripts/seed.mjs"], packages: ["pg", "@example/db-tools"], topics: ["migrations", "testing"] }, ...extra };
  return input;
};
const lessonDraft = (extra = {}) => lessonInput("req_lessonv201", extra).draft;
const refused = (d) => assert.throws(() => validateDraft(d, { recordedBy: human }), { code: "DEVTWIN_INVALID_INPUT" });

test("v2 lesson draft with paths packages and topics validates and round-trips", async (t) => {
  const { roots } = await committedProject(t);
  const input = lessonInput("req_lessonv201");
  assert.equal(validateDraft(input.draft, { recordedBy: human }), input.draft);
  const added = await addRecord(roots, input, { now });
  const record = (await readSnapshot(roots, SCOPE, PROJECT)).records.find((r) => r.id === added.recordId);
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.kind, "lesson");
  assert.equal(record.class, "lesson");
  assert.equal(record.reach, "project");
  assert.deepEqual(record.match, input.draft.match);
  assert.equal(record.body, input.draft.body);
  assert.equal(record.applicability.level, "project");
});

test("v2 writers default class reach and match from the kind", () => {
  const record = buildRecord({ scope: SCOPE, project: PROJECT, requestId: "req_default01", requestHash: "sha256:" + "0".repeat(64), recordedBy: human, draft: draft().draft }, { now });
  assert.equal(record.schemaVersion, 2);
  assert.equal(record.class, "fact");
  assert.equal(record.reach, "project");
  assert.deepEqual(record.match, { paths: [], packages: [], topics: [] });
  assert.equal(buildRecord({ scope: SCOPE, project: PROJECT, requestId: "req_default02", requestHash: "sha256:" + "0".repeat(64), recordedBy: human, draft: lessonDraft({ class: undefined, match: undefined }) }, { now }).class, "lesson");
});

test("v1 record reads unchanged next to v2 records in one snapshot", async (t) => {
  const { roots } = await committedProject(t);
  const v2 = await addRecord(roots, lessonInput("req_lessonv202"), { now });
  const requestId = "req_legacyv101", id = recordIdFor({ scope: SCOPE, project: PROJECT, requestId }), body = "Legacy fact body\n";
  const v1 = { schemaVersion: 1, id, scope: SCOPE, project: PROJECT, kind: "fact", status: "observed", title: "Legacy fact", bodyHash: sha256(body), bodyBytes: Buffer.byteLength(body), sources: [{ ref: "user:email:owner@example.com" }], verification: [], recordedBy: human, applicability: { level: "project", branch: null, commit: null, worktree: null, task: null, environment: null }, supersedes: [], review: null, revisitAfter: null, requestId, requestHash: "sha256:" + "1".repeat(64), operationId: null, createdAt: now().toISOString() };
  const dir = join(roots.dataRoot, "scopes/example/projects/example.atlas/records", id);
  await mkdir(dir, { mode: 0o700 });
  await writeFile(join(dir, "body.md"), body, { mode: 0o600 });
  await writeFile(join(dir, "record.json"), canonicalJson(v1) + "\n", { mode: 0o600 });
  const snap = await readSnapshot(roots, SCOPE, PROJECT);
  assert.deepEqual(snap.corrupt, []);
  const legacy = snap.records.find((r) => r.id === id);
  const { body: readBody, recordHash, effective, supersededBy, ...stored } = legacy;
  assert.deepEqual(stored, v1);
  assert.equal(readBody, body);
  assert.equal("class" in legacy || "match" in legacy || "reach" in legacy, false);
  assert.equal(snap.records.find((r) => r.id === v2.recordId).schemaVersion, 2);
});

test("v2 reader refuses unknown schema versions and malformed v2 fields", () => {
  const base = buildRecord({ scope: SCOPE, project: PROJECT, requestId: "req_reader001", requestHash: "sha256:" + "0".repeat(64), recordedBy: human, draft: lessonDraft() }, { now });
  assert.equal(validateRecord(base), base);
  assert.throws(() => validateRecord({ ...base, schemaVersion: 3 }), { code: "DEVTWIN_SCHEMA_UNSUPPORTED" });
  assert.throws(() => validateRecord({ ...base, reach: "galaxy" }), { code: "DEVTWIN_INVALID_INPUT" });
  assert.throws(() => validateRecord({ ...base, match: { paths: ["/etc/hosts"], packages: [], topics: [] } }), { code: "DEVTWIN_INVALID_INPUT" });
  const { class: _c, ...missing } = base;
  assert.throws(() => validateRecord(missing), { code: "DEVTWIN_INVALID_INPUT" });
});

test("match globs refuse absolute paths parent segments and denied files", () => {
  for (const path of ["/etc/passwd", "../outside/**", "src/../../x", "./src/*.mjs", "src//a", "src\\win", "~/notes", "config/.env*", "**/*.pem", "node_modules/**", "C:/x"]) refused(lessonDraft({ match: { paths: [path], packages: [], topics: [] } }));
  assert.doesNotThrow(() => validateDraft(lessonDraft({ match: { paths: ["src/**/*.test.mjs", "docs/?.md", "*"], packages: [], topics: [] } }), { recordedBy: human }));
});

test("preference with project reach is refused", () => {
  const preference = { ...lessonDraft(), kind: "preference" };
  refused({ ...preference, reach: "project" });
  assert.doesNotThrow(() => validateDraft({ ...preference, reach: "personal" }, { recordedBy: human }));
  assert.doesNotThrow(() => validateDraft({ ...preference, reach: "org" }, { recordedBy: human }));
});

test("v2 class reach and match caps and allowlists hold", () => {
  refused(lessonDraft({ class: "rumor" }));
  refused(lessonDraft({ reach: "galaxy" }));
  refused(lessonDraft({ class: "fact" }));
  refused({ ...draft().draft, reach: "org" });
  refused(lessonDraft({ match: { paths: [], packages: [], topics: [], extra: [] } }));
  refused(lessonDraft({ match: ["src/**"] }));
  refused(lessonDraft({ match: { paths: "src/**" } }));
  refused(lessonDraft({ match: { paths: Array.from({ length: 21 }, (_, i) => "src/p" + i + "/**") } }));
  refused(lessonDraft({ match: { packages: Array.from({ length: 21 }, (_, i) => "pkg-" + i) } }));
  refused(lessonDraft({ match: { topics: Array.from({ length: 11 }, (_, i) => "topic-" + i) } }));
  refused(lessonDraft({ match: { paths: ["src/" + "a".repeat(200)] } }));
  refused(lessonDraft({ match: { packages: ["Has Space"] } }));
  refused(lessonDraft({ match: { packages: ["a".repeat(215)] } }));
  refused(lessonDraft({ match: { topics: ["Upper"] } }));
  refused(lessonDraft({ match: { topics: ["t".repeat(49)] } }));
  refused(lessonDraft({ match: { topics: ["dup", "dup"] } }));
  assert.doesNotThrow(() => validateDraft(lessonDraft({ match: { paths: Array.from({ length: 20 }, (_, i) => "src/p" + i + "/**"), packages: Array.from({ length: 20 }, (_, i) => "pkg-" + i), topics: Array.from({ length: 10 }, (_, i) => "topic-" + i) } }), { recordedBy: human }));
});

test("project store refuses records whose reach is not project", async (t) => {
  const { roots } = await committedProject(t);
  await assert.rejects(addRecord(roots, lessonInput("req_lessonorg1", { reach: "org" }), { now }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(proposeRecord(roots, lessonInput("req_lessonorg1", { reach: "org" }), { now }), { code: "DEVTWIN_INVALID_INPUT" });
  assert.equal((await readSnapshot(roots, SCOPE, PROJECT)).records.some((r) => r.requestId === "req_lessonorg1"), false);
});

test("v2 project lesson passes the handoff privacy check unchanged", async (t) => {
  const { roots } = await committedProject(t);
  const added = await addRecord(roots, lessonInput("req_lessonv203", { sources: [{ ref: "commit:abcdef1" }] }), { now });
  const record = (await readSnapshot(roots, SCOPE, PROJECT)).records.find((r) => r.id === added.recordId);
  const portable = portableRecord(record);
  assert.equal(portable.kind, "lesson");
  assert.equal(portable.id, record.id);
  assert.equal(portable.recordHash, record.recordHash);
  assert.equal(portable.title, record.title);
  assert.equal(portable.body, record.body);
  assert.deepEqual(portableRecord(portable, { projected: true }), portable);
});

test("personal and org record IDs are derived and distinct from project IDs", () => {
  const personal = personalRecordIdFor({ requestId: "req_shared0001" });
  const org = orgRecordIdFor({ scope: SCOPE, requestId: "req_shared0001" });
  const project = recordIdFor({ scope: SCOPE, project: PROJECT, requestId: "req_shared0001" });
  for (const id of [personal, org]) assert.match(id, RECORD_ID);
  assert.equal(new Set([personal, org, project, orgRecordIdFor({ scope: "example-two", requestId: "req_shared0001" })]).size, 4);
  assert.equal(personalRecordIdFor({ requestId: "req_shared0001" }), personal);
  assert.throws(() => personalRecordIdFor({ requestId: "bad" }), { code: "DEVTWIN_INVALID_ID" });
  assert.throws(() => orgRecordIdFor({ scope: "Bad Scope", requestId: "req_shared0001" }), { code: "DEVTWIN_INVALID_ID" });
});

test("context brief orders a v2 lesson after project facts", async (t) => {
  const s = await committedProject(t);
  const lesson = await addRecord(s.roots, lessonInput("req_lessonv204"), { now });
  const fact = await addRecord(s.roots, draft({ requestId: "req_factv2001" }), { now });
  const brief = await buildBrief(s.roots, s.pilot, { scope: SCOPE, cwd: s.repo });
  const ids = brief.records.map((r) => r.id);
  assert.ok(ids.includes(lesson.recordId));
  assert.ok(ids.indexOf(fact.recordId) < ids.indexOf(lesson.recordId));
});
