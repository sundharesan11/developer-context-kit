import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, rm, symlink, link, chmod, cp, realpath } from "node:fs/promises";
import { sandbox } from "./helpers.mjs";
import { kitDigest, writeManifest, readManifest, verifyKit, MANIFEST } from "../src/kit/manifest.mjs";
import { kitId, parseKitId, parseKitArg, displayKitId, kitIdentity, identityOfKit, kitsFolder } from "../src/kit/identity.mjs";
import { assertKit } from "../src/config/pilot.mjs";
import { receiptProblem, receiptPath } from "../src/hooks/receipt.mjs";
import { currentPaths, confirmationState, confirmedPath } from "../src/paths/confirm.mjs";
import { sha256 } from "../src/storage/canonical.mjs";

const VERSION = "0.1.0-alpha.1", COMMIT = "c".repeat(40), DIGEST = "d".repeat(64);
const FILES = { "package.json": JSON.stringify({ name: "devtwin", version: VERSION }) + "\n", "bin/devtwin.mjs": "#!/usr/bin/env node\n", "src/a.mjs": "export const a = 1;\n", "src/sub/b.mjs": "export {};\n", "README.md": "# devtwin\n", "LICENSE": "license\n" };
const gate = (field, reason) => (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === field && (reason === undefined || e.details.reason === reason);
// KTD4 modes: folders 0500, files 0400, bin/devtwin.mjs 0500. unlock makes every folder writable again for an edit.
async function setModes(root, dir, file) {
  const walk = async (rel) => {
    const path = join(root, rel), st = lstatSync(path);
    if (st.isDirectory()) { await chmod(path, 0o700); for (const name of await readdir(path)) await walk(join(rel, name)); await chmod(path, dir); }
    else if (st.isFile()) await chmod(path, file(rel));
  };
  await walk(".");
}
const lock = (root) => setModes(root, 0o500, (rel) => rel === "bin/devtwin.mjs" ? 0o500 : 0o400);
const unlock = (root) => setModes(root, 0o700, () => 0o600);
async function stageKit(dir, files = FILES) {
  for (const [rel, text] of Object.entries(files)) { await mkdir(join(dir, rel, ".."), { recursive: true }); await writeFile(join(dir, rel), text); }
  await chmod(join(dir, "bin/devtwin.mjs"), 0o755);
  return dir;
}
// A package kit installed under <home>/.devtwin/kits as U44 will install it.
async function packageKit(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), kits = join(devtwin, "kits");
  await mkdir(kits, { recursive: true, mode: 0o700 });
  await chmod(devtwin, 0o700);
  const staged = await stageKit(join(kits, "staging"));
  const manifest = await writeManifest(staged, { sourceCommit: COMMIT });
  const kit = join(kits, VERSION + "-" + manifest.digest.slice(0, 12));
  await cp(staged, kit, { recursive: true });
  await rm(staged, { recursive: true });
  await lock(kit);
  const identity = { kind: "package", version: VERSION, digest: manifest.digest };
  const check = (options = {}) => assertKit(kit, identity, { home, ...options });
  // edit(fn) unlocks the kit, runs fn and locks it again, so each refusal comes from one change only.
  const edit = async (fn) => { await unlock(kit); await fn(); await lock(kit); };
  return { sb, home, devtwin, kits, kit: await realpath(kit), manifest, identity, check, edit };
}
const foreign = (match) => (path) => { const st = lstatSync(path); return match(path) ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1 }) : st; };

