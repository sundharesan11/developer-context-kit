import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sandbox } from "./helpers.mjs";
const gate = (dir) => spawnSync(process.execPath, [join(import.meta.dirname, "../scripts/run-tests.mjs"), dir], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
async function project(t, body, required) {
  const dir = await sandbox(t);
  await mkdir(join(dir, "test"));
  await writeFile(join(dir, "test/a.test.mjs"), `import test from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`);
  await writeFile(join(dir, "test/required-tests.json"), JSON.stringify(required));
  return dir;
}
test("G1 gate rejects empty, comment-only, skipped and missing required tests", async (t) => {
  const empty = "test(\"x\", () => " + "{ });";
  const comment = "test(\"x\", () => " + "{ /* later */ });";
  const skipped = ["test", "skip"].join(".") + "(\"x\", () => assert.ok(true));";
  for (const body of [empty, comment, skipped]) assert.equal(gate(await project(t, body, ["x"])).status, 1);
  const missing = gate(await project(t, "test(\"x\", () => assert.ok(true));", ["x", "never-ran"]));
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /required test did not pass: never-ran/);
  const good = gate(await project(t, "test(\"x\", () => assert.ok(true));", ["x"]));
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).files, 1);
});
