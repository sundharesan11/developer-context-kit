import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { getSource, loadBundledCatalog } from "../src/skill-sources/catalog.mjs";
import { validateSelection, gitBlobSha, manifestFingerprint } from "../src/skill-sources/selection.mjs";
import { previewAcquisition, downloadAcquisition } from "../src/skill-sources/github-package.mjs";
import { main } from "../src/cli.mjs";
import { makePilot } from "./helpers.mjs";
import { chmod } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const source = getSource(loadBundledCatalog(), "humanizer");
const pin = {sourceId: source.id, channel: "stable-release", tag: "v1", commit: "a".repeat(40)};
const tree = "b".repeat(40);
const stem = "/repos/blader/humanizer/git";
const bytes = Buffer.from("# Synthetic fixture\n");
const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function routes() {
  return {
    [`${stem}/commits/${pin.commit}`]: {sha: pin.commit, tree: {sha: tree}},
    [`${stem}/trees/${tree}?recursive=1`]: {sha: tree, truncated: false, tree: [
      {path: "SKILL.md", type: "blob", mode: "100644", sha: blob, size: bytes.length},
      {path: "LICENSE", type: "blob", mode: "100755", sha: blob, size: bytes.length},
      {path: "unselected +@é.", type: "blob", mode: "100664", sha: blob, size: bytes.length},
      {path: "link", type: "blob", mode: "120000", sha: blob, size: bytes.length}
    ]},
    [`${stem}/blobs/${blob}`]: {sha: blob, size: bytes.length, encoding: "base64", content: bytes.toString("base64")}
  };
}
async function fixture(t, map = routes()) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const entry = map[req.url];
    res.writeHead(entry?.status ?? 200, {"content-type": "application/json", ...entry?.headers});
    res.end(entry?.raw ?? JSON.stringify(entry?.body ?? entry));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (url, opts) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.github.com");
    assert.equal(opts.redirect, "manual");
    assert.ok(opts.signal);
    assert.equal(opts.headers.Authorization, undefined);
    assert.equal(opts.headers.Cookie, undefined);
    return fetch(`http://127.0.0.1:${server.address().port}${parsed.pathname}${parsed.search}`, opts);
  };
  return {request, seen};
}
const input = {pin, files: ["SKILL.md", "LICENSE"]};

