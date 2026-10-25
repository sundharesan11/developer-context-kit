import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeFile, access, mkdir, chmod } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, treeSnapshot, makePilot, seedCommittedProject, now } from "./helpers.mjs";
import { git, locateWorktree } from "../src/identity/git.mjs";
import { runDoctor } from "../src/config/doctor.mjs";
import { applyInit } from "../src/config/store.mjs";
import { resolveContext } from "../src/context/resolve.mjs";
import { scanRepository } from "../src/onboarding/scan.mjs";
async function gitStub(t, script) {
  const bin = join(await sandbox(t), "bin"); await mkdir(bin);
  await writeFile(join(bin, "git"), "#!/bin/sh\n" + script + "\n", { mode: 0o755 });
  const path = process.env.PATH; process.env.PATH = bin + ":" + path; t.after(() => { process.env.PATH = path; });
}
const breakConfig = (repo) => writeFile(join(repo, ".git", "config"), "[core\nbad");
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
test("Git unreadable include fails closed with GIT_QUERY_FAILED before any filter runs", async (t) => {
  const dir = await sandbox(t), canary = join(dir, "RAN"), cfg = join(dir, "included.conf");
  const repo = await makeRepo(join(dir, "atlas"), { "a.txt": "a\n", ".gitattributes": "* filter=canary\n" });
  await writeFile(cfg, `[filter "canary"]\nclean = touch ${canary}\n`);
  await fixtureGit(repo, ["config", "--local", "include.path", cfg]);
  await writeFile(join(repo, "a.txt"), "b\n");
  await chmod(cfg, 0);
  const before = await treeSnapshot(repo);
  // Root ignores file modes, so the include stays readable and the filter guard refuses instead.
  await assert.rejects(locateWorktree(repo), { code: process.getuid() === 0 ? "DEVTWIN_PATH_UNSAFE" : "DEVTWIN_GIT_QUERY_FAILED" });
  await assert.rejects(access(canary));
  assert.equal(await treeSnapshot(repo), before);
});
test("Git malformed config is GIT_QUERY_FAILED, not a non-repository", async (t) => {
  const dir = await sandbox(t);
  const repo = await makeRepo(join(dir, "atlas"), { a: "a" });
  await breakConfig(repo);
  await assert.rejects(locateWorktree(repo), { code: "DEVTWIN_GIT_QUERY_FAILED" });
  await assert.rejects(scanRepository({ repo }), { code: "DEVTWIN_GIT_QUERY_FAILED" });
});
test("Git query that hangs past the timeout is GIT_QUERY_FAILED", async (t) => {
  const dir = await sandbox(t);
  await gitStub(t, "exec sleep 5");
  const started = Date.now();
  assert.throws(() => git(dir, ["status"], { timeoutMs: 200 }), { code: "DEVTWIN_GIT_QUERY_FAILED" });
  assert.ok(Date.now() - started < 4000);
});
test("Git output above the buffer is LIMIT", async (t) => {
  const dir = await sandbox(t);
  await gitStub(t, "exec head -c 17000000 /dev/zero");
  await assert.rejects(locateWorktree(dir), { code: "DEVTWIN_LIMIT" });
});
test("Git more than 16 remotes or a remote URL above 2 KiB is LIMIT", async (t) => {
  const dir = await sandbox(t);
  const many = await makeRepo(join(dir, "many"), { a: "a" });
  for (let i = 0; i < 16; i++) await fixtureGit(many, ["remote", "add", "r" + i, `https://git.example.com/acme/r${i}.git`]);
  assert.equal((await locateWorktree(many)).remotes.length, 16);
  await fixtureGit(many, ["remote", "add", "r16", "https://git.example.com/acme/r16.git"]);
  await assert.rejects(locateWorktree(many), { code: "DEVTWIN_LIMIT" });
  const long = await makeRepo(join(dir, "long"), { a: "a" });
  await fixtureGit(long, ["remote", "add", "origin", "https://git.example.com/" + "a".repeat(2048)]);
  await assert.rejects(locateWorktree(long), { code: "DEVTWIN_LIMIT" });
});
test("Git remote whose URL query fails is GIT_QUERY_FAILED, not a silently dropped remote", async (t) => {
  const repo = await makeRepo(join(await sandbox(t), "atlas"), { a: "a" });
  await fixtureGit(repo, ["remote", "add", "origin", "https://git.example.com/acme/atlas.git"]);
  const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  await gitStub(t, `case " $* " in *" remote get-url "*) exit 2;; esac\nexec '${real}' "$@"`);
  await assert.rejects(locateWorktree(repo), { code: "DEVTWIN_GIT_QUERY_FAILED" });
});
test("Git doctor reports GIT_QUERY_FAILED for a bound repository with broken config", async (t) => {
  const s = await seedCommittedProject(t);
  assert.equal((await runDoctor(s.roots)).checks.find((c) => c.id === "bound-roots").status, "ok");
  await breakConfig(s.repo);
  const bound = (await runDoctor(s.roots)).checks.find((c) => c.id === "bound-roots");
  assert.equal(bound.status, "fail");
  assert.equal(bound.detail.code, "DEVTWIN_GIT_QUERY_FAILED");
  assert.equal(bound.detail.gitQueryFailed, 1);
});
test("Git init refuses roots inside a repository whose config is broken", async (t) => {
  const p = await makePilot(t);
  await fixtureGit(p.pilot.pilotRoot, ["init", "-q"]);
  await breakConfig(p.pilot.pilotRoot);
  await assert.rejects(applyInit(p.roots, { actorRefs: [], preferences: {}, now }), { code: "DEVTWIN_GIT_QUERY_FAILED" });
  await assert.rejects(access(p.configRoot));
});
test("Git non-repository directory keeps its not-a-repo meaning", async (t) => {
  const p = await makePilot(t), dir = join(p.reposDir, "plain");
  await mkdir(dir);
  assert.equal((await locateWorktree(dir)).git, false);
  await assert.rejects(resolveContext(p.roots, { scope: "acme", cwd: dir }), (e) => e.code === "DEVTWIN_PROJECT_UNBOUND" && e.details.reason === "not-bound-in-scope");
  await assert.rejects(scanRepository({ repo: dir }), { code: "DEVTWIN_INVALID_INPUT" });
});
