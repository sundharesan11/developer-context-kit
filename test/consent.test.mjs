import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, stat, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { initPilot, makeRepo, treeSnapshot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { readSnapshot } from "../src/records/store.mjs";
import { readPersonalSnapshot } from "../src/records/personal.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { readConsent, requireConsent, ruleDigestFor, consentRules } from "../src/consent/store.mjs";

const SCOPE = "example", PROJECT = "example.atlas";
// One machine with a bound repository and an injected owner dialog. env is the caller's environment.
async function machine(t) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: SCOPE, hubs: [], policies: [], now });
  const repo = await makeRepo(join(p.reposDir, "atlas"), { "README.md": "# Atlas\n" });
  const input = { scope: SCOPE, project: PROJECT, repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_consent001" };
  await applyOnboard(p.roots, p.pilot, input, { fingerprint: (await planOnboard(p.roots, p.pilot, input)).fingerprint, now });
  const dialogs = [];
  let decision = "approved";
  const cli = async (args, { env = {} } = {}) => {
    const chunks = [];
    await main([...args, "--pilot", p.path], { now, home: p.fakeHome, env, ownerDialog: async (content) => { dialogs.push(content); return decision; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.ok, true, args.join(" ") + ": " + JSON.stringify(out.error)); return out.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.ok, false, args.join(" ")); assert.equal(out.error.code, code, args.join(" ") + ": " + JSON.stringify(out.error)); return out.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  return { p, roots: p.roots, repo, cli, ok, fail, applied, dialogs, setDialog: (value) => { decision = value; } };
}
const propose = async (m, { session = "ses_agent", title = "Seed after migrations", env = { CLAUDECODE: "1" } } = {}) =>
  (await m.ok(["lesson", "propose", "--session", session, "--scope", SCOPE, "--project", PROJECT, "--title", title, "--summary", "Do run migrations before seeds.", "--body", "Seeds fail on a fresh database.\n", "--path", "db/**", "--apply"], { env })).proposalId;
const accept = (id, target) => ["lesson", "accept", "--id", id, "--target", target];
const bash = (command) => ({ session_id: "s-agent", cwd: "/x", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_01Example" });

test("agent lesson accept to a project writes with no dialog and records the agent", async (t) => {
  const m = await machine(t);
  for (const [env, actor, session] of [[{ CLAUDECODE: "1" }, "claude", "ses_claude"], [{ CODEX_THREAD_ID: "thr_1" }, "codex", "ses_codex"], [{}, "human", "ses_human"]]) {
    const id = await propose(m, { session, title: "Seed after migrations " + actor, env });
    const plan = await m.ok(accept(id, "project"), { env });
    assert.equal(plan.tier, "automatic");
    assert.equal(plan.dialog, undefined);
    const result = await m.ok([...accept(id, "project"), "--apply", "--plan-fingerprint", plan.fingerprint], { env });
    assert.equal(result.tier, "automatic");
    assert.equal(result.recordedBy, actor);
    const record = (await readSnapshot(m.roots, SCOPE, PROJECT)).records.find((r) => r.id === result.project.recordId);
    assert.deepEqual([record.recordedBy.actor, record.status, record.reach], [actor, "observed", "project"]);
  }
  assert.equal(m.dialogs.length, 0, "no accept to a project shows the owner dialog");
  // The hook lets an agent run it.
  for (const command of ["devtwin lesson accept --id prop_1 --target project --apply --plan-fingerprint sha256:00", "script -q /dev/null devtwin lesson accept --id prop_1 --target project --apply"]) assert.equal(ownerAction("claude", bash(command)), null, command);
});

test("lesson accept to general or hub+general waits for the activity review", async (t) => {
  const m = await machine(t);
  const id = await propose(m);
  const before = await treeSnapshot(m.p.pilot.pilotRoot);
  for (const target of ["general", "hub+general"]) {
    for (const args of [accept(id, target), [...accept(id, target), "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)]]) {
      const error = await m.fail(args, "DEVTWIN_GATE_REQUIRED", { env: { CLAUDECODE: "1" } });
      assert.match(error.message, /waits for the weekly activity review/);
      // U30: hub+general is the older spelling of the target set general,hub.
      assert.deepEqual([error.details.target, error.details.via], [target === "hub+general" ? "general,hub" : target, "activity review"]);
    }
  }
  assert.equal(await treeSnapshot(m.p.pilot.pilotRoot), before, "nothing is written");
  assert.deepEqual((await readPersonalSnapshot(m.roots)).records, []);
  assert.equal(m.dialogs.length, 0);
  assert.deepEqual((await m.ok(["lesson", "proposals"])).proposals.map((x) => [x.id, x.state]), [[id, "pending"]]);
});

test("consent grant for repo-push after the owner dialog records the target and rule digest", async (t) => {
  const m = await machine(t);
  const args = ["consent", "grant", "--kind", "repo-push", "--repo", m.repo];
  const before = await treeSnapshot(m.p.pilot.pilotRoot);
  const plan = await m.ok(args);
  assert.deepEqual([plan.consent.kind, plan.consent.target, plan.consent.holdHours, plan.current], ["repo-push", m.repo, 24, null]);
  assert.equal(plan.consent.ruleDigest, ruleDigestFor("repo-push", 24));
  // U30: the repository part of the rules: the default learnings folder and base, and no origin remote to record.
  assert.deepEqual([plan.consent.rules.learningsDir, plan.consent.rules.learningsBase, plan.consent.rules.remoteUrl, plan.consent.remoteUrl], ["docs/solutions/lessons", "refs/remotes/origin/HEAD", null, null]);
  assert.equal(await treeSnapshot(m.p.pilot.pilotRoot), before, "the preview writes nothing");
  assert.equal(m.dialogs.length, 0);
  // A denied dialog writes nothing; an approved one writes the consent.
  m.setDialog("denied");
  await m.fail([...args, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
  assert.equal(await readConsent(m.roots, "repo-push", m.repo), null);
  m.setDialog("approved");
  await m.fail([...args, "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], "DEVTWIN_PLAN_MISMATCH");
  assert.equal(m.dialogs.length, 1, "a stale fingerprint is refused before the dialog");
  const granted = await m.ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual([granted.granted, granted.kind, granted.target, granted.ruleDigest, granted.valid], [true, "repo-push", m.repo, plan.consent.ruleDigest, true]);
  assert.match(m.dialogs.at(-1).title, /learning-branch pushes/);
  assert.ok(m.dialogs.at(-1).body.includes("Repository: " + m.repo));
  const dir = join(m.p.stateRoot, "consents", "repo-push"), file = join(dir, createHash("sha256").update(m.repo).digest("hex") + ".json");
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { schemaVersion: 1, kind: "repo-push", target: m.repo, holdHours: 24, ruleDigest: plan.consent.ruleDigest, grantedAt: now().toISOString(), remoteUrl: null });
  assert.deepEqual((await m.ok(["consent", "list"])).consents.map((c) => [c.kind, c.target, c.valid]), [["repo-push", m.repo, true]]);
  // Hold hours from 1 to 168; another hold time is another rule digest.
  const one = await m.ok([...args, "--hold-hours", "1"]);
  assert.notEqual(one.consent.ruleDigest, plan.consent.ruleDigest);
  for (const hours of ["0", "169", "2.5", "-1", "x"]) await m.fail([...args, "--hold-hours=" + hours], "DEVTWIN_INVALID_INPUT");
  // An unbound repository, a wrong target flag, an unknown kind and a hub without a join are refused.
  const loose = await makeRepo(join(m.p.reposDir, "beacon"), { "README.md": "# Beacon\n" });
  await m.fail(["consent", "grant", "--kind", "repo-push", "--repo", loose], "DEVTWIN_PROJECT_UNBOUND");
  await m.fail(["consent", "grant", "--kind", "repo-push", "--scope", SCOPE, "--repo", m.repo], "DEVTWIN_INVALID_INPUT");
  await m.fail(["consent", "grant", "--kind", "push-all", "--repo", m.repo], "DEVTWIN_INVALID_INPUT");
  await m.fail(["consent", "grant", "--kind", "hub-publish", "--scope", SCOPE], "DEVTWIN_HUB_NOT_JOINED");
  // Revoke: preview, dialog, then the consent is gone.
  const revoke = await m.ok(["consent", "revoke", "--kind", "repo-push", "--repo", m.repo]);
  assert.equal(revoke.current.valid, true);
  const revoked = await m.ok(["consent", "revoke", "--kind", "repo-push", "--repo", m.repo, "--apply", "--plan-fingerprint", revoke.fingerprint]);
  assert.equal(revoked.revoked, true);
  assert.match(m.dialogs.at(-1).title, /Revoke a standing consent/);
  assert.equal(existsSync(file), false);
  assert.deepEqual(await readdir(dir), []);
  await m.fail(["consent", "revoke", "--kind", "repo-push", "--repo", m.repo], "DEVTWIN_NOT_FOUND");
  assert.deepEqual(await m.ok(["consent", "list"]), { consents: [], notes: [] });
});

test("a consent whose rule digest changed reads as void and the action needs consent", async (t) => {
  const m = await machine(t);
  const granted = await m.applied(["consent", "grant", "--kind", "repo-push", "--repo", m.repo, "--hold-hours", "48"]);
  assert.equal((await requireConsent(m.roots, "repo-push", m.repo)).holdHours, 48);
  assert.equal(granted.ruleDigest, ruleDigestFor("repo-push", 48));
  assert.equal(consentRules("repo-push", 48).holdHours, 48);
  const file = join(m.p.stateRoot, "consents", "repo-push", createHash("sha256").update(m.repo).digest("hex") + ".json");
  const stored = JSON.parse(await readFile(file, "utf8"));
  // The rules the consent was granted under are not today's rules.
  await writeFile(file, JSON.stringify({ ...stored, ruleDigest: "sha256:" + "1".repeat(64) }));
  const read = await readConsent(m.roots, "repo-push", m.repo);
  assert.deepEqual([read.valid, read.voidReason], [false, "rules-changed"]);
  await assert.rejects(requireConsent(m.roots, "repo-push", m.repo), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED" && /Needs consent/.test(e.message) && e.details.reason === "rules-changed");
  assert.deepEqual((await m.ok(["consent", "list"])).consents.map((c) => [c.valid, c.voidReason]), [[false, "rules-changed"]]);
  // A broken file is void too, and a missing one needs consent.
  await writeFile(file, "{");
  assert.equal((await readConsent(m.roots, "repo-push", m.repo)).voidReason, "invalid");
  await assert.rejects(requireConsent(m.roots, "hub-publish", SCOPE), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED" && e.details.reason === "none" && e.details.consent === "hub-publish");
  // A new grant replaces the void consent.
  await m.applied(["consent", "grant", "--kind", "repo-push", "--repo", m.repo]);
  assert.equal((await readConsent(m.roots, "repo-push", m.repo)).valid, true);
});

test("consent grant and revoke apply from a hooked agent shell are denied", async (t) => {
  const m = await machine(t);
  const kit = 'node "$DEVTWIN_KIT/bin/devtwin.mjs"';
  for (const command of [
    `${kit} consent grant --pilot '${m.p.path}' --kind repo-push --repo '${m.repo}' --apply --plan-fingerprint 'sha256:00'`,
    `script -q /dev/null devtwin consent revoke --kind hub-publish --scope ${SCOPE} --apply`,
    `bash -c "devtwin consent grant --kind hub-publish --scope ${SCOPE} --apply"`,
    `${kit} setup apply --pilot '${m.p.path}' --step consent-repo --push-repo '${m.repo}' --plan-fingerprint 'sha256:00'`,
    `${kit} setup apply --pilot '${m.p.path}' --step consent-hub --scope ${SCOPE} --plan-fingerprint 'sha256:00'`
  ]) {
    assert.ok(ownerAction("claude", bash(command)), command);
    const chunks = [];
    await main(["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", m.p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(bash(command)), now });
    assert.equal(JSON.parse(chunks.join("")).hookSpecificOutput.permissionDecision, "deny", command);
  }
  // The previews and the list stay open to agents.
  for (const command of [`devtwin consent grant --kind repo-push --repo ${m.repo}`, "devtwin consent list", `devtwin consent revoke --kind hub-publish --scope ${SCOPE}`]) assert.equal(ownerAction("claude", bash(command)), null, command);
  assert.equal(m.dialogs.length, 0);
  assert.equal(await readConsent(m.roots, "repo-push", m.repo), null);
});

test("setup consent-repo step grants the repo-push consent after the owner dialog", async (t) => {
  const m = await machine(t);
  const status = await m.ok(["setup", "status"]);
  const steps = Object.fromEntries(status.steps.map((s) => [s.id, s]));
  assert.deepEqual([steps["consent-repo"].owner, steps["consent-repo"].skipped], [true, "no --push-repo given"]);
  assert.deepEqual([steps["consent-hub"].owner, steps["consent-hub"].skipped], [true, "no hub joined for this scope"]);
  for (const key of ["what", "why", "undo"]) assert.match(steps["consent-repo"][key], /\S{10}/);
  const args = ["--step", "consent-repo", "--push-repo", m.repo, "--hold-hours", "12"];
  const plan = await m.ok(["setup", "plan", ...args]);
  assert.equal(plan.step.done, false);
  assert.deepEqual([plan.preview.consent.kind, plan.preview.consent.target, plan.preview.consent.holdHours], ["repo-push", m.repo, 12]);
  m.setDialog("denied");
  await m.fail(["setup", "apply", ...args, "--plan-fingerprint", plan.fingerprint], "DEVTWIN_OWNER_DENIED");
  m.setDialog("approved");
  const applied = await m.ok(["setup", "apply", ...args, "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual([applied.step.id, applied.result.granted, applied.result.holdHours], ["consent-repo", true, 12]);
  assert.equal(m.dialogs.length, 2);
  assert.equal((await m.ok(["setup", "plan", ...args])).step.done, true);
  await m.fail(["setup", "apply", "--step", "consent-hub", "--scope", SCOPE, "--plan-fingerprint", "sha256:00"], "DEVTWIN_GATE_REQUIRED");
});
