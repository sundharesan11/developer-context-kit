import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { sandbox, makeRepo, treeSnapshot } from "./helpers.mjs";
import { scanRepository } from "../src/onboarding/scan.mjs";
import { deriveCandidates } from "../src/onboarding/candidates.mjs";
test("discovery is zero-footprint, never runs scripts, cites sources", async (t) => {
  const dir = await sandbox(t);
  const repo = await makeRepo(join(dir, "atlas"), {
    "README.md": "# Atlas\nBilling API.\n",
    "package.json": JSON.stringify({ name: "atlas", scripts: { test: "node --test", postinstall: `touch ${join(dir, "PWNED")}` } }),
    "AGENTS.md": "Use pnpm.\n", ".env": ["SEC", "RET="].join("") + "CANARY_VALUE_9f3a",
  });
  const before = await treeSnapshot(repo);
  const scan = await scanRepository({ repo, approvedDocs: [] });
  const { candidates, unknowns } = deriveCandidates(scan, { expectedRemotes: [], environments: ["staging"] });
  assert.equal(await treeSnapshot(repo), before);
  await assert.rejects(access(join(dir, "PWNED")));
  assert.ok(candidates.every((c) => c.sources.every((s) => /^file:|^commit:|^user:/.test(s.ref))));
  assert.ok(!JSON.stringify({ scan, candidates }).includes("CANARY_VALUE_9f3a"));
  assert.ok(unknowns.length >= 2);
});
