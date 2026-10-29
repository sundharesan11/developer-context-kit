import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { lstatSync, existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, symlink, chmod } from "node:fs/promises";
import { sandbox, runCli } from "./helpers.mjs";
import { readManifest, kitDigest, MANIFEST } from "../src/kit/manifest.mjs";
import { kitId, displayKitId } from "../src/kit/identity.mjs";
import { assertKit, loadPilot } from "../src/config/pilot.mjs";

const VERSION = "0.1.0-alpha.1";
const FILES = { "package.json": JSON.stringify({ name: "devtwin", version: VERSION }) + "\n", "bin/devtwin.mjs": "#!/usr/bin/env node\n", "src/a.mjs": "export const a = 1;\n", "src/sub/b.mjs": "export {};\n", "skills/x/SKILL.md": "# x\n", "README.md": "# devtwin\n", "LICENSE": "license\n" };
const mode = (path) => lstatSync(path).mode & 0o777;
// A running package kit (the npm global copy) with files outside the runtime set, and a private <home>/.devtwin.
async function fixture(t, { devtwin = true } = {}) {
  const sb = await sandbox(t), src = join(sb, "global/devtwin"), home = join(sb, "home");
  for (const [rel, text] of Object.entries({ ...FILES, "test/x.test.mjs": "x\n", "docs/a.md": "a\n" })) { await mkdir(join(src, rel, ".."), { recursive: true }); await writeFile(join(src, rel), text); }
  await chmod(join(src, "bin/devtwin.mjs"), 0o755);
  await mkdir(home);
  if (devtwin) await mkdir(join(home, ".devtwin"), { mode: 0o700 });
  const kits = join(home, ".devtwin/kits"), digest = kitDigest(src), name = VERSION + "-" + digest.slice(0, 12);
  const cli = (args) => runCli(["kit", ...args], { home, kitRoot: src });
  return { sb, src, home, kits, digest, name, kit: join(kits, name), cli, identity: { kind: "package", version: VERSION, digest } };
}
const editLocked = async (path, fn) => { await chmod(join(path, ".."), 0o700); await chmod(path, 0o600); await fn(); await chmod(path, 0o400); await chmod(join(path, ".."), 0o500); };

test("kit install plans first, then copies the runtime set into a locked folder named by version and digest", async (t) => {
  const f = await fixture(t);
  const plan = await f.cli(["install"]);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.result, { applied: false, status: "new", kitRoot: f.kit, version: VERSION, digest: f.digest, kitId: kitId(f.identity), files: Object.keys(FILES).length, staleTemp: 0, next: "devtwin live set-kit --kit " + VERSION + "+" + f.digest });
  assert.equal(existsSync(f.kits), false, "the plan writes nothing");
  const done = await f.cli(["install", "--apply"]);
  assert.equal(done.code, 0, JSON.stringify(done.json));
  assert.deepEqual(done.json.result, { ...plan.json.result, applied: true, status: "installed" });
  assert.equal(mode(f.kits), 0o700);
  assert.deepEqual(await readdir(f.kits), [f.name]);
  const manifest = readManifest(f.kit);
  assert.deepEqual(manifest, { schemaVersion: 1, version: VERSION, digest: f.digest, files: Object.keys(FILES).sort(), sourceCommit: null });
  // The installed files are the manifest's, byte for byte, and the KTD4 modes are set on every entry.
  for (const rel of manifest.files) {
    assert.equal(await readFile(join(f.kit, rel), "utf8"), FILES[rel], rel);
    assert.equal(mode(join(f.kit, rel)), rel === "bin/devtwin.mjs" ? 0o500 : 0o400, rel);
  }
  assert.equal(mode(join(f.kit, MANIFEST)), 0o400);
  for (const dir of ["", "bin", "src", "src/sub", "skills", "skills/x"]) assert.equal(mode(join(f.kit, dir)), 0o500, dir || ".");
  assert.equal(existsSync(join(f.kit, "test")) || existsSync(join(f.kit, "docs")), false, "files outside the runtime set stay behind");
  assert.doesNotThrow(() => assertKit(f.kit, f.identity, { home: f.home }));
});

