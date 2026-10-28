import test from "node:test";
import assert from "node:assert/strict";
import { join, relative } from "node:path";
import { mkdir, writeFile, readFile, readdir, lstat, chmod, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { initPilot, fixtureGit, makeRepo, sandbox, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { readSnapshot } from "../src/records/store.mjs";
import { readAudit } from "../src/audit/log.mjs";
import { readConsent, consentPath } from "../src/consent/store.mjs";
import { listHeld } from "../src/held/queue.mjs";
import { sendDue } from "../src/held/send.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { transportOf } from "../src/learnings/repo-write.mjs";
import { readSolutions } from "../src/import/solutions.mjs";

const SCOPE = "example", PROJECT = "example.atlas";
const HOUR = 3600 * 1000;
const at = (hours) => () => new Date(now().getTime() + hours * HOUR);
// The fixture transport from test/held.test.mjs: it runs the remote service on the local bare repository and clears
// the client's per-command config. Only a test can select it, through the hub binding's SSH command.
const FAKE_SSH = "#!/bin/sh\n[ \"$1\" = \"-G\" ] && exit 1\nfor last; do :; done\nunset GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT\ncase \"$last\" in\n  \"git-upload-pack \"*|\"git-receive-pack \"*) exec sh -c \"git ${last#git-}\" ;;\nesac\nexit 1\n";
const bash = (command) => ({ session_id: "s-agent", cwd: "/x", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_01Example" });

// The working copy of a repository without .git, plus HEAD and the index: what a learning write must never change.
async function workingTree(repo) {
  const rows = [];
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      if (path === repo && name === ".git") continue;
      const st = await lstat(child);
      rows.push([relative(repo, child), st.mode, st.size, st.mtimeMs, st.isFile() ? createHash("sha256").update(await readFile(child)).digest("hex") : null]);
      if (st.isDirectory()) await walk(child);
    }
  }
  await walk(repo);
  const index = existsSync(join(repo, ".git", "index")) ? createHash("sha256").update(await readFile(join(repo, ".git", "index"))).digest("hex") : null;
  return JSON.stringify({ rows, head: await readFile(join(repo, ".git", "HEAD"), "utf8"), index });
}

// One machine: a pilot whose repoLearnings class approves the atlas repository (unless approve is false), the scope
// with a joined hub (its handle, email and SSH command are the recorded identity; unless identity is false), the
// onboarded atlas repository with a bare remote, and an approving owner dialog and notification seam.
async function machine(t, { approve = true, identity = true, remote = "ssh", originHead = true, canary = false, sshScript = FAKE_SSH } = {}) {
  const sb = await sandbox(t);
  const p = await initPilot(t);
  const ssh = join(sb, "fake-ssh");
  await writeFile(ssh, typeof sshScript === "function" ? sshScript(sb) : sshScript);
  await chmod(ssh, 0o755);
  // The hub, for the scope's recorded identity.
  const hubBare = join(sb, "hub.git"), hubWork = join(sb, "colleague");
  await mkdir(hubBare);
  await fixtureGit(hubBare, ["init", "-q", "--bare", "-b", "main"]);
  await makeRepo(hubWork, { "hub.json": JSON.stringify({ hubId: "example-hub", schemaVersion: 1 }) + "\n", "README.md": "hub\n" });
  await fixtureGit(hubWork, ["push", "-q", hubBare, "main"]);
  // The repository and its bare remote.
  const bare = join(sb, "atlas.git");
  await mkdir(bare);
  await fixtureGit(bare, ["init", "-q", "--bare", "-b", "main"]);
  const repo = await makeRepo(join(p.reposDir, "atlas"), { "README.md": "# Atlas\n", "docs/solutions/seed-order.md": "# Seed order\n\nRun migrations before seeds.\n" });
  await fixtureGit(repo, ["push", "-q", bare, "main"]);
  const url = remote === "https" ? "https://git.example.invalid/atlas.git" : "ssh://repo.example.invalid" + bare;
  await fixtureGit(repo, ["remote", "add", "origin", url]);
  await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  if (originHead) await fixtureGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const hubRoot = join(p.pilot.pilotRoot, "hubs");
  const path = await p.with({ writeClasses: { hubRoot: [hubRoot], ...(approve ? { repoLearnings: [repo] } : {}) } });
  const pilot = await loadPilot(path, { home: p.fakeHome, env: {} });
  const roots = rootsFromPilot(pilot);
  await applyScopeAdd(roots, { scope: SCOPE, hubs: [], policies: [], now });
  const input = { scope: SCOPE, project: PROJECT, repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_repolearn01" };
  await applyOnboard(roots, pilot, input, { fingerprint: (await planOnboard(roots, pilot, input)).fingerprint, now });
  const dialogs = [], notes = [];
  const cli = async (args, { clock = now, env = {} } = {}) => {
    const chunks = [];
    await main([...args, "--pilot", path], { now: clock, home: p.fakeHome, env, ownerDialog: async (content) => { dialogs.push(content); return "approved"; },
      notifier: (args) => { notes.push(args); return { status: 0 }; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.ok, true, args.join(" ") + ": " + JSON.stringify(out.error)); return out.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.ok, false, args.join(" ")); assert.equal(out.error.code, code, args.join(" ") + ": " + JSON.stringify(out.error)); return out.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  if (identity) await applied(["hub", "join", "--scope", SCOPE, "--remote", "ssh://hub.example.invalid" + hubBare, "--handle", "alice", "--email", "alice@example.com", "--ssh-command", ssh]);
  // The canary: a filter driver defined on one line with another section, and an attributes file that selects it for
  // every path. Any Git command that ran the filter would create the marker.
  const marker = join(sb, "filter-ran");
  if (canary) {
    await appendFile(join(repo, ".git", "config"), "[core][filter \"x\"]\n\tclean = touch " + marker + "\n\tsmudge = touch " + marker + "\n");
    await writeFile(join(repo, ".git", "info", "attributes"), "* filter=x\n");
  }
  let n = 0;
  const propose = async ({ title = "Seed after migrations", env = { CLAUDECODE: "1" } } = {}) => (await ok(["lesson", "propose", "--session", "ses_repo" + ++n, "--scope", SCOPE, "--project", PROJECT, "--title", title,
    "--summary", "Do run migrations before seeds.", "--body", "Seeds fail on a fresh database.\n", "--path", "db/**", "--topic", "database", "--apply"], { env })).proposalId;
  const accept = (id, target) => ["lesson", "accept", "--id", id, "--target", target, "--session", "ses_accept"];
  const grant = () => applied(["consent", "grant", "--kind", "repo-push", "--repo", repo]);
  const refs = async () => (await fixtureGit(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).trim();
  const remoteRefs = async () => (await fixtureGit(bare, ["for-each-ref", "--format=%(refname) %(objectname)"])).trim();
  // A second bare repository on the same fixture host: where a redirected push would land.
  const other = join(sb, "other.git");
  await mkdir(other);
  await fixtureGit(other, ["init", "-q", "--bare", "-b", "main"]);
  const otherRefs = async () => (await fixtureGit(other, ["for-each-ref", "--format=%(refname)"])).trim();
  return { p, sb, path, pilot, roots, repo, bare, url, other, otherUrl: "ssh://repo.example.invalid" + other, otherRefs, marker, cli, ok, fail, applied, dialogs, notes, propose, accept, grant, refs, remoteRefs };
}
// Everything a refused accept must leave alone: the repository's refs and working copy, the audit log, the held queue
// and the project records.
async function untouched(m, action) {
  const before = [await m.refs(), await workingTree(m.repo), JSON.stringify((await readAudit(m.roots)).entries), JSON.stringify(await listHeld(m.roots)), (await readSnapshot(m.roots, SCOPE, PROJECT)).records.length];
  const result = await action();
  assert.deepEqual([await m.refs(), await workingTree(m.repo), JSON.stringify((await readAudit(m.roots)).entries), JSON.stringify(await listHeld(m.roots)), (await readSnapshot(m.roots, SCOPE, PROJECT)).records.length], before);
  return result;
}

test("repo target with a consent writes the record and a learning branch from the learnings base and holds the push", async (t) => {
  const m = await machine(t);
  await m.grant();
  // A dirty working copy: a changed tracked file and an untracked one.
  await writeFile(join(m.repo, "README.md"), "# Atlas\n\nWork in progress.\n");
  await writeFile(join(m.repo, "notes.txt"), "scratch\n");
  const status = await fixtureGit(m.repo, ["status", "--porcelain=v1"]);
  const head = await fixtureGit(m.repo, ["rev-parse", "HEAD"]), base = (await fixtureGit(m.repo, ["rev-parse", "refs/remotes/origin/main"])).trim();
  const tree = await workingTree(m.repo);
  const id = await m.propose();
  // U25: general is parked for the activity review; the preview of general,repo writes nothing.
  const parked = await untouched(m, () => m.ok(m.accept(id, "general,repo"), { env: { CLAUDECODE: "1" } }));
  assert.deepEqual([parked.target, parked.parked, parked.tiers], ["general,repo", ["general"], { general: "always-ask", repo: "automatic" }]);
  const plan = await m.ok(m.accept(id, "project,repo"), { env: { CLAUDECODE: "1" } });
  assert.deepEqual([plan.target, plan.targets, plan.tier, plan.tiers], ["project,repo", ["project", "repo"], "automatic", { project: "automatic", repo: "automatic" }]);
  assert.match(plan.repo.branch, /^devtwin\/learning-[a-f0-9]{24}$/);
  assert.equal(plan.repo.rel, "docs/solutions/lessons/seed-after-migrations.md");
  const result = await m.ok([...m.accept(id, "project,repo"), "--apply", "--plan-fingerprint", plan.fingerprint], { env: { CLAUDECODE: "1" } });
  assert.equal(m.dialogs.length, 2, "only the hub join and consent grant dialogs; the accept shows none");
  // The project record, and the branch with exactly one new file on top of the learnings base.
  const record = (await readSnapshot(m.roots, SCOPE, PROJECT)).records.find((r) => r.id === result.project.recordId);
  assert.equal(record.recordedBy.actor, "claude");
  assert.equal((await fixtureGit(m.repo, ["rev-parse", "refs/heads/" + result.repo.branch])).trim(), result.repo.commit);
  assert.equal((await fixtureGit(m.repo, ["rev-parse", result.repo.commit + "^1"])).trim(), base);
  assert.equal(result.repo.base, "refs/remotes/origin/main");
  assert.equal((await fixtureGit(m.repo, ["diff-tree", "--no-commit-id", "--name-status", "-r", base, result.repo.commit])).trim(), "A\tdocs/solutions/lessons/seed-after-migrations.md");
  const file = await fixtureGit(m.repo, ["cat-file", "blob", result.repo.commit + ":docs/solutions/lessons/seed-after-migrations.md"]);
  assert.equal(file, "---\ntitle: \"Seed after migrations\"\ndate: " + now().toISOString().slice(0, 10) + "\ncategory: lesson\ntags: [\"database\"]\nsource: devtwin " + result.project.recordId + "\n---\n\n# Seed after migrations\n\nDo run migrations before seeds.\n\nSeeds fail on a fresh database.\n");
  assert.equal((await fixtureGit(m.repo, ["log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", result.repo.commit])).trim(), "alice <alice@example.com>|alice <alice@example.com>|Add devtwin lesson: Seed after migrations");
  // HEAD, the index, the working copy and git status are as they were.
  assert.equal(await fixtureGit(m.repo, ["rev-parse", "HEAD"]), head);
  assert.equal(await fixtureGit(m.repo, ["status", "--porcelain=v1"]), status);
  assert.equal(await workingTree(m.repo), tree);
  // The push waits in the held queue for 24 hours, with one notification; nothing reached the remote.
  assert.deepEqual([result.repo.push.queued, result.repo.push.sendAfter], [true, at(24)().toISOString()]);
  assert.equal(m.notes.length, 1);
  const held = await listHeld(m.roots);
  assert.deepEqual(held.map((x) => [x.kind, x.target, x.audit, x.payload.branch]), [["repo-learning", "repo:" + createHash("sha256").update(m.repo).digest("hex"), result.repo.audit, result.repo.branch]]);
  assert.doesNotMatch(await m.remoteRefs(), /devtwin/);
  const activity = await m.ok(["activity"]);
  assert.deepEqual(activity.learned.filter((x) => x.kind === "repo-learning").map((x) => [x.id, x.state, x.target]), [[result.repo.audit, "held", "repo"]]);
  assert.equal(activity.counts.held, 1);
});

test("repo target without a consent writes the branch but queues nothing, and learning send queues it once granted", async (t) => {
  const m = await machine(t);
  const tree = await workingTree(m.repo);
  const id = await m.propose();
  const result = await m.applied(m.accept(id, "repo"));
  assert.equal(result.tier, "automatic");
  assert.deepEqual([result.repo.push.queued, result.repo.push.reason], [false, "needs-consent"]);
  assert.match(result.repo.push.message, /consent grant --kind repo-push/);
  assert.equal(result.audit, result.repo.audit);
  assert.match(await m.refs(), new RegExp("refs/heads/" + result.repo.branch + " " + result.repo.commit));
  assert.equal(await workingTree(m.repo), tree);
  // With no record target, the file's source is the learning ID.
  assert.match(await fixtureGit(m.repo, ["cat-file", "blob", result.repo.commit + ":" + result.repo.rel]), new RegExp("source: devtwin " + result.repo.learningId + "\n"));
  assert.deepEqual(await listHeld(m.roots), []);
  assert.equal(m.notes.length, 0);
  // The digest lists the branch as waiting for a consent.
  const activity = await m.ok(["activity"]);
  assert.deepEqual(activity.waiting.map((x) => [x.kind, x.branch, x.reason]), [["learning-branch", result.repo.branch, "needs-consent"]]);
  assert.equal(activity.learned.find((x) => x.id === result.repo.audit).state, "local");
  await m.fail(["learning", "send", "--branch", result.repo.branch], "DEVTWIN_APPROVAL_REQUIRED");
  // A grant does not queue it; learning send does, under the consent.
  await m.grant();
  assert.deepEqual(await listHeld(m.roots), []);
  assert.deepEqual((await m.ok(["activity"])).waiting.map((x) => x.reason), ["not-queued"]);
  const sent = await m.applied(["learning", "send", "--branch", result.repo.branch], { env: { CLAUDECODE: "1" } });
  assert.deepEqual([sent.push.queued, sent.audit], [true, result.repo.audit]);
  assert.deepEqual((await listHeld(m.roots)).map((x) => x.payload.commit), [result.repo.commit]);
  assert.deepEqual((await m.ok(["activity"])).waiting, []);
  await m.fail(["learning", "send", "--branch", result.repo.branch], "DEVTWIN_CONFLICT");
});

test("repo target fails before any write for an existing branch, an unapproved repository, no identity or no learnings base", async (t) => {
  // An existing branch with the learning's name.
  const m = await machine(t);
  const id = await m.propose();
  const plan = await m.ok(m.accept(id, "project,repo"));
  await fixtureGit(m.repo, ["update-ref", "refs/heads/" + plan.repo.branch, "HEAD"]);
  const conflict = await untouched(m, () => m.fail([...m.accept(id, "project,repo"), "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_CONFLICT"));
  assert.equal(conflict.details.branch, plan.repo.branch);
  // A repository not in repoLearnings.
  const loose = await machine(t, { approve: false });
  const error = await untouched(loose, async () => loose.fail(loose.accept(await loose.propose(), "project,repo"), "DEVTWIN_GATE_REQUIRED"));
  assert.deepEqual([error.details.reason, error.details.field], ["not-approved", "writeClasses.repoLearnings"]);
  // No recorded Git identity for the scope.
  const anonymous = await machine(t, { identity: false });
  const missing = await untouched(anonymous, async () => anonymous.fail(anonymous.accept(await anonymous.propose(), "repo"), "DEVTWIN_GATE_REQUIRED"));
  assert.equal(missing.details.reason, "no-identity");
  // No refs/remotes/origin/HEAD and no project set --learnings-base.
  const baseless = await machine(t, { originHead: false });
  const nobase = await untouched(baseless, async () => baseless.fail(baseless.accept(await baseless.propose(), "project,repo"), "DEVTWIN_GATE_REQUIRED"));
  assert.equal(nobase.details.reason, "no-learnings-base");
  assert.match(nobase.message, /project set --learnings-base/);
  // project set --learnings-base names one; the same accept then works from it.
  await baseless.applied(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-base", "refs/remotes/origin/main"]);
  const done = await baseless.applied(baseless.accept(await baseless.propose({ title: "Pin the seed order" }), "repo"));
  assert.equal(done.repo.base, "refs/remotes/origin/main");
  // A repository that requires signed commits fails with a clear message.
  const signed = await machine(t);
  await fixtureGit(signed.repo, ["config", "commit.gpgsign", "true"]);
  const signing = await untouched(signed, async () => signed.fail(signed.accept(await signed.propose(), "repo"), "DEVTWIN_GATE_REQUIRED"));
  assert.equal(signing.details.reason, "signing-required");
});

test("undo of a learning branch whose commit is in the learnings base refuses and names the manual revert", async (t) => {
  const m = await machine(t);
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  // The branch was merged: the learnings base now contains its commit.
  await fixtureGit(m.repo, ["update-ref", "refs/remotes/origin/main", result.repo.commit]);
  const error = await m.fail(["undo", "--id", result.repo.audit], "DEVTWIN_GATE_REQUIRED");
  assert.equal(error.details.reason, "merged");
  assert.match(error.message, new RegExp("git revert " + result.repo.commit));
  assert.equal((await fixtureGit(m.repo, ["rev-parse", "refs/heads/" + result.repo.branch])).trim(), result.repo.commit);
  // undo --since skips it with the same reason.
  assert.deepEqual((await m.ok(["undo", "--since", "2026-01-01T00:00:00Z"])).skipped.filter((x) => x.id === result.repo.audit), [{ id: result.repo.audit, reason: "merged" }]);
});

test("undo of a learning branch never pushed adds a revert commit on its own ref and queues nothing", async (t) => {
  const m = await machine(t);
  await m.grant();
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  assert.equal((await listHeld(m.roots)).length, 1);
  const tree = await workingTree(m.repo);
  const undone = await m.applied(["undo", "--id", result.repo.audit]);
  assert.match(m.dialogs.at(-1).body, /adds a revert commit to devtwin\/learning-[a-f0-9]{24}, cancels its held push; nothing is pushed/);
  const [entry] = undone.undone;
  assert.deepEqual([entry.branch, entry.cancelled.held, entry.push.queued, entry.push.reason], [result.repo.branch, result.repo.push.heldId, false, "never-pushed"]);
  assert.deepEqual(await listHeld(m.roots), []);
  const tip = (await fixtureGit(m.repo, ["rev-parse", "refs/heads/" + result.repo.branch])).trim();
  assert.equal(tip, entry.revert);
  assert.equal((await fixtureGit(m.repo, ["rev-parse", tip + "^1"])).trim(), result.repo.commit, "a fast-forward of its own ref");
  assert.equal((await fixtureGit(m.repo, ["rev-parse", tip + "^{tree}"])).trim(), (await fixtureGit(m.repo, ["rev-parse", "refs/remotes/origin/main^{tree}"])).trim());
  assert.equal(await workingTree(m.repo), tree);
  assert.deepEqual((await m.ok(["activity"])).waiting, [], "an undone branch waits for nothing");
});

test("project set is owner-only and a changed learnings dir voids the repository's consent", async (t) => {
  const m = await machine(t);
  for (const command of ["devtwin project set --scope example --project example.atlas --learnings-dir docs/lessons --apply --plan-fingerprint sha256:00", "script -q /dev/null devtwin project set --learnings-dir docs/lessons --apply"]) assert.equal(ownerAction("claude", bash(command)), "project set --apply", command);
  assert.equal(ownerAction("claude", bash("devtwin project set --scope example --project example.atlas --learnings-dir docs/lessons")), null, "the preview stays open");
  await m.grant();
  assert.equal((await readConsent(m.roots, "repo-push", m.repo)).valid, true);
  const plan = await m.ok(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-dir", "docs/lessons"]);
  assert.deepEqual([plan.current.learningsDir, plan.next.learningsDir, plan.voids], [null, "docs/lessons", [m.repo]]);
  await m.fail(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-dir", "../outside"], "DEVTWIN_INVALID_INPUT");
  await m.fail(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-base", "main"], "DEVTWIN_INVALID_INPUT");
  // A local branch is not a learnings base: the push checks the base against a remote branch.
  await m.fail(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-base", "refs/heads/main"], "DEVTWIN_INVALID_INPUT");
  const set = await m.ok(["project", "set", "--scope", SCOPE, "--project", PROJECT, "--learnings-dir", "docs/lessons", "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual([set.learningsDir, set.voided], ["docs/lessons", [m.repo]]);
  assert.match(m.dialogs.at(-1).body, /This voids the repo-push consent for:/);
  assert.deepEqual(await readConsent(m.roots, "repo-push", m.repo).then((c) => [c.valid, c.voidReason]), [false, "rules-changed"]);
  // The next branch goes to the new folder and stays local until the consent is granted again.
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  assert.deepEqual([result.repo.rel, result.repo.push.reason, result.repo.push.voidReason], ["docs/lessons/seed-after-migrations.md", "needs-consent", "rules-changed"]);
});

test("learning push refuses when the configured push URL differs from the consent's", async (t) => {
  const m = await machine(t);
  await m.grant();
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  await fixtureGit(m.repo, ["remote", "set-url", "--push", "origin", "ssh://elsewhere.example.invalid/atlas.git"]);
  const out = await sendDue(m.roots, { now: at(25) });
  assert.deepEqual(out.kept.map((x) => x.reason), ["push-url-differs"]);
  assert.deepEqual([out.sent, out.dropped], [[], []]);
  assert.doesNotMatch(await m.remoteRefs(), /devtwin/);
  assert.equal((await listHeld(m.roots))[0].payload.commit, result.repo.commit, "the item stays held");
});

test("learning push to an HTTPS remote prints the command and pushes nothing", async (t) => {
  assert.deepEqual(["ssh://git.example.invalid/a.git", "git@example.invalid:org/a.git", "https://git.example.invalid/a.git", "/srv/a.git", "file:///srv/a.git", "git://git.example.invalid/a.git", "ext::sh -c x", "-oProxyCommand=x:a.git", "host:-x", null].map(transportOf),
    ["ssh", "ssh", "https", "other", "other", "other", "other", "other", "other", "none"]);
  const m = await machine(t, { remote: "https" });
  const consent = await m.grant();
  assert.equal(consent.remoteUrl, "https://git.example.invalid/atlas.git");
  assert.match(m.dialogs.at(-1).body, /not SSH: devtwin prints the push command for you instead/);
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  assert.deepEqual([result.repo.push.queued, result.repo.push.reason], [false, "https"]);
  assert.equal(result.repo.push.command, "git -C '" + m.repo + "' push 'https://git.example.invalid/atlas.git' " + result.repo.commit + ":refs/heads/" + result.repo.branch);
  assert.deepEqual(await listHeld(m.roots), []);
  assert.equal(m.notes.length, 0);
  assert.doesNotMatch(await m.remoteRefs(), /devtwin/);
});

test("learning push integration: the bare remote receives the branch after the hold and a planted filter never runs", async (t) => {
  const m = await machine(t, { canary: true });
  await m.grant();
  const tree = await workingTree(m.repo);
  const result = await m.applied(m.accept(await m.propose(), "project,repo"));
  assert.equal(await workingTree(m.repo), tree);
  // Before the hold ends nothing leaves.
  const early = await sendDue(m.roots, { now: at(23) });
  assert.deepEqual(early.kept.map((x) => x.reason), ["not-due"]);
  assert.doesNotMatch(await m.remoteRefs(), /devtwin/);
  // The hourly learning-send job sends it after the hold.
  const sent = await sendDue(m.roots, { now: at(24) });
  assert.deepEqual(sent.sent.map((x) => [x.branch, x.commit, x.state]), [[result.repo.branch, result.repo.commit, "sent"]]);
  assert.match(await m.remoteRefs(), new RegExp("refs/heads/" + result.repo.branch + " " + result.repo.commit));
  assert.equal((await fixtureGit(m.bare, ["rev-parse", "main"])).trim(), (await fixtureGit(m.repo, ["rev-parse", "refs/remotes/origin/main"])).trim(), "main is not touched");
  assert.equal((await m.ok(["activity"], { clock: at(24) })).learned.find((x) => x.id === result.repo.audit).state, "sent");
  // Undo of the pushed branch: a revert commit on its own ref, pushed after the hold by fast-forward.
  const undone = await m.applied(["undo", "--id", result.repo.audit], { clock: at(25) });
  const [entry] = undone.undone;
  assert.deepEqual([entry.push.queued, entry.push.sendAfter], [true, at(49)().toISOString()]);
  assert.deepEqual((await sendDue(m.roots, { now: at(48) })).sent, []);
  const reverted = await sendDue(m.roots, { now: at(49) });
  assert.deepEqual(reverted.sent.map((x) => [x.kind, x.commit]), [["repo-revert", entry.revert]]);
  assert.match(await m.remoteRefs(), new RegExp("refs/heads/" + result.repo.branch + " " + entry.revert));
  assert.equal(await workingTree(m.repo), tree);
  assert.equal(existsSync(m.marker), false, "the filter driver never ran");
});

test("undo of a pushed learning branch refuses once the remote branch is gone", async (t) => {
  const m = await machine(t);
  await m.grant();
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  await sendDue(m.roots, { now: at(24) });
  await fixtureGit(m.bare, ["update-ref", "-d", "refs/heads/" + result.repo.branch]);
  const error = await m.fail(["undo", "--id", result.repo.audit], "DEVTWIN_GATE_REQUIRED", { clock: at(25) });
  assert.equal(error.details.reason, "remote-gone");
  assert.match(error.message, /revert it by hand: git revert/);
});

// The fixture transport, logging each remote command it is asked to run to <sandbox>/ssh.log.
const LOGGING_SSH = (sb) => FAKE_SSH.replace("unset GIT_CONFIG_PARAMETERS", "printf '%s\\n' \"$last\" >> '" + join(sb, "ssh.log") + "'\nunset GIT_CONFIG_PARAMETERS");
// A commit with evil.js (and a solution file) on top of the learnings base, made in a scratch branch that is then
// deleted, as an agent shell could. -> its ID
async function evilCommit(m) {
  await fixtureGit(m.repo, ["checkout", "-q", "-b", "scratch"]);
  await writeFile(join(m.repo, "evil.js"), "malicious()\n");
  await writeFile(join(m.repo, "docs", "solutions", "evil.md"), "# Evil\n\nRun evil.js first.\n");
  await fixtureGit(m.repo, ["add", "evil.js", "docs/solutions/evil.md"]);
  await fixtureGit(m.repo, ["commit", "-q", "-m", "innocent"]);
  const id = (await fixtureGit(m.repo, ["rev-parse", "HEAD"])).trim();
  await fixtureGit(m.repo, ["checkout", "-q", "main"]);
  await fixtureGit(m.repo, ["branch", "-q", "-D", "scratch"]);
  return id;
}
const pushRepos = async (m) => { try { return await readdir(join(m.roots.stateRoot, "tmp")); } catch { return []; } };

test("learning push ignores the repository's pushurl and pushInsteadOf for the consent URL and never runs its receivepack", async (t) => {
  // remote.<consent URL>.pushurl, added after the grant: a remote section keyed by the URL the push names.
  const keyed = await machine(t, { sshScript: LOGGING_SSH });
  await keyed.grant();
  await fixtureGit(keyed.repo, ["config", "remote." + keyed.url + ".pushurl", keyed.otherUrl]);
  await fixtureGit(keyed.repo, ["config", "remote." + keyed.url + ".receivepack", "git-receive-pack-canary"]);
  await fixtureGit(keyed.repo, ["config", "remote." + keyed.url + ".uploadpack", "git-upload-pack-canary"]);
  await fixtureGit(keyed.repo, ["config", "push.followTags", "true"]);
  await fixtureGit(keyed.repo, ["tag", "-a", "-m", "private", "private-tag", "HEAD"]);
  const first = await keyed.applied(keyed.accept(await keyed.propose(), "repo"));
  const sent = await sendDue(keyed.roots, { now: at(24) });
  assert.deepEqual(sent.sent.map((x) => x.commit), [first.repo.commit]);
  assert.match(await keyed.remoteRefs(), new RegExp("refs/heads/" + first.repo.branch + " " + first.repo.commit));
  assert.doesNotMatch(await keyed.remoteRefs(), /private-tag/);
  assert.equal(await keyed.otherRefs(), "", "nothing reached the other repository");
  const log = (await readFile(join(keyed.sb, "ssh.log"), "utf8")).trim().split("\n");
  assert.ok(log.length >= 2 && log.every((line) => /^git-(upload|receive)-pack '/.test(line)), log.join("\n"));
  assert.deepEqual(await pushRepos(keyed), [], "the push repository is removed");
  // pushInsteadOf: origin is an alias that insteadOf turns into the consent URL, and a pushInsteadOf rule turns the
  // consent URL into another repository. The configured push URL still reads as the consent URL.
  const aliased = await machine(t);
  await aliased.grant();
  await fixtureGit(aliased.repo, ["remote", "set-url", "origin", "alias:atlas"]);
  await fixtureGit(aliased.repo, ["config", "url." + aliased.url + ".insteadOf", "alias:atlas"]);
  await fixtureGit(aliased.repo, ["config", "url." + aliased.otherUrl + ".pushInsteadOf", aliased.url]);
  const second = await aliased.applied(aliased.accept(await aliased.propose(), "repo"));
  const out = await sendDue(aliased.roots, { now: at(24) });
  assert.deepEqual(out.sent.map((x) => x.commit), [second.repo.commit]);
  assert.match(await aliased.remoteRefs(), new RegExp("refs/heads/" + second.repo.branch));
  assert.equal(await aliased.otherRefs(), "", "nothing reached the other repository");
});

test("replace refs change neither the learning commit nor what the push or the import reads", async (t) => {
  const m = await machine(t);
  await m.grant();
  const base = (await fixtureGit(m.repo, ["rev-parse", "refs/remotes/origin/main"])).trim();
  const evil = await evilCommit(m);
  await fixtureGit(m.repo, ["replace", "-f", base, evil]);
  const result = await m.applied(m.accept(await m.propose(), "repo"));
  // The commit adds only the lesson, on the real base tree.
  assert.equal((await fixtureGit(m.repo, ["--no-replace-objects", "rev-parse", result.repo.commit + "^1"])).trim(), base);
  assert.equal((await fixtureGit(m.repo, ["--no-replace-objects", "diff-tree", "--no-commit-id", "--name-status", "-r", base, result.repo.commit])).trim(), "A\t" + result.repo.rel);
  const out = await sendDue(m.roots, { now: at(24) });
  assert.deepEqual(out.sent.map((x) => x.commit), [result.repo.commit]);
  const files = (await fixtureGit(m.bare, ["ls-tree", "-r", "--name-only", "refs/heads/" + result.repo.branch])).trim().split("\n");
  assert.ok(!files.includes("evil.js") && files.includes(result.repo.rel), files.join(","));
  assert.notEqual((await fixtureGit(m.bare, ["cat-file", "-t", evil]).catch(() => "missing")).trim(), "commit", "the replacement commit never left");
  // The import reads the base commit's own tree.
  assert.deepEqual(readSolutions(m.repo, base).items.map((x) => x.file), ["docs/solutions/seed-order.md"]);
});

test("a learning branch on a moved local base stays held, and one on a base the remote moved past is sent", async (t) => {
  const m = await machine(t);
  await m.grant();
  // An agent shell moves the local remote-tracking ref onto its own commit, then the lesson is accepted.
  const evil = await evilCommit(m);
  await fixtureGit(m.repo, ["update-ref", "refs/remotes/origin/main", evil]);
  const moved = await m.applied(m.accept(await m.propose(), "repo"));
  assert.equal((await fixtureGit(m.repo, ["rev-parse", moved.repo.commit + "^1"])).trim(), evil);
  const out = await sendDue(m.roots, { now: at(24) });
  assert.deepEqual([out.sent, out.kept.map((x) => x.reason)], [[], ["base-not-on-remote"]]);
  assert.doesNotMatch(await m.remoteRefs(), /devtwin/);
  assert.equal((await fixtureGit(m.bare, ["cat-file", "-t", evil]).catch(() => "missing")).trim(), "missing", "evil.js never reached the remote");
  assert.deepEqual((await m.ok(["activity", "--held"], { clock: at(24) })).held.map((x) => [x.id, x.blocked]), [[moved.repo.push.heldId, "base-not-on-remote"]]);
  assert.deepEqual(await pushRepos(m), []);
  // Another machine: the remote's main moved on past the local base. The parent is an ancestor of the remote tip,
  // which is in the local objects, so the branch is sent.
  const n = await machine(t);
  await n.grant();
  await writeFile(join(n.repo, "CHANGELOG.md"), "next\n");
  await fixtureGit(n.repo, ["add", "CHANGELOG.md"]);
  await fixtureGit(n.repo, ["commit", "-q", "-m", "next"]);
  await fixtureGit(n.repo, ["push", "-q", n.bare, "HEAD:main"]);
  const behind = await n.applied(n.accept(await n.propose(), "repo"));
  assert.deepEqual((await sendDue(n.roots, { now: at(24) })).sent.map((x) => x.commit), [behind.repo.commit]);
});

test("a revoke during a send run stops the items after it, and a later grant does not release a held branch until learning send queues it again", async (t) => {
  // The fixture transport removes the consent right after the first push, as a revoke between two items would.
  const m = await machine(t, { sshScript: (sb) => FAKE_SSH.replace('exec sh -c "git ${last#git-}" ;;', 'sh -c "git ${last#git-}"; s=$?; case "$last" in "git-receive-pack "*) rm -f "$(cat \'' + join(sb, "consent-path") + '\')" ;; esac; exit $s ;;') });
  await m.grant();
  await writeFile(join(m.sb, "consent-path"), consentPath(m.roots, "repo-push", m.repo));
  const first = await m.applied(m.accept(await m.propose({ title: "First lesson" }), "repo"));
  const second = await m.applied(m.accept(await m.propose({ title: "Second lesson" }), "repo"));
  const run = await sendDue(m.roots, { now: at(24) });
  assert.equal(run.sent.length, 1);
  assert.deepEqual(run.kept.map((x) => x.reason), ["needs-consent"]);
  const left = (await listHeld(m.roots)).map((x) => x.payload.commit);
  assert.equal(left.length, 1);
  assert.ok([first.repo.commit, second.repo.commit].includes(left[0]));
  const branch = left[0] === first.repo.commit ? first.repo.branch : second.repo.branch;
  assert.doesNotMatch(await m.remoteRefs(), new RegExp(branch));
  // A new grant does not release it: it was held under the earlier grant.
  await writeFile(join(m.sb, "consent-path"), "/nonexistent");
  await m.applied(["consent", "grant", "--kind", "repo-push", "--repo", m.repo], { clock: at(25) });
  const after = await sendDue(m.roots, { now: at(26) });
  assert.deepEqual([after.sent, after.kept.map((x) => x.reason)], [[], ["consent-changed"]]);
  assert.doesNotMatch(await m.remoteRefs(), new RegExp(branch));
  assert.deepEqual((await m.ok(["activity", "--held"], { clock: at(26) })).held.map((x) => x.blocked), ["consent-changed"]);
  // learning send --branch queues it again under the new grant, with a new hold and a notification.
  const again = await m.applied(["learning", "send", "--branch", branch], { clock: at(26), env: { CLAUDECODE: "1" } });
  assert.deepEqual([again.push.requeued, again.push.sendAfter], [true, at(50)().toISOString()]);
  assert.match(m.notes.at(-1).message ?? JSON.stringify(m.notes.at(-1)), /Held again/);
  assert.deepEqual((await sendDue(m.roots, { now: at(49) })).sent, []);
  assert.equal((await sendDue(m.roots, { now: at(50) })).sent.length, 1);
  assert.match(await m.remoteRefs(), new RegExp(branch));
});