test("kit identity names a Git or package kit and parses only full digests", () => {
  const git = { kind: "git", commit: COMMIT }, pkg = { kind: "package", version: VERSION, digest: DIGEST };
  assert.equal(kitId(git), "git:" + COMMIT);
  assert.equal(kitId(pkg), "npm:" + VERSION + "+sha256:" + DIGEST);
  assert.deepEqual(parseKitId(kitId(git)), git);
  assert.deepEqual(parseKitId(kitId(pkg)), pkg);
  assert.equal(displayKitId(pkg), "npm:" + VERSION + "+sha256:" + DIGEST.slice(0, 12));
  assert.equal(displayKitId(kitId(git)), "git:" + COMMIT.slice(0, 12));
  for (const bad of ["npm:" + VERSION + "+sha256:" + DIGEST.slice(0, 12), "npm:1.0+sha256:" + DIGEST, "npm:1.0.0+build+sha256:" + DIGEST, "git:" + COMMIT.slice(0, 12), "git:main", "sha256:" + DIGEST, ""]) {
    assert.throws(() => parseKitId(bad), { code: "DEVTWIN_INVALID_INPUT" }, bad);
  }
  assert.deepEqual(kitIdentity({ kitCommit: COMMIT }), git);
  assert.deepEqual(kitIdentity({ kitVersion: VERSION, kitDigest: DIGEST }), pkg);
  for (const live of [{}, { kitCommit: COMMIT, kitDigest: DIGEST, kitVersion: VERSION }, { kitCommit: COMMIT, kitVersion: VERSION }, { kitVersion: VERSION }, { kitVersion: VERSION, kitDigest: DIGEST.slice(0, 12) }, { kitCommit: "main" }]) {
    assert.throws(() => kitIdentity(live), { code: "DEVTWIN_INVALID_INPUT" }, JSON.stringify(live));
  }
  assert.equal(kitsFolder("/h"), join("/h", ".devtwin", "kits"));
});

test("kit digest covers path, executable bit and bytes of the runtime set, and the manifest is outside it", async (t) => {
  const sb = await sandbox(t), a = await stageKit(join(sb, "a")), digest = kitDigest(a);
  assert.match(digest, /^[0-9a-f]{64}$/);
  // The normalized mode makes the source checkout, the tarball and a locked copy digest the same.
  await lock(a);
  assert.equal(kitDigest(a), digest);
  await unlock(a);
  await chmod(join(a, "bin/devtwin.mjs"), 0o755);
  assert.equal(kitDigest(a), digest);
  await chmod(join(a, "src/a.mjs"), 0o755);
  assert.notEqual(kitDigest(a), digest, "an executable bit is part of the digest");
  await chmod(join(a, "src/a.mjs"), 0o644);
  // Files outside the runtime set are not part of it, and the manifest is not either.
  await writeFile(join(a, "notes.txt"), "x");
  await writeManifest(a, { sourceCommit: null });
  assert.equal(kitDigest(a), digest);
  await writeFile(join(a, "src/a.mjs"), "export const a = 2;\n");
  assert.notEqual(kitDigest(a), digest);
});

test("kit manifest records version, digest, sorted files and the source commit, and readManifest refuses a bad one", async (t) => {
  const sb = await sandbox(t), kit = await stageKit(join(sb, "kit"));
  const manifest = await writeManifest(kit, { sourceCommit: COMMIT });
  assert.deepEqual(manifest, { schemaVersion: 1, version: VERSION, digest: kitDigest(kit), files: Object.keys(FILES).sort(), sourceCommit: COMMIT });
  assert.deepEqual(readManifest(kit), manifest);
  assert.deepEqual(JSON.parse(await readFile(join(kit, MANIFEST), "utf8")), manifest);
  await assert.rejects(writeManifest(kit, { sourceCommit: null }), { code: "DEVTWIN_CONFLICT" });
  for (const bad of [{ ...manifest, digest: DIGEST.slice(0, 12) }, { ...manifest, files: [...manifest.files].reverse() }, { ...manifest, files: [...manifest.files, "../x"] }, { ...manifest, sourceCommit: "main" }, { ...manifest, extra: 1 }, { ...manifest, schemaVersion: 2 }, { ...manifest, version: "1.0" }]) {
    await writeFile(join(kit, MANIFEST), JSON.stringify(bad));
    assert.throws(() => readManifest(kit), gate("kitRoot", "manifest"), JSON.stringify(bad));
  }
  await rm(join(kit, MANIFEST));
  assert.throws(() => readManifest(kit), gate("kitRoot", "manifest"));
});

