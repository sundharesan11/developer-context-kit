import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { seedCommittedProject, committedProject, twoScopes, draftFor, now, fixtureGit, makeRepo } from "./helpers.mjs";
import { addRecord, supersedeRecord, proposeRecord } from "../src/records/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { sha256 } from "../src/storage/canonical.mjs";

const asOf = "2026-10-09T00:00:00.000Z";
let serial = 0;
async function api() {
  assert.ok(existsSync(new URL("../src/handoff/portable.mjs", import.meta.url)), "portable handoff module is implemented");
  return import("../src/handoff/portable.mjs");
}
async function add(s, changes = {}, extra = {}) {
  const input = draftFor("acme", "acme.atlas", { requestId: `req_handoff${String(++serial).padStart(5, "0")}` });
  Object.assign(input.draft, changes);
  Object.assign(input, extra);
  return addRecord(s.roots, input, { now });
}
const inputFor = (s, ids) => ({ scope: "acme", cwd: s.repo ?? s.atlas, recordIds: ids, asOf });
const build = async (s, ids, extra = {}) => (await api()).buildPortableHandoff(s.roots, s.pilot, { ...inputFor(s, ids), ...extra });

test("handoff deterministic bytes and digest bind explicit as-of and selected hashes", async (t) => {
  const s = await seedCommittedProject(t), a = await add(s), b = await add(s, { body: "Second fact" });
  const one = await build(s, [a.recordId, b.recordId]), two = await build(s, [b.recordId, a.recordId]);
  assert.equal(one.markdown, two.markdown);
  const footer = `\nPacket SHA-256 (all preceding bytes): ${one.packetHash}\n`;
  assert.ok(one.markdown.endsWith(footer));
  assert.equal(sha256(one.markdown.slice(0, -footer.length)), one.packetHash);
  assert.equal(sha256(one.markdown), one.fileHash);
  assert.equal(Buffer.byteLength(one.markdown), one.bytes);
  assert.notEqual((await build(s, [a.recordId, b.recordId], { asOf: "2026-10-10T00:00:00.000Z" })).packetHash, one.packetHash);
  assert.notEqual((await build(s, [a.recordId])).packetHash, one.packetHash);
  assert.deepEqual(one.model.records.map((r) => r.id), [a.recordId, b.recordId].sort());
});

test("handoff selection refuses empty duplicate missing proposed and superseded records", async (t) => {
  const s = await seedCommittedProject(t), a = await add(s), p = await add(s, { status: "proposed" });
  for (const ids of [undefined, [], [a.recordId, a.recordId]]) await assert.rejects(build(s, ids), { code: "DEVCTX_INVALID_INPUT" });
  for (const ids of [["rec_" + "f".repeat(24)], [p.recordId]]) await assert.rejects(build(s, ids), { code: "DEVCTX_RECORD_NOT_EXPORTABLE" });
  for (const date of [undefined, "bad", "2026-02-30T00:00:00.000Z", "2026-10-09", "2026-10-09T00:00:00Z"]) {
    await assert.rejects(build(s, [a.recordId], { asOf: date }), { code: "DEVCTX_INVALID_INPUT" });
  }
  const input = draftFor("acme", "acme.atlas", { requestId: "req_successor001" });
  await supersedeRecord(s.roots, { ...input, targets: [a.recordId], expectHashes: [a.recordHash] }, { now });
  await assert.rejects(build(s, [a.recordId]), { code: "DEVCTX_RECORD_NOT_EXPORTABLE" });
});

