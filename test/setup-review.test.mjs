import test from "node:test";
import assert from "node:assert/strict";
import { join, basename } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
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
import { applySetupReview } from "../src/review/commands.mjs";
import { digest } from "../src/storage/canonical.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";

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
  // The context main builds, for calls that need a test seam.
  const ctx = () => ({ roots, pilot, now: () => clock, home: p.fakeHome, env: {}, kitRoot: KIT, launchctl, ownerDialog: async (content) => { dialogs.push(content); return "approved"; } });
  const hook = async (event, session) => {
    const chunks = [];
    await main(["hook", "--event", event, "--agent", "claude", "--pilot", path], { now: () => clock, kitRoot: KIT, stdin: JSON.stringify({ session_id: session, cwd: repo, hook_event_name: "SessionStart" }), stdout: { write: (v) => { chunks.push(v); return true; } } });
    return chunks.join("");
  };
  return { p, path, roots, repo, home, memoryDir, cli, ok, fail, applied, plan, review, dialogs, notes, memoryFile, ctx, hook, now: () => clock, advance: (ms) => { clock = new Date(clock.getTime() + ms); return clock; } };
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
  // With no budget log yet, lesson use is not collected, and the plan says why.
  assert.deepEqual(plan.notCollected.map((n) => n.kind), ["skill-template-use", "lesson-unused"]);
  assert.match(plan.notCollected[1].reason, /budget log is empty/);
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

test("apply with no decision refuses, and a line without a decision stays open (R36)", async (t) => {
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
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[0].id, "--reject", lines[1].id], "DEVTWIN_INVALID_INPUT");
  await m.fail(["review", "apply", "--accept", "sug_" + "0".repeat(24), "--accept", lines[0].id, "--reject", lines[1].id], "DEVTWIN_NOT_FOUND");
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[1].id, "--apply"], "DEVTWIN_PLAN_REQUIRED");
  await m.fail(["review", "apply", "--accept", lines[0].id, "--reject", lines[1].id, "--apply", "--plan-fingerprint", plan.fingerprint], "DEVTWIN_PLAN_MISMATCH");
  assert.deepEqual(await everyStore(m), before);
  assert.equal(m.dialogs.length, dialogs, "no owner dialog without a decision");
  assert.equal((await readAudit(m.roots)).entries.filter((e) => e.route === "review apply").length, 0);
  // Deciding one line changes only that line; the other stays open with its preference untouched.
  const kept = (await activePreferences(m.roots)).map((p) => p.id).filter((id) => id !== lines[0].target);
  const out = await m.review({ accept: [lines[0].id] });
  assert.equal(out.open, 1);
  assert.deepEqual(out.accepted.map((a) => a.id), [lines[0].id]);
  assert.deepEqual((await activePreferences(m.roots)).map((p) => p.id), kept);
  assert.deepEqual((await m.plan()).suggestions.map((s) => s.id), [lines[1].id]);
  assert.equal((await readAudit(m.roots)).entries.filter((e) => e.route === "review apply").length, 1);
});

