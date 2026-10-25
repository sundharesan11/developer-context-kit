import test from "node:test";
import assert from "node:assert/strict";
import { assertNoSensitive, scanSensitive, findForbiddenFields } from "../src/records/redact.mjs";
import { toJson } from "../src/errors.mjs";
test("sensitive content and forbidden field names are rejected", () => {
  const fakeKey = ["api", "_key"].join("") + " = " + "abcdef" + "123456";
  assert.throws(() => assertNoSensitive(fakeKey), (e) => e.code === "DEVTWIN_SENSITIVE_CONTENT" && !JSON.stringify(toJson(e)).includes("abcdef123456"));
  assert.deepEqual(scanSensitive("npm test; tokenizer: wordpiece"), []);
  assert.deepEqual(findForbiddenFields({ a: { password: "x" } }).length, 1);
});
test("common provider token formats and suffixed key names are caught", () => {
  const j = (...parts) => parts.join("");
  const samples = [["github-token", j("github", "_pat_", "A".repeat(30))], ["llm-api-key", j("sk", "-ant-", "a".repeat(30))], ["stripe-key", j("rk", "_live_", "c".repeat(20))], ["google-api-key", j("AI", "za", "d".repeat(35))], ["npm-token", j("npm", "_", "e".repeat(36))], ["aws-key", j("AS", "IA", "F".repeat(16))], ["bearer-token", j("Bear", "er ", "g".repeat(30))], ["credential-assignment", j("x-api", "-key", ": ", "abcdefgh")], ["private-key", j("-----BEGIN PGP ", "PRIVATE KEY", " BLOCK-----")]];
  for (const [type, text] of samples) assert.ok(scanSensitive(text).some((x) => x.type === type), type);
  for (const text of ["max_tokens: 4096", "sk-learn is a library", "task-runner and mask-key notes"]) assert.deepEqual(scanSensitive(text), [], text);
  assert.deepEqual(findForbiddenFields({ access_token: 1, clientSecret: 2, githubToken: 3, max_tokens: 4, tokenizer: 5 }), ["access_token", "clientSecret", "githubToken"]);
});
