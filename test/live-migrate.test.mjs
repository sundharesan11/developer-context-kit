import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, chmod, lstat, rename, cp, symlink, rm } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, runCli, packageKit } from "./helpers.mjs";
import { loadPilot, readApprovedDigest } from "../src/config/pilot.mjs";
import { applyLiveMigrate, previewLiveMigrate } from "../src/config/migrate.mjs";
import { canonicalJson, sha256 } from "../src/storage/canonical.mjs";
import { SKILL_NAMES } from "../src/agents/install.mjs";
import { LEGACY_SKILL_NAMES, kitEnv, envNotes } from "../src/config/legacy.mjs";
import { rollbackCheck } from "../src/agents/inventory.mjs";
import { rootsFromPilot } from "../src/config/pilot.mjs";

const mode = async (path) => (await lstat(path)).mode & 0o777;
const kitFiles = (skills) => Object.fromEntries(skills.map((s) => [`skills/${s}/SKILL.md`, `---\nname: ${s}\ndescription: Use when testing ${s}.\n---\n# ${s}\n`]));
async function pinnedKit(dir, files) {
  const kit = await makeRepo(dir, files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  return { kit, commit: (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim() };
}
// Paths, types, modes and content of a tree. Directory times are left out: holding a lock touches state/locks.
async function contentSnapshot(dir) {
  const rows = [];
  async function walk(path, rel) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), st = await lstat(child), r = rel ? rel + "/" + name : name;
      rows.push([r, st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file", st.mode & 0o7777, st.isFile() ? createHash("sha256").update(await readFile(child)).digest("hex") : null]);
      if (st.isDirectory() && !st.isSymbolicLink()) await walk(child, r);
    }
  }
  await walk(dir, "");
  return rows;
}
// Writes bundled entries and their completed journal exactly as a devctx kit did: devctx-* folders with .devctx-owned.json.
async function legacyInstall(stateRoot, { configId, kitCommit, dirs, runId = "run_legacyinstall01" }) {
  const intended = [];
  for (const [agent, dir] of Object.entries(dirs)) for (const skill of LEGACY_SKILL_NAMES) {
    const path = join(dir, skill), body = Buffer.from(`legacy ${skill}\n`);
    const receipt = { schemaVersion: 2, kind: "skill-bundled", skill, configId, runId, kitCommit, files: { "SKILL.md": sha256(body) } };
    const receiptBytes = canonicalJson(receipt) + "\n";
    await mkdir(path, { mode: 0o700 });
    await writeFile(join(path, "SKILL.md"), body, { mode: 0o600 });
    await writeFile(join(path, ".devctx-owned.json"), receiptBytes, { mode: 0o600 });
    intended.push({ agent, skill, path, root: dir, status: "create", old: null, new: { "SKILL.md": sha256(body), ".devctx-owned.json": sha256(receiptBytes) }, receipt });
  }
  const runDir = join(stateRoot, "runs", runId);
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await chmod(join(stateRoot, "runs"), 0o700);
  const journal = { schemaVersion: 2, kind: "skill-bundled", configId, runId, kitCommit, mode: "install", planFingerprint: "sha256:" + "1".repeat(64), targetHome: null, intended, started: intended.map((_, i) => i), created: intended.map((_, i) => i), completed: intended };
  await writeFile(join(runDir, "journal.json"), canonicalJson(journal) + "\n", { mode: 0o600 });
  // An inventory as the devctx kit wrote it, with its owned rows under "devctx".
  const folders = Object.entries(dirs).map(([agent, dir]) => ({ agent, dir, existed: true, type: "dir", entries: [], devctx: [] }));
  await writeFile(join(runDir, "inventory.json"), canonicalJson({ schemaVersion: 1, kind: "skill-inventory", runId, configId, mode: "install", recordedAt: "2026-10-25T00:00:00.000Z", folders }) + "\n", { mode: 0o600 });
  return runId;
}
// A fake home with a working legacy setup under ~/.devctx and an empty private ~/.devtwin holding the new kit.
async function legacyHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), legacyDir = join(home, ".devctx"), newDir = join(home, ".devtwin");
  const dirs = { claude: join(home, ".claude/skills"), codex: join(home, ".agents/skills") };
  for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
  await mkdir(legacyDir, { mode: 0o700 }); await chmod(legacyDir, 0o700);
  const oldKit = await pinnedKit(join(legacyDir, "kit"), kitFiles(LEGACY_SKILL_NAMES));
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const legacyConfig = join(legacyDir, "live.json"), newConfig = join(newDir, "live.json");
  const oldCli = (args) => runCli(args, { home, env: {}, kitRoot: oldKit.kit });
  const ok = (r) => { assert.equal(r.json.ok, true, JSON.stringify(r.json.error)); return r.json.result; };
  const initArgs = ["live", "init", "--pilot", legacyConfig, "--agent", "claude", "--agent", "codex", "--repo", repo];
  const preview = ok(await oldCli(initArgs));
  ok(await oldCli([...initArgs, "--apply", "--plan-fingerprint", preview.fingerprint]));
  ok(await oldCli(["init", "--pilot", legacyConfig, "--actor", "email:owner@example.com", "--apply"]));
  const hub = join(legacyDir, "store/inputs/hub");
  await mkdir(hub, { mode: 0o700 });
  ok(await oldCli(["scope", "add", "--pilot", legacyConfig, "--scope", "example", "--hub", "notes=local-dir:" + hub, "--apply"]));
  const configId = JSON.parse(await readFile(legacyConfig, "utf8")).live.configId;
  const runId = await legacyInstall(join(legacyDir, "store/state"), { configId, kitCommit: oldKit.commit, dirs });
  await mkdir(newDir, { mode: 0o700 }); await chmod(newDir, 0o700);
  const newKit = await pinnedKit(join(newDir, "kit"), kitFiles(SKILL_NAMES));
  const cli = (args, env = {}) => runCli(args, { home, env, kitRoot: newKit.kit });
  const ctx = { home, env: {}, kitRoot: newKit.kit };
  const input = (extra = {}) => ({ configPath: newConfig, from: legacyConfig, ...extra });
  return { sb, home, legacyDir, newDir, dirs, oldKit, newKit, repo, legacyConfig, newConfig, configId, runId, cli, ctx, input, ok };
}
const migrateArgs = (h) => ["live", "migrate", "--pilot", h.newConfig, "--from", h.legacyConfig];
const failed = (r, code) => { assert.equal(r.json.ok, false, JSON.stringify(r.json)); assert.equal(r.json.error.code, code, JSON.stringify(r.json.error)); return r.json.error; };

