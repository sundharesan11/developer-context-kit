import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rm, symlink, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { sandbox, makeRepo } from "./helpers.mjs";
import { readApprovedSource, sourceIdentity, verifySourceBinding, checkSourceFreshness } from "../src/storage/source-read.mjs";
test("final file replaced by symlink between plan and apply is SOURCE_CHANGED", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "r"), { "README.md": "a" });
  const bound = await readApprovedSource(repo, "README.md");
  await rm(join(repo, "README.md")); await symlink("/etc/hosts", join(repo, "README.md"));
  await assert.rejects(verifySourceBinding(repo, bound), { code: "DEVCTX_SOURCE_CHANGED" });
});
test("parent dir swapped for symlink is refused; content mutation detected", async (t) => {
  const dir = await sandbox(t);
  const repo = await makeRepo(join(dir, "r"), { "docs/a.md": "v1" });
  const bound = await readApprovedSource(repo, "docs/a.md");
  await writeFile(join(repo, "docs/a.md"), "v2");
  await assert.rejects(verifySourceBinding(repo, bound), { code: "DEVCTX_SOURCE_CHANGED" });
  await rename(join(repo, "docs"), join(dir, "elsewhere")); await symlink(join(dir, "elsewhere"), join(repo, "docs"));
  assert.equal((await readApprovedSource(repo, "docs/a.md")).skipped, "symlink");
});
test("denied (including nested .env) and oversized files are skipped with reasons", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "r"), { ".env.example": "K=v", "config/.env.local": "K=v", "keys/id_ed25519": "k", "big.md": "x".repeat(131073) });
  for (const rel of [".env.example", "config/.env.local", "keys/id_ed25519"]) assert.equal((await readApprovedSource(repo, rel)).skipped, "denied", rel);
  assert.equal((await readApprovedSource(repo, "big.md")).skipped, "too-large");
});
test("content mutated while the descriptor is held is SOURCE_CHANGED", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "r"), { "docs/a.md": "v1" });
  const afterStat = async () => { await appendFile(join(repo, "docs/a.md"), "-appended"); };
  await assert.rejects(readApprovedSource(repo, "docs/a.md", { faults: { afterStat } }), { code: "DEVCTX_SOURCE_CHANGED" });
});
test("parent directory replaced after the read (same bytes) is SOURCE_CHANGED; identity is persisted", async (t) => {
  const dir = await sandbox(t);
  const repo = await makeRepo(join(dir, "r"), { "docs/a.md": "v1" });
  const afterRead = async () => {
    await rename(join(repo, "docs"), join(dir, "old-docs"));
    await mkdir(join(repo, "docs")); await writeFile(join(repo, "docs/a.md"), "v1");
  };
  await assert.rejects(readApprovedSource(repo, "docs/a.md", { faults: { afterRead } }), { code: "DEVCTX_SOURCE_CHANGED" });
  const bound = sourceIdentity(await readApprovedSource(repo, "docs/a.md"));
  assert.deepEqual(Object.keys(bound).sort(), ["ancestors", "dev", "ino", "mtimeMs", "rel", "sha256", "size"]);
  assert.equal(bound.ancestors.length, 2);
  await rename(join(repo, "docs"), join(dir, "older-docs"));
  await mkdir(join(repo, "docs")); await writeFile(join(repo, "docs/a.md"), "v1");
  await assert.rejects(verifySourceBinding(repo, bound), { code: "DEVCTX_SOURCE_CHANGED" });
  assert.equal(await checkSourceFreshness(repo, { rel: "docs/a.md", sha256: bound.sha256 }), "current");
  await writeFile(join(repo, "docs/a.md"), "v2");
  assert.equal(await checkSourceFreshness(repo, { rel: "docs/a.md", sha256: bound.sha256 }), "needs-revalidation");
});
