import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { stat, symlink } from "node:fs/promises";
import { sandbox } from "./helpers.mjs";
import { writeNewFile, readPrivateText, safeJoin } from "../src/storage/fsx.mjs";
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
