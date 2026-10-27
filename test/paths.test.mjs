import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile, stat, realpath } from "node:fs/promises";
import { makePilot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { confirmedPath, readKitHead } from "../src/paths/confirm.mjs";
import { sha256 } from "../src/storage/canonical.mjs";

const COMMIT_A = "a".repeat(40), COMMIT_B = "b".repeat(40);
// A kit folder with a Git HEAD on a branch; no Git process runs.
async function fakeKit(dir, { commit = COMMIT_A } = {}) {
  await mkdir(join(dir, ".git/refs/heads"), { recursive: true });
  await writeFile(join(dir, ".git/HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(dir, ".git/refs/heads/main"), commit + "\n");
  return realpath(dir);
}
async function fixture(t) {
  const p = await makePilot(t);
  await main(["init", "--pilot", p.path, "--actor", "email:owner@example.com", "--apply"], { stdout: { write: () => true }, now, home: p.fakeHome, env: {} });
  const kit = await fakeKit(join(p.sandbox, "kit"));
  const run = async (args, seams = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", p.path], { stdout: { write(value) { chunks.push(value); return true; } }, now, home: p.fakeHome, env: {}, kitRoot: kit, ...seams });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  return { ...p, kit, run };
}

test("paths confirm previews, applies after the owner dialog and paths check reports each field", async (t) => {
  const f = await fixture(t);
  const preview = (await f.run(["paths", "confirm"])).json.result;
  assert.equal(preview.preview, true);
  assert.equal(preview.kitRoot, f.kit);
  assert.equal(preview.kitHead, "ref: refs/heads/main");
  assert.equal(preview.kitRef, COMMIT_A);
  assert.equal(preview.pilotPath, await realpath(f.path));
  assert.equal(preview.pilotSha256, sha256(await readFile(f.path)));
  assert.equal((await f.run(["paths", "check"])).json.result.state, "missing");
  // The apply needs the fingerprint and the owner dialog, which shows both paths.
  assert.equal((await f.run(["paths", "confirm", "--apply"])).json.error.code, "DEVTWIN_PLAN_REQUIRED");
  const refused = await f.run(["paths", "confirm", "--apply", "--plan-fingerprint", preview.fingerprint], { ownerDialog: () => "denied" });
  assert.equal(refused.json.error.code, "DEVTWIN_OWNER_DENIED");
  await assert.rejects(stat(confirmedPath(f.stateRoot)), { code: "ENOENT" });
  const shown = [];
  const applied = await f.run(["paths", "confirm", "--apply", "--plan-fingerprint", preview.fingerprint], { ownerDialog: (content) => { shown.push(content); return "approved"; } });
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json.error));
  assert.ok(shown[0].body.includes(f.kit) && shown[0].body.includes(preview.pilotPath), shown[0].body);
  assert.equal((await stat(confirmedPath(f.stateRoot))).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(confirmedPath(f.stateRoot), "utf8"));
  assert.deepEqual(saved, { schemaVersion: 1, kitRoot: f.kit, kitHead: "ref: refs/heads/main", kitRef: COMMIT_A, pilotPath: preview.pilotPath, pilotSha256: preview.pilotSha256, confirmedAt: now().toISOString() });
  const check = (await f.run(["paths", "check"])).json.result;
  assert.equal(check.state, "confirmed");
  assert.deepEqual(Object.values(check.fields), ["match", "match", "match", "match", "match"]);
  // A new kit commit and an edited config each show as a mismatch of their own field.
  await writeFile(join(f.kit, ".git/refs/heads/main"), COMMIT_B + "\n");
  const moved = (await f.run(["paths", "check"])).json.result;
  assert.equal(moved.state, "mismatch");
  assert.deepEqual(moved.fields, { kitRoot: "match", kitHead: "match", kitRef: "mismatch", pilotPath: "match", pilotSha256: "match" });
  await writeFile(join(f.kit, ".git/refs/heads/main"), COMMIT_A + "\n");
  await writeFile(f.path, (await readFile(f.path, "utf8")) + "\n");
  const edited = (await f.run(["paths", "check"])).json.result;
  assert.deepEqual(edited.fields, { kitRoot: "match", kitHead: "match", kitRef: "match", pilotPath: "match", pilotSha256: "mismatch" });
  // A stale preview is refused after the edit.
  assert.equal((await f.run(["paths", "confirm", "--apply", "--plan-fingerprint", preview.fingerprint], { ownerDialog: () => "approved" })).json.error.code, "DEVTWIN_PLAN_MISMATCH");
});

test("paths confirm reads a detached HEAD and packed refs without Git", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.kit, ".git/HEAD"), COMMIT_B + "\n");
  assert.deepEqual(readKitHead(f.kit), { kitHead: COMMIT_B, kitRef: null });
  await writeFile(join(f.kit, ".git/HEAD"), "ref: refs/heads/release\n");
  await writeFile(join(f.kit, ".git/packed-refs"), "# pack-refs with: peeled\n" + COMMIT_A + " refs/heads/release\n");
  assert.deepEqual(readKitHead(f.kit), { kitHead: "ref: refs/heads/release", kitRef: COMMIT_A });
  await writeFile(join(f.kit, ".git/HEAD"), "ref: refs/../../../etc/passwd\n");
  assert.throws(() => readKitHead(f.kit), (e) => e.code === "DEVTWIN_GATE_REQUIRED");
  // A kit with no Git folder cannot be confirmed.
  const bare = join(f.sandbox, "bare-kit");
  await mkdir(bare);
  const out = await f.run(["paths", "confirm"], { kitRoot: bare });
  assert.equal(out.json.error.code, "DEVTWIN_GATE_REQUIRED");
});

test("paths confirm --apply from a hooked agent shell is denied", async (t) => {
  const shell = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const kit = "node /opt/kit/bin/devtwin.mjs";
  assert.equal(ownerAction("claude", shell(kit + " paths confirm --pilot /x/live.json --apply --plan-fingerprint sha256:00")), "paths confirm --apply");
  assert.equal(ownerAction("codex", shell("env " + kit + " paths confirm --pilot /x/live.json --ap\"\"ply")), "paths confirm --apply");
  assert.equal(ownerAction("claude", shell(kit + " setup apply --pilot /x/live.json --step paths-confirm --plan-fingerprint sha256:00")), "setup apply --step paths-confirm");
  assert.equal(ownerAction("claude", shell(kit + " paths confirm --pilot /x/live.json")), null, "the preview stays open");
  assert.equal(ownerAction("claude", shell(kit + " paths check --pilot /x/live.json")), null);
  // Through the hook route itself, the call prints only the deny.
  const f = await fixture(t);
  const chunks = [];
  const payload = { session_id: "s1", cwd: f.sandbox, hook_event_name: "PreToolUse", ...shell(kit + " paths confirm --pilot " + f.path + " --apply") };
  await main(["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", f.path], { stdout: { write(v) { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now });
  assert.equal(JSON.parse(chunks.join("")).hookSpecificOutput.permissionDecision, "deny");
});
