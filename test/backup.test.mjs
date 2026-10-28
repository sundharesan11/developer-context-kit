import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile, lstat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { makePilot, now, treeSnapshot } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyInit, applyScopeAdd } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { seal, unseal, KEEP } from "../src/backup/archive.mjs";
import { securityKeychain, readArgs, WRITE_ARGS, SERVICE } from "../src/backup/keychain.mjs";

const DAY = 86400000;
// A Keychain stand-in that records each call.
function fakeKeychain() {
  let stored = null;
  const calls = [];
  return { calls, read: async () => { calls.push("read"); return stored ? Buffer.from(stored) : null; }, write: async (key) => { calls.push("write"); stored = Buffer.from(key); }, stored: () => stored };
}
// Every regular file under dir: relative path -> { bytes, mode }.
async function files(dir) {
  const out = {};
  async function walk(path) {
    for (const name of await readdir(path)) {
      const child = join(path, name), st = await lstat(child);
      if (st.isDirectory()) await walk(child);
      else if (st.isFile()) out[relative(dir, child)] = { bytes: (await readFile(child)).toString("hex"), mode: st.mode & 0o777 };
    }
  }
  if (existsSync(dir)) await walk(dir);
  return out;
}
const CACHES = ["lessons/example.json", "summaries/s1.json", "hooks/sessions/k.json", "hooks/budget.jsonl", "hooks/budget.jsonl.1"];
async function machine(t, { backup = true } = {}) {
  const p = await makePilot(t), folder = join(p.pilot.pilotRoot, "backups");
  const path = await p.with(backup ? { writeClasses: { backupTargets: [folder] } } : {});
  const roots = rootsFromPilot(await loadPilot(path, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} }));
  await applyInit(roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  await applyScopeAdd(roots, { scope: "example", hubs: [], policies: [], now });
  // A nested data file with its own mode, the caches the archive leaves out, and a link it skips.
  await mkdir(join(p.dataRoot, "notes/deep"), { recursive: true, mode: 0o700 });
  await writeFile(join(p.dataRoot, "notes/deep/plain.md"), "example-marker-text\n", { mode: 0o640 });
  await chmod(join(p.dataRoot, "notes/deep/plain.md"), 0o640);
  await writeFile(join(p.dataRoot, "notes/empty.bin"), Buffer.alloc(0), { mode: 0o600 });
  for (const rel of CACHES) { await mkdir(join(p.stateRoot, rel, ".."), { recursive: true, mode: 0o700 }); await writeFile(join(p.stateRoot, rel), "cache\n", { mode: 0o600 }); }
  await symlink(join(p.dataRoot, "notes/deep/plain.md"), join(p.dataRoot, "notes/link.md"));
  const keychain = fakeKeychain(), dialogs = [];
  let clock = now(), decision = "approved";
  const cli = async (args, { env = {} } = {}) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path], { stdout: { write: (v) => { chunks.push(v); return true; } }, now: () => clock, home: p.fakeHome, env, keychain,
      ownerDialog: async (c) => { dialogs.push(c); return decision; } });
    return { code, text: chunks.join(""), json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => { const out = await cli(args); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const fail = async (args, code) => { const out = await cli(args); assert.equal(out.json.ok, false, args.join(" ")); assert.equal(out.json.error.code, code, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.error; };
  const create = async () => { const plan = await ok(["backup", "create"]); return ok(["backup", "create", "--apply", "--plan-fingerprint", plan.fingerprint]); };
  const restore = async (from, to) => { const plan = await ok(["backup", "restore", "--from", from, "--to", to]); return { plan, done: await ok(["backup", "restore", "--from", from, "--to", to, "--apply", "--plan-fingerprint", plan.fingerprint]) }; };
  return { p, path, folder, roots, keychain, dialogs, cli, ok, fail, create, restore, deny: () => { decision = "denied"; }, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
// The files of the three roots that a backup holds: everything but the caches and the locks.
async function storeFiles(m) {
  const out = {};
  for (const [name, root] of [["config", m.p.configRoot], ["data", m.p.dataRoot], ["state", m.p.stateRoot]]) {
    for (const [rel, value] of Object.entries(await files(root))) {
      if (name === "state" && (CACHES.includes(rel) || rel.startsWith("locks/"))) continue;
      out[name + "/" + rel] = value;
    }
  }
  return out;
}

test("create then restore into a new folder gives the same bytes and modes for every archived file (AE8)", async (t) => {
  const m = await machine(t);
  const preview = await m.ok(["backup", "create"]);
  assert.equal(preview.preview, true);
  assert.equal(preview.target, m.folder);
  assert.equal(existsSync(m.folder), false, "the preview writes nothing");
  const made = await m.ok(["backup", "create", "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.equal(made.keyCreated, true);
  // Read, make, read back, then read again just before sealing.
  assert.deepEqual(m.keychain.calls, ["read", "write", "read", "read"]);
  assert.match(made.archive, /devtwin-backup-20261007T000000Z-[0-9a-f]{8}\.dtb$/);
  assert.equal((await stat(made.archive)).mode & 0o777, 0o600);
  assert.equal((await stat(m.folder)).mode & 0o777, 0o700);
  assert.equal((await readFile(made.archive)).includes("example-marker-text"), false, "the archive is encrypted");
  const expected = await storeFiles(m);
  assert.ok(expected["data/notes/deep/plain.md"] && expected["data/notes/empty.bin"] && expected["config/scopes/example.json"]);
  assert.equal(expected["data/notes/deep/plain.md"].mode, 0o640);
  assert.equal(made.files, Object.keys(expected).length);
  assert.equal(made.skipped, 1, "the link is skipped");

  const to = join(m.folder, "restored");
  const { plan, done } = await m.restore(made.archive, to);
  assert.equal(plan.files, made.files);
  assert.deepEqual([done.restored, done.files, done.verified], [true, made.files, made.files]);
  assert.equal((await stat(to)).mode & 0o777, 0o700);
  const restored = await files(to);
  assert.deepEqual(restored, expected);
  // The caches, the locks and the link are not in the archive.
  for (const rel of CACHES) assert.equal(restored["state/" + rel], undefined, rel);
  assert.equal(Object.keys(restored).some((rel) => rel.startsWith("state/locks/")), false);
  assert.equal(restored["data/notes/link.md"], undefined);
  const status = await m.ok(["backup", "status"]);
  assert.deepEqual(status.folders.map((f) => [f.folder, f.archives, f.newestAt]), [[m.folder, 1, "2026-10-07T00:00:00Z"]]);
  assert.equal(status.keyExported, false);
});

test("the fifteenth archive removes the oldest", async (t) => {
  const m = await machine(t);
  const made = [];
  for (let i = 0; i < KEEP + 1; i++) { made.push((await m.create()).archive); m.advance(DAY); }
  const left = (await readdir(m.folder)).sort();
  assert.equal(left.length, KEEP);
  assert.equal(existsSync(made[0]), false, "the oldest is gone");
  assert.deepEqual(left, made.slice(1).map((path) => relative(m.folder, path)).sort());
  assert.equal(m.keychain.calls.filter((c) => c === "write").length, 1, "one key for every archive");
});

test("retention keeps the newest archive of each of the newest fourteen days; twenty creates on one day keep the earlier days", async (t) => {
  const m = await machine(t);
  const daily = [];
  for (let i = 0; i < 3; i++) { daily.push(relative(m.folder, (await m.create()).archive)); m.advance(DAY); }
  const today = [];
  for (let i = 0; i < 20; i++) { const made = await m.create(); today.push(relative(m.folder, made.archive)); m.advance(60000); }
  assert.deepEqual((await readdir(m.folder)).sort(), [...daily, today.at(-1)].sort(), "each earlier day keeps its archive; today keeps its newest");
  // Twelve more days make sixteen days with archives: the oldest two days go.
  for (let i = 0; i < 12; i++) { m.advance(DAY); await m.create(); }
  const left = (await readdir(m.folder)).sort();
  assert.equal(left.length, KEEP);
  assert.deepEqual(daily.map((name) => left.includes(name)), [false, false, true], "the oldest days go first");
  assert.ok(left.includes(today.at(-1)));
});

test("the backup key is made under the backup-key lock and read again before sealing", async (t) => {
  const m = await machine(t);
  const plan = await m.ok(["backup", "create"]);
  const lock = join(m.p.stateRoot, "locks", "backup-key.lock");
  await mkdir(join(m.p.stateRoot, "locks"), { recursive: true, mode: 0o700 });
  await writeFile(lock, JSON.stringify({ pid: process.pid, host: "example.invalid", owner: { kind: "test" } }), { mode: 0o600 });
  const busy = await m.fail(["backup", "create", "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_BUSY");
  assert.equal(busy.details.lock, "backup-key");
  assert.deepEqual(m.keychain.calls, [], "no key is read or made while another create holds the lock");
  await rm(lock);
  // Another key replaced this one after it was made: create stops before it writes an archive no key opens.
  const read = m.keychain.read;
  let reads = 0;
  m.keychain.read = async () => { reads += 1; return reads === 3 ? Buffer.alloc(32, 7) : read(); };
  const error = await m.fail(["backup", "create", "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_CONFLICT");
  assert.equal(error.details.field, "keychain");
  assert.equal(existsSync(m.folder) ? (await readdir(m.folder)).length : 0, 0);
  m.keychain.read = read;
  assert.equal((await m.create()).keyCreated, false);
});

test("a held scope lock or the audit lock makes create skip with BUSY and write nothing", async (t) => {
  const m = await machine(t);
  const plan = await m.ok(["backup", "create"]);
  for (const lock of ["example", "audit", "held"]) {
    const path = join(m.p.stateRoot, "locks", lock + ".lock");
    await mkdir(join(m.p.stateRoot, "locks"), { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ pid: process.pid, host: "example.invalid", owner: { kind: "test" } }), { mode: 0o600 });
    const error = await m.fail(["backup", "create", "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_BUSY");
    assert.equal(error.details.lock, lock);
    assert.equal(existsSync(m.folder), false, lock);
    assert.deepEqual(m.keychain.calls, [], "no key is made");
    assert.equal(existsSync(path), true, "the held lock stays");
    await rm(path);
    assert.deepEqual((await readdir(join(m.p.stateRoot, "locks"))).sort(), [], "every lock taken is released");
  }
  assert.equal((await m.create()).created, true);
});

test("restore refuses an existing folder, a non-empty folder and a folder outside the backup folder before it writes (AE8)", async (t) => {
  const m = await machine(t);
  const { archive } = await m.create();
  const empty = join(m.folder, "empty"), full = join(m.folder, "full");
  await mkdir(empty, { mode: 0o700 });
  await mkdir(full, { mode: 0o700 });
  await writeFile(join(full, "keep.txt"), "keep\n");
  const before = await treeSnapshot(m.p.pilot.pilotRoot);
  for (const [to, code] of [[empty, "DEVTWIN_CONFLICT"], [full, "DEVTWIN_CONFLICT"], [m.folder, "DEVTWIN_GATE_REQUIRED"], [join(m.p.pilot.pilotRoot, "elsewhere"), "DEVTWIN_GATE_REQUIRED"],
    [join(m.p.stateRoot, "restored"), "DEVTWIN_GATE_REQUIRED"], [join(m.folder, "missing/restored"), "DEVTWIN_NOT_FOUND"], ["relative/restored", "DEVTWIN_INVALID_INPUT"]]) {
    await m.fail(["backup", "restore", "--from", archive, "--to", to], code);
    await m.fail(["backup", "restore", "--from", archive, "--to", to, "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], code);
  }
  assert.equal(await treeSnapshot(m.p.pilot.pilotRoot), before, "nothing is written");
});

test("restore is an owner action: a denied dialog writes nothing", async (t) => {
  const m = await machine(t);
  const { archive } = await m.create();
  const to = join(m.folder, "restored"), plan = await m.ok(["backup", "restore", "--from", archive, "--to", to]);
  m.deny();
  await m.fail(["backup", "restore", "--from", archive, "--to", to, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
  assert.equal(existsSync(to), false);
  assert.equal(m.dialogs.at(-1).title, "devtwin: Restore a backup");
});

test("a flipped byte fails authentication and restore writes nothing", async (t) => {
  const m = await machine(t);
  const { archive } = await m.create();
  const to = join(m.folder, "restored"), plan = await m.ok(["backup", "restore", "--from", archive, "--to", to]);
  const bytes = await readFile(archive);
  for (const at of [3, 9, Math.floor(bytes.length / 2), bytes.length - 1]) {
    const bad = Buffer.from(bytes);
    bad[at] ^= 0x01;
    const copy = join(m.folder, "flipped-" + at + ".dtb");
    await writeFile(copy, bad, { mode: 0o600 });
    const before = await treeSnapshot(m.folder);
    const error = await m.fail(["backup", "restore", "--from", copy, "--to", to], "DEVTWIN_INTEGRITY");
    if (at > 9) assert.match(error.message, /authentication/);
    await m.fail(["backup", "restore", "--from", copy, "--to", to, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_INTEGRITY");
    assert.equal(await treeSnapshot(m.folder), before, "nothing is written");
    assert.equal(existsSync(to), false);
  }
});

test("restore refuses a manifest path that leaves its folder, even in an authenticated archive", async (t) => {
  const m = await machine(t);
  await m.create();
  const key = m.keychain.stored(), body = Buffer.from("escape\n");
  const hash = createHash("sha256").update(body).digest("hex");
  const wrong = seal(key, { schemaVersion: 1, createdAt: "x", files: [{ root: "data", path: "ok.txt", mode: 0o600, size: body.length, sha256: "0".repeat(64) }], skipped: [] }, [body]);
  assert.throws(() => unseal(key, wrong), (e) => e.code === "DEVTWIN_INTEGRITY", "a wrong hash fails");
  const to = join(m.folder, "restored");
  for (const path of ["../escape.txt", "a/../../escape.txt", "/tmp/escape.txt", "./x", "a//b", "a\\..\\b", ""]) {
    const crafted = seal(key, { schemaVersion: 1, createdAt: now().toISOString(), files: [{ root: "data", path, mode: 0o600, size: body.length, sha256: hash }], skipped: [] }, [body]);
    assert.throws(() => unseal(key, crafted), (e) => e.code === "DEVTWIN_INTEGRITY", JSON.stringify(path));
    const file = join(m.folder, "crafted.dtb");
    await writeFile(file, crafted, { mode: 0o600 });
    const before = await treeSnapshot(m.p.pilot.pilotRoot);
    await m.fail(["backup", "restore", "--from", file, "--to", to], "DEVTWIN_INTEGRITY");
    assert.equal(await treeSnapshot(m.p.pilot.pilotRoot), before, JSON.stringify(path));
    await rm(file);
  }
  // A root the archive does not know, and a file that is also a folder of another file, fail too.
  for (const list of [[{ root: "home", path: "x" }], [{ root: "data", path: "a" }, { root: "data", path: "a/b" }]]) {
    const crafted = seal(key, { schemaVersion: 1, createdAt: "x", files: list.map((f) => ({ ...f, mode: 0o600, size: body.length, sha256: hash })), skipped: [] }, list.map(() => body));
    assert.throws(() => unseal(key, crafted), (e) => e.code === "DEVTWIN_INTEGRITY", JSON.stringify(list));
  }
  assert.equal(existsSync(join(m.p.pilot.pilotRoot, "escape.txt")), false);
});

test("backup key export --apply from a hooked agent shell is denied; its preview stays open", () => {
  const shell = (command) => ownerAction("claude", { tool_name: "Bash", tool_input: { command } });
  assert.equal(shell("devtwin backup key export --pilot /x/live.json --apply --plan-fingerprint s"), "backup key export --apply");
  assert.equal(shell("node \"$DEVTWIN_KIT/bin/devtwin.mjs\" backup key export --apply"), "backup key export --apply");
  assert.equal(ownerAction("codex", { tool_name: "exec_command", tool_input: { command: ["devtwin", "backup", "key", "export", "--apply"] } }), "backup key export --apply");
  assert.equal(shell("devtwin backup restore --from /x/a.dtb --to /x/new --apply"), "backup restore --apply");
  for (const open of ["devtwin backup key export --pilot /x/live.json", "devtwin backup restore --from /x/a.dtb --to /x/new", "devtwin backup create --apply --plan-fingerprint s", "devtwin backup status"]) assert.equal(shell(open), null, open);
});

test("key export: a denied dialog prints nothing and writes no receipt; an approved one prints the key once with a time-only receipt", async (t) => {
  const m = await machine(t);
  const plan = await m.ok(["backup", "key", "export"]);
  assert.deepEqual([plan.preview, plan.exportedBefore], [true, false]);
  assert.match(plan.warning, /outside any agent session/);
  // No key yet: the export makes none.
  await m.fail(["backup", "key", "export", "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_NOT_FOUND");
  await m.create();
  const hex = m.keychain.stored().toString("hex"), receipt = join(m.p.stateRoot, "backup", "key-export.json");
  m.deny();
  const denied = await m.cli(["backup", "key", "export", "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(denied.json.error.code, "DEVTWIN_OWNER_DENIED");
  assert.equal(denied.text.includes(hex), false);
  assert.equal(existsSync(receipt), false);
  assert.match(m.dialogs.at(-1).body, /password manager/);
  m.dialogs.length = 0;
  const approve = await machine(t);
  await approve.create();
  const key = approve.keychain.stored().toString("hex"), preview = await approve.ok(["backup", "key", "export"]);
  const out = await approve.cli(["backup", "key", "export", "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.equal(out.json.result.key, key);
  assert.equal(out.text.split(key).length - 1, 1, "the key is printed once");
  assert.match(out.json.result.note, /password manager/);
  const stored = JSON.parse(await readFile(join(approve.p.stateRoot, "backup", "key-export.json"), "utf8"));
  assert.deepEqual(Object.keys(stored).sort(), ["exportedAt", "schemaVersion"]);
  assert.equal((await stat(join(approve.p.stateRoot, "backup", "key-export.json"))).mode & 0o777, 0o600);
  assert.equal((await approve.ok(["backup", "status"])).keyExported, true);
});

test("the activity digest warns until the key export receipt exists, and while no backup folder is approved", async (t) => {
  const m = await machine(t);
  const codes = async (x) => (await x.ok(["activity"])).warnings.map((w) => w.code).sort();
  assert.deepEqual(await codes(m), ["BACKUP_KEY_NOT_EXPORTED"]);
  assert.match((await m.ok(["activity"])).warnings[0].message, /cannot be restored on another machine until you run backup key export/);
  await m.create();
  const plan = await m.ok(["backup", "key", "export"]);
  await m.ok(["backup", "key", "export", "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual(await codes(m), []);
  const none = await machine(t, { backup: false });
  assert.deepEqual(await codes(none), ["BACKUP_KEY_NOT_EXPORTED", "BACKUP_NO_TARGET"]);
  await none.fail(["backup", "create"], "DEVTWIN_GATE_REQUIRED");
});

test("the default Keychain implementation never puts the key in argv", async () => {
  const calls = [], key = Buffer.alloc(32, 0xab), hex = key.toString("hex");
  let answer = { status: 0, stdout: hex + "\n" };
  const spawn = (command, args, options) => { calls.push({ command, args, input: options.input ?? null }); return answer; };
  const keychain = securityKeychain({ spawn, platform: "darwin", account: "example" });
  await keychain.write(key);
  assert.deepEqual(await keychain.read(), key);
  assert.deepEqual(calls.map((c) => [c.command, c.args]), [["/usr/bin/security", [...WRITE_ARGS]], ["/usr/bin/security", readArgs("example")]]);
  assert.deepEqual(readArgs("example"), ["find-generic-password", "-s", SERVICE, "-a", "example", "-w"]);
  assert.equal(calls[0].input, "add-generic-password -U -s devtwin-backup -a example -w " + hex + "\n");
  for (const call of calls) assert.equal(call.args.some((arg) => arg.includes(hex)), false);
  answer = { status: 44, stdout: "" };
  assert.equal(await keychain.read(), null);
  answer = { status: 0, stdout: "not-hex" };
  await assert.rejects(keychain.read(), (e) => e.code === "DEVTWIN_INTEGRITY");
  answer = { status: 1, stdout: "" };
  await assert.rejects(keychain.write(key), (e) => e.code === "DEVTWIN_STORAGE_ERROR");
  await assert.rejects(securityKeychain({ spawn, platform: "linux", account: "example" }).read(), (e) => e.code === "DEVTWIN_GATE_REQUIRED");
  await assert.rejects(securityKeychain({ spawn, platform: "darwin", account: "bad name" }).read(), (e) => e.code === "DEVTWIN_INVALID_INPUT");
});
