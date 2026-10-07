import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, digest } from "../src/storage/canonical.mjs";
test("digest ignores key order; non-finite rejected", () => {
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.throws(() => canonicalJson({ a: Infinity }), { code: "DEVCTX_INVALID_INPUT" });
});
