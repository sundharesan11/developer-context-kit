import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./helpers.mjs";
test("version prints JSON and exits 0", async () => {
  const { code, json } = await runCli(["version"]);
  assert.equal(code, 0);
  assert.deepEqual(json, { ok: true, command: "version", result: { name: "devctx", version: "0.0.0-local" } });
});
test("unknown command or flag exits 2", async () => {
  assert.equal((await runCli(["nope"])).json.error.code, "DEVCTX_USAGE");
  assert.equal((await runCli(["version", "--bogus"])).code, 2);
});