test("handoff scope isolation excludes other projects preferences and policies", async (t) => {
  const s = await twoScopes(t), a = await add(s);
  await addRecord(s.roots, draftFor("globex", "globex.beacon", { body: "CANARY-GLOBEX-7731" }), { now });
  const config = join(s.roots.configRoot, "scopes/acme.json"), value = JSON.parse(await readFile(config, "utf8"));
  await writeFile(config, JSON.stringify({ ...value, policies: [{ id: "pol_canary", hubId: "missing", rel: "ABSENT.md", required: true }] }));
  const user = join(s.roots.configRoot, "user.json");
  await writeFile(user, JSON.stringify({ preferences: { invalid: "PRIVATE-PREFERENCE-CANARY" } }));
  const packet = await build(s, [a.recordId]);
  for (const canary of ["globex", "CANARY-GLOBEX", "PRIVATE-PREFERENCE-CANARY", "pol_canary"]) assert.ok(!packet.markdown.includes(canary));
  await assert.rejects(build(s, [a.recordId], { scope: "globex" }), { code: "DEVCTX_PROJECT_UNBOUND" });
  const other = await seedCommittedProject(t);
  const repo = await makeRepo(join(other.reposDir, "beacon"), { "README.md": "Other project canary" });
  const onboard = { scope: "acme", project: "acme.other", repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "none", requestId: "req_otherproject01" };
  const plan = await planOnboard(other.roots, other.pilot, onboard);
  await applyOnboard(other.roots, other.pilot, onboard, { fingerprint: plan.fingerprint, now });
  const canary = await addRecord(other.roots, draftFor("acme", "acme.other", { body: "SAME-SCOPE-CANARY" }), { now });
  const local = await add(other);
  assert.ok(!(await build(other, [local.recordId])).markdown.includes("SAME-SCOPE-CANARY"));
  await assert.rejects(build(other, [canary.recordId]), { code: "DEVCTX_RECORD_NOT_EXPORTABLE" });
});

test("handoff discloses selected unknowns disputes provenance and exclusion counts", async (t) => {
  const s = await seedCommittedProject(t), ids = [];
  for (const kind of ["unknown", "command", "handoff"]) ids.push((await add(s, { kind, title: "Selected " + kind, body: "Next action: review\nBlockers: unknown" })).recordId);
  ids.push((await add(s, { status: "disputed", title: "Selected dispute" })).recordId);
  await add(s, { kind: "unknown", title: "UNSELECTED-TITLE-CANARY" });
  await add(s, { status: "disputed" });
  await add(s, { status: "proposed" });
  const old = await add(s), input = draftFor("acme", "acme.atlas", { requestId: "req_disclosures01" });
  await supersedeRecord(s.roots, { ...input, targets: [old.recordId], expectHashes: [old.recordHash] }, { now });
  await proposeRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_pendingprop01", body: "PRIVATE-PROPOSAL-CANARY" }), { now });
  const packet = await build(s, ids);
  assert.deepEqual(packet.model.exclusions, { unselectedEffective: 3, proposed: 1, superseded: 1, hiddenUncommitted: 0, unselectedUnknown: 1, unselectedDisputed: 1 });
  for (const text of ["Selected unknown", "Selected dispute", "Unknowns and disputes", "documented, not executed", "private proposal files", "not authentication"]) assert.ok(packet.markdown.includes(text), text);
  for (const text of ["UNSELECTED-TITLE-CANARY", "PRIVATE-PROPOSAL-CANARY"]) assert.ok(!packet.markdown.includes(text));
  for (const record of packet.model.records) assert.ok(packet.markdown.includes(record.recordHash) && packet.markdown.includes(record.id));
});

test("handoff withholds structured account identities and environment metadata", async (t) => {
  const s = await seedCommittedProject(t);
  const a = await add(s, { status: "confirmed", review: { reviewer: "email:owner@example.com" }, applicability: { level: "project", environment: "ENVIRONMENT-CANARY" } });
  const packet = await build(s, [a.recordId]);
  assert.deepEqual(packet.model.records[0].review, { reviewerRecorded: true, receipt: "owner-cli-confirmation" });
  assert.deepEqual(packet.model.records[0].sources, [{ kind: "user", recorded: true }]);
  assert.equal(packet.model.records[0].recordHash, a.recordHash);
  assert.ok(!/(?:email|github|slack|linear|handle):/.test(packet.markdown));
  assert.ok(!packet.markdown.includes("ENVIRONMENT-CANARY"));
  assert.match(packet.markdown, /reviewer and user-reference identities/);
});

