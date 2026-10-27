import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, readFile, symlink, link, chmod, lstat, rm, readdir } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, makePilot } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, assertWritable, recordApprovedDigest } from "../src/config/pilot.mjs";
import { planLiveSetWriteClasses, applyLiveSetWriteClasses } from "../src/config/live.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { replaceMarkedBlock, replaceOwnedEntries, editOwnedFile, MARKERS } from "../src/storage/owned-file.mjs";
const refused = (field, code = "DEVTWIN_GATE_REQUIRED") => (e) => e.code === code && (field === undefined || e.details.field === field);
const unsafe = (e) => ["DEVTWIN_GATE_REQUIRED", "DEVTWIN_PATH_UNSAFE"].includes(e.code);
const writable = (roots, paths, options) => Promise.resolve().then(() => assertWritable(roots, paths, options));
const RUN = "run_fence01";
// A live config like test/live-config.test.mjs, with the agent folders the write classes point into.
async function liveFixture(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills", ".codex", "Library/LaunchAgents"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const kitCommit = (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim();
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const obj = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [repo], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills") }, kitRoot: kit, kitCommit } };
  const context = { home, env: {}, kitRoot: kit };
  const paths = { settings: join(home, ".claude/settings.json"), claudeMd: join(home, ".claude/CLAUDE.md"), agentsMd: join(home, ".codex/AGENTS.md"), owned: join(home, ".claude/devtwin-preferences.md"), codexHooks: join(home, ".codex/hooks.json"), plist: join(home, "Library/LaunchAgents/devtwin.hub-sync.plist"), hub: join(home, "devtwin-hubs") };
  const classes = { hubRoot: [paths.hub], instructionTargets: [paths.claudeMd, paths.agentsMd, paths.owned], hookTargets: [paths.settings, paths.codexHooks], launchAgents: [paths.plist] };
  let n = 0;
  const f = {
    sb, home, devtwin, obj, context, paths, classes,
    async write(writeClasses = classes, { path = join(devtwin, "live-" + ++n + ".json") } = {}) {
      await writeFile(path, JSON.stringify({ ...obj, ...(writeClasses === null ? {} : { writeClasses }) }), { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    },
    async approved(writeClasses) {
      const path = await f.write(writeClasses);
      const roots = rootsFromPilot(await loadPilot(path, { ...context, liveGate: { approval: false } }));
      ensureRoots(roots);
      await recordApprovedDigest(roots);
      return path;
    },
    async roots(writeClasses) { return rootsFromPilot(await loadPilot(await f.approved(writeClasses), context)); }
  };
  return f;
}
const hookEntry = (command) => ({ matcher: "Edit", hooks: [{ type: "command", command }] });
const ownsHook = (entry) => Array.isArray(entry?.hooks) && entry.hooks.length > 0 && entry.hooks.every((hook) => typeof hook.command === "string" && hook.command.startsWith("devtwin hook "));
test("an approved hook target accepts a write to devtwin's own entry", async (t) => {
  const f = await liveFixture(t), roots = await f.roots();
  const before = JSON.stringify({ model: "example", hooks: { PreToolUse: [hookEntry("example-lint"), hookEntry("devtwin hook old")] } }, null, 4) + "\n";
  await writeFile(f.paths.settings, before, { mode: 0o644 });
  assert.doesNotThrow(() => assertWritable(roots, [f.paths.settings], { writeClass: "hookTargets" }));
  const edit = (text) => replaceOwnedEntries(text, { path: ["hooks", "PreToolUse"], owns: ownsHook, entries: [hookEntry("devtwin hook pre-edit")] });
  const result = await editOwnedFile(roots, { path: f.paths.settings, writeClass: "hookTargets", runId: RUN, edit });
  assert.equal(result.changed, true);
  const after = await readFile(f.paths.settings, "utf8");
  assert.deepEqual(JSON.parse(after), { model: "example", hooks: { PreToolUse: [hookEntry("example-lint"), hookEntry("devtwin hook pre-edit")] } });
  assert.match(after, /^\{\n {4}"model"/);
  assert.equal((await lstat(f.paths.settings)).mode & 0o777, 0o644);
  assert.equal(await readFile(result.backup, "utf8"), before);
  // A second identical edit is a no-op and writes no second backup.
  assert.deepEqual(await editOwnedFile(roots, { path: f.paths.settings, writeClass: "hookTargets", runId: "run_fence02", edit }), { changed: false, path: f.paths.settings, backup: null });
  assert.throws(() => replaceOwnedEntries(after, { path: ["hooks", "PreToolUse"], owns: ownsHook, entries: [hookEntry("example-lint")] }), refused(undefined, "DEVTWIN_INVALID_INPUT"));
  assert.throws(() => replaceOwnedEntries(after, { path: ["__proto__"], owns: ownsHook, entries: [] }), refused(undefined, "DEVTWIN_INVALID_INPUT"));
  assert.throws(() => replaceOwnedEntries(after, { path: ["model"], owns: ownsHook, entries: [] }), refused(undefined, "DEVTWIN_CONFLICT"));
  assert.throws(() => replaceOwnedEntries("{ // comment\n}", { path: ["hooks"], owns: ownsHook, entries: [] }), refused(undefined, "DEVTWIN_INTEGRITY"));
});
test("a write to an unapproved file in the same folder as an approved target is refused", async (t) => {
  const f = await liveFixture(t), roots = await f.roots(), other = join(f.home, ".claude/settings.local.json");
  for (const [path, writeClass] of [[other, "hookTargets"], [join(f.home, ".claude"), "hookTargets"], [join(f.home, ".claude/skills/devtwin-x"), "hookTargets"], [join(f.home, "Library/LaunchAgents/devtwin.other.plist"), "launchAgents"], [join(f.home, ".codex/config.toml"), "hookTargets"]]) {
    await assert.rejects(writable(roots, [path], { writeClass }), refused("destination"), path);
  }
  // An approved target is writable only through its own class, never by a mutator that names none or another.
  for (const options of [{}, { writeClass: "instructionTargets" }, { writeClass: "hubRoot" }]) await assert.rejects(writable(roots, [f.paths.settings], options), refused("destination"));
  for (const writeClass of ["forbidden", "repos", 7]) await assert.rejects(writable(roots, [f.paths.settings], { writeClass }), refused("writeClass"));
  await assert.rejects(editOwnedFile(roots, { path: other, writeClass: "hookTargets", runId: RUN, edit: () => "{}\n" }), refused("destination"));
  await assert.rejects(lstat(other), { code: "ENOENT" });
  // The existing store and protected-home rules still hold beside the classes.
  assert.doesNotThrow(() => assertWritable(roots, [join(roots.stateRoot, "runs/run_x/receipt.json")], { writeClass: "hookTargets" }));
  for (const path of [join(f.home, ".codex/skills/devtwin-x"), join(f.home, ".agents/skills/devtwin-x"), join(f.home, ".gemini/settings.json"), f.obj.repos[0]]) await assert.rejects(writable(roots, [path], { writeClass: "hookTargets" }), refused("destination"));
});
test("changing an approved write class without re-approval fails with GATE_REQUIRED", async (t) => {
  const f = await liveFixture(t), path = await f.approved();
  const before = await loadPilot(path, f.context);
  assert.deepEqual(before.writeClasses, f.classes);
  const widened = { ...f.classes, hookTargets: [f.paths.settings], launchAgents: [f.paths.plist, join(f.home, "Library/LaunchAgents/devtwin.radar.plist")] };
  await f.write(widened, { path });
  await assert.rejects(loadPilot(path, f.context), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "live.approval" && e.details.reason === "changed");
  await f.write(null, { path });
  await assert.rejects(loadPilot(path, f.context), refused("live.approval"));
  // The approved route records the new digest, after which the changed classes load.
  await f.write(f.classes, { path });
  const preview = await planLiveSetWriteClasses({ configPath: path, writeClasses: widened }, f.context);
  assert.deepEqual(preview.writeClasses, { from: f.classes, to: widened });
  await assert.rejects(applyLiveSetWriteClasses({ configPath: path, writeClasses: widened, fingerprint: "sha256:" + "0".repeat(64) }, f.context), { code: "DEVTWIN_PLAN_MISMATCH" });
  const applied = await applyLiveSetWriteClasses({ configPath: path, writeClasses: widened, fingerprint: preview.fingerprint }, f.context);
  assert.equal(applied.digest, preview.digest.to);
  assert.deepEqual((await loadPilot(path, f.context)).writeClasses, widened);
});
test("a marker-block edit in a fixture CLAUDE.md keeps every byte outside the markers", async (t) => {
  const f = await liveFixture(t), roots = await f.roots();
  const head = "# Notes é\r\n\r\nKeep  this\ttext.\r\n", tail = "\r\n## After\r\ntrailing without newline";
  const original = head + MARKERS.begin + "\nold block\n" + MARKERS.end + tail;
  await writeFile(f.paths.claudeMd, original, { mode: 0o644 });
  const result = await editOwnedFile(roots, { path: f.paths.claudeMd, writeClass: "instructionTargets", runId: RUN, edit: (text) => replaceMarkedBlock(text, "Read devtwin-preferences.md.\n") });
  const after = await readFile(f.paths.claudeMd);
  assert.ok(after.subarray(0, Buffer.byteLength(head)).equals(Buffer.from(head)));
  assert.ok(after.subarray(after.length - Buffer.byteLength(tail)).equals(Buffer.from(tail)));
  assert.equal(after.toString("utf8"), head + MARKERS.begin + "\nRead devtwin-preferences.md.\n" + MARKERS.end + tail);
  assert.ok((await readFile(result.backup)).equals(Buffer.from(original)));
  assert.equal((await lstat(f.paths.claudeMd)).mode & 0o777, 0o644, "an edit keeps the developer's file mode");
  // With no block, the block is appended and the old bytes stay a byte-exact prefix; removing it restores them.
  const plain = "user text without newline";
  const added = replaceMarkedBlock(plain, "line\n");
  assert.equal(added, plain + "\n" + MARKERS.begin + "\nline\n" + MARKERS.end + "\n");
  assert.equal(replaceMarkedBlock(added, null), plain + "\n");
  assert.equal(replaceMarkedBlock(null, "x"), MARKERS.begin + "\nx\n" + MARKERS.end + "\n");
  assert.equal(replaceMarkedBlock(plain, null), plain);
  for (const text of [MARKERS.end + MARKERS.begin, MARKERS.begin + MARKERS.begin + MARKERS.end, MARKERS.begin, MARKERS.begin + "\n" + MARKERS.end + MARKERS.end]) assert.throws(() => replaceMarkedBlock(text, "x"), refused(undefined, "DEVTWIN_CONFLICT"), text);
  assert.throws(() => replaceMarkedBlock(plain, "a " + MARKERS.end), refused(undefined, "DEVTWIN_INVALID_INPUT"));
  // A file that is not valid UTF-8 is refused instead of being rewritten with replacement characters.
  await writeFile(f.paths.agentsMd, Buffer.from([0x23, 0x20, 0xff, 0x0a]));
  await assert.rejects(editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: RUN, edit: (text) => replaceMarkedBlock(text, "x\n") }), refused(undefined, "DEVTWIN_INTEGRITY"));
  assert.ok((await readFile(f.paths.agentsMd)).equals(Buffer.from([0x23, 0x20, 0xff, 0x0a])));
});
test("an owned-file edit writes a byte-exact private backup into the run folder before replacing", async (t) => {
  const f = await liveFixture(t), roots = await f.roots();
  const bytes = Buffer.concat([Buffer.from("﻿# BOM kept\r\n"), Buffer.from("\u{1f600} emoji\n")]);
  await writeFile(f.paths.agentsMd, bytes, { mode: 0o644 });
  const crash = () => { throw new Error("injected crash"); };
  const edit = (text) => replaceMarkedBlock(text, "prefs\n");
  await assert.rejects(editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: RUN, edit }, { faults: { beforeReplace: crash } }), /injected crash/);
  assert.ok((await readFile(f.paths.agentsMd)).equals(bytes));
  const dir = join(roots.stateRoot, "runs", RUN, "backups"), names = (await readdir(dir)).sort();
  assert.equal(names.length, 2);
  const backup = join(dir, names.find((name) => name.endsWith(".bak"))), record = JSON.parse(await readFile(join(dir, names.find((name) => name.endsWith(".json"))), "utf8"));
  assert.ok((await readFile(backup)).equals(bytes));
  assert.deepEqual({ path: record.path, writeClass: record.writeClass, size: record.size }, { path: f.paths.agentsMd, writeClass: "instructionTargets", size: bytes.length });
  for (const path of [dir, backup]) assert.equal((await lstat(path)).mode & 0o077, 0);
  // The same run never overwrites the first backup; a new run edits, and a file changed mid-edit is not replaced.
  await assert.rejects(editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: RUN, edit }), refused(undefined, "DEVTWIN_CONFLICT"));
  const raced = editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: "run_fence03", edit }, { faults: { beforeReplace: () => writeFile(f.paths.agentsMd, "changed\n") } });
  await assert.rejects(raced, refused(undefined, "DEVTWIN_INTEGRITY"));
  assert.equal(await readFile(f.paths.agentsMd, "utf8"), "changed\n");
  const done = await editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: "run_fence04", edit });
  assert.equal(await readFile(done.backup, "utf8"), "changed\n");
  // A missing target gets a record of absence and no backup; it is never created through a missing folder.
  const created = await editOwnedFile(roots, { path: f.paths.owned, writeClass: "instructionTargets", runId: "run_fence05", edit: (text) => { assert.equal(text, null); return "# prefs\n"; } });
  assert.equal(created.backup, null);
  assert.equal(JSON.parse(await readFile(created.record, "utf8")).absent, true);
  await assert.rejects(editOwnedFile(roots, { path: f.paths.agentsMd, writeClass: "instructionTargets", runId: "bad", edit }), refused(undefined, "DEVTWIN_INVALID_ID"));
  // A hard-linked or group-writable target is refused.
  await writeFile(f.paths.claudeMd, "x\n", { mode: 0o644 });
  await link(f.paths.claudeMd, join(f.sb, "hard"));
  await assert.rejects(editOwnedFile(roots, { path: f.paths.claudeMd, writeClass: "instructionTargets", runId: "run_fence06", edit }), refused(undefined, "DEVTWIN_PATH_UNSAFE"));
  await rm(join(f.sb, "hard"));
  await chmod(f.paths.claudeMd, 0o664);
  await assert.rejects(editOwnedFile(roots, { path: f.paths.claudeMd, writeClass: "instructionTargets", runId: "run_fence07", edit }), refused(undefined, "DEVTWIN_PATH_UNSAFE"));
  assert.equal(await readFile(f.paths.claudeMd, "utf8"), "x\n");
});
test("a launch agent not named devtwin.*.plist is refused", async (t) => {
  const f = await liveFixture(t), agents = join(f.home, "Library/LaunchAgents");
  await mkdir(join(f.home, "Library/LaunchDaemons"));
  await mkdir(join(agents, "sub"));
  for (const bad of [join(agents, "com.example.job.plist"), join(agents, "devtwin.plist"), join(agents, "devtwin.radar.txt"), join(agents, "Devtwin.radar.plist"), join(agents, "devtwin-radar.plist"), join(agents, "sub/devtwin.radar.plist"), join(f.home, "Library/LaunchDaemons/devtwin.radar.plist"), join(f.sb, "Library/LaunchAgents/devtwin.radar.plist"), "Library/LaunchAgents/devtwin.radar.plist", agents + "/x/../devtwin.radar.plist"]) {
    await assert.rejects(loadPilot(await f.write({ launchAgents: [bad] }), { ...f.context, liveGate: { approval: false } }), refused(undefined), bad);
  }
  const roots = await f.roots({ launchAgents: [f.paths.plist] });
  assert.doesNotThrow(() => assertWritable(roots, [f.paths.plist], { writeClass: "launchAgents" }));
  await assert.rejects(writable(roots, [join(agents, "com.example.job.plist")], { writeClass: "launchAgents" }), refused("destination"));
});
test("a symlinked write-class target is refused", async (t) => {
  const f = await liveFixture(t), elsewhere = join(f.sb, "elsewhere");
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, "settings.json"), "{}\n");
  const gate = { ...f.context, liveGate: { approval: false } };
  await symlink(join(elsewhere, "settings.json"), f.paths.settings);
  await assert.rejects(loadPilot(await f.write({ hookTargets: [f.paths.settings] }), gate), unsafe);
  await rm(f.paths.settings);
  await symlink(elsewhere, f.paths.hub);
  await assert.rejects(loadPilot(await f.write({ hubRoot: [f.paths.hub] }), gate), unsafe);
  await rm(f.paths.hub);
  // A link swapped in after approval is refused at write time, and nothing is written through it.
  const roots = await f.roots({ hookTargets: [f.paths.settings], hubRoot: [f.paths.hub] });
  await symlink(join(elsewhere, "settings.json"), f.paths.settings);
  await assert.rejects(writable(roots, [f.paths.settings], { writeClass: "hookTargets" }), unsafe);
  await assert.rejects(editOwnedFile(roots, { path: f.paths.settings, writeClass: "hookTargets", runId: RUN, edit: () => "{\"x\":1}\n" }), unsafe);
  assert.equal(await readFile(join(elsewhere, "settings.json"), "utf8"), "{}\n");
  await mkdir(f.paths.hub);
  await symlink(elsewhere, join(f.paths.hub, "clone"));
  await assert.rejects(writable(roots, [join(f.paths.hub, "clone/hub.json")], { writeClass: "hubRoot" }), unsafe);
});
test("hubRoot allows writes inside and refuses siblings", async (t) => {
  const f = await liveFixture(t), roots = await f.roots({ hubRoot: [f.paths.hub] });
  assert.doesNotThrow(() => assertWritable(roots, [f.paths.hub, join(f.paths.hub, "example/hub.json"), join(f.paths.hub, "example/notes/n.json")], { writeClass: "hubRoot" }));
  for (const path of [join(f.home, "devtwin-hubs-other"), join(f.home, "devtwin-hubs-other/x"), f.home, join(f.home, "devtwin")]) await assert.rejects(writable(roots, [path], { writeClass: "hubRoot" }), refused("destination"), path);
  await assert.rejects(writable(roots, [join(f.paths.hub, "x")], { writeClass: "hookTargets" }), refused("destination"));
  const gate = { ...f.context, liveGate: { approval: false } };
  for (const hub of [join(f.home, ".claude/hubs"), join(f.home, ".codex"), f.home, f.obj.pilotRoot, join(f.obj.pilotRoot, "hubs"), f.obj.repos[0], join(f.obj.live.kitRoot, "hubs"), join(f.sb, "outside-home/hubs"), f.devtwin]) {
    await assert.rejects(loadPilot(await f.write({ hubRoot: [hub] }), gate), refused(undefined), hub);
  }
  await assert.rejects(loadPilot(await f.write({ hubRoot: [f.paths.hub, join(f.paths.hub, "nested")] }), gate), refused(undefined));
});
test("backupTargets allows writes inside and refuses siblings, the store and other classes", async (t) => {
  const f = await liveFixture(t), backups = join(f.home, "devtwin-backups"), roots = await f.roots({ backupTargets: [backups], hubRoot: [f.paths.hub] });
  assert.doesNotThrow(() => assertWritable(roots, [backups, join(backups, "devtwin-backup-x.dtb"), join(backups, "restored/state/a.json")], { writeClass: "backupTargets" }));
  for (const path of [join(f.home, "devtwin-backups-other"), f.home, join(f.paths.hub, "x")]) await assert.rejects(writable(roots, [path], { writeClass: "backupTargets" }), refused("destination"), path);
  await assert.rejects(writable(roots, [join(backups, "x")], { writeClass: "hubRoot" }), refused("destination"));
  const gate = { ...f.context, liveGate: { approval: false } };
  for (const folder of [join(f.home, ".claude/backups"), f.home, f.obj.pilotRoot, join(f.obj.stateRoot, "backups"), f.obj.repos[0], join(f.obj.live.kitRoot, "backups"), join(f.sb, "outside-home/backups"), f.devtwin, f.paths.hub]) {
    await assert.rejects(loadPilot(await f.write({ hubRoot: [f.paths.hub], backupTargets: [folder] }), gate), refused(undefined), folder);
  }
  await assert.rejects(loadPilot(await f.write({ backupTargets: [backups, join(backups, "nested")] }), gate), refused(undefined));
});
test("write classes refuse unknown classes, duplicates and targets outside the agent folders", async (t) => {
  const f = await liveFixture(t), gate = { ...f.context, liveGate: { approval: false } };
  for (const writeClasses of [{ other: [] }, { hookTargets: f.paths.settings }, { hookTargets: [7] }, [], { hookTargets: [f.paths.settings, f.paths.settings] }, { instructionTargets: [join(f.home, ".claude/notes.md")] }, { instructionTargets: [join(f.home, ".claude/skills/devtwin.md")] }, { instructionTargets: [join(f.home, "CLAUDE.md")] }, { instructionTargets: [join(f.sb, "other/.claude/CLAUDE.md")] }, { instructionTargets: [f.home + "/.claude/../.claude/CLAUDE.md"] }, { instructionTargets: [f.paths.settings] }, { hookTargets: [join(f.home, ".claude/settings.local.json")] }, { hookTargets: [join(f.home, ".codex/config.toml")] }, { hookTargets: [f.paths.claudeMd] }]) {
    await assert.rejects(loadPilot(await f.write(writeClasses), gate), refused(undefined), JSON.stringify(writeClasses));
  }
  // CLAUDE_CONFIG_DIR moves the Claude targets, and only inside the home.
  const configDir = join(f.home, "claude-config");
  await mkdir(join(configDir, "skills"), { recursive: true });
  const env = { CLAUDE_CONFIG_DIR: configDir }, live = { ...f.obj.live, skillDirs: { claude: join(configDir, "skills") } };
  const path = join(f.devtwin, "live-env.json");
  await writeFile(path, JSON.stringify({ ...f.obj, live, writeClasses: { hookTargets: [join(configDir, "settings.json")] } }), { mode: 0o600 });
  assert.deepEqual((await loadPilot(path, { ...gate, env })).writeClasses.hookTargets, [join(configDir, "settings.json")]);
  await writeFile(path, JSON.stringify({ ...f.obj, live, writeClasses: { hookTargets: [f.paths.settings] } }), { mode: 0o600 });
  await assert.rejects(loadPilot(path, { ...gate, env }), refused(undefined));
});
test("disposable pilot write classes stay exact and inside a listed agent home", async (t) => {
  const p = await makePilot(t), [home] = p.agentHomes, settings = join(home, ".claude/settings.json"), hub = join(p.pilot.pilotRoot, "hubs");
  const opts = { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} };
  const roots = rootsFromPilot(await loadPilot(await p.with({ writeClasses: { hookTargets: [settings], hubRoot: [hub] } }), opts));
  assert.doesNotThrow(() => assertWritable(roots, [settings], { writeClass: "hookTargets" }));
  assert.doesNotThrow(() => assertWritable(roots, [join(hub, "example/hub.json")], { writeClass: "hubRoot" }));
  await assert.rejects(writable(roots, [join(home, ".claude/other.json")], { writeClass: "hookTargets" }), refused("destination"));
  for (const writeClasses of [{ hookTargets: [join(p.fakeHome, ".claude/settings.json")] }, { launchAgents: [join(p.fakeHome, "Library/LaunchAgents/devtwin.radar.plist")] }, { hubRoot: [join(p.sandbox, "hubs")] }, { hubRoot: [join(home, "hubs")] }, { hubRoot: [p.dataRoot] }]) {
    await assert.rejects(loadPilot(await p.with({ writeClasses }), opts), refused(undefined), JSON.stringify(writeClasses));
  }
});
