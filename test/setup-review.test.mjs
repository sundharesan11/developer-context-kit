import test from "node:test";
import assert from "node:assert/strict";
import { join, basename } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { makePilot, makeRepo, fixtureGit, treeSnapshot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyInit, applyScopeAdd } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { readSnapshot } from "../src/records/store.mjs";
import { readPersonalSnapshot } from "../src/records/personal.mjs";
import { readAudit, appendEntry } from "../src/audit/log.mjs";
import { activePreferences } from "../src/prefs/store.mjs";
import { listConsents } from "../src/consent/store.mjs";
import { readProfile } from "../src/profile/store.mjs";
import { claudeFolderName } from "../src/import/memory.mjs";
import { ensurePrivatePath, writeNewFile } from "../src/storage/fsx.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { tierOf } from "../src/policy/tiers.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const SCOPE = "example", PROJECT = "example.atlas", AGENT = { CLAUDECODE: "1" }, DAY = 86400000;
const SESSION = "9060c0de-0000-4000-8000-000000000021";
const memory = ({ name, type, description, body }) =>
  "---\nname: " + name + "\ndescription: \"" + description + "\"\nmetadata:\n  node_type: memory\n  type: " + type + "\n  originSessionId: " + SESSION + "\n  modified: 2026-10-25T13:04:13.524Z\n---\n\n" + body + "\n";
