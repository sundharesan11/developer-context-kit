import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile, access } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, treeSnapshot } from "./helpers.mjs";
import { git, locateWorktree } from "../src/identity/git.mjs";
test("linked worktree, branch, head and dirty warning", async (t) => {
  const dir = await sandbox(t);
  const repo = await makeRepo(join(dir, "atlas"), { "README.md": "# Atlas\n" });
  await fixtureGit(repo, ["worktree", "add", "-q", join(dir, "wt"), "-b", "feature"]);
  const wt = await locateWorktree(join(dir, "wt"));
  assert.equal(wt.kind, "linked-worktree"); assert.equal(wt.branch, "feature");
  await writeFile(join(repo, "x"), "1");
  assert.ok((await locateWorktree(repo)).warnings.some((w) => w.code === "DIRTY_WORKTREE"));
});
test("repository fsmonitor never runs; inherited GIT_DIR ignored; probe writes nothing", async (t) => {
  const dir = await sandbox(t), canary = join(dir, "RAN");
  const hook = join(dir, "fsm.sh"); await writeFile(hook, `#!/bin/sh\ntouch "${canary}"\n`, { mode: 0o755 });
  const repo = await makeRepo(join(dir, "atlas"), { "a": "a" });
  await fixtureGit(repo, ["config", "core.fsmonitor", hook]);
  await writeFile(join(repo, "a"), "changed");
  const before = await treeSnapshot(repo);
  process.env.GIT_DIR = "/nonexistent"; t.after(() => delete process.env.GIT_DIR);
  const loc = await locateWorktree(repo);
  assert.equal(loc.root, repo);
  assert.ok(loc.warnings.some((w) => w.code === "DIRTY_WORKTREE"));
  await assert.rejects(access(canary));
  assert.equal(await treeSnapshot(repo), before);
});
test("git takes an argument array and strips credentials from remotes", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "atlas"), { a: "a" });
  assert.equal((await git(repo, ["rev-parse", "--is-inside-work-tree"])).stdout.trim(), "true");
  const userinfo = ["user", "pass"].join(":") + "@";
  await fixtureGit(repo, ["remote", "add", "origin", `https://${userinfo}git.example.com/acme/atlas.git?x=1#f`]);
  const loc = await locateWorktree(repo);
  assert.deepEqual(loc.remotes, [{ name: "origin", url: "https://git.example.com/acme/atlas.git" }]);
});