test("handoff holds unsafe text metadata paths and links without rewriting", async (t) => {
  const s = await seedCommittedProject(t), a = await add(s);
  const { renderPortableHandoff } = await api(), packet = await build(s, [a.recordId]);
  const unsafe = ["/" + ["Users", "someone", "file"].join("/"), "C:" + "\\private\\file", "~/private", "https://example.invalid/page?key=value", "git@example.invalid:repo", "email:owner@example.com", "/v1/items", "data:text/plain,hello", "file:///tmp/example", "Hi\rthere", "Hi\u2028there", ["api", "_key"].join("") + " = " + "abcdef123456"];
  for (const body of unsafe) {
    const model = structuredClone(packet.model);
    Object.assign(model.records[0], { body, bodyHash: sha256(body), bodyBytes: Buffer.byteLength(body), bodyEndsWithLF: body.endsWith("\n") });
    assert.throws(() => renderPortableHandoff(model), (e) => ["DEVCTX_HANDOFF_UNSAFE", "DEVCTX_SENSITIVE_CONTENT"].includes(e.code) && !JSON.stringify(e).includes(body));
  }
  for (const body of ["Next action: review\nBlockers: none", "sha256:abc commit:abc file:README.md and/or", "<img src=relative.png>\n```\n~~~~"]) {
    const model = structuredClone(packet.model);
    Object.assign(model.records[0], { body, bodyHash: sha256(body), bodyBytes: Buffer.byteLength(body), bodyEndsWithLF: body.endsWith("\n") });
    assert.ok(renderPortableHandoff(model).markdown.includes(body));
  }
  for (const changes of [{ title: "mailto:owner" }, { sources: [{ ref: "url:https://example.invalid" }] }, { sources: [{ ref: "file:README.md", extra: "/tmp/private" }] }]) {
    const record = await add(s, changes);
    await assert.rejects(build(s, [record.recordId]), { code: "DEVCTX_HANDOFF_UNSAFE" });
  }
  const badActor = await add(s, {}, { recordedBy: { actor: "human", runId: "mailto:owner" } });
  await assert.rejects(build(s, [badActor.recordId]), { code: "DEVCTX_HANDOFF_UNSAFE" });
});

test("handoff body bytes can be independently recovered and hashed", async (t) => {
  const s = await seedCommittedProject(t);
  for (const body of ["", "text", "text\n", "text\n\n", "தமிழ்\ttext", "```\n~~~~"]) {
    const a = await add(s, { body }), packet = await build(s, [a.recordId]);
    const match = packet.markdown.match(/^(~{3,})text\n([\s\S]*?)\n\1$/m);
    assert.ok(match);
    assert.equal(match[2], body);
    assert.equal(sha256(match[2]), packet.model.records[0].bodyHash);
    assert.equal(Buffer.byteLength(match[2]), packet.model.records[0].bodyBytes);
    assert.equal(match[2].endsWith("\n"), packet.model.records[0].bodyEndsWithLF);
  }
  for (const body of ["a\rb", "a\u0085b", "a\u2028b", "a\u2029b"]) {
    const a = await add(s, { body });
    await assert.rejects(build(s, [a.recordId]), { code: "DEVCTX_HANDOFF_UNSAFE" });
  }
});

test("handoff refuses corrupt snapshots and selected-content overflow", async (t) => {
  const s = await seedCommittedProject(t), big = await add(s, { body: "x".repeat(32768) });
  await assert.rejects(build(s, [big.recordId]), { code: "DEVCTX_LIMIT" });
  const unicode = await add(s, { body: "界".repeat(10500) });
  await assert.rejects(build(s, [unicode.recordId]), { code: "DEVCTX_LIMIT" });
  const ids = [];
  for (let i = 0; i < 13; i++) ids.push((await add(s)).recordId);
  await assert.rejects(build(s, ids), { code: "DEVCTX_LIMIT" });
  await writeFile(join(s.dataRoot, "scopes/acme/projects/acme.atlas/records", big.recordId, "body.md"), "corrupt");
  await assert.rejects(build(s, [ids[0]]), { code: "DEVCTX_INTEGRITY" });
});