test("live migrate previews without writing, then copies the legacy store with its modes and rewritten paths and never touches the legacy folder", async (t) => {
  const h = await legacyHome(t);
  const legacyBefore = await contentSnapshot(h.legacyDir), skillsBefore = await contentSnapshot(h.home + "/.claude");
  const preview = h.ok(await h.cli(migrateArgs(h)));
  assert.equal(preview.preview, true);
  assert.equal(preview.status, "migrate");
  assert.deepEqual(await readdir(h.newDir), ["kit"]);
  assert.equal(preview.from.configId, h.configId);
  assert.equal(preview.config.pilotRoot, join(h.newDir, "store"));
  assert.equal(preview.config.live.kitRoot, h.newKit.kit);
  assert.equal(preview.config.live.kitCommit, h.newKit.commit);
  assert.deepEqual(preview.leftBehind, ["kit"]);
  assert.deepEqual(preview.rewrites.map((r) => r.file), ["live.json", "store/config/scopes/example.json"]);
  assert.ok(preview.rewrites[0].pointers.includes("/pilotRoot"));
  assert.deepEqual(preview.rewrites[1].pointers, ["/hubs/0/path"]);
  assert.deepEqual(preview.warnings, []);
  assert.ok(preview.next.some((s) => s.step === "remove-legacy-root" && s.command === "rm -rf '" + h.legacyDir + "'"));
  assert.ok(preview.next.some((s) => s.step === "shell-profile" && s.command === "export DEVTWIN_KIT='" + h.newKit.kit + "'"));
  const applied = h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
  assert.equal(applied.applied, true);
  assert.equal(applied.configId, h.configId);
  // The legacy folder is byte- and mode-identical, and so are the skill folders.
  assert.deepEqual(await contentSnapshot(h.legacyDir), legacyBefore);
  assert.deepEqual(await contentSnapshot(h.home + "/.claude"), skillsBefore);
  assert.deepEqual((await readdir(h.newDir)).sort(), ["kit", "live.json", "store"]);
  // Every copied node keeps its mode, and only the rewritten files, the approval and the receipt differ.
  const oldStore = new Map((await contentSnapshot(join(h.legacyDir, "store"))).map((r) => [r[0], r]));
  const newStore = new Map((await contentSnapshot(join(h.newDir, "store"))).map((r) => [r[0], r]));
  const changed = ["config/scopes/example.json", "state/live/approved-config.json"];
  assert.deepEqual([...newStore.keys()].filter((k) => !oldStore.has(k)), ["state/live/migration.json"]);
  for (const [rel, row] of oldStore) {
    assert.equal(newStore.get(rel)?.[2], row[2], rel + " mode");
    if (!changed.includes(rel)) assert.deepEqual(newStore.get(rel), row, rel);
  }
  assert.equal(await mode(h.newConfig), 0o600);
  for (const dir of ["store", "store/config", "store/data", "store/state", "store/inputs"]) assert.equal(await mode(join(h.newDir, dir)), 0o700, dir);
  const scope = JSON.parse(await readFile(join(h.newDir, "store/config/scopes/example.json"), "utf8"));
  assert.equal(scope.hubs[0].path, join(h.newDir, "store/inputs/hub"));
  const pilot = await loadPilot(h.newConfig, h.ctx);
  assert.equal(pilot.live.configId, h.configId);
  assert.deepEqual(await readApprovedDigest(pilot), { schemaVersion: 1, configId: h.configId, digest: pilot.digest });
  assert.ok(!JSON.stringify(JSON.parse(await readFile(h.newConfig, "utf8"))).includes(h.legacyDir));
  h.ok(await h.cli(["doctor", "--pilot", h.newConfig]));
  // Idempotent: a second preview reports the finished migration and its apply writes nothing.
  const again = h.ok(await h.cli(migrateArgs(h)));
  assert.equal(again.status, "migrated");
  const snapshot = await contentSnapshot(h.newDir);
  const noop = h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", again.fingerprint]));
  assert.equal(noop.applied, false);
  assert.deepEqual(await contentSnapshot(h.newDir), snapshot);
});

