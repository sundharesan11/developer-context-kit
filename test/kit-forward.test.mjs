import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, packageKit } from "./helpers.mjs";
import { pilotDigest } from "../src/config/pilot.mjs";
import { displayKitId, kitFields } from "../src/kit/identity.mjs";
import { runDevtwin, LOCAL_ROUTES } from "../src/kit/forward.mjs";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// A kit bin that reports what it was run with, so a forward can be checked end to end.
const ECHO_BIN = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ args: process.argv.slice(2), forwarded: process.env.DEVTWIN_FORWARDED ?? null }) + \"\\n\");\nprocess.exitCode = 5;\n";
// A temporary home with a private .devtwin, the running (global) kit outside it, and two package kits under its kits.
async function forwardHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  await mkdir(devtwin, { recursive: true });
  await chmod(devtwin, 0o700);
  const global = join(sb, "global/devtwin");
  await mkdir(join(global, "bin"), { recursive: true });
  const a = await packageKit(home, join(sb, "src-a"), { version: "0.1.0-alpha.1", files: { "bin/devtwin.mjs": ECHO_BIN } });
  const b = await packageKit(home, join(sb, "src-b"), { version: "0.1.0-alpha.2", files: { "bin/devtwin.mjs": ECHO_BIN } });
  const liveConfig = join(devtwin, "live.json");
  // A live config naming a kit, with its approval in the store, as live init leaves them; approve: false leaves none.
  const writeLive = async (path, kitRoot, identity, { approve = true, stateRoot = join(dirname(path), "store-" + Math.random().toString(16).slice(2), "state") } = {}) => {
    const raw = { schemaVersion: 1, pilotRoot: dirname(stateRoot), configRoot: join(dirname(stateRoot), "config"), dataRoot: join(dirname(stateRoot), "data"), stateRoot, inputsRoot: join(dirname(stateRoot), "inputs"), agentHomes: [], repos: [], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills") }, kitRoot, ...kitFields(identity) } };
    await writeFile(path, JSON.stringify(raw, null, 2) + "\n", { mode: 0o600 });
    await mkdir(join(stateRoot, "live"), { recursive: true, mode: 0o700 });
    if (approve) await writeFile(join(stateRoot, "live/approved-config.json"), JSON.stringify({ schemaVersion: 1, configId: raw.live.configId, digest: pilotDigest(raw) }) + "\n", { mode: 0o600 });
    return { raw, stateRoot };
  };
  // One run through the forwarding front: spawn and the local CLI are recorded, never run.
  const run = async (argv, { env = {}, kitRoot = global, status = 7 } = {}) => {
    const spawned = [], local = [], err = [], out = [];
    const code = await runDevtwin(argv, {
      home, env, kitRoot, execPath: "/fake/node",
      spawn: (cmd, args, options) => { spawned.push({ cmd, args, options }); return { status }; },
      run: async (args) => { local.push(args); return 0; },
      stderr: { write: (v) => { err.push(v); return true; } }, stdout: { write: (v) => { out.push(v); return true; } }
    });
    return { code, spawned, local, stderr: err.join(""), stdout: out.join("") };
  };
  return { sb, home, devtwin, global, a, b, liveConfig, writeLive, run };
}
const forwardedTo = (r, kit, argv) => {
  assert.equal(r.local.length, 0, "not run locally");
  assert.equal(r.spawned.length, 1);
  const [{ cmd, args, options }] = r.spawned;
  assert.equal(cmd, "/fake/node");
  assert.deepEqual(args, [join(kit.kit, "bin/devtwin.mjs"), ...argv]);
  assert.equal(options.stdio, "inherit");
  assert.equal(options.shell, undefined, "never a shell");
  assert.equal(options.env.DEVTWIN_FORWARDED, "1");
  assert.equal(r.stderr, "devtwin: running kit " + displayKitId(kit.identity) + "\n");
};
const ranLocally = (r, argv, note) => {
  assert.equal(r.spawned.length, 0, "not forwarded");
  assert.deepEqual(r.local, [argv]);
  if (note === undefined) assert.equal(r.stderr, "");
  else { assert.match(r.stderr, note); assert.equal(r.stderr.split("\n").filter(Boolean).length, 1, "one line"); }
};

