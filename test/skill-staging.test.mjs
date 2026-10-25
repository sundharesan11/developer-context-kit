import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { mkdir, readFile, readdir, stat, chmod, writeFile, symlink, link, rename } from "node:fs/promises";
import { makePilot, treeSnapshot } from "./helpers.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { getSource, loadBundledCatalog } from "../src/skill-sources/catalog.mjs";
import { gitBlobSha } from "../src/skill-sources/selection.mjs";
import { previewAcquisition } from "../src/skill-sources/github-package.mjs";
import { stageAcquisition, inspectAcquisition } from "../src/skill-sources/staging.mjs";
import { toJson } from "../src/errors.mjs";

const source = getSource(loadBundledCatalog(), "humanizer");
const pin = {sourceId: source.id, channel: "stable-release", tag: "v1", commit: "a".repeat(40)};
const tree = "b".repeat(40), bytes = Buffer.from("# Inert fixture\n"), blob = gitBlobSha(bytes);
const runIdBytes = () => Buffer.alloc(16, 7), runId = "stage_" + "07".repeat(16);
async function fixture(t) {
  const p = await makePilot(t); let calls = 0;
  const request = async (url) => {
    calls++;
    const path = new URL(url).pathname;
    const body = path.includes("/commits/") ? {sha: pin.commit, tree: {sha: tree}} : path.includes("/trees/") ? {sha: tree, truncated: false, tree: [
      {path: "skills", type: "tree", mode: "040000", sha: tree},
      {path: "skills/SKILL.md", type: "blob", mode: "100755", sha: blob, size: bytes.length}
    ]} : {sha: blob, size: bytes.length, encoding: "base64", content: bytes.toString("base64")};
    return new Response(JSON.stringify(body), {headers: {"content-type": "application/json"}});
  };
  const input = {pin, files: ["skills/SKILL.md"]};
  const preview = await previewAcquisition(source, input, {request});
  return {...p, request, input: {...input, fingerprint: preview.fingerprint}, calls: () => calls, run: join(p.dataRoot, "skill-sources/staging", runId)};
}

test("skill staging writes only private dataRoot and completes receipt last", async (t) => {
  const p = await fixture(t);
  const homes = await Promise.all(p.agentHomes.map(treeSnapshot));
  const result = await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes});
  assert.equal(result.status, "staged");
  assert.equal(result.runId, runId);
  assert.equal(result.assessment.installation, "not-installed");
  assert.deepEqual(await inspectAcquisition(p.roots, runId), result);
  assert.deepEqual(await Promise.all(p.agentHomes.map(treeSnapshot)), homes);
  assert.deepEqual(await readdir(p.pilot.pilotRoot), ["data", "homes", "inputs", "repos"]);
  assert.deepEqual(await readdir(p.run), ["files", "receipt.json"]);
  assert.equal((await stat(p.run)).mode & 0o777, 0o700);
  assert.equal((await stat(join(p.run, "files/skills/SKILL.md"))).mode & 0o777, 0o600);
  assert.ok((await readFile(join(p.run, "files/skills/SKILL.md"))).equals(bytes));
  assert.equal(result.files[0].mode, "100755");
});

test("skill staging inspection refuses incomplete and changed runs", async (t) => {
  for (const hook of ["afterRunCreated", "afterFileWritten", "beforeReceipt", "afterReceiptLinked", "afterReceipt"]) {
    const p = await fixture(t);
    const error = await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes, faults: {[hook]: async () => { throw new Error("RAW_CANARY " + p.sandbox); }}}).catch((e) => e);
    assert.ok(["DEVTWIN_STORAGE_ERROR", "DEVTWIN_STAGE_UNCONFIRMED"].includes(error.code), hook);
    const output = JSON.stringify(toJson(error));
    assert.ok(!output.includes(p.sandbox) && !output.includes(p.fakeHome) && !output.includes("RAW_CANARY"));
    if (hook === "afterReceipt") assert.equal((await inspectAcquisition(p.roots, runId)).status, "staged");
    else await assert.rejects(inspectAcquisition(p.roots, runId), {code: "DEVTWIN_STAGE_INCOMPLETE"});
    if (hook === "afterReceiptLinked" || hook === "afterReceipt") assert.deepEqual(error.details, {runId, next: "inspect"});
  }
  const p = await fixture(t);
  await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes});
  await writeFile(join(p.run, "files/skills/SKILL.md"), "changed");
  await assert.rejects(inspectAcquisition(p.roots, runId), {code: "DEVTWIN_INTEGRITY"});
});