test("after live migrate, agents install replaces owned legacy devctx-* skills and preserves foreign and edited ones", async (t) => {
  const h = await legacyHome(t);
  await mkdir(join(h.dirs.claude, "devctx-notes"));
  await writeFile(join(h.dirs.claude, "devctx-notes/SKILL.md"), "foreign\n");
  await writeFile(join(h.dirs.codex, "devctx-record/SKILL.md"), "edited by hand\n");
  const preview = h.ok(await h.cli(migrateArgs(h)));
  h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
  const status = h.ok(await h.cli(["agents", "status", "--pilot", h.newConfig]));
  const legacyActions = status.actions.filter((a) => a.skill.startsWith("devctx-"));
  assert.deepEqual(legacyActions.filter((a) => a.status === "remove").map((a) => a.agent + ":" + a.skill).sort(), ["claude:devctx-onboard", "claude:devctx-record", "claude:devctx-resume", "codex:devctx-onboard", "codex:devctx-resume"]);
  assert.deepEqual(legacyActions.filter((a) => a.status === "preserve").map((a) => [a.agent, a.skill, a.reason]), [["codex", "devctx-record", "legacy-edited"]]);
  assert.ok(legacyActions.every((a) => a.reason === "legacy-name" || a.status === "preserve"));
  for (const agent of ["claude", "codex"]) {
    const plan = h.ok(await h.cli(["agents", "install", "--pilot", h.newConfig, "--agent", agent]));
    assert.ok(plan.actions.filter((a) => SKILL_NAMES.includes(a.skill)).every((a) => a.status === "create"));
    h.ok(await h.cli(["agents", "install", "--pilot", h.newConfig, "--agent", agent, "--apply", "--plan-fingerprint", plan.fingerprint]));
  }
  assert.deepEqual((await readdir(h.dirs.claude)).sort(), ["devctx-notes", ...SKILL_NAMES].sort());
  assert.deepEqual((await readdir(h.dirs.codex)).sort(), ["devctx-record", ...SKILL_NAMES].sort());
  assert.equal(await readFile(join(h.dirs.claude, "devctx-notes/SKILL.md"), "utf8"), "foreign\n");
  assert.equal(await readFile(join(h.dirs.codex, "devctx-record/SKILL.md"), "utf8"), "edited by hand\n");
  const receipt = JSON.parse(await readFile(join(h.dirs.claude, "devtwin-resume/.devtwin-owned.json"), "utf8"));
  assert.equal(receipt.configId, h.configId);
  assert.equal(receipt.kitCommit, h.newKit.commit);
  const after = h.ok(await h.cli(["agents", "status", "--pilot", h.newConfig]));
  assert.equal(after.status, "ok");
  assert.ok(after.actions.filter((a) => SKILL_NAMES.includes(a.skill)).every((a) => a.status === "installed"));
  assert.deepEqual(after.actions.filter((a) => a.skill.startsWith("devctx-")).map((a) => a.status), ["preserve"]);
  // The legacy folder still holds the old store untouched; the legacy entries are gone from the skill folders.
  assert.ok((await readdir(join(h.legacyDir, "store/state/runs"))).includes(h.runId));
});