const transcript = (cwds) => cwds.map((cwd, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", cwd, sessionId: SESSION, gitBranch: "main", version: "2.1.311", message: { role: "user", content: "fixture" } })).join("\n") + "\n";

// One machine: a pilot with a bound repository, a fake Claude Code folder, an approved review-monthly launch agent, a
// fake launchctl, an injected notifier and an injected owner dialog. Nothing opens a real window or loads a real job.
async function machine(t) {
  const p = await makePilot(t), home = p.agentHomes[0], agents = join(home, "Library", "LaunchAgents");
  await mkdir(join(home, ".claude", "projects"), { recursive: true });
  await mkdir(agents, { recursive: true });
  const path = await p.with({ writeClasses: { launchAgents: [join(agents, "devtwin.review-monthly.plist")] } });
  const pilot = await loadPilot(path, { home: p.fakeHome, kitRoot: KIT, env: {} });
  const roots = rootsFromPilot(pilot);
  await applyInit(roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  await applyScopeAdd(roots, { scope: SCOPE, hubs: [], policies: [], now });
  const repo = await makeRepo(join(p.reposDir, "atlas"), { "README.md": "# Atlas\n", "package.json": "{\"name\":\"atlas\"}\n" });
  await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await fixtureGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const input = { scope: SCOPE, project: PROJECT, repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_setuprev01" };
  await applyOnboard(roots, pilot, input, { fingerprint: (await planOnboard(roots, pilot, input)).fingerprint, now });
  const dialogs = [], notes = [], loaded = new Set();
  let clock = now();
  const launchctl = (args) => {
    if (args[0] === "bootstrap") { loaded.add(basename(args[2], ".plist")); return { status: 0 }; }
    if (args[0] === "print") return { status: loaded.has(args[1].split("/").pop()) ? 0 : 113 };
    return { status: 0 };
  };
  const cli = async (args, { env = {} } = {}) => {
    const chunks = [];
    await main([...args, "--pilot", path], { now: () => clock, home: p.fakeHome, env, kitRoot: KIT, launchctl, notifier: (a) => { notes.push(a); return { status: 0 }; },
      ownerDialog: async (content) => { dialogs.push(content); return "approved"; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.ok, true, args.join(" ") + ": " + JSON.stringify(out.error)); return out.result; };
  const fail = async (args, code, extra) => { const out = await cli(args, extra); assert.equal(out.ok, false, args.join(" ")); assert.equal(out.error.code, code, args.join(" ") + ": " + JSON.stringify(out.error)); return out.error; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  const memoryDir = join(home, ".claude", "projects", claudeFolderName(repo));
  const memoryFile = async (name, text) => {
    await mkdir(join(memoryDir, "memory"), { recursive: true });
    await writeFile(join(memoryDir, SESSION + ".jsonl"), transcript([repo, join(repo, "src")]));
    await writeFile(join(memoryDir, "memory", name), text);
  };
  const plan = () => ok(["review", "plan"]);
  const review = async ({ accept = [], reject = [] }) => {
    const flags = [...accept.flatMap((id) => ["--accept", id]), ...reject.flatMap((id) => ["--reject", id])];
    return applied(["review", "apply", ...flags]);
  };
  return { p, path, roots, repo, home, memoryDir, cli, ok, fail, applied, plan, review, dialogs, notes, memoryFile, advance: (ms) => { clock = new Date(clock.getTime() + ms); return clock; } };
}
const ofKind = (plan, kind) => plan.suggestions.filter((s) => s.kind === kind);
const proposePref = (m, { session, title, text, topic }) => m.ok(["pref", "propose", "--session", session, "--title", title, "--text", text, "--topic", topic, "--apply"]);
async function savedPref(m, { session, title, text, topic }) {
  const { proposalId } = await proposePref(m, { session, title, text, topic });
  return m.applied(["pref", "accept", "--id", proposalId]);
}
const everyStore = async (m) => [await treeSnapshot(m.p.dataRoot), await treeSnapshot(m.p.configRoot), await treeSnapshot(join(m.p.stateRoot, "consents")).catch(() => null)];

test("a fresh setup has no suggestions, and the monthly job then shows no reminder (R34)", async (t) => {
  const m = await machine(t);
  const plan = await m.plan();
  assert.deepEqual(plan.suggestions, []);
  assert.deepEqual(plan.notCollected.map((n) => n.kind), ["skill-template-use"]);
  assert.deepEqual(plan.failed, []);
  const job = await m.ok(["schedule", "plan", "--job", "review-monthly"]);
  await m.ok(["schedule", "apply", "--job", "review-monthly", "--plan-fingerprint", job.fingerprint]);
  const ran = await m.ok(["schedule", "run", "--job", "review-monthly"]);
  assert.equal(ran.suggestions, 0);
  assert.equal(ran.notification, null);
  assert.deepEqual(m.notes, []);
});

test("the monthly reminder counts the open review plan lines", async (t) => {
  const m = await machine(t);
  await savedPref(m, { session: "ses_a", title: "Test runner", text: "Run the unit tests with node --test.", topic: "testing" });
  m.advance(DAY);
  await proposePref(m, { session: "ses_b", title: "Test runner again", text: "Run the unit tests with npm test.", topic: "testing" });
  const job = await m.ok(["schedule", "plan", "--job", "review-monthly"]);
  await m.ok(["schedule", "apply", "--job", "review-monthly", "--plan-fingerprint", job.fingerprint]);
  const ran = await m.ok(["schedule", "run", "--job", "review-monthly"]);
  assert.equal(ran.suggestions, 1);
  assert.match(m.notes.at(-1).at(-2), /^Your monthly setup review has 1 suggestion\. Run devtwin review plan to see them\.$/);
});

test("apply with no per-line decisions refuses, and nothing changes without a decision for every line (R36)", async (t) => {
  const m = await machine(t);
  await savedPref(m, { session: "ses_a", title: "Test runner", text: "Run the unit tests with node --test.", topic: "testing" });
  await savedPref(m, { session: "ses_a", title: "Commit style", text: "Write commit subjects in the imperative mood.", topic: "commits" });
  m.advance(DAY);
  await proposePref(m, { session: "ses_b", title: "Test runner again", text: "Run the unit tests with npm test.", topic: "testing" });
  await proposePref(m, { session: "ses_b", title: "Commit style again", text: "Write commit subjects under fifty characters.", topic: "commits" });
  const plan = await m.plan();
  const lines = ofKind(plan, "preference-overridden");
  assert.equal(lines.length, 2);
  const before = await everyStore(m), dialogs = m.dialogs.length;
  assert.equal((await m.fail(["review", "apply"], "DEVTWIN_INVALID_INPUT")).details.field, "decision");
  assert.equal((await m.fail(["review", "apply", "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_INVALID_INPUT")).details.field, "decision");
  const missing = await m.fail(["review", "apply", "--accept", lines[0].id], "DEVTWIN_INVALID_INPUT");
  assert.deepEqual(missing.details.missing, [lines[1].id]);
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[0].id, "--reject", lines[1].id], "DEVTWIN_INVALID_INPUT");
  await m.fail(["review", "apply", "--accept", "sug_" + "0".repeat(24), "--accept", lines[0].id, "--reject", lines[1].id], "DEVTWIN_NOT_FOUND");
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[1].id, "--apply"], "DEVTWIN_PLAN_REQUIRED");
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[1].id, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_PLAN_MISMATCH");
  assert.deepEqual(await everyStore(m), before);
  assert.equal(m.dialogs.length, dialogs, "no owner dialog without a decision for every line");
  assert.equal((await readAudit(m.roots)).entries.filter((e) => e.route === "review apply").length, 0);
});

test("an accepted suggestion changes only its own target, and a rejected one stays hidden until its evidence changes", async (t) => {
  const m = await machine(t);
  const keep = await savedPref(m, { session: "ses_a", title: "Commit style", text: "Write commit subjects in the imperative mood.", topic: "commits" });
  const retire = await savedPref(m, { session: "ses_a", title: "Test runner", text: "Run the unit tests with node --test.", topic: "testing" });
  m.advance(DAY);
  await proposePref(m, { session: "ses_b", title: "Test runner again", text: "Run the unit tests with npm test.", topic: "testing" });
  await proposePref(m, { session: "ses_b", title: "Commit style again", text: "Write commit subjects under fifty characters.", topic: "commits" });
  const plan = await m.plan();
  const [commits, testing] = ofKind(plan, "preference-overridden").sort((a, b) => a.evidence.topic < b.evidence.topic ? -1 : 1);
  assert.equal(testing.target, retire.recordId);
  assert.equal(commits.target, keep.recordId);
  assert.equal(testing.change.command, "devtwin pref retire --id " + retire.recordId);
  // Evidence carries IDs, hashes and dates, never the preference text.
  assert.doesNotMatch(JSON.stringify(plan.suggestions), /node --test|imperative|fifty/);
  const dialogs = m.dialogs.length;
  const out = await m.review({ accept: [testing.id], reject: [commits.id] });
  assert.equal(m.dialogs.length, dialogs + 1);
  const dialog = m.dialogs.at(-1);
  assert.match(dialog.title, /1 accepted, 1 rejected/);
  assert.ok(dialog.body.includes(testing.id) && dialog.body.includes("devtwin pref retire --id " + retire.recordId));
  assert.deepEqual(out.accepted.map((a) => [a.id, a.route]), [[testing.id, "pref retire"]]);
  assert.deepEqual(out.rejected.map((r) => r.id), [commits.id]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual((await activePreferences(m.roots)).map((p) => p.id), [keep.recordId]);
  const audit = (await readAudit(m.roots)).entries.filter((e) => e.route === "review apply");
  assert.deepEqual(audit.map((e) => [e.kind, e.tier, e.target, e.itemIds[0], e.actor]).sort(), [["setup-review", "always-ask", "accept", testing.id, "human"], ["setup-review", "always-ask", "reject", commits.id, "human"]]);
  // The decided lines are gone from the plan; the activity digest does not count a decision as something learned.
  assert.deepEqual((await m.plan()).suggestions, []);
  assert.equal((await m.ok(["activity"])).learned.filter((e) => e.kind === "setup-review").length, 0);
  // New evidence (another correction on the same topic) brings the rejected line back.
  m.advance(DAY);
  await proposePref(m, { session: "ses_c", title: "Commit style once more", text: "Write commit subjects with a ticket number.", topic: "commits" });
  assert.deepEqual((await m.plan()).suggestions.map((s) => s.id), [commits.id]);
});

test("a changed project scan produces a sandbox-setting suggestion, and accepting it saves only that setting", async (t) => {
  const m = await machine(t);
  const step = ["setup", "plan", "--step", "sandbox", "--repo", m.repo];
  const preview = await m.ok(step);
  await m.ok(["setup", "apply", "--step", "sandbox", "--repo", m.repo, "--plan-fingerprint", preview.fingerprint]);
  assert.deepEqual(ofKind(await m.plan(), "sandbox-setting"), []);
  await writeFile(join(m.repo, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n");
  const plan = await m.plan();
  const lines = ofKind(plan, "sandbox-setting");
  assert.deepEqual(lines.map((l) => [l.evidence.recommendation, l.evidence.state, l.change.informational]).sort(), [["codex-sandbox", "changed", true], ["container", "new", false]]);
  const container = lines.find((l) => l.evidence.recommendation === "container"), codex = lines.find((l) => l.evidence.recommendation === "codex-sandbox");
  const before = (await readPersonalSnapshot(m.roots)).records.map((r) => [r.id, r.recordHash]);
  const out = await m.review({ accept: [container.id, codex.id] });
  assert.deepEqual(out.accepted.map((a) => [a.id, a.informational ?? false]).sort(), [[codex.id, true], [container.id, false]].sort());
  const after = (await readPersonalSnapshot(m.roots)).records;
  assert.deepEqual(after.filter((r) => before.some(([id]) => id === r.id)).map((r) => [r.id, r.recordHash]), before, "the saved settings are unchanged");
  assert.deepEqual(after.filter((r) => !before.some(([id]) => id === r.id)).map((r) => r.title), ["Sandbox: Container setup"]);
  assert.deepEqual(ofKind(await m.plan(), "sandbox-setting"), []);
});

test("a radar item with a try-it guide suggests a radar interest, and accepting adds only that interest", async (t) => {
  const m = await machine(t);
  const profile = await m.ok(["profile", "plan", "--interest", "agent evals"]);
  await m.ok(["profile", "apply", "--interest", "agent evals", "--plan-fingerprint", profile.fingerprint]);
  const dir = join(m.p.dataRoot, "scopes", SCOPE, "guides", "radar");
  ensurePrivatePath(m.p.dataRoot, ["scopes", SCOPE, "guides", "radar"]);
  await writeNewFile(join(dir, "guide-0123456789ab.md"), "# Try `Acme Agent Kit`\n\n- Kind: an agent tool or skill\n");
  await writeNewFile(join(dir, "guide-ba9876543210.md"), "# Try `agent evals`\n\n- Kind: an approach or design idea\n");
  const [line] = ofKind(await m.plan(), "radar-interest");
  assert.equal(line.target, "interest:acme agent kit");
  assert.equal(line.evidence.item, "0123456789ab");
  assert.equal(ofKind(await m.plan(), "radar-interest").length, 1, "an interest you already have is not suggested");
  await m.review({ accept: [line.id] });
  assert.deepEqual((await readProfile(m.roots)).profile.radar.interests, ["agent evals", "Acme Agent Kit"]);
  assert.deepEqual(ofKind(await m.plan(), "radar-interest"), []);
});

test("imported memory gives memory-delivered-twice, promoted-source-changed and promoted-source-removed lines, and only the removed one retracts", async (t) => {
  const m = await machine(t);
  await m.memoryFile("queue.md", memory({ name: "queue", type: "project", description: "Queue", body: "The staging queue drains every hour." }));
  await m.memoryFile("ports.md", memory({ name: "ports", type: "project", description: "Ports", body: "The API listens on port 8080 in development." }));
  const imported = await m.ok(["import", "run"]);
  assert.equal(imported.written.length, 2);
  let plan = await m.plan();
  const twice = ofKind(plan, "memory-delivered-twice");
  assert.deepEqual(twice.map((l) => basename(l.evidence.file)).sort(), ["ports.md", "queue.md"]);
  assert.ok(twice.every((l) => l.change.informational && l.evidence.file.startsWith(m.memoryDir)));
  assert.doesNotMatch(JSON.stringify(plan.suggestions), /staging queue|8080/);
  // The memory changes and another one is deleted; the import has not run again.
  await m.memoryFile("queue.md", memory({ name: "queue", type: "project", description: "Queue", body: "The staging queue drains every ten minutes." }));
  await rm(join(m.memoryDir, "memory", "ports.md"));
  plan = await m.plan();
  const [changed] = ofKind(plan, "promoted-source-changed"), [removed] = ofKind(plan, "promoted-source-removed");
  assert.equal(changed.evidence.source, "memory:" + PROJECT + "/queue.md");
  assert.equal(changed.change.informational, true);
  assert.equal(removed.evidence.source, "memory:" + PROJECT + "/ports.md");
  assert.match(removed.change.command, /^devtwin undo --id aud_[a-f0-9]{24}$/);
  const queueTwice = ofKind(plan, "memory-delivered-twice");
  assert.deepEqual(queueTwice.map((l) => basename(l.evidence.file)), ["queue.md"], "a deleted memory file is no longer read twice");
  const records = (await readSnapshot(m.roots, SCOPE, PROJECT)).records;
  const out = await m.review({ accept: [removed.id, queueTwice[0].id], reject: [changed.id] });
  assert.deepEqual(out.accepted.map((a) => a.route ?? "record").sort(), ["record", "undo"]);
  const after = (await readSnapshot(m.roots, SCOPE, PROJECT)).records;
  const byId = new Map(after.map((r) => [r.id, r]));
  assert.equal(byId.get(removed.target).effective, "superseded", "the removed source's record is retracted");
  assert.notEqual(byId.get(changed.target).effective, "superseded", "the changed source's record is left alone");
  assert.equal(after.length, records.length + 1, "one retraction and nothing else");
  assert.ok(m.dialogs.some((d) => /undo/i.test(d.title)), "undo showed its own owner dialog");
  assert.deepEqual((await m.plan()).suggestions, []);
});

test("a lesson no session got in 30 days is suggested, and accepting it runs undo on that lesson alone", async (t) => {
  const m = await machine(t);
  const learn = async (session, title, path) => {
    const proposal = await m.ok(["lesson", "propose", "--session", session, "--scope", SCOPE, "--project", PROJECT, "--title", title, "--summary", "Do check this first.", "--body", "It broke before.\n", "--path", path, "--apply"], { env: AGENT });
    return (await m.applied(["lesson", "accept", "--id", proposal.proposalId, "--target", "project", "--session", session], { env: AGENT })).project.recordId;
  };
  const seeds = await learn("ses_one", "Run migrations before seeds", "db/**");
  const docs = await learn("ses_two", "Build the docs before release", "docs/**");
  assert.deepEqual(ofKind(await m.plan(), "lesson-unused"), [], "a new lesson is not suggested");
  // The hook delivered the docs lesson last week; nothing delivered the seeds lesson.
  m.advance(31 * DAY);
  ensurePrivatePath(m.p.stateRoot, ["hooks"]);
  await writeFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), JSON.stringify({ at: new Date(now().getTime() + 25 * DAY).toISOString(), agent: "claude", session: "a".repeat(64), event: "PreToolUse", bytes: 10, lines: 1, overflow: 0, lessons: [docs] }) + "\n", { mode: 0o600 });
  const [line] = ofKind(await m.plan(), "lesson-unused");
  assert.equal(line.target, seeds);
  assert.equal(line.evidence.lastDelivered, null);
  assert.match(line.change.command, /^devtwin undo --id aud_/);
  await m.review({ accept: [line.id] });
  const byId = new Map((await readSnapshot(m.roots, SCOPE, PROJECT)).records.map((r) => [r.id, r]));
  assert.equal(byId.get(seeds).effective, "superseded");
  assert.notEqual(byId.get(docs).effective, "superseded");
});

test("a consent never used for 30 days is suggested, and accepting it revokes that consent through consent revoke", async (t) => {
  const m = await machine(t);
  await m.applied(["consent", "grant", "--kind", "repo-push", "--repo", m.repo]);
  assert.deepEqual(ofKind(await m.plan(), "consent-unused"), []);
  m.advance(31 * DAY);
  const [line] = ofKind(await m.plan(), "consent-unused");
  assert.equal(line.target, "repo-push:" + realpathSync(m.repo));
  const dialogs = m.dialogs.length;
  const out = await m.review({ accept: [line.id] });
  assert.deepEqual(out.accepted.map((a) => a.route), ["consent revoke"]);
  assert.equal(m.dialogs.length, dialogs + 2, "the review dialog, then consent revoke's own dialog");
  assert.deepEqual(await listConsents(m.roots), []);
});

test("a learning branch left local for more than 14 days is an informational line; accepting it records the decision only", async (t) => {
  const m = await machine(t);
  const learningId = "lrn_" + "c".repeat(24);
  await appendEntry(m.roots, { kind: "repo-learning", tier: "automatic", route: "lesson accept", target: "repo", scope: SCOPE, project: PROJECT, itemIds: [learningId, "cmt_" + "d".repeat(40)], actor: "claude", requestId: "req_branchfixture1" }, { now });
  m.advance(10 * DAY);
  assert.deepEqual(ofKind(await m.plan(), "learning-branch-stale"), []);
  m.advance(5 * DAY);
  const [line] = ofKind(await m.plan(), "learning-branch-stale");
  assert.equal(line.target, "devtwin/learning-" + "c".repeat(24));
  assert.equal(line.change.informational, true);
  const before = await everyStore(m);
  const out = await m.review({ accept: [line.id] });
  assert.deepEqual(out.accepted.map((a) => [a.id, a.informational]), [[line.id, true]]);
  assert.deepEqual(await everyStore(m), before);
  assert.deepEqual((await m.plan()).suggestions, []);
});

test("two declined proposals on one topic give a preference-declined line", async (t) => {
  const m = await machine(t);
  for (const [session, text] of [["ses_a", "Use tabs for indentation."], ["ses_b", "Indent with four spaces."]]) {
    const { proposalId } = await proposePref(m, { session, title: "Indentation", text, topic: "indentation" });
    await m.applied(["pref", "decline", "--id", proposalId]);
  }
  const [line] = (await m.plan()).suggestions;
  assert.deepEqual([line.kind, line.target, line.evidence.declined.length, line.change.informational], ["preference-declined", "topic:indentation", 2, true]);
});

test("review apply is always ask: the hook denies review apply --apply from an agent shell, and its previews stay open", () => {
  assert.equal(tierOf({ route: "review apply" }), "always-ask");
  assert.equal(tierOf({ route: "review plan" }), "read");
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  assert.equal(ownerAction("claude", bash("devtwin review apply --pilot p.json --accept sug_" + "a".repeat(24) + " --apply --plan-fingerprint sha256:x")), "review apply --apply");
  assert.equal(ownerAction("codex", { tool_name: "exec_command", tool_input: { command: ["sh", "-c", "devtwin review apply --accept x --ap''ply"] } }), "review apply --apply");
  assert.equal(ownerAction("claude", bash("devtwin review plan --pilot p.json")), null);
  assert.equal(ownerAction("claude", bash("devtwin review apply --pilot p.json --accept sug_" + "a".repeat(24))), null);
});