test("identity of a running kit is git for a clone and package for a folder with a manifest", async (t) => {
  const sb = await sandbox(t), git = join(sb, "git"), pkg = await stageKit(join(sb, "pkg"));
  await mkdir(join(git, ".git"), { recursive: true });
  await writeFile(join(git, ".git/HEAD"), COMMIT + "\n");
  assert.deepEqual(identityOfKit(git), { kind: "git", commit: COMMIT });
  assert.equal(identityOfKit(pkg), null);
  const manifest = await writeManifest(pkg, { sourceCommit: null });
  assert.deepEqual(identityOfKit(pkg), { kind: "package", version: VERSION, digest: manifest.digest });
});

test("a good package kit passes the kit gate", async (t) => {
  const k = await packageKit(t);
  assert.doesNotThrow(() => k.check());
  assert.deepEqual(verifyKit(k.kit).manifest, k.manifest);
  // The installed modes are what KTD4 names.
  assert.equal(lstatSync(k.kit).mode & 0o777, 0o500);
  assert.equal(lstatSync(join(k.kit, "bin/devtwin.mjs")).mode & 0o777, 0o500);
  assert.equal(lstatSync(join(k.kit, "src/a.mjs")).mode & 0o777, 0o400);
});

test("package kit with a changed, added or removed file fails with GATE_REQUIRED", async (t) => {
  const k = await packageKit(t);
  const original = Object.fromEntries(await Promise.all(["src/a.mjs", "package.json"].map(async (rel) => [rel, await readFile(join(k.kit, rel), "utf8")])));
  for (const rel of ["src/a.mjs", "package.json"]) {
    await k.edit(() => writeFile(join(k.kit, rel), original[rel].replace(/.$/s, " ")));
    assert.throws(() => k.check(), gate("live.kitRoot", "digest"), rel);
    await k.edit(() => writeFile(join(k.kit, rel), original[rel]));
    assert.doesNotThrow(() => k.check());
  }
  for (const rel of ["src/new.mjs", "extra.txt", "node_modules/pkg/index.js", "src/.DS_Store"]) {
    await k.edit(async () => { await mkdir(join(k.kit, rel, ".."), { recursive: true }); await writeFile(join(k.kit, rel), "x"); });
    assert.throws(() => k.check(), gate("live.kitRoot", "listing"), rel);
    await k.edit(() => rm(join(k.kit, rel.split("/")[0] === "node_modules" ? "node_modules" : rel), { recursive: true }));
    assert.doesNotThrow(() => k.check(), rel);
  }
  await k.edit(() => mkdir(join(k.kit, "empty")));
  assert.throws(() => k.check(), gate("live.kitRoot", "listing"), "an extra folder");
  await k.edit(() => rm(join(k.kit, "empty"), { recursive: true }));
  await k.edit(() => rm(join(k.kit, "src/sub/b.mjs")));
  assert.throws(() => k.check(), gate("live.kitRoot", "listing"));
});

test("package kit with a link, a writable folder or a foreign owner fails with GATE_REQUIRED", async (t) => {
  const k = await packageKit(t);
  await k.edit(() => symlink("a.mjs", join(k.kit, "src/link.mjs")));
  assert.throws(() => k.check(), gate("live.kitRoot", "link"));
  await k.edit(() => rm(join(k.kit, "src/link.mjs")));
  assert.doesNotThrow(() => k.check());
  await chmod(join(k.kit, "src"), 0o520);
  assert.throws(() => k.check(), gate("live.kitRoot", "writable"));
  await chmod(join(k.kit, "src"), 0o500);
  await chmod(join(k.kit, "src/a.mjs"), 0o402);
  assert.throws(() => k.check(), gate("live.kitRoot", "writable"));
  await chmod(join(k.kit, "src/a.mjs"), 0o400);
  await chmod(k.kits, 0o720);
  assert.throws(() => k.check(), gate("live.kitRoot", "kits-folder"));
  await chmod(k.kits, 0o700);
  await chmod(k.devtwin, 0o750);
  assert.throws(() => k.check(), gate("live.kitRoot", "kits-folder"));
  await chmod(k.devtwin, 0o700);
  assert.throws(() => k.check({ lstat: foreign((path) => path.endsWith("src/a.mjs")) }), gate("live.kitRoot", "owner"));
  assert.throws(() => k.check({ lstat: foreign((path) => path === k.kit) }), gate("live.kitRoot", "owner"));
  assert.throws(() => k.check({ lstat: foreign((path) => path === k.kits) }), gate("live.kitRoot", "kits-folder"));
  assert.doesNotThrow(() => k.check());
});