test("agents uninstall removes owned legacy devctx-* entries, and rollback-check reads an inventory written under the old name", async (t) => {
  const h = await legacyHome(t);
  const preview = h.ok(await h.cli(migrateArgs(h)));
  h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
  const plan = h.ok(await h.cli(["agents", "uninstall", "--pilot", h.newConfig, "--agent", "claude"]));
  assert.deepEqual(plan.actions.filter((a) => a.status === "remove").map((a) => a.skill).sort(), [...LEGACY_SKILL_NAMES].sort());
  h.ok(await h.cli(["agents", "uninstall", "--pilot", h.newConfig, "--agent", "claude", "--apply", "--plan-fingerprint", plan.fingerprint]));
  assert.deepEqual(await readdir(h.dirs.claude), []);
  const pilot = await loadPilot(h.newConfig, h.ctx);
  // The legacy inventory saw empty folders; the codex folder still holds its legacy entries, so it differs.
  await assert.rejects(rollbackCheck(rootsFromPilot(pilot), pilot, { runId: h.runId }), (error) => error.code === "DEVTWIN_ROLLBACK_MISMATCH" && error.details.folders.find((f) => f.agent === "codex").devtwin.length > 0 && error.details.folders.find((f) => f.agent === "claude").devtwin.length === 0);
});

test("live migrate refuses a stale fingerprint, a non-empty target, a held legacy lock, an interrupted install and a kit inside the legacy folder", async (t) => {
  const h = await legacyHome(t);
  const preview = h.ok(await h.cli(migrateArgs(h)));
  failed(await h.cli([...migrateArgs(h), "--apply"]), "DEVTWIN_PLAN_REQUIRED");
  failed(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)]), "DEVTWIN_PLAN_MISMATCH");
  failed(await h.cli(["live", "migrate", "--pilot", h.newConfig]), "DEVTWIN_INVALID_INPUT");
  await writeFile(join(h.newDir, "notes.txt"), "x");
  assert.deepEqual(failed(await h.cli(migrateArgs(h)), "DEVTWIN_CONFLICT").details.entries, ["notes.txt"]);
  await rm(join(h.newDir, "notes.txt"));
  const lock = join(h.legacyDir, "store/state/locks/install.lock");
  await writeFile(lock, JSON.stringify({ pid: 1, host: "elsewhere" }), { mode: 0o600 });
  assert.deepEqual(failed(await h.cli(migrateArgs(h)), "DEVTWIN_BUSY").details.locks, ["install.lock"]);
  await rm(lock);
  const journal = join(h.legacyDir, "store/state/runs", h.runId, "journal.json");
  const original = await readFile(journal, "utf8"), parsed = JSON.parse(original);
  await writeFile(journal, canonicalJson({ ...parsed, completed: parsed.completed.slice(1) }) + "\n");
  assert.deepEqual(failed(await h.cli(migrateArgs(h)), "DEVTWIN_RECOVERY_REQUIRED").details.runs, [h.runId]);
  await writeFile(journal, original);
  await chmod(h.newDir, 0o755);
  failed(await h.cli(migrateArgs(h)), "DEVTWIN_PATH_UNSAFE");
  await chmod(h.newDir, 0o700);
  const inside = await pinnedKit(join(h.legacyDir, "kit-next"), kitFiles(SKILL_NAMES));
  const r = await runCli(migrateArgs(h), { home: h.home, env: {}, kitRoot: inside.kit });
  assert.equal(failed(r, "DEVTWIN_GATE_REQUIRED").details.reason, "inside-legacy-root");
  await rm(join(h.legacyDir, "kit-next"), { recursive: true, force: true });
  assert.deepEqual(await readdir(h.newDir), ["kit"]);
  // The original preview still applies once everything is back.
  h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
});

