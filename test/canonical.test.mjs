import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digest } from "../src/storage/canonical.mjs";
test("digest ignores key order; non-finite rejected", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: Infinity }), { code: "DEVTWIN_INVALID_INPUT" });
});
test("canonical JSON preserves own special keys and array order", () => {
  const withKey = JSON.parse('{"__proto__":{"role":"admin"},"items":[2,1]}');
  const withoutKey = { items: [2, 1] };
  assert.notEqual(digest(withKey), digest(withoutKey));
  assert.equal(canonicalJson(withKey), '{"__proto__":{"role":"admin"},"items":[2,1]}');
  assert.notEqual(digest({ items: [1, 2] }), digest(withoutKey));
});
