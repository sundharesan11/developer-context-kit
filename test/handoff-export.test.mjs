import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile, stat, mkdir, writeFile, symlink, link, chmod } from "node:fs/promises";
import { seedCommittedProject, committedProject, draftFor, runCli, now, fixtureGit, treeSnapshot } from "./helpers.mjs";
import { addRecord, supersedeRecord } from "../src/records/store.mjs";
import { sha256 } from "../src/storage/canonical.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";

const asOf = "2026-10-09T00:00:00.000Z";
const input = (s, ids, filename = "packet") => ({ scope: "acme", cwd: s.repo, recordIds: ids, asOf, out: join(s.dataRoot, "exports/handoffs/acme/acme.atlas", filename + ".handoff.md") });
async function exporter() {
  assert.ok(existsSync(new URL("../src/handoff/export.mjs", import.meta.url)), "private handoff exporter is implemented");
  return (await import("../src/handoff/export.mjs")).exportHandoff;
}
async function invoke(s, value, options) { return (await exporter())(s.roots, s.pilot, value, options); }
const args = (s, value) => ["handoff", "export", "--pilot", s.path, "--scope", value.scope, "--cwd", value.cwd,
  ...value.recordIds.flatMap((id) => ["--record", id]), "--as-of", value.asOf, "--out", value.out];

test("handoff CLI exports selected evidence only to private dataRoot", async (t) => {
  const s = await seedCommittedProject(t);
  const record = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const out = join(s.dataRoot, "exports/handoffs/acme/acme.atlas/packet.handoff.md");
  const before = await fixtureGit(s.repo, ["status", "--porcelain"]);
  const result = await runCli(["handoff", "export", "--pilot", s.path,
    "--scope", "acme", "--cwd", s.repo, "--record", record.recordId,
    "--as-of", "2026-10-09T00:00:00.000Z", "--out", out]);
  assert.equal(result.code, 0, JSON.stringify(result.json));
  const markdown = await readFile(out, "utf8");
  assert.match(markdown, /Fixture body/);
  assert.ok(markdown.includes(record.recordId));
  assert.ok(!markdown.includes(s.repo) && !markdown.includes(s.dataRoot));
  assert.equal((await stat(out)).mode & 0o777, 0o600);
  assert.equal(result.json.result.publication, "not-approved");
  assert.equal(await fixtureGit(s.repo, ["status", "--porcelain"]), before);
});

test("handoff output refuses alternate roots aliases existing nodes and unsafe parents", async (t) => {
  const s = await seedCommittedProject(t), a = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const value = input(s, [a.recordId]);
  const paths = [s.repo, s.inputsRoot, s.configRoot, s.stateRoot, s.agentHomes[0], s.forbidden[0], s.sandbox, resolve(import.meta.dirname, ".."), join(s.fakeHome, ".codex")].map((dir) => join(dir, "bad.handoff.md"));
  paths.push("relative.handoff.md", dirname(value.out) + "/../acme.atlas/bad.handoff.md", join(dirname(value.out), "nested/bad.handoff.md"));
  const before = await treeSnapshot(s.pilot.pilotRoot);
  for (const out of paths) await assert.rejects(invoke(s, { ...value, out }), (e) => ["DEVTWIN_GATE_REQUIRED", "DEVTWIN_PATH_UNSAFE"].includes(e.code));
  assert.equal(await treeSnapshot(s.pilot.pilotRoot), before);
  await mkdir(dirname(value.out), { recursive: true, mode: 0o700 });
  await writeFile(value.out, "preserve", { mode: 0o600 });
  await symlink(value.out, join(dirname(value.out), "linked.handoff.md"));
  await link(value.out, join(dirname(value.out), "hardlinked.handoff.md"));
  await mkdir(join(dirname(value.out), "directory.handoff.md"));
  for (const filename of ["packet", "linked", "hardlinked", "directory"]) await assert.rejects(invoke(s, input(s, [a.recordId], filename)), (e) => ["DEVTWIN_CONFLICT", "DEVTWIN_PATH_UNSAFE", "DEVTWIN_GATE_REQUIRED"].includes(e.code));
  assert.equal(await readFile(value.out, "utf8"), "preserve");
  await chmod(dirname(value.out), 0o755);
  await assert.rejects(invoke(s, input(s, [a.recordId], "unsafe")), { code: "DEVTWIN_PATH_UNSAFE" });
  assert.equal((await stat(dirname(value.out))).mode & 0o777, 0o755);
  const other = await seedCommittedProject(t), b = await addRecord(other.roots, draftFor("acme", "acme.atlas"), { now });
  await symlink(other.inputsRoot, join(other.dataRoot, "exports"));
  await assert.rejects(invoke(other, input(other, [b.recordId])), (e) => ["DEVTWIN_PATH_UNSAFE", "DEVTWIN_GATE_REQUIRED"].includes(e.code));
  const restricted = await seedCommittedProject(t), c = await addRecord(restricted.roots, draftFor("acme", "acme.atlas"), { now });
  await chmod(restricted.dataRoot, 0o500);
  try {
    await assert.rejects(invoke(restricted, input(restricted, [c.recordId])), { code: "DEVTWIN_PATH_UNSAFE" });
    assert.equal((await stat(restricted.dataRoot)).mode & 0o777, 0o500);
  } finally { await chmod(restricted.dataRoot, 0o700); }
});