test("rejecting every line of a review larger than one dialog needs no dialog, and too many accepted lines refuse", async (t) => {
  const m = await machine(t);
  for (let i = 0; i < 12; i++) await m.memoryFile("note-" + String(i).padStart(2, "0") + ".md", memory({ name: "note" + i, type: "project", description: "Note " + i, body: "Fixture note number " + i + "." }));
  assert.equal((await m.ok(["import", "run"])).written.length, 12);
  const plan = await m.plan(), lines = ofKind(plan, "memory-delivered-twice"), ids = lines.map((l) => l.id);
  assert.equal(lines.length, 12);
  const dialogs = m.dialogs.length;
  // Accepting all twelve does not fit one dialog: accept fewer at once.
  assert.match((await m.fail(["review", "apply", ...ids.flatMap((id) => ["--accept", id]), "--apply", "--plan-fingerprint", (await m.ok(["review", "apply", ...ids.flatMap((id) => ["--accept", id])])).fingerprint], "DEVTWIN_LIMIT")).message, /accept fewer/);
  assert.equal(m.dialogs.length, dialogs);
  // Two accepted lines fit; the dialog lists them in full and counts the rejected ones.
  const out = await m.review({ accept: ids.slice(0, 2), reject: ids.slice(2, 8) });
  assert.equal(m.dialogs.length, dialogs + 1);
  const dialog = m.dialogs.at(-1);
  assert.match(dialog.title, /2 accepted, 6 rejected/);
  assert.ok(dialog.body.includes(ids[0]) && dialog.body.includes(ids[1]));
  assert.ok(dialog.body.includes("And 6 lines rejected"));
  assert.ok(!dialog.body.includes(ids[2]), "a rejected line is counted, not listed");
  assert.deepEqual([out.accepted.length, out.rejected.length, out.open], [2, 6, 4]);
  // Rejecting the rest shows no dialog and leaves nothing open.
  const preview = await m.ok(["review", "apply", ...ids.slice(8).flatMap((id) => ["--reject", id])]);
  assert.equal(preview.dialog, false);
  const rejected = await m.review({ reject: ids.slice(8) });
  assert.equal(rejected.rejected.length, 4);
  assert.equal(m.dialogs.length, dialogs + 1, "an all-reject apply shows no dialog");
  assert.deepEqual((await m.plan()).suggestions, []);
});