test("kit install of a folder already present and good is a no-op", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli(["install", "--apply"])).code, 0);
  const before = lstatSync(join(f.kit, MANIFEST));
  for (const args of [["install"], ["install", "--apply"]]) {
    const again = await f.cli(args);
    assert.equal(again.code, 0, JSON.stringify(again.json));
    assert.equal(again.json.result.status, "present");
    assert.equal(again.json.result.applied, false);
  }
  assert.deepEqual(await readdir(f.kits), [f.name]);
  assert.equal(lstatSync(join(f.kit, MANIFEST)).ino, before.ino);
});

test("kit install refuses a tampered existing folder with KIT_CORRUPT and never overwrites it", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli(["install", "--apply"])).code, 0);
  const file = join(f.kit, "src/a.mjs");
  await editLocked(file, () => writeFile(file, "tampered\n"));
  for (const args of [["install"], ["install", "--apply"]]) {
    const r = await f.cli(args);
    assert.equal(r.code, 1);
    assert.equal(r.json.error.code, "DEVTWIN_KIT_CORRUPT");
    assert.equal(r.json.error.details.reason, "digest");
  }
  assert.equal(await readFile(file, "utf8"), "tampered\n");
  assert.deepEqual(await readdir(f.kits), [f.name], "no temp folder is left");
});

test("kit install refuses a link in the source and leaves no kit or temp folder", async (t) => {
  const f = await fixture(t);
  await symlink("a.mjs", join(f.src, "src/link.mjs"));
  for (const args of [["install"], ["install", "--apply"]]) {
    const r = await f.cli(args);
    assert.equal(r.json.error.code, "DEVTWIN_PATH_UNSAFE");
    assert.deepEqual(r.json.error.details.paths, ["src/link.mjs"]);
  }
  assert.deepEqual(existsSync(f.kits) ? await readdir(f.kits) : [], []);
});

test("kit install refuses a missing or unsafe ~/.devtwin and does not create it", async (t) => {
  const f = await fixture(t, { devtwin: false });
  for (const args of [["install"], ["install", "--apply"]]) {
    const r = await f.cli(args);
    assert.equal(r.json.error.code, "DEVTWIN_PATH_UNSAFE");
    assert.equal(existsSync(join(f.home, ".devtwin")), false);
  }
  await mkdir(join(f.home, ".devtwin"), { mode: 0o755 });
  await chmod(join(f.home, ".devtwin"), 0o755);
  assert.equal((await f.cli(["install", "--apply"])).json.error.code, "DEVTWIN_PATH_UNSAFE");
  assert.equal(existsSync(f.kits), false);
  // A group-writable kits folder is refused, not repaired.
  await chmod(join(f.home, ".devtwin"), 0o700);
  await mkdir(f.kits, { mode: 0o770 });
  await chmod(f.kits, 0o770);
  assert.equal((await f.cli(["install", "--apply"])).json.error.code, "DEVTWIN_PATH_UNSAFE");
  assert.deepEqual(await readdir(f.kits), []);
});

test("kit install from a Git clone is refused with a note to use the clone", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.src, ".git"));
  await writeFile(join(f.src, ".git/HEAD"), "c".repeat(40) + "\n");
  const r = await f.cli(["install", "--apply"]);
  assert.equal(r.json.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(r.json.error.details.reason, "git-clone");
  assert.match(r.json.error.details.note, /clone/);
  assert.equal(existsSync(f.kits), false);
});

