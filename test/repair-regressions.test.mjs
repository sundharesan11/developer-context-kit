import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access, readFile, writeFile, readdir, mkdir, chmod } from "node:fs/promises";
import { committedProject, twoScopes, draft, draftFor, now, runCli, fixtureGit, makePilot, makeRepo, onboardFixture, treeSnapshot } from "./helpers.mjs";
import { addRecord, commitBundle, proposeRecord, publishProposal, readSnapshot } from "../src/records/store.mjs";
import { locateWorktree } from "../src/identity/git.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { resolveContext } from "../src/context/resolve.mjs";
import { applyInit, validatePreferences } from "../src/config/store.mjs";
import { planInstall, applyInstall } from "../src/agents/install.mjs";
import { createApproval, verifyApproval } from "../src/auth/approval.mjs";
import { runDoctor } from "../src/config/doctor.mjs";
import { remoteHost } from "../src/hubs/propose.mjs";
import { spawnSync } from "node:child_process";

test("N1 proposal IDs cannot traverse scopes through library or CLI", async (t) => {
  const s = await twoScopes(t);
  const p = await proposeRecord(s.roots, draftFor("globex", "globex.beacon", { requestId: "req_traverse01", body: "GLOBEX-ONLY-CANARY-4411" }), { now });
  const id = "../../../../globex/projects/globex.beacon/proposals/" + p.proposalId;
  const before = (await readSnapshot(s.roots, "acme", "acme.atlas")).records.length;
  await assert.rejects(publishProposal(s.roots, { scope: "acme", project: "acme.atlas", proposalId: id }, { controller: "human", now }), { code: "DEVTWIN_INVALID_ID" });
  const cli = await runCli(["record", "publish", "--pilot", s.pilot.path, "--scope", "acme", "--project", "acme.atlas", "--proposal", id, "--apply"]);
  assert.equal(cli.json.error.code, "DEVTWIN_INVALID_ID");
  assert.equal((await readSnapshot(s.roots, "acme", "acme.atlas")).records.length, before);
});

test("N1 proposal content must belong to the selected scope", async (t) => {
  const s = await twoScopes(t);
  const p = await proposeRecord(s.roots, draftFor("acme", "acme.atlas", { requestId: "req_scope001" }), { now });
  const raw = JSON.parse(await readFile(p.path, "utf8"));
  raw.input.scope = "globex";
  await writeFile(p.path, JSON.stringify(raw));
  await assert.rejects(publishProposal(s.roots, { scope: "acme", project: "acme.atlas", proposalId: p.proposalId }, { controller: "human", now }), { code: "DEVTWIN_CONFLICT" });
});

test("N2 public record mutators reject caller supersession and leave target effective", async (t) => {
  const s = await committedProject(t);
  const target = await addRecord(s.roots, draft({ requestId: "req_target001" }), { now });
  for (const mutate of [addRecord, commitBundle, proposeRecord]) {
    const input = { ...draft({ requestId: "req_bad" + mutate.name.toLowerCase(), status: "confirmed", review: { reviewer: "email:owner@example.com" } }), recordedBy: { actor: "claude", runId: "run_agent001" }, supersedes: [target.recordId] };
    await assert.rejects(mutate(s.roots, input, { now }), { code: "DEVTWIN_INVALID_INPUT" });
  }
  await assert.rejects(commitBundle(s.roots, draft({ requestId: "req_optbad001" }), { now, supersedes: [target.recordId] }), { code: "DEVTWIN_INVALID_INPUT" });
  await assert.rejects(addRecord(s.roots, { ...draft({ requestId: "req_phantom01", status: "confirmed", review: { reviewer: "email:owner@example.com" } }), recordedBy: { actor: "codex", runId: "run_agent001" }, supersedes: ["rec_" + "0".repeat(24)] }, { now }), { code: "DEVTWIN_INVALID_INPUT" });
  assert.equal((await readSnapshot(s.roots, "acme", "acme.atlas")).records.find((r) => r.id === target.recordId).effective, "observed");
});