test("skill acquisition rejects ambiguous selections before requests", async () => {
  let calls = 0;
  const request = () => { calls++; throw new Error("unexpected request"); };
  for (const files of [[], ["../a"], ["/a"], ["a//b"], ["a\\b"], ["a%2fb"], ["é"], ["a."], [".git/config"], ["id_mapping"], ["a.db"], ["a", "a"], ["A/x", "a/y"], ["a", "a/b"], ["A", "a"]]) {
    await assert.rejects(previewAcquisition(source, {pin, files}, {request}), (e) => ["DEVTWIN_INVALID_INPUT", "DEVTWIN_SELECTION_CONFLICT"].includes(e.code));
  }
  await assert.rejects(previewAcquisition(source, {...input, pin: {...pin, extra: true}}, {request}), {code: "DEVTWIN_INVALID_INPUT"});
  assert.equal(calls, 0);
  assert.deepEqual(validateSelection(source, pin, input.files).files, ["LICENSE", "SKILL.md"]);
  assert.equal(gitBlobSha(Buffer.alloc(0)), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("skill acquisition verifies pinned blob bytes with bounded local transport", async (t) => {
  const {request, seen} = await fixture(t);
  const preview = await previewAcquisition(source, input, {request});
  assert.equal(preview.status, "previewed");
  assert.equal(preview.assessment.pin, "caller-supplied-unverified");
  assert.equal(preview.manifest.totalBytes, bytes.length * 2);
  assert.equal(seen.length, 2);
  const acquired = await downloadAcquisition(source, {...input, fingerprint: preview.fingerprint}, {request});
  assert.equal(seen.length, 6);
  assert.deepEqual(acquired.blobs.map((f) => f.path), ["LICENSE", "SKILL.md"]);
  assert.ok(acquired.blobs.every((f) => f.bytes.equals(bytes)));
  assert.ok(seen.every((path) => !/tags|releases|ref/.test(path)));
  const reversed = await previewAcquisition(source, {...input, files: [...input.files].reverse()}, {request});
  assert.equal(reversed.fingerprint, preview.fingerprint);
  const before = seen.length;
  await assert.rejects(downloadAcquisition(source, {...input, fingerprint: "sha256:" + "0".repeat(64)}, {request}), {code: "DEVTWIN_PREVIEW_CHANGED"});
  assert.equal(seen.length - before, 2);
  assert.notEqual(manifestFingerprint({...preview.manifest, pin: {...pin, tag: "v2"}}), preview.fingerprint);
});

test("skill acquisition refuses truncated trees, unsupported selections and identity changes", async (t) => {
  for (const [mutate, code] of [
    [(r) => { r[`${stem}/trees/${tree}?recursive=1`].truncated = true; }, "UPSTREAM_INVALID"],
    [(r) => { r[`${stem}/commits/${pin.commit}`].sha = tree; }, "UPSTREAM_INVALID"],
    [(r) => { r[`${stem}/trees/${tree}?recursive=1`].tree[0].size = 131073; }, "LIMIT"],
    [(r) => { r[`${stem}/trees/${tree}?recursive=1`].tree.push({...r[`${stem}/trees/${tree}?recursive=1`].tree[0], path: "skill.md"}); }, "SELECTION_CONFLICT"]
  ]) {
    const r = routes(); mutate(r);
    const {request} = await fixture(t, r);
    await assert.rejects(previewAcquisition(source, input, {request}), {code: `DEVTWIN_${code}`});
  }
  const {request} = await fixture(t);
  await assert.rejects(previewAcquisition(source, {pin, files: ["link"]}, {request}), {code: "DEVTWIN_UNSUPPORTED_ENTRY"});
  await assert.rejects(previewAcquisition(source, {pin, files: ["missing"]}, {request}), {code: "DEVTWIN_SELECTION_MISSING"});
});

test("skill acquisition rejects malformed base64 and bytes with a false Git object ID", async (t) => {
  for (const [patch, code] of [
    [{content: "!"}, "UPSTREAM_INVALID"],
    [{encoding: "utf8"}, "UPSTREAM_INVALID"],
    [{size: bytes.length + 1}, "UPSTREAM_INVALID"],
    [{content: Buffer.alloc(bytes.length, 65).toString("base64")}, "INTEGRITY"]
  ]) {
    const r = routes(); Object.assign(r[`${stem}/blobs/${blob}`], patch);
    const {request} = await fixture(t, r);
    const preview = await previewAcquisition(source, input, {request});
    await assert.rejects(downloadAcquisition(source, {...input, fingerprint: preview.fingerprint}, {request}), {code: `DEVTWIN_${code}`});
  }
});

test("skill acquisition handles HTTP errors and streamed size caps without exposing bodies", async (t) => {
  for (const [status, code] of [[301, "REDIRECT_REFUSED"], [404, "SOURCE_NOT_FOUND"], [401, "GITHUB_UNAUTHORIZED"], [403, "GITHUB_FORBIDDEN"], [429, "RATE_LIMITED"], [500, "UPSTREAM_UNAVAILABLE"]]) {
    const r = routes(); r[`${stem}/commits/${pin.commit}`] = {status, raw: "PRIVATE_RESPONSE_CANARY", headers: {location: "https://elsewhere.invalid"}};
    const {request, seen} = await fixture(t, r);
    await assert.rejects(previewAcquisition(source, input, {request}), (e) => e.code === `DEVTWIN_${code}` && !JSON.stringify(e).includes("PRIVATE_RESPONSE_CANARY"));
    assert.equal(seen.length, 1);
  }
  const request = async () => new Response("x".repeat(2097153), {headers: {"content-type": "application/json"}});
  await assert.rejects(previewAcquisition(source, input, {request}), {code: "DEVTWIN_LIMIT"});
});

async function cli(args, options = {}) {
  let output = "";
  const code = await main(args, {...options, stdout: {write: (value) => { output += value; }}});
  return {code, ...JSON.parse(output)};
}
const selectionArgs = ["--source", "humanizer", "--pin-json", JSON.stringify(pin), "--files-json", JSON.stringify(input.files)];
test("skill acquisition CLI preserves old gates and explicit selection", async (t) => {
  const p = await makePilot(t), {request, seen} = await fixture(t);
  const opts = {request, home: p.fakeHome, env: {}};
  const preview = await cli(["skill-sources", "preview", ...selectionArgs], opts);
  assert.equal(preview.code, 0);
  const args = ["skill-sources", "stage", "--pilot", p.path, ...selectionArgs, "--preview-hash", preview.result.fingerprint];
  const staged = await cli(args, opts);
  assert.equal(staged.code, 0);
  const calls = seen.length;
  const inspected = await cli(["skill-sources", "inspect", "--pilot", p.path, "--run", staged.result.runId], opts);
  assert.equal(inspected.code, 0);
  assert.deepEqual(inspected.result, staged.result);
  assert.equal(seen.length, calls);
  for (const route of ["stage", "inspect"]) {
    assert.equal((await cli(["skill-sources", route], opts)).error.code, "DEVTWIN_GATE_REQUIRED");
  }
  for (const extra of [["--run", "x"], ["--source", "humanizer"], ["--data-root", p.dataRoot], ["--config-root=x"], ["--state-root=x"]]) {
    assert.equal((await cli([...args, ...extra], opts)).error.code, "DEVTWIN_USAGE");
  }
  assert.equal(seen.length, calls);
  assert.equal((await cli(["skill-sources", "preview", ...selectionArgs, "--pilot", p.path], opts)).error.code, "DEVTWIN_USAGE");
  await chmod(p.pilot.pilotRoot, 0o777);
  const refused = await cli(args, opts);
  assert.equal(refused.error.code, "DEVTWIN_PATH_UNSAFE");
  assert.ok(!JSON.stringify(refused).includes(p.sandbox));
  const malformedPilot = await p.with({pilotRoot: p.sandbox + "/" + "x".repeat(5000)});
  const preStage = await cli(["skill-sources", "inspect", "--pilot", malformedPilot, "--run", "stage_" + "00".repeat(16)], opts);
  assert.equal(preStage.error.code, "DEVTWIN_STORAGE_ERROR");
  assert.ok(!JSON.stringify(preStage).includes(p.sandbox));
});

test("skill acquisition fingerprint has a fixed canonical byte contract", () => {
  const manifest = {schemaVersion: 1, sourceId: "humanizer", repository: {owner: "blader", name: "humanizer"}, pin, tree, selection: ["SKILL.md"], files: [{path: "SKILL.md", blob: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", mode: "100644", size: 0}], totalBytes: 0};
  assert.equal(manifestFingerprint(manifest), "sha256:bc0aafc1e8f1be3ff60905daa286bb93a05712cbfe0f459603286e6daa3c1448");
});

test("skill acquisition bounds decoded files, tree counts and aggregate response bytes", async () => {
  const emptyBlob = gitBlobSha(Buffer.alloc(0));
  const files = Array.from({length: 24}, (_, i) => `file-${i}`);
  const entries = files.map((path) => ({path, mode: "100644", type: "blob", sha: emptyBlob, size: 0}));
  let calls = 0;
  function transport({count = false, sizes = false, padding = false} = {}) {
    return async (url) => {
      calls++;
      let body;
      if (url.includes("/commits/")) body = {sha: pin.commit, tree: {sha: tree}};
      else if (url.includes("/trees/")) body = {sha: tree, truncated: false, tree: count ? Array.from({length: 10001}, (_, i) => ({...entries[0], path: `p${i}`})) : sizes ? entries.map((e) => ({...e, size: 131072})) : entries};
      else body = {sha: emptyBlob, size: 0, encoding: "base64", content: ""};
      if (padding) body.padding = " ".repeat(url.includes("/blobs/") ? 250000 : 2000000);
      return new Response(JSON.stringify(body), {headers: {"content-type": "application/json"}});
    };
  }
  await assert.rejects(previewAcquisition(source, {pin, files}, {request: transport({count: true})}), {code: "DEVTWIN_LIMIT"});
  await assert.rejects(previewAcquisition(source, {pin, files}, {request: transport({sizes: true})}), {code: "DEVTWIN_LIMIT"});
  const preview = await previewAcquisition(source, {pin, files}, {request: transport()});
  calls = 0;
  const acquired = await downloadAcquisition(source, {pin, files, fingerprint: preview.fingerprint}, {request: transport()});
  assert.equal(calls, 26);
  assert.equal(acquired.blobs.length, 24);
  assert.ok(acquired.blobs.every((b) => b.bytes.length === 0));
  await assert.rejects(downloadAcquisition(source, {pin, files, fingerprint: preview.fingerprint}, {request: transport({padding: true})}), {code: "DEVTWIN_LIMIT"});
});

test("skill acquisition validates wrapped base64, compressed JSON and protocol faults", async (t) => {
  const r = routes();
  r[`${stem}/blobs/${blob}`].content = bytes.toString("base64").match(/.{1,4}/g).join("\r\n");
  const compressed = gzipSync(JSON.stringify(r[`${stem}/commits/${pin.commit}`]));
  r[`${stem}/commits/${pin.commit}`] = {raw: compressed, headers: {"content-encoding": "gzip", "content-length": String(compressed.length)}};
  const f = await fixture(t, r);
  const p = await previewAcquisition(source, input, {request: f.request});
  assert.equal((await downloadAcquisition(source, {...input, fingerprint: p.fingerprint}, {request: f.request})).blobs.length, 2);
  for (const response of [
    new Response(Buffer.from([255]), {headers: {"content-type": "application/json"}}),
    new Response("{}", {headers: {"content-type": "text/plain"}}),
    new Response("{}", {headers: {"content-type": "application/json", "content-length": "3"}}),
    new Response("{}", {headers: {"content-type": "application/json", "content-length": "bad"}})
  ]) await assert.rejects(previewAcquisition(source, input, {request: async () => response}), {code: "DEVTWIN_UPSTREAM_INVALID"});
  await assert.rejects(previewAcquisition(source, input, {request: async () => { throw new Error("canary"); }}), {code: "DEVTWIN_NETWORK_UNAVAILABLE"});
});

test("skill acquisition deadlines cancel hanging bodies and bound the whole operation", async (t) => {
  let canceled = false;
  const request = async () => new Response(new ReadableStream({pull: () => new Promise(() => undefined), cancel: () => { canceled = true; }}), {headers: {"content-type": "application/json"}});
  await assert.rejects(previewAcquisition(source, input, {request}), {code: "DEVTWIN_NETWORK_TIMEOUT"});
  assert.equal(canceled, true);
  let clockReads = 0, calls = 0;
  const mocked = t.mock.method(performance, "now", () => ++clockReads < 3 ? 0 : 30001);
  await assert.rejects(previewAcquisition(source, input, {request: async () => { calls++; return new Response(JSON.stringify({sha: pin.commit, tree: {sha: tree}}), {headers: {"content-type": "application/json"}}); }}), {code: "DEVTWIN_NETWORK_TIMEOUT"});
  mocked.mock.restore();
  assert.equal(calls, 1);
});