test("live migrate refuses a symlink in the legacy store and an unapproved legacy config", async (t) => {
  const h = await legacyHome(t);
  await symlink("/etc/hosts", join(h.legacyDir, "store/data/link"));
  const error = failed(await h.cli(migrateArgs(h)), "DEVTWIN_PATH_UNSAFE");
  assert.equal(error.details.reason, "symlink");
  await rm(join(h.legacyDir, "store/data/link"));
  const config = JSON.parse(await readFile(h.legacyConfig, "utf8"));
  await writeFile(h.legacyConfig, JSON.stringify({ ...config, repos: [] }, null, 2) + "\n");
  assert.equal(failed(await h.cli(migrateArgs(h)), "DEVTWIN_GATE_REQUIRED").details.field, "live.approval");
  assert.deepEqual(await readdir(h.newDir), ["kit"]);
});

test("live migrate removes its own staging after a failure and discards a partial copy left by a crash", async (t) => {
  const h = await legacyHome(t);
  const plan = await previewLiveMigrate(h.input(), h.ctx);
  const kept = join(h.sb, "kept-staging");
  let n = 0;
  const faults = { async afterFile() { if (++n === 3) { await cp(join(h.newDir, ".store-migrating"), kept, { recursive: true }); throw new Error("injected crash"); } } };
  await assert.rejects(applyLiveMigrate(h.input({ fingerprint: plan.fingerprint }), h.ctx, { faults }), /injected crash/);
  assert.deepEqual(await readdir(h.newDir), ["kit"]);
  // A killed process leaves its staging folder behind, with a temporary file.
  await rename(kept, join(h.newDir, ".store-migrating"));
  await writeFile(join(h.newDir, ".store-migrating", ".devtwin-migrate-0123456789abcdef.tmp"), "partial", { mode: 0o600 });
  const again = await previewLiveMigrate(h.input(), h.ctx);
  assert.equal(again.partial.removable, true);
  await applyLiveMigrate(h.input({ fingerprint: again.fingerprint }), h.ctx);
  assert.deepEqual((await readdir(h.newDir)).sort(), ["kit", "live.json", "store"]);
  await loadPilot(h.newConfig, h.ctx);
});

test("live migrate holds a staging folder that is not a clean partial copy", async (t) => {
  const h = await legacyHome(t);
  await mkdir(join(h.newDir, ".store-migrating/config"), { recursive: true, mode: 0o700 });
  await chmod(join(h.newDir, ".store-migrating"), 0o700);
  await writeFile(join(h.newDir, ".store-migrating/config/user.json"), "{\"changed\":true}\n", { mode: 0o600 });
  const plan = await previewLiveMigrate(h.input(), h.ctx);
  assert.deepEqual({ removable: plan.partial.removable, reason: plan.partial.reason, entry: plan.partial.entry }, { removable: false, reason: "unexpected-entry", entry: "config/user.json" });
  await assert.rejects(applyLiveMigrate(h.input({ fingerprint: plan.fingerprint }), h.ctx), (error) => error.code === "DEVTWIN_RECOVERY_REQUIRED");
  assert.equal(await readFile(join(h.newDir, ".store-migrating/config/user.json"), "utf8"), "{\"changed\":true}\n");
});

test("live migrate finishes a run that stopped after the store was renamed into place", async (t) => {
  const h = await legacyHome(t);
  const plan = await previewLiveMigrate(h.input(), h.ctx);
  await assert.rejects(applyLiveMigrate(h.input({ fingerprint: plan.fingerprint }), h.ctx, { faults: { afterRename() { throw new Error("injected crash"); } } }), /injected crash/);
  assert.deepEqual((await readdir(h.newDir)).sort(), ["kit", "store"]);
  const again = await previewLiveMigrate(h.input(), h.ctx);
  assert.equal(again.status, "finish");
  const done = await applyLiveMigrate(h.input({ fingerprint: again.fingerprint }), h.ctx);
  assert.equal(done.applied, true);
  await loadPilot(h.newConfig, h.ctx);
});