test("handoff direct APIs require matching pilot before reads or writes", async (t) => {
  const s = await seedCommittedProject(t), a = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const value = input(s, [a.recordId]), call = await exporter(), before = await treeSnapshot(s.pilot.pilotRoot);
  for (const [roots, pilot] of [[{ ...s.roots, pilot: undefined }, s.pilot], [s.roots, undefined], [s.roots, { ...s.pilot }], [{ ...s.roots, dataRoot: s.inputsRoot }, s.pilot]]) {
    await assert.rejects(call(roots, pilot, value), { code: "DEVTWIN_GATE_REQUIRED" });
  }
  await assert.rejects(invoke(s, { ...value, cwd: s.sandbox }), { code: "DEVTWIN_GATE_REQUIRED" });
  assert.equal(await treeSnapshot(s.pilot.pilotRoot), before);
});

test("handoff CLI accepts repeated --record and refuses duplicate single-value options", async (t) => {
  const s = await seedCommittedProject(t), a = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const b = await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_secondexport01" }), { now });
  const value = input(s, [a.recordId, b.recordId]);
  const result = await runCli(args(s, value));
  assert.equal(result.code, 0, JSON.stringify(result.json));
  assert.equal(result.json.result.records.length, 2);
  for (const [flag, option] of [["pilot", s.path], ["out", value.out], ["as-of", asOf], ["cwd", s.repo], ["scope", "acme"]]) {
    assert.equal((await runCli([...args(s, value), "--" + flag, option])).json.error.code, "DEVTWIN_USAGE");
  }
  assert.equal((await runCli(args(s, { ...value, recordIds: [] }))).json.error.code, "DEVTWIN_INVALID_INPUT");
  assert.equal((await runCli(["skill-sources", "stage", "--pilot", s.path, "--pilot", s.path])).json.error.code, "DEVTWIN_USAGE");
});

test("handoff preflight failures create no export file or directories", async (t) => {
  const s = await seedCommittedProject(t);
  for (const [i, body] of ["/tmp/private", "x".repeat(32768)].entries()) {
    const a = await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: `req_failure000${i}`, body }), { now });
    const before = await treeSnapshot(s.pilot.pilotRoot);
    await assert.rejects(invoke(s, input(s, [a.recordId])), { code: i === 0 ? "DEVTWIN_HANDOFF_UNSAFE" : "DEVTWIN_LIMIT" });
    assert.equal(await treeSnapshot(s.pilot.pilotRoot), before);
    assert.equal(existsSync(join(s.dataRoot, "exports")), false);
  }
  await assert.rejects(invoke(s, input(s, [])), { code: "DEVTWIN_INVALID_INPUT" });
  assert.equal(existsSync(join(s.dataRoot, "exports")), false);
});