test("package kit outside the kits folder, or with a manifest that does not match, fails with GATE_REQUIRED", async (t) => {
  const k = await packageKit(t);
  const elsewhere = join(k.sb, "elsewhere", "kit");
  await mkdir(join(k.sb, "elsewhere"));
  await cp(k.kit, elsewhere, { recursive: true });
  assert.throws(() => assertKit(elsewhere, k.identity, { home: k.home }), gate("live.kitRoot", "outside-kits"));
  const nested = join(k.kits, "a");
  await mkdir(nested, { mode: 0o700 });
  await cp(k.kit, join(nested, "kit"), { recursive: true });
  assert.throws(() => assertKit(join(nested, "kit"), k.identity, { home: k.home }), gate("live.kitRoot", "outside-kits"));
  assert.throws(() => assertKit(k.kit, { ...k.identity, digest: DIGEST }, { home: k.home }), gate("live.kitDigest", "digest"));
  assert.throws(() => assertKit(k.kit, { ...k.identity, version: "0.1.0" }, { home: k.home }), gate("live.kitVersion", "version"));
  await k.edit(() => writeFile(join(k.kit, MANIFEST), JSON.stringify({ ...k.manifest, digest: DIGEST })));
  assert.throws(() => assertKit(k.kit, { ...k.identity, digest: DIGEST }, { home: k.home }), gate("live.kitRoot", "digest"));
  await k.edit(() => rm(join(k.kit, MANIFEST)));
  assert.throws(() => k.check(), gate("live.kitRoot", "manifest"));
});

// The receipt fast path: one small read of .git/HEAD for a Git kit, of the manifest for a package kit.
async function receiptAt(t, receipt) {
  const sb = await sandbox(t), stateRoot = join(sb, "state"), pilotPath = join(sb, "live.json"), pilotBytes = Buffer.from("{}");
  await mkdir(join(stateRoot, "hooks"), { recursive: true, mode: 0o700 });
  await writeFile(pilotPath, pilotBytes);
  const write = (body) => writeFile(receiptPath(stateRoot), JSON.stringify({ pilotPath, pilotSha256: sha256(pilotBytes), verifiedAt: new Date().toISOString(), ttlSeconds: 3600, ...body }), { mode: 0o600 });
  await write(receipt);
  return { sb, stateRoot, pilotPath, pilotBytes, write, problem: (kitRoot) => receiptProblem(stateRoot, { pilotPath, pilotBytes, kitRoot, now: new Date() }) };
}

test("hook receipt fast path flags kit-changed when the manifest digest changes, and old Git receipts still validate", async (t) => {
  const sb = await sandbox(t), pkg = await realpath(await stageKit(join(sb, "pkg")));
  const manifest = await writeManifest(pkg, { sourceCommit: null }), id = kitId({ kind: "package", version: VERSION, digest: manifest.digest });
  const r = await receiptAt(t, { schemaVersion: 2, kitRoot: pkg, kitId: id, kitCommit: null });
  assert.equal(await r.problem(pkg), null);
  await writeFile(join(pkg, MANIFEST), JSON.stringify({ ...manifest, digest: DIGEST }));
  assert.equal(await r.problem(pkg), "kit-changed");
  await writeFile(join(pkg, MANIFEST), JSON.stringify(manifest));
  await r.write({ schemaVersion: 2, kitRoot: pkg, kitId: "npm:" + VERSION + "+sha256:" + manifest.digest.slice(0, 12), kitCommit: null });
  assert.equal(await r.problem(pkg), "invalid");
  // Schema 1 from a Git kit: kitCommit against .git/HEAD.
  const git = join(sb, "git");
  await mkdir(join(git, ".git"), { recursive: true });
  await writeFile(join(git, ".git/HEAD"), COMMIT + "\n");
  const real = await realpath(git);
  await r.write({ schemaVersion: 1, kitRoot: real, kitCommit: COMMIT });
  assert.equal(await r.problem(real), null);
  await r.write({ schemaVersion: 2, kitRoot: real, kitId: "git:" + COMMIT, kitCommit: COMMIT });
  assert.equal(await r.problem(real), null);
  await writeFile(join(git, ".git/HEAD"), "e".repeat(40) + "\n");
  assert.equal(await r.problem(real), "kit-changed");
  await r.write({ schemaVersion: 1, kitRoot: real, kitCommit: COMMIT });
  assert.equal(await r.problem(real), "kit-changed");
  // A disposable pilot's receipt names no kit.
  await r.write({ schemaVersion: 2, kitRoot: real, kitId: null, kitCommit: null });
  assert.equal(await r.problem(real), null);
});