test("N3 effective include and worktree filter config is refused before status", async (t) => {
  const p = await makePilot(t);
  for (const mode of ["include", "worktree"]) {
    const repo = await makeRepo(join(p.reposDir, mode), { "a.txt": "first\n", ".gitattributes": "* filter=canary\n" });
    const canary = join(p.sandbox, mode + "-ran");
    if (mode === "include") {
      const cfg = join(p.sandbox, "included.conf");
      await writeFile(cfg, `[filter "canary"]\nclean = touch ${canary}\n`);
      await fixtureGit(repo, ["config", "--local", "include.path", cfg]);
    } else {
      await fixtureGit(repo, ["config", "--local", "extensions.worktreeConfig", "true"]);
      await fixtureGit(repo, ["config", "--worktree", "filter.canary.clean", `touch ${canary}`]);
    }
    await writeFile(join(repo, "a.txt"), "other\n");
    const before = await treeSnapshot(repo);
    await assert.rejects(locateWorktree(repo), { code: "DEVTWIN_PATH_UNSAFE" });
    await assert.rejects(access(canary));
    assert.equal(await treeSnapshot(repo), before);
  }
});

test("N4 linked worktree advances binding and preserves both roots", async (t) => {
  const s = await onboardFixture(t);
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const linked = join(s.reposDir, "beacon");
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "feature", linked]);
  const input = { ...s.input, repo: linked, requestId: "req_linked001" };
  const plan = await planOnboard(s.roots, s.pilot, input);
  assert.equal(plan.binding.version, 2);
  assert.deepEqual(plan.binding.roots.map((r) => r.path).sort(), [s.repo, linked].sort());
  await applyOnboard(s.roots, s.pilot, input, { fingerprint: plan.fingerprint, now });
  assert.equal((await resolveContext(s.roots, { scope: "acme", cwd: linked })).state, "bound");
});

test("N4 different repository cannot join an existing project", async (t) => {
  const s = await onboardFixture(t);
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const unrelated = await makeRepo(join(s.reposDir, "beacon"), { "README.md": "# Other\n" });
  await assert.rejects(planOnboard(s.roots, s.pilot, { ...s.input, repo: unrelated, requestId: "req_otherrepo01" }), { code: "DEVTWIN_BINDING_CONFLICT" });
});

test("N5 earlier onboard request replays after same-path re-onboard", async (t) => {
  const s = await onboardFixture(t);
  const first = await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const secondInput = { ...s.input, requestId: "req_onboard02" };
  const secondPlan = await planOnboard(s.roots, s.pilot, secondInput);
  await applyOnboard(s.roots, s.pilot, secondInput, { fingerprint: secondPlan.fingerprint, now });
  const replay = await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  assert.deepEqual(replay, { ...first, replayed: true });
  const oldBody = join(s.roots.dataRoot, "scopes/acme/projects/acme.atlas/records", first.bundles[0].id, "body.md");
  await writeFile(oldBody, "corrupt old bundle");
  await assert.rejects(applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now }), { code: "DEVTWIN_RECOVERY_REQUIRED" });
});

test("N6 proposal validates sensitive and extra fields before persistence", async (t) => {
  const s = await committedProject(t);
  const secret = "api" + "_key = " + "abcdef123456";
  await assert.rejects(proposeRecord(s.roots, draft({ requestId: "req_secret001", body: secret }), { now }), { code: "DEVTWIN_SENSITIVE_CONTENT" });
  await assert.rejects(proposeRecord(s.roots, { ...draft({ requestId: "req_extra001" }), unexpected: true }, { now }), { code: "DEVTWIN_INVALID_INPUT" });
  const dir = join(s.roots.dataRoot, "scopes/acme/projects/acme.atlas/proposals");
  assert.deepEqual(await readdir(dir).catch((e) => e.code === "ENOENT" ? [] : Promise.reject(e)), []);
});