test("skill staging refuses reused run IDs without adopting or writing the old run", async (t) => {
  const p = await fixture(t);
  await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes});
  const before = await treeSnapshot(p.run), calls = p.calls();
  await assert.rejects(stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes}), {code: "DEVTWIN_CONFLICT"});
  assert.equal(p.calls() - calls, 3);
  assert.equal(await treeSnapshot(p.run), before);
  await assert.rejects(stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes: () => "../bad"}), {code: "DEVTWIN_INVALID_INPUT"});
});

test("skill staging enforces tiered private ancestry and never chmods existing directories", async (t) => {
  for (const which of ["pilot", "data", "intermediate", "nonsticky", "sticky"]) {
    const p = await fixture(t);
    let roots = p.roots;
    if (which === "pilot") await chmod(p.pilot.pilotRoot, 0o775);
    if (which === "data") await mkdir(p.dataRoot, {mode: 0o755});
    if (which === "intermediate") {
      await mkdir(join(p.pilot.pilotRoot, "middle"), {mode: 0o775});
      await chmod(join(p.pilot.pilotRoot, "middle"), 0o775);
      roots = rootsFromPilot(await loadPilot(await p.with({dataRoot: join(p.pilot.pilotRoot, "middle/data")}), {home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {}}));
    }
    if (which === "nonsticky" || which === "sticky") await chmod(p.sandbox, which === "sticky" ? 0o1777 : 0o777);
    if (which === "sticky") assert.equal((await stageAcquisition(roots, source, p.input, {request: p.request})).status, "staged");
    else await assert.rejects(stageAcquisition(roots, source, p.input, {request: p.request}), {code: "DEVTWIN_PATH_UNSAFE"});
    if (which === "data") assert.equal((await stat(p.dataRoot)).mode & 0o777, 0o755);
  }
});

test("skill staging inspection rejects extra, linked, renamed and corrupt entries privately", async (t) => {
  for (const mutation of ["extra", "link", "hardlink", "case", "receipt", "mode", "executable", "receipt-executable", "pending"]) {
    const p = await fixture(t);
    await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes});
    const path = join(p.run, "files/skills/SKILL.md");
    if (mutation === "extra") await writeFile(join(p.run, "files/extra"), "x", {mode: 0o600});
    if (mutation === "link") { await rename(path, path + "-old"); await symlink(path + "-old", path); }
    if (mutation === "hardlink") await link(path, join(p.sandbox, "hardlink"));
    if (mutation === "case") await rename(path, join(dirname(path), "skill.md"));
    if (mutation === "receipt") await writeFile(join(p.run, "receipt.json"), "{");
    if (mutation === "mode") await chmod(path, 0o644);
    if (mutation === "executable") await chmod(path, 0o700);
    if (mutation === "receipt-executable") await chmod(join(p.run, "receipt.json"), 0o700);
    if (mutation === "pending") await writeFile(join(p.run, ".receipt-pending"), "x", {mode: 0o600});
    const error = await inspectAcquisition(p.roots, runId).catch((e) => e);
    assert.ok(["DEVTWIN_PATH_UNSAFE", "DEVTWIN_INTEGRITY"].includes(error.code), mutation);
    assert.ok(!JSON.stringify(toJson(error)).includes(p.sandbox));
  }
});

test("skill staging preserves safe rate limit hints and writes nothing on download failure", async (t) => {
  const p = await fixture(t);
  const request = async () => new Response("unread", {status: 429, headers: {"retry-after": "10", "x-ratelimit-reset": "1800000000"}});
  const before = await treeSnapshot(p.pilot.pilotRoot);
  await assert.rejects(stageAcquisition(p.roots, source, p.input, {request}), {code: "DEVTWIN_RATE_LIMITED", details: {retryAfterSeconds: 10, resetAt: "2027-01-15T08:00:00.000Z"}});
  assert.equal(await treeSnapshot(p.pilot.pilotRoot), before);
});

test("skill staging preserves pilot binding and rejects dataRoot parent replacements", async (t) => {
  const p = await fixture(t);
  await stageAcquisition(p.roots, source, p.input, {request: p.request, runIdBytes});
  const changed = rootsFromPilot(await loadPilot(await p.with({forbidden: [...p.forbidden, join(p.sandbox, "more-forbidden")]}), {home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {}}));
  await assert.rejects(inspectAcquisition(changed, runId), {code: "DEVTWIN_GATE_REQUIRED", details: {field: "pilotDigest"}});
  const q = await fixture(t);
  await assert.rejects(stageAcquisition(q.roots, source, q.input, {request: q.request, runIdBytes, faults: {afterRunCreated: async () => {
    await rename(q.run, q.run + "-old"); await mkdir(q.run, {mode: 0o700});
  }}}), {code: "DEVTWIN_PATH_UNSAFE"});
  assert.deepEqual(await readdir(q.run), []);
});