test("handoff export rechecks selected evidence before exclusive publication", async (t) => {
  const s = await committedProject(t), body = await readFile(join(s.repo, "README.md"), "utf8");
  const draft = draftFor("acme", "acme.atlas");
  draft.draft.sources = [{ ref: "file:README.md", sha256: sha256(body) }];
  const a = await addRecord(s.roots, draft, { now }), value = input(s, [a.recordId]);
  await assert.rejects(invoke(s, value, { faults: { beforeRecheck: () => writeFile(join(s.repo, "README.md"), "changed\n") } }), { code: "DEVTWIN_SOURCE_CHANGED" });
  assert.equal(existsSync(value.out), false);
  await writeFile(join(s.repo, "README.md"), body);
  await assert.rejects(invoke(s, value, { faults: { beforeRecheck: () => addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_raceaddition01" }), { now }) } }), { code: "DEVTWIN_SOURCE_CHANGED" });
  const one = await invoke(s, value), two = await invoke(s, input(s, [a.recordId], "second"));
  assert.equal(one.fileHash, two.fileHash);
  assert.equal(await readFile(value.out, "utf8"), await readFile(input(s, [a.recordId], "second").out, "utf8"));
  await assert.rejects(invoke(s, value), { code: "DEVTWIN_CONFLICT" });
  await assert.rejects(invoke(s, input(s, [a.recordId], "superseded"), { faults: { beforeRecheck: () => supersedeRecord(s.roots, { ...draftFor("acme", "acme.atlas", { requestId: "req_racesupersede01" }), targets: [a.recordId], expectHashes: [a.recordHash] }, { now }) } }), { code: "DEVTWIN_RECORD_NOT_EXPORTABLE" });
});

test("handoff CLI errors do not echo private paths or unsafe content", async (t) => {
  const s = await seedCommittedProject(t), a = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const value = input(s, [a.recordId]);
  await mkdir(dirname(value.out), { recursive: true, mode: 0o700 });
  await chmod(dirname(value.out), 0o755);
  const badParent = await runCli(args(s, value));
  assert.equal(badParent.json.error.code, "DEVTWIN_PATH_UNSAFE");
  const badPilot = await runCli(args({ ...s, path: join(s.sandbox, "missing.json") }, value));
  const unsafe = await addRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_unsafeerror01", body: "/tmp/PRIVATE-CONTENT-CANARY" }), { now });
  const badContent = await runCli(args(s, input(s, [unsafe.recordId])));
  assert.equal(badContent.json.error.code, "DEVTWIN_HANDOFF_UNSAFE");
  for (const result of [badParent, badPilot, badContent]) {
    const text = JSON.stringify(result.json);
    assert.ok(!text.includes(s.sandbox) && !text.includes("PRIVATE-CONTENT-CANARY") && !text.includes("ENOENT"));
  }
});

test("handoff export from a pilot with a profile carries no profile text and lists the profile as excluded", async (t) => {
  const s = await seedCommittedProject(t), a = await addRecord(s.roots, draftFor("acme", "acme.atlas"), { now });
  const profile = { workKind: "PROFILE-CANARY-WORK", stackCurrent: ["PROFILE-CANARY-STACK"], writing: { signOff: "PROFILE-CANARY-SIGNOFF" } };
  const plan = await planProfile(s.roots, { profile });
  await applyProfile(s.roots, { profile, fingerprint: plan.fingerprint }, { now });
  const value = input(s, [a.recordId]);
  const result = await invoke(s, value);
  const markdown = await readFile(value.out, "utf8");
  assert.ok(!markdown.includes("PROFILE-CANARY") && !JSON.stringify(result).includes("PROFILE-CANARY"));
  assert.match(markdown, /^Excluded fields\/content: preferences; personal profile; /m);
});