test("N7 uninstall preserves owned directory with an added user file", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0];
  const input = { targetHome: home, agents: ["claude"], mode: "install" };
  const install = await planInstall(p.pilot, input);
  await applyInstall(p.roots, p.pilot, input, { fingerprint: install.fingerprint, runId: "run_repair001" });
  const dir = join(home, ".claude/skills/devtwin-record");
  await writeFile(join(dir, "notes.md"), "user note");
  const removeInput = { ...input, mode: "uninstall" };
  const remove = await planInstall(p.pilot, removeInput);
  assert.equal(remove.actions.find((a) => a.skill === "devtwin-record").status, "modified");
  await applyInstall(p.roots, p.pilot, removeInput, { fingerprint: remove.fingerprint, runId: "run_repair002" });
  assert.equal(await readFile(join(dir, "notes.md"), "utf8"), "user note");
  assert.match(await readFile(join(dir, "SKILL.md"), "utf8"), /devtwin/);
});

test("N8 init refuses roots inside a Git worktree and partial init reports recovery", async (t) => {
  const p = await makePilot(t);
  await fixtureGit(p.sandbox, ["init", "-q", "-b", "main"]);
  await assert.rejects(applyInit(p.roots, { now }), { code: "DEVTWIN_PATH_UNSAFE" });
  const q = await makePilot(t);
  await mkdir(q.configRoot, { recursive: true, mode: 0o700 });
  await chmod(q.configRoot, 0o700);
  await writeFile(join(q.configRoot, "user.json"), "{}", { mode: 0o600 });
  await assert.rejects(applyInit(q.roots, { now }), { code: "DEVTWIN_RECOVERY_REQUIRED" });
  assert.throws(() => validatePreferences({ notes: ["api" + "_key = " + "abcdef123456"] }), { code: "DEVTWIN_SENSITIVE_CONTENT" });
});

test("N9 CLI default installer run IDs allow install then uninstall", async (t) => {
  const p = await makePilot(t), home = p.agentHomes[0];
  const base = ["--pilot", p.path, "--home", home, "--agent", "claude"];
  const install = await runCli(["agents", "install", ...base]);
  assert.equal((await runCli(["agents", "install", ...base, "--apply", "--plan-fingerprint", install.json.result.fingerprint])).code, 0);
  const remove = await runCli(["agents", "uninstall", ...base]);
  assert.equal((await runCli(["agents", "uninstall", ...base, "--apply", "--plan-fingerprint", remove.json.result.fingerprint])).code, 0);
});

test("N10 empty and undated approvals are invalid", () => {
  assert.throws(() => createApproval({}), { code: "DEVTWIN_APPROVAL_INVALID" });
  const fields = { scope: "acme", project: "acme.atlas", provider: "fake", accountId: "acct", actorRef: "email:owner@example.com", workspaceId: "ws", operation: "draft", recipient: "issue:ABC-1", payloadHash: "sha256:" + "0".repeat(64), expiresAt: "2026-10-07T01:00:00.000Z" };
  const approval = createApproval(fields);
  assert.throws(() => verifyApproval({ ...approval, expiresAt: undefined }, { ...fields, expiresAt: undefined }, now()), { code: "DEVTWIN_APPROVAL_INVALID" });
});

test("N11 doctor attributes broken committed binding to registry", async (t) => {
  const s = await committedProject(t);
  const binding = join(s.roots.configRoot, "projects/acme/acme.atlas/v1.json");
  await writeFile(binding, "{}");
  const report = await runDoctor(s.roots);
  assert.equal(report.checks.find((c) => c.id === "registry").status, "fail");
});

test("N11 scp remote host is an identifier tripwire", () => {
  const host = "private.example";
  assert.equal(remoteHost("git@" + host + ":org/repo.git"), host);
  assert.equal(remoteHost("ssh://git@" + host + "/org/repo.git"), host);
});

test("N11 package audit sees a dot-dot-prefixed denylist inside root", async (t) => {
  const p = await makePilot(t);
  const root = join(p.sandbox, "candidate");
  await mkdir(root);
  await writeFile(join(root, ".gitignore"), "..deny.txt\n");
  await writeFile(join(root, "..deny.txt"), "private term\n");
  await writeFile(join(root, "allow.json"), JSON.stringify([".gitignore", "allow.json"]));
  await fixtureGit(root, ["init", "-q", "-b", "main"]);
  const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--root", root, "--allowlist", join(root, "allow.json"), "--denylist", join(root, "..deny.txt"), "--no-pack"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).findings.some((x) => x.type === "denylist-inside-root"));
});