test("paths confirm records the kitId of a package kit, and a saved Git confirmation still reads", async (t) => {
  const sb = await sandbox(t), pkg = await realpath(await stageKit(join(sb, "pkg"))), stateRoot = join(sb, "state"), pilotPath = join(sb, "live.json");
  const manifest = await writeManifest(pkg, { sourceCommit: null }), id = kitId({ kind: "package", version: VERSION, digest: manifest.digest });
  await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(pilotPath, "{}");
  const values = currentPaths({ pilotPath, kitRoot: pkg });
  assert.deepEqual(values, { kitRoot: pkg, kitId: id, pilotPath: await realpath(pilotPath), pilotSha256: sha256(Buffer.from("{}")) });
  const save = (body) => writeFile(confirmedPath(stateRoot), JSON.stringify({ ...body, confirmedAt: new Date().toISOString() }), { mode: 0o600 });
  await save({ schemaVersion: 2, ...values });
  assert.equal((await confirmationState(stateRoot, { pilotPath, kitRoot: pkg })).state, "confirmed");
  await writeFile(join(pkg, MANIFEST), JSON.stringify({ ...manifest, digest: DIGEST }));
  assert.deepEqual((await confirmationState(stateRoot, { pilotPath, kitRoot: pkg })).fields, { kitRoot: "match", kitId: "mismatch", pilotPath: "match", pilotSha256: "match" });
  // A schema 1 confirmation names Git fields; a package kit does not match it, and a schema 2 one needs kitId.
  await save({ schemaVersion: 1, kitRoot: pkg, kitHead: COMMIT, kitRef: null, pilotPath: values.pilotPath, pilotSha256: values.pilotSha256 });
  assert.equal((await confirmationState(stateRoot, { pilotPath, kitRoot: pkg })).state, "mismatch");
  await save({ schemaVersion: 2, kitRoot: pkg, kitHead: COMMIT, kitRef: null, pilotPath: values.pilotPath, pilotSha256: values.pilotSha256 });
  assert.equal((await confirmationState(stateRoot, { pilotPath, kitRoot: pkg })).state, "invalid");
});

test("package kit with a file hard-linked to another file fails with GATE_REQUIRED", async (t) => {
  const k = await packageKit(t);
  const outside = join(k.sb, "outside.mjs"), file = join(k.kit, "src/a.mjs");
  await writeFile(outside, await readFile(file, "utf8"));
  await k.edit(async () => { await rm(file); await link(outside, file); });
  assert.throws(() => k.check(), gate("live.kitRoot", "hardlink"));
  assert.throws(() => verifyKit(k.kit), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.reason === "hardlink");
  await k.edit(async () => { await rm(file); await writeFile(file, await readFile(outside, "utf8")); });
  assert.doesNotThrow(() => k.check());
});

test("parseKitArg reads a --kit value as <version>+<64 hex> and nothing else", () => {
  assert.deepEqual(parseKitArg(VERSION + "+" + DIGEST), { kind: "package", version: VERSION, digest: DIGEST });
  for (const bad of [undefined, null, 1, "", VERSION, VERSION + "+" + DIGEST.slice(0, 12), VERSION + "+sha256:" + DIGEST, "1.0+" + DIGEST, VERSION + "+" + DIGEST + "+x", "npm:" + VERSION + "+" + DIGEST]) assert.equal(parseKitArg(bad), null, String(bad));
});
