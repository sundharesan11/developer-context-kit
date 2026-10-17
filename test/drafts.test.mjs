import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { makePilot, now, runCli } from "./helpers.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
const cli = (p, args = []) => runCli(["draft", "save", "--pilot", p.path, ...args]);
async function bodyFile(p, text, name = "draft.md") {
  const path = join(p.inputsRoot, name);
  await writeFile(path, text);
  return path;
}
const BODY = "Hi team,\n\nThe billing API rollout finished today.\n";
test("draft save previews the destination and hash, and apply writes the draft under dataRoot/drafts with mode 0600", async (t) => {
  const p = await makePilot(t);
  const file = await bodyFile(p, BODY);
  const plan = await cli(p, ["--body-file", file]);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  const result = plan.json.result;
  assert.equal(result.preview, true);
  assert.equal(result.scope, null);
  assert.equal(result.destination.root, "dataRoot");
  assert.match(result.destination.path, /^drafts\/draft-[a-f0-9]{24}\.md$/);
  assert.match(result.bodyHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.bytes, Buffer.byteLength(BODY));
  assert.match(result.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(result).includes(p.dataRoot));
  await assert.rejects(access(join(p.dataRoot, "drafts")));
  const applied = await cli(p, ["--body-file", file, "--apply", "--plan-fingerprint", result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.deepEqual(applied.json.result.destination, result.destination);
  assert.equal(applied.json.result.bodyHash, result.bodyHash);
  const written = join(p.dataRoot, result.destination.path);
  assert.equal(await readFile(written, "utf8"), BODY);
  assert.equal((await stat(written)).mode & 0o777, 0o600);
  assert.equal((await stat(join(p.dataRoot, "drafts"))).mode & 0o777, 0o700);
  const again = await cli(p, ["--body-file", file, "--apply", "--plan-fingerprint", result.fingerprint]);
  assert.equal(again.json.error.code, "DEVCTX_CONFLICT");
});
test("draft save with --scope writes under dataRoot/scopes/<scope>/drafts and an unknown scope fails", async (t) => {
  const p = await makePilot(t);
  await applyScopeAdd(p.roots, { scope: "alpha", hubs: [], policies: [], now });
  const file = await bodyFile(p, BODY);
  const plan = await cli(p, ["--body-file", file, "--scope", "alpha"]);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  assert.equal(plan.json.result.scope, "alpha");
  assert.match(plan.json.result.destination.path, /^scopes\/alpha\/drafts\/draft-[a-f0-9]{24}\.md$/);
  const applied = await cli(p, ["--body-file", file, "--scope", "alpha", "--apply", "--plan-fingerprint", plan.json.result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal(await readFile(join(p.dataRoot, plan.json.result.destination.path), "utf8"), BODY);
  await assert.rejects(access(join(p.dataRoot, "drafts")));
  const unknown = await cli(p, ["--body-file", file, "--scope", "globex"]);
  assert.equal(unknown.json.error.code, "DEVCTX_SCOPE_UNKNOWN");
  const unknownApply = await cli(p, ["--body-file", file, "--scope", "globex", "--apply", "--plan-fingerprint", plan.json.result.fingerprint]);
  assert.equal(unknownApply.json.error.code, "DEVCTX_SCOPE_UNKNOWN");
  await assert.rejects(access(join(p.dataRoot, "scopes", "globex")));
});
test("draft save preview states that a draft saved here cannot be sent by routing later", async (t) => {
  const p = await makePilot(t);
  const plan = await cli(p, ["--body-file", await bodyFile(p, BODY)]);
  assert.equal(plan.json.result.sendable, false);
  assert.match(plan.json.result.note, /cannot be sent by routing later/);
  assert.match(plan.json.result.note, /connect draft/);
});
test("draft save refuses a body file outside inputsRoot with GATE_REQUIRED", async (t) => {
  const p = await makePilot(t);
  const outside = join(p.sandbox, "outside.md");
  await writeFile(outside, BODY);
  const res = await cli(p, ["--body-file", outside]);
  assert.equal(res.code, 1);
  assert.equal(res.json.error.code, "DEVCTX_GATE_REQUIRED");
  const missing = await cli(p, []);
  assert.equal(missing.json.error.code, "DEVCTX_INVALID_INPUT");
});
test("draft save refuses a body containing a JWT with SENSITIVE_CONTENT and writes nothing", async (t) => {
  const p = await makePilot(t);
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ4In0", "c2lnbmF0dXJlMDA"].join(".");
  const res = await cli(p, ["--body-file", await bodyFile(p, "Note: " + jwt + "\n")]);
  assert.equal(res.json.error.code, "DEVCTX_SENSITIVE_CONTENT");
  await assert.rejects(access(join(p.dataRoot, "drafts")));
});
test("draft save apply with a mismatched or missing fingerprint writes nothing", async (t) => {
  const p = await makePilot(t);
  const file = await bodyFile(p, BODY);
  const plan = await cli(p, ["--body-file", file]);
  await writeFile(file, BODY + "Edited after preview.\n");
  const stale = await cli(p, ["--body-file", file, "--apply", "--plan-fingerprint", plan.json.result.fingerprint]);
  assert.equal(stale.json.error.code, "DEVCTX_PLAN_MISMATCH");
  const missing = await cli(p, ["--body-file", file, "--apply"]);
  assert.equal(missing.json.error.code, "DEVCTX_PLAN_REQUIRED");
  await assert.rejects(access(join(p.dataRoot, "drafts")));
});
test("draft save is listed in help and takes no message-type or send option", async () => {
  const help = await runCli(["help"]);
  assert.ok(help.json.result.commands.includes("draft save"));
  assert.ok(!help.json.result.commands.some((c) => /^draft (send|post|schedule)/.test(c)));
  const { draftSaveCommand } = await import("../src/drafts/commands.mjs");
  assert.deepEqual(Object.keys(draftSaveCommand.options).sort(), ["apply", "body-file", "plan-fingerprint", "scope"]);
});