test("each decision is saved when its change completes, so an error in a later change loses none", async (t) => {
  const m = await machine(t);
  await savedPref(m, { session: "ses_a", title: "Test runner", text: "Run the unit tests with node --test.", topic: "testing" });
  await savedPref(m, { session: "ses_a", title: "Commit style", text: "Write commit subjects in the imperative mood.", topic: "commits" });
  m.advance(DAY);
  await proposePref(m, { session: "ses_b", title: "Test runner again", text: "Run the unit tests with npm test.", topic: "testing" });
  await proposePref(m, { session: "ses_b", title: "Commit style again", text: "Write commit subjects under fifty characters.", topic: "commits" });
  const [first, second] = ofKind(await m.plan(), "preference-overridden");
  const input = { accept: [first.id, second.id], reject: [] };
  const preview = await m.ok(["review", "apply", "--accept", first.id, "--accept", second.id]);
  let calls = 0;
  const faults = { beforeChange: () => { if (++calls === 2) throw new Error("injected failure"); } };
  await assert.rejects(applySetupReview(m.roots, input, { fingerprint: preview.fingerprint, ctx: m.ctx(), faults }), /injected failure/);
  const saved = JSON.parse(await readFile(join(m.p.stateRoot, "setup-review", "decisions.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.decisions), [first.id]);
  assert.deepEqual((await m.plan()).suggestions.map((s) => s.id), [second.id], "the failed line comes back");
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

test("radar-interest lines stay within the 30-interest cap, and a full profile fails that line alone at apply", async (t) => {
  const m = await machine(t);
  const fill = (n) => Array.from({ length: n }, (_, i) => "topic " + String(i).padStart(2, "0"));
  const setInterests = async (list) => { const flags = list.flatMap((i) => ["--interest", i]); const plan = await m.ok(["profile", "plan", ...flags]); await m.ok(["profile", "apply", ...flags, "--plan-fingerprint", plan.fingerprint]); };
  await setInterests(fill(29));
  const dir = join(m.p.dataRoot, "scopes", SCOPE, "guides", "radar");
  ensurePrivatePath(m.p.dataRoot, ["scopes", SCOPE, "guides", "radar"]);
  for (const [item, name] of [["0123456789ab", "Acme Agent Kit"], ["0123456789ac", "Bravo Evals"], ["0123456789ad", "Charlie Tracing"]]) await writeNewFile(join(dir, "guide-" + item + ".md"), "# Try `" + name + "`\n\n- Kind: an agent tool or skill\n");
  assert.equal(ofKind(await m.plan(), "radar-interest").length, 1, "room for one more interest, so one line");
  // With room for two, both accepted lines run; when the profile fills up between them, the second fails on its own.
  await setInterests(fill(28));
  const lines = ofKind(await m.plan(), "radar-interest");
  assert.equal(lines.length, 2);
  const input = { accept: lines.map((l) => l.id), reject: [] };
  const preview = await m.ok(["review", "apply", ...lines.flatMap((l) => ["--accept", l.id])]);
  let calls = 0;
  const faults = { beforeChange: async () => { if (++calls === 2) await setInterests([...(await readProfile(m.roots)).profile.radar.interests, "topic extra"]); } };
  const out = await applySetupReview(m.roots, input, { fingerprint: preview.fingerprint, ctx: m.ctx(), faults });
  assert.deepEqual(out.accepted.map((a) => a.id), [lines[0].id]);
  assert.deepEqual(out.failed.map((f) => [f.id, f.code]), [[lines[1].id, "DEVTWIN_LIMIT"]]);
  assert.equal((await readProfile(m.roots)).profile.radar.interests.length, 30);
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

const budgetRow = (at, extra) => JSON.stringify({ at: at.toISOString(), agent: "claude", session: "a".repeat(64), event: "PreToolUse", bytes: 10, lines: 1, overflow: 0, ...extra }) + "\n";
async function learnAs(m, session, title, match, summary = "Do check this first.") {
  const proposal = await m.ok(["lesson", "propose", "--session", session, "--scope", SCOPE, "--project", PROJECT, "--title", title, "--summary", summary, "--body", "It broke before.\n", ...match, "--apply"], { env: AGENT });
  return (await m.applied(["lesson", "accept", "--id", proposal.proposalId, "--target", "project", "--session", session], { env: AGENT })).project.recordId;
}
test("an imported memory file the import now skips is reported as skipped, not removed", { skip: process.getuid?.() === 0 && "root reads any file" }, async (t) => {
  const m = await machine(t);
  await m.memoryFile("queue.md", memory({ name: "queue", type: "project", description: "Queue", body: "The staging queue drains every hour." }));
  await m.memoryFile("ports.md", memory({ name: "ports", type: "project", description: "Ports", body: "The API listens on port 8080 in development." }));
  assert.equal((await m.ok(["import", "run"])).written.length, 2);
  const locked = join(m.memoryDir, "memory", "ports.md");
  await chmod(locked, 0o000);
  t.after(() => chmod(locked, 0o600).catch(() => {}));
  const plan = await m.plan();
  assert.deepEqual(ofKind(plan, "promoted-source-removed"), []);
  const [skipped] = ofKind(plan, "promoted-source-skipped");
  assert.equal(skipped.evidence.source, "memory:" + PROJECT + "/ports.md");
  assert.equal(skipped.evidence.reason, "unreadable");
  assert.equal(skipped.change.informational, true);
  // Once the file is truly gone, the line is promoted-source-removed with the undo change.
  await rm(locked);
  const [removed] = ofKind(await m.plan(), "promoted-source-removed");
  assert.equal(removed.evidence.source, "memory:" + PROJECT + "/ports.md");
  assert.match(removed.change.command, /^devtwin undo --id aud_/);
});

test("a lesson no session got in 30 days is suggested, and accepting it runs undo on that lesson alone", async (t) => {
  const m = await machine(t);
  const learn = (session, title, path) => learnAs(m, session, title, ["--path", path]);
  const seeds = await learn("ses_one", "Run migrations before seeds", "db/**");
  const docs = await learn("ses_two", "Build the docs before release", "docs/**");
  assert.deepEqual(ofKind(await m.plan(), "lesson-unused"), [], "a new lesson is not suggested");
  // The hook delivered the docs lesson last week; nothing delivered the seeds lesson.
  m.advance(31 * DAY);
  ensurePrivatePath(m.p.stateRoot, ["hooks"]);
  // The log reaches back 31 days, so a missing delivery counts.
  await writeFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), [budgetRow(now(), {}), budgetRow(new Date(now().getTime() + 25 * DAY), { lessons: [docs] })].join(""), { mode: 0o600 });
  const [line] = ofKind(await m.plan(), "lesson-unused");
  assert.equal(line.target, seeds);
  assert.equal(line.evidence.lastDelivered, null);
  assert.match(line.change.command, /^devtwin undo --id aud_/);
  await m.review({ accept: [line.id] });
  const byId = new Map((await readSnapshot(m.roots, SCOPE, PROJECT)).records.map((r) => [r.id, r]));
  assert.equal(byId.get(seeds).effective, "superseded");
  assert.notEqual(byId.get(docs).effective, "superseded");
});

test("the lesson-unused collector waits for a budget log that reaches back 30 days", async (t) => {
  const m = await machine(t);
  await learnAs(m, "ses_one", "Run migrations before seeds", ["--path", "db/**"]);
  m.advance(31 * DAY);
  // No budget log: not collected.
  let plan = await m.plan();
  assert.deepEqual(ofKind(plan, "lesson-unused"), []);
  assert.ok(plan.notCollected.some((n) => n.kind === "lesson-unused" && /empty/.test(n.reason)));
  // A log whose oldest line is 20 days old: still not collected.
  ensurePrivatePath(m.p.stateRoot, ["hooks"]);
  await writeFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), budgetRow(new Date(m.now().getTime() - 20 * DAY), {}), { mode: 0o600 });
  plan = await m.plan();
  assert.deepEqual(ofKind(plan, "lesson-unused"), []);
  assert.ok(plan.notCollected.some((n) => n.kind === "lesson-unused" && /less than 30 days/.test(n.reason)));
  // A log whose oldest line is 30 days old: collected.
  await writeFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), budgetRow(new Date(m.now().getTime() - 30 * DAY), {}), { mode: 0o600 });
  plan = await m.plan();
  assert.equal(ofKind(plan, "lesson-unused").length, 1);
  assert.ok(!plan.notCollected.some((n) => n.kind === "lesson-unused"));
});

test("an ask-before lesson that only the session summary delivered is not suggested as unused", async (t) => {
  const m = await machine(t);
  const push = await learnAs(m, "ses_one", "Ask before pushing", ["--command", "git push"], "Confirm with the owner first.");
  const seeds = await learnAs(m, "ses_two", "Run migrations before seeds", ["--path", "db/**"]);
  ensurePrivatePath(m.p.stateRoot, ["hooks"]);
  await writeFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), budgetRow(now(), {}), { mode: 0o600 });
  m.advance(31 * DAY);
  // A session starts: the summary shows the ask-before line, and the budget log lists its lesson ID (no text).
  await writeKitReceipt(m.roots, { pilotPath: m.path, kitRoot: KIT, now: m.now() });
  assert.match(await m.hook("session-start", "session-ask"), /ask before: Ask before pushing/);
  const last = JSON.parse((await readFile(join(m.p.stateRoot, "hooks", "budget.jsonl"), "utf8")).trim().split("\n").at(-1));
  assert.deepEqual(last.summaryLessons, [push]);
  assert.equal(last.lessons, undefined);
  assert.deepEqual(ofKind(await m.plan(), "lesson-unused").map((l) => l.target), [seeds]);
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
  // The reason is shown but not hashed: a new reason alone does not bring a decided line back.
  const { reason, ...hashed } = line.evidence;
  assert.equal(reason, "needs-consent");
  assert.equal(line.evidenceHash, digest(hashed));
  const before = await everyStore(m);
  const out = await m.review({ accept: [line.id] });
  assert.deepEqual(out.accepted.map((a) => [a.id, a.informational]), [[line.id, true]]);
  assert.deepEqual(await everyStore(m), before);
  assert.deepEqual((await m.plan()).suggestions, []);
  // undo --since skips the setup-review decision silently: it records a decision, not a write.
  const undo = await m.ok(["undo", "--since", now().toISOString()]);
  const decisions = (await readAudit(m.roots)).entries.filter((e) => e.kind === "setup-review").map((e) => e.id);
  assert.equal(decisions.length, 1);
  assert.ok(![...undo.entries, ...undo.skipped].some((e) => decisions.includes(e.id)), JSON.stringify(undo.skipped));
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
