import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stat, symlink, lstat, readdir, mkdir, chmod } from "node:fs/promises";
import { sandbox, sleep } from "./helpers.mjs";
import { writeNewFile, readPrivateText, readPrivateBytes, safeJoin, atomicReplace, fsyncDir } from "../src/storage/fsx.mjs";
test("writeNewFile is 0600 and never overwrites; readPrivateText refuses symlinks", async (t) => {
  const dir = await sandbox(t), file = join(dir, "a");
  await writeNewFile(file, "x");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeNewFile(file, "y"), { code: "DEVCTX_CONFLICT" });
  await symlink(file, join(dir, "l"));
  await assert.rejects(readPrivateText(join(dir, "l")), { code: "DEVCTX_PATH_UNSAFE" });
});
test("safeJoin refuses traversal", () => {
  for (const bad of ["..", "../x", "/a", "", "A", ".h"]) assert.throws(() => safeJoin("/r", bad), { code: "DEVCTX_PATH_ESCAPE" });
});
test("U4 writeNewFile removes its partial file after an injected write failure and a retry succeeds", async (t) => {
  const dir = await sandbox(t), file = join(dir, "a");
  await assert.rejects(writeNewFile(file, "x", { faults: { beforeWrite: () => { throw new Error("disk full"); } } }), /disk full/);
  await assert.rejects(lstat(file), { code: "ENOENT" });
  await assert.rejects(writeNewFile(file, "x", { faults: { beforeFsync: () => { throw new Error("fsync failed"); } } }), /fsync failed/);
  await assert.rejects(lstat(file), { code: "ENOENT" });
  await writeNewFile(file, "x");
  assert.equal(await readPrivateText(file), "x");
});
test("U4 atomicReplace leaves no temp file after an injected rename failure", async (t) => {
  const dir = await sandbox(t), file = join(dir, "a");
  await writeNewFile(file, "old");
  await assert.rejects(atomicReplace(file, "new", { faults: { beforeRename: () => { throw new Error("rename failed"); } } }), /rename failed/);
  assert.deepEqual(await readdir(dir), ["a"]);
  assert.equal(await readPrivateText(file), "old");
  await atomicReplace(file, "new");
  assert.deepEqual(await readdir(dir), ["a"]);
  assert.equal(await readPrivateText(file), "new");
});
test("U4 fsyncDir refuses a symlinked or non-directory path", async (t) => {
  const dir = await sandbox(t);
  await mkdir(join(dir, "real"));
  await symlink(join(dir, "real"), join(dir, "link"));
  await writeNewFile(join(dir, "f"), "x");
  fsyncDir(join(dir, "real"));
  assert.throws(() => fsyncDir(join(dir, "link")), { code: "DEVCTX_PATH_UNSAFE" });
  assert.throws(() => fsyncDir(join(dir, "f")), { code: "DEVCTX_PATH_UNSAFE" });
});
test("U4 readPrivateBytes refuses a file whose ctime changes during the read", async (t) => {
  const dir = await sandbox(t), file = join(dir, "a");
  await writeNewFile(file, "x");
  await assert.rejects(readPrivateBytes(file, 1024, { faults: { afterRead: async () => { await sleep(5); await chmod(file, 0o600); } } }), { code: "DEVCTX_INTEGRITY" });
  assert.equal((await readPrivateBytes(file)).toString(), "x");
});