test("forward runs a live command in the pinned kit with the same arguments and exit code", async (t) => {
  const h = await forwardHome(t);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  const argv = ["doctor", "--pilot", h.liveConfig];
  const r = await h.run(argv, { env: { KEEP: "x" } });
  forwardedTo(r, h.a, argv);
  assert.equal(r.code, 7);
  assert.equal(r.spawned[0].options.env.KEEP, "x", "the environment passes through");
  // End to end through bin/devtwin.mjs: a real node process runs the kit's bin, whose exit code comes back.
  const child = spawnSync(process.execPath, [join(REPO_ROOT, "bin/devtwin.mjs"), ...argv, "--extra", "a b"], { env: { PATH: process.env.PATH, HOME: h.home }, encoding: "utf8" });
  assert.equal(child.status, 5, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { args: [...argv, "--extra", "a b"], forwarded: "1" });
  assert.equal(child.stderr, "devtwin: running kit " + displayKitId(h.a.identity) + "\n");
});

test("forward sends live set-kit --kit and live init --kit to the named kit under ~/.devtwin/kits", async (t) => {
  const h = await forwardHome(t);
  // set-kit runs from the new kit even while the live config pins another one.
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  for (const argv of [["live", "set-kit", "--pilot", h.liveConfig, "--kit", h.b.arg], ["live", "set-kit", "--pilot", h.liveConfig, "--kit=" + h.b.arg, "--apply", "--plan-fingerprint", "sha256:00"]]) forwardedTo(await h.run(argv), h.b, argv);
  // live init has no live config yet.
  const fresh = join(h.sb, "fresh.json");
  for (const argv of [["live", "init", "--pilot", fresh, "--agent", "claude", "--kit", h.a.arg], ["live", "init", "--kit", h.b.arg, "--pilot", fresh, "--agent", "claude", "--apply"]]) forwardedTo(await h.run(argv), argv.includes(h.a.arg) ? h.a : h.b, argv);
  // Run from the named kit itself, it runs locally.
  const own = ["live", "init", "--pilot", fresh, "--agent", "claude", "--kit", h.a.arg];
  ranLocally(await h.run(own, { kitRoot: h.a.kit }), own);
  // A Git commit pin is not a package kit: set-kit --commit runs locally and the clone validates itself.
  const commit = ["live", "set-kit", "--pilot", fresh, "--commit", "a".repeat(40)];
  ranLocally(await h.run(commit), commit);
  // A --kit that names no installed kit, or a malformed one, is not forwarded.
  const missing = ["live", "set-kit", "--pilot", h.liveConfig, "--kit", "0.1.0-alpha.9+" + "c".repeat(64)];
  ranLocally(await h.run(missing), missing, /^devtwin: not forwarding to npm:0\.1\.0-alpha\.9\+sha256:cccccccccccc \(missing\); running this kit\n$/);
  const malformed = ["live", "init", "--pilot", fresh, "--kit", "0.1.0+short"];
  ranLocally(await h.run(malformed), malformed);
});

test("forward runs --version, version, help, demo, the kit routes and the hook locally", async (t) => {
  const h = await forwardHome(t);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  const local = [["--version"], ["version"], ["help"], ["demo"], ["kit", "install"], ["kit", "install", "--apply"], ["kit", "list"], ["kit", "list", "--pilot", h.liveConfig],
    ["skill-sources", "catalog"], ["skill", "template-list"], [], ["--pilot", h.liveConfig], ["no-such", "route", "--pilot", h.liveConfig],
    ["hook", "--event", "session-start", "--agent", "claude", "--pilot", h.liveConfig]];
  for (const argv of local) ranLocally(await h.run(argv), argv);
  for (const route of ["version", "help", "demo", "kit install", "kit list", "hook"]) assert.ok(LOCAL_ROUTES.includes(route), route);
  // hook verify is a pilot command, not the hook: it writes the receipt from the pinned kit.
  const verify = ["hook", "verify", "--pilot", h.liveConfig];
  forwardedTo(await h.run(verify), h.a, verify);
});