test("handoff freshness uses resolved worktree source hashes and explicit evaluation date", async (t) => {
  const s = await committedProject(t), text = await readFile(join(s.repo, "README.md"), "utf8");
  const a = await add(s, { sources: [{ ref: "file:README.md", sha256: sha256(text) }], revisitAfter: "2026-10-09" });
  let packet = await build(s, [a.recordId]);
  assert.deepEqual(packet.model.records[0].freshness, ["stale-by-date"]);
  assert.equal(packet.model.records[0].sourceChecks[0].observedHash, sha256(text));
  assert.deepEqual((await build(s, [a.recordId], { asOf: "2026-10-08T00:00:00.000Z" })).model.records[0].freshness, ["current"]);
  await writeFile(join(s.repo, "README.md"), "changed\n");
  packet = await build(s, [a.recordId]);
  assert.ok(packet.model.records[0].freshness.includes("needs-revalidation"));
  assert.equal(packet.model.records[0].sourceChecks[0].observedHash, sha256("changed\n"));
  await unlink(join(s.repo, "README.md"));
  assert.ok((await build(s, [a.recordId])).model.records[0].freshness.includes("source-missing"));
  const b = await add(s, { sources: [{ ref: "file:OTHER.md" }], applicability: { level: "project", branch: "other", commit: "a".repeat(40), worktree: "/fixture/other" } });
  const caveats = (await build(s, [b.recordId], { asOf: "2026-10-06T00:00:00.000Z" })).model.records[0].freshness;
  for (const label of ["recorded-after-as-of", "different-branch", "different-revision", "different-worktree", "unbound-source"]) assert.ok(caveats.includes(label));
  await writeFile(join(s.repo, "README.md"), text);
  const unverified = await add(s, { sources: [{ ref: "file:README.md" }] });
  assert.ok((await build(s, [unverified.recordId])).model.records[0].freshness.includes("unverified-source"));
  const invalid = await add(s, { revisitAfter: "2026-02-30" });
  await assert.rejects(build(s, [invalid.recordId]), { code: "DEVCTX_HANDOFF_UNSAFE" });
  const linked = join(s.reposDir, "beacon");
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "other", linked]);
  await writeFile(join(linked, "README.md"), "Linked worktree\n");
  const request = { ...s.input, repo: linked, requestId: "req_linkedhandoff01", accept: "none" };
  const plan = await planOnboard(s.roots, s.pilot, request);
  await applyOnboard(s.roots, s.pilot, request, { fingerprint: plan.fingerprint, now });
  const exact = await add(s, { sources: [{ ref: "file:README.md", sha256: sha256("Linked worktree\n") }] });
  assert.deepEqual((await build(s, [exact.recordId], { cwd: linked })).model.records[0].freshness, ["current"]);
});

test("handoff dirty detached and unverified evidence caveats remain visible", async (t) => {
  const s = await seedCommittedProject(t), marker = join(s.repo, "SHOULD_NOT_RUN");
  const a = await add(s, { kind: "command", body: "touch SHOULD_NOT_RUN" });
  await writeFile(join(s.repo, "README.md"), "Dirty\n");
  await fixtureGit(s.repo, ["checkout", "--detach", "-q"]);
  const packet = await build(s, [a.recordId]);
  assert.equal(packet.model.exportingWorktree.dirty, true);
  assert.equal(packet.model.exportingWorktree.branch, null);
  assert.deepEqual(packet.model.records[0].freshness, ["not-file-verified"]);
  for (const text of ["dirty bytes", "Branch: unknown", "documented, not executed", "Application tests: unknown"]) assert.ok(packet.markdown.includes(text), text);
  assert.equal(existsSync(marker), false);
});
