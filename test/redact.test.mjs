import test from "node:test";
import assert from "node:assert/strict";
import { assertNoSensitive, scanSensitive, findForbiddenFields, scanValueLike, assertNoValueLike } from "../src/records/redact.mjs";
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
test("value-like scan finds URLs with user info or a query, assignments and random runs", () => {
  const types = (text) => [...new Set(scanValueLike(text).map((x) => x.type))].sort();
  assert.deepEqual(types("post" + "gres://u:p" + "@db.example.com/app"), ["url-userinfo"]);
  assert.deepEqual(types("redis://default" + "@cache.example.com"), ["url-userinfo"]);
  assert.deepEqual(types("https://vault.example.com/ui?team=core"), ["assignment", "url-query"]);
  assert.deepEqual(types("DB_HOST" + "=" + "db.example.com"), ["assignment"]);
  assert.deepEqual(types("q7Xk2Lm9" + "Pz4Rt8Vw" + "3Nb6Yc1H" + "s5Dj0Gf2"), ["high-entropy"]);
  assert.deepEqual(types("cache/" + "3f9a6c1e8b2d" + "4f70a5c9e1b3"), ["high-entropy"]);
  for (const text of [".env", "~/.config/gh/hosts.yml", "db.internal.example.com:5432", "https://vault.example.com/ui/secrets", "AbstractSingletonProxyFactoryBean", "DeveloperContextKitConfiguration", "config/environments/production-database-primary.yml"]) assert.deepEqual(scanValueLike(text), [], text);
  const run = "q7Xk2Lm9" + "Pz4Rt8Vw" + "3Nb6Yc1H" + "s5Dj0Gf2";
  assert.throws(() => assertNoValueLike("vault/" + run), (e) => e.code === "DEVTWIN_SENSITIVE_CONTENT" && e.details.types.includes("high-entropy") && !JSON.stringify(toJson(e)).includes(run));
  assert.throws(() => assertNoValueLike(["api", "_key"].join("") + ": " + "abcdef" + "123456"), (e) => e.details.types.includes("credential-assignment"));
});
test("a GitHub Actions id-token permission is not a credential, but an id-token value still is", () => {
  const key = ["id", "-token"].join("");
  for (const text of [key + ": write", "the `" + key + ": write` permission", "  " + key + ": read\n", key + ":none;"]) assert.deepEqual(scanSensitive(text), [], text);
  for (const text of [key + ": " + "abcdef" + "123456", key + ": " + "write" + "_abc123", "my_" + "token: " + "write`x", "token = " + "write-abcdef", key + ": " + "write-" + "abcdef123456", key + ": " + "write." + "abcdef123456", key + " = " + "write." + "abcdef123456", key + ": " + "none" + "/abcdef123456"]) assert.ok(scanSensitive(text).some((x) => x.type === "credential-assignment"), text);
});