test("forward does not run an unapproved config, a kit outside ~/.devtwin/kits or a kit that fails the check", async (t) => {
  const h = await forwardHome(t);
  const argv = ["doctor", "--pilot", h.liveConfig];
  // No approval in the store, then an approval for other bytes.
  const { stateRoot } = await h.writeLive(h.liveConfig, h.a.kit, h.a.identity, { approve: false });
  ranLocally(await h.run(argv), argv, /^devtwin: not forwarding to npm:0\.1\.0-alpha\.1\+sha256:[0-9a-f]{12} \(unapproved\); running this kit\n$/);
  await writeFile(join(stateRoot, "live/approved-config.json"), JSON.stringify({ schemaVersion: 1, configId: "cfg_0123456789abcdef", digest: "sha256:" + "0".repeat(64) }) + "\n", { mode: 0o600 });
  ranLocally(await h.run(argv), argv, /\(unapproved\)/);
  // A package kit installed under another home.
  const other = join(h.sb, "other-home");
  await mkdir(join(other, ".devtwin"), { recursive: true, mode: 0o700 });
  const outside = await packageKit(other, join(h.sb, "src-c"), { version: "0.1.0-alpha.3" });
  await h.writeLive(h.liveConfig, outside.kit, outside.identity);
  ranLocally(await h.run(argv), argv, /\(outside-kits\)/);
  // The config names a digest the kit's manifest does not hold, or a version it does not.
  await h.writeLive(h.liveConfig, h.a.kit, { ...h.a.identity, digest: h.b.digest });
  ranLocally(await h.run(argv), argv, /\(kit-check\)/);
  await h.writeLive(h.liveConfig, h.a.kit, { ...h.a.identity, version: "0.1.0-alpha.2" });
  ranLocally(await h.run(argv), argv, /\(kit-check\)/);
  // A Git kit at another commit than the one pinned.
  const clone = await makeRepo(join(h.devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(clone, ["checkout", "-q", "--detach"]);
  const head = (await fixtureGit(clone, ["rev-parse", "HEAD"])).trim();
  await h.writeLive(h.liveConfig, clone, { kind: "git", commit: "b".repeat(40) });
  ranLocally(await h.run(argv), argv, /\(kit-check\)/);
  // The same clone at its pinned commit is forwarded.
  await h.writeLive(h.liveConfig, clone, { kind: "git", commit: head });
  const r = await h.run(argv);
  assert.deepEqual(r.spawned[0].args, [join(clone, "bin/devtwin.mjs"), ...argv]);
  assert.equal(r.stderr, "devtwin: running kit git:" + head.slice(0, 12) + "\n");
  // A config whose JSON is broken, or one that is not private.
  await writeFile(h.liveConfig, "{not json", { mode: 0o600 });
  ranLocally(await h.run(argv), argv, /\(unreadable\)/);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  await chmod(h.liveConfig, 0o644);
  ranLocally(await h.run(argv), argv, /\(unreadable\)/);
});

test("forward reads the config --pilot names, and ~/.devtwin/live.json without one", async (t) => {
  const h = await forwardHome(t);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  const named = join(h.sb, "named/live.json");
  await mkdir(dirname(named), { mode: 0o700 });
  await h.writeLive(named, h.b.kit, h.b.identity);
  for (const argv of [["doctor", "--pilot", named], ["doctor", "--pilot=" + named], ["live", "add-repo", "--pilot", named, "--repo", "/r"]]) forwardedTo(await h.run(argv), h.b, argv);
  for (const argv of [["doctor", "--pilot", h.liveConfig], ["doctor"]]) forwardedTo(await h.run(argv), h.a, argv);
  // Two --pilot values could name two configs: no guess.
  const twice = ["doctor", "--pilot", named, "--pilot", h.liveConfig];
  ranLocally(await h.run(twice), twice, /\(pilot-twice\)/);
  // A disposable pilot (no live block) runs locally with no note.
  const pilot = join(h.sb, "pilot.json");
  await writeFile(pilot, JSON.stringify({ schemaVersion: 1, pilotRoot: join(h.sb, "p") }));
  ranLocally(await h.run(["doctor", "--pilot", pilot]), ["doctor", "--pilot", pilot]);
});

test("forward refuses a second hop", async (t) => {
  const h = await forwardHome(t);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  const argv = ["doctor", "--pilot", h.liveConfig];
  const r = await h.run(argv, { env: { DEVTWIN_FORWARDED: "1" } });
  assert.equal(r.code, 1);
  assert.deepEqual([r.spawned, r.local], [[], []]);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.command, "doctor");
  assert.equal(out.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(out.error.details.reason, "second-hop");
  const kit = ["live", "set-kit", "--pilot", h.liveConfig, "--kit", h.b.arg];
  assert.equal(JSON.parse((await h.run(kit, { env: { DEVTWIN_FORWARDED: "1" } })).stdout).error.details.reason, "second-hop");
  // In the kit the first hop reached, the command runs there.
  ranLocally(await h.run(argv, { env: { DEVTWIN_FORWARDED: "1" }, kitRoot: h.a.kit }), argv);
});

test("forward runs locally with no note when there is no live config or the running kit is the pinned one", async (t) => {
  const h = await forwardHome(t);
  for (const argv of [["doctor", "--pilot", h.liveConfig], ["doctor", "--pilot", join(h.sb, "none/live.json")], ["live", "init", "--pilot", h.liveConfig, "--agent", "claude"]]) ranLocally(await h.run(argv), argv);
  await h.writeLive(h.liveConfig, h.a.kit, h.a.identity);
  const argv = ["doctor", "--pilot", h.liveConfig];
  ranLocally(await h.run(argv, { kitRoot: h.a.kit }), argv);
});
