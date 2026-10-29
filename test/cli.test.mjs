import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runCli } from "./helpers.mjs";
const root = join(import.meta.dirname, "..");
test("version prints JSON and exits 0", async () => {
  const { code, json } = await runCli(["version"]);
  assert.equal(code, 0);
  // KTD9: the version comes from package.json; a Git clone adds its commit, read from .git without a Git process.
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  assert.deepEqual(json, { ok: true, command: "version", result: { name: "devtwin", version, commit } });
  assert.equal(version, "0.1.0-alpha.1");
});
test("--version is the version command", async () => {
  const { code, json } = await runCli(["--version"]);
  assert.equal(code, 0);
  assert.equal(json.command, "version");
  assert.equal(json.result.version, JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
  assert.equal((await runCli(["--version", "extra"])).code, 2);
});
test("unknown command or flag exits 2", async () => {
  assert.equal((await runCli(["nope"])).json.error.code, "DEVTWIN_USAGE");
  assert.equal((await runCli(["version", "--bogus"])).code, 2);
});
