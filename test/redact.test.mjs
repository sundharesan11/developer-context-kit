import test from "node:test";
import assert from "node:assert/strict";
import { assertNoSensitive, scanSensitive, findForbiddenFields } from "../src/records/redact.mjs";
import { toJson } from "../src/errors.mjs";
test("sensitive content and forbidden field names are rejected", () => {
  const fakeKey = ["api", "_key"].join("") + " = " + "abcdef" + "123456";
  assert.throws(() => assertNoSensitive(fakeKey), (e) => e.code === "DEVCTX_SENSITIVE_CONTENT" && !JSON.stringify(toJson(e)).includes("abcdef123456"));
  assert.deepEqual(scanSensitive("npm test; tokenizer: wordpiece"), []);
  assert.deepEqual(findForbiddenFields({ a: { password: "x" } }).length, 1);
});