test("live migrate from a legacy folder works from a package kit installed under the new folder's kits", async (t) => {
  const h = await legacyHome(t);
  const pkg = await packageKit(h.home, join(h.sb, "global/devtwin"), { files: kitFiles(SKILL_NAMES) });
  // From the Git kit, the kits folder is an entry the new folder may not hold.
  assert.deepEqual(failed(await h.cli(migrateArgs(h)), "DEVTWIN_CONFLICT").details.entries, ["kits"]);
  await rm(h.newKit.kit, { recursive: true, force: true });
  const cli = (args) => runCli(args, { home: h.home, env: {}, kitRoot: pkg.kit });
  const preview = h.ok(await cli(migrateArgs(h)));
  assert.equal(preview.status, "migrate");
  assert.deepEqual(preview.warnings, [], "a package kit under <new folder>/kits is no KIT_NOT_SIBLING");
  const live = preview.config.live;
  assert.deepEqual([live.kitRoot, live.kitVersion, live.kitDigest, Object.hasOwn(live, "kitCommit")], [pkg.kit, pkg.version, pkg.digest, false]);
  assert.deepEqual([preview.to.kitRoot, preview.to.kitVersion, preview.to.kitDigest, preview.to.kitId, Object.hasOwn(preview.to, "kitCommit")], [pkg.kit, pkg.version, pkg.digest, pkg.kitId, false]);
  const applied = h.ok(await cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
  assert.equal(applied.configId, h.configId);
  assert.deepEqual((await readdir(h.newDir)).sort(), ["kits", "live.json", "store"]);
  const receipt = JSON.parse(await readFile(join(h.newDir, "store/state/live/migration.json"), "utf8"));
  assert.deepEqual(receipt.to, { config: h.newConfig, root: h.newDir, digest: applied.digest, kitRoot: pkg.kit, kitVersion: pkg.version, kitDigest: pkg.digest, kitId: pkg.kitId });
  const written = JSON.parse(await readFile(h.newConfig, "utf8")).live;
  assert.deepEqual([written.kitVersion, written.kitDigest, Object.hasOwn(written, "kitCommit")], [pkg.version, pkg.digest, false]);
  h.ok(await cli(["doctor", "--pilot", h.newConfig]));
  // agents install from the package kit replaces the owned legacy entries; the receipts name the package kit.
  const plan = h.ok(await cli(["agents", "install", "--pilot", h.newConfig, "--agent", "claude"]));
  h.ok(await cli(["agents", "install", "--pilot", h.newConfig, "--agent", "claude", "--apply", "--plan-fingerprint", plan.fingerprint, "--run-id", "run_pkgmigrate01"]));
  const owned = JSON.parse(await readFile(join(h.dirs.claude, SKILL_NAMES[0], ".devtwin-owned.json"), "utf8"));
  assert.deepEqual([owned.schemaVersion, owned.kitId, owned.kitCommit], [3, pkg.kitId, null]);
  assert.equal(h.ok(await cli(migrateArgs(h))).status, "migrated");
});

test("DEVTWIN_KIT wins over the legacy DEVCTX_KIT, which is read for one transition and reported as deprecated", async (t) => {
  assert.deepEqual(kitEnv({ DEVTWIN_KIT: "/k/new", DEVCTX_KIT: "/k/old" }), { name: "DEVTWIN_KIT", value: "/k/new", deprecated: false, legacyAlsoSet: true });
  assert.deepEqual(kitEnv({ DEVCTX_KIT: "/k/old" }), { name: "DEVCTX_KIT", value: "/k/old", deprecated: true, legacyAlsoSet: true });
  assert.deepEqual(kitEnv({ DEVTWIN_KIT: "" }), { name: null, value: null, deprecated: false, legacyAlsoSet: false });
  assert.deepEqual(envNotes({ DEVTWIN_KIT: "/k/new" }), []);
  assert.equal(envNotes({ DEVCTX_KIT: "/k/old" })[0].code, "LEGACY_KIT_ENV");
  const h = await legacyHome(t);
  const preview = h.ok(await h.cli(migrateArgs(h), { DEVCTX_KIT: h.oldKit.kit }));
  assert.equal(preview.notes[0].using, "DEVCTX_KIT");
  h.ok(await h.cli([...migrateArgs(h), "--apply", "--plan-fingerprint", preview.fingerprint]));
  const status = h.ok(await h.cli(["agents", "status", "--pilot", h.newConfig], { DEVCTX_KIT: h.newKit.kit }));
  assert.equal(status.notes[0].code, "LEGACY_KIT_ENV");
  assert.equal(h.ok(await h.cli(["agents", "status", "--pilot", h.newConfig], { DEVTWIN_KIT: h.newKit.kit })).notes, undefined);
});

test("help lists live migrate", async () => {
  const r = await runCli(["help"]);
  assert.ok(r.json.result.commands.includes("live migrate"));
});