test("an interrupted kit install leaves only a temp folder, which the next run removes without following links", async (t) => {
  const f = await fixture(t);
  await mkdir(f.kits, { mode: 0o700 });
  const temp = join(f.kits, ".tmp-0123456789abcdef"), outside = join(f.sb, "outside");
  await mkdir(join(temp, "src/sub"), { recursive: true });
  await mkdir(outside);
  await writeFile(join(outside, "keep.txt"), "keep\n");
  await writeFile(join(temp, "src/sub/b.mjs"), "x");
  await symlink(outside, join(temp, "src/out"));
  await chmod(join(temp, "src/sub/b.mjs"), 0o400);
  for (const dir of ["src/sub", "src", "."]) await chmod(join(temp, dir), 0o500);
  // kit list ignores the temp folder; the plan reports it and leaves it.
  assert.deepEqual((await f.cli(["list"])).json.result.kits, []);
  assert.equal((await f.cli(["install"])).json.result.staleTemp, 1);
  assert.ok(existsSync(temp));
  const r = await f.cli(["install", "--apply"]);
  assert.equal(r.code, 0, JSON.stringify(r.json));
  assert.equal(r.json.result.status, "installed");
  assert.deepEqual(await readdir(f.kits), [f.name]);
  assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep\n", "the link target is untouched");
});

// A live config naming the installed kit, as live set-kit (U45) will write it.
async function liveConfig(f, kitRoot = f.kit) {
  const devtwin = join(f.home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(f.home, rel), { recursive: true });
  await mkdir(store, { mode: 0o700 });
  const config = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [], forbidden: [],
    live: { configId: "cfg_0123456789abcdef", home: f.home, skillDirs: { claude: join(f.home, ".claude/skills"), codex: join(f.home, ".agents/skills") }, kitRoot, kitVersion: f.identity.version, kitDigest: f.identity.digest } };
  const path = join(devtwin, "live.json");
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

test("an installed kit passes the live config kit gate", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.cli(["install", "--apply"])).code, 0);
  const path = await liveConfig(f);
  const pilot = await loadPilot(path, { home: f.home, env: {}, kitRoot: f.kit, liveGate: { approval: false } });
  assert.equal(pilot.live.kitDigest, f.digest);
  assert.equal(pilot.live.kitRoot, f.kit);
});

test("kit list shows each kit folder, its kitId, whether it verifies and which one the live config pins", async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.cli(["list"])).json.result, { kits: [], pilot: null });
  assert.equal((await f.cli(["install", "--apply"])).code, 0);
  // A second kit from another version, then tampered.
  await writeFile(join(f.src, "package.json"), JSON.stringify({ name: "devtwin", version: "0.1.0-alpha.2" }) + "\n");
  const second = await f.cli(["install", "--apply"]);
  assert.equal(second.code, 0, JSON.stringify(second.json));
  const other = second.json.result.kitRoot, file = join(other, "README.md");
  await editLocked(file, () => writeFile(file, "changed\n"));
  const unpinned = await f.cli(["list"]);
  assert.equal(unpinned.code, 0, JSON.stringify(unpinned.json));
  assert.deepEqual(unpinned.json.result.kits.map((k) => k.pinned), [false, false]);
  const path = await liveConfig(f);
  for (const args of [["list"], ["list", "--pilot", path]]) {
    const r = await f.cli(args);
    assert.equal(r.code, 0, JSON.stringify(r.json));
    assert.equal(r.json.result.pilot, path);
    assert.deepEqual(r.json.result.kits, [
      { name: f.name, kitRoot: f.kit, kitId: kitId(f.identity), display: displayKitId(f.identity), status: "ok", reason: null, pinned: true },
      { name: other.split("/").pop(), kitRoot: other, kitId: second.json.result.kitId, display: displayKitId(second.json.result.kitId), status: "bad", reason: "digest", pinned: false }
    ]);
  }
  // A named config that cannot be read is an error, not an unpinned list.
  assert.equal((await f.cli(["list", "--pilot", join(f.home, "missing.json")])).code, 1);
});
