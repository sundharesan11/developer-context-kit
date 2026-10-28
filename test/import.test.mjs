import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, writeFile, symlink, stat } from "node:fs/promises";
import { main } from "../src/cli.mjs";
import { makePilot, makeRepo, fixtureGit, treeSnapshot, sandbox, now } from "./helpers.mjs";
import { applyInit, applyScopeAdd } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { readSnapshot } from "../src/records/store.mjs";
import { readAudit } from "../src/audit/log.mjs";
import { claudeFolderName, parseFrontMatter, proveFolder, MEMORY_LIMITS } from "../src/import/memory.mjs";
import { habitCommands, placesIn } from "../src/import/map.mjs";
import { runImport, seenPath, newJobRunId } from "../src/import/commands.mjs";

const SCOPE = "example", OTHER = "sample";
const SESSION = "9060c0de-0000-4000-8000-000000000001";
const SOLUTION = "---\ntitle: Seed after migrations\n---\n\n# Seed after migrations\n\nRun migrations before seeds on a fresh database.\n";
// A memory file shaped like the ones Claude Code 2.1.311 writes: front matter with a nested metadata block.
const memory = ({ name, type, description, body, modified = "2026-10-25T13:04:13.524Z" }) =>
  "---\nname: " + name + "\ndescription: \"" + description + "\"\nmetadata:\n  node_type: memory\n  type: " + type + "\n  originSessionId: " + SESSION + "\n  modified: " + modified + "\n---\n\n" + body + "\n";
// Transcript lines: a summary line with no cwd, and user and assistant lines that record where the session ran.
const transcript = (cwds) => [JSON.stringify({ type: "summary", summary: "Fixture session", leafUuid: "leaf-1" }),
  ...cwds.map((cwd, i) => JSON.stringify({ type: i % 2 ? "assistant" : "user", cwd, sessionId: SESSION, gitBranch: "main", version: "2.1.311", message: { role: "user", content: "fixture" } }))].join("\n") + "\n";

// One machine: a pilot whose launch agent class allows the import job, with scopes example and sample, and bound
// repositories (each with a remote default branch, so docs/solutions has a learnings base). claude is the fixture
// Claude Code folder, inside the pilot's first agent home.
async function machine(t, { repos = [["atlas", "example.atlas"]], solutions = { "docs/solutions/seed-order.md": SOLUTION } } = {}) {
  const p = await makePilot(t);
  const agents = join(p.agentHomes[0], "Library", "LaunchAgents");
  await mkdir(agents, { recursive: true });
  const path = await p.with({ repos: repos.map(([dir]) => join(p.reposDir, dir)), writeClasses: { launchAgents: [join(agents, "devtwin.import-daily.plist")] } });
  const pilot = await loadPilot(path, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
  const roots = rootsFromPilot(pilot);
  await applyInit(roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  for (const scope of [SCOPE, OTHER]) await applyScopeAdd(roots, { scope, hubs: [], policies: [], now });
  const bound = [];
  for (const [i, [dir, project]] of repos.entries()) {
    const repo = await makeRepo(join(p.reposDir, dir), { "README.md": "# Atlas\n", ...solutions });
    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await fixtureGit(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const input = { scope: SCOPE, project, repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_import" + String(i).padStart(4, "0") };
    await applyOnboard(roots, pilot, input, { fingerprint: (await planOnboard(roots, pilot, input)).fingerprint, now });
    bound.push({ repo, project });
  }
  const claude = join(p.agentHomes[0], ".claude");
  await mkdir(join(claude, "projects"), { recursive: true });
  const dialogs = [];
  let clock = now();
  const cli = async (args, { env = {} } = {}) => {
    const chunks = [];
    await main([...args, "--pilot", path], { now: () => clock, home: p.fakeHome, env, launchctl: fakeLaunchctl(), ownerDialog: async (content) => { dialogs.push(content); return "approved"; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.ok, true, args.join(" ") + ": " + JSON.stringify(out.error)); return out.result; };
  // The Claude Code folder of a root, with transcripts and memory files.
  const folder = async (root, { cwds = [root, join(root, "src")], files = {} } = {}) => {
    const dir = join(claude, "projects", claudeFolderName(root));
    await mkdir(join(dir, "memory"), { recursive: true });
    await writeFile(join(dir, SESSION + ".jsonl"), transcript(cwds));
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, "memory", name), text);
    return dir;
  };
  const records = async (project = bound[0].project) => (await readSnapshot(roots, SCOPE, project)).records;
  // Every source: the Claude folder and each repository, hashed with modes, sizes, times and bytes. Every run checks
  // that the sources are byte-identical before and after it.
  const sources = async () => [await treeSnapshot(claude), ...await Promise.all(bound.map((b) => treeSnapshot(b.repo)))].join(",");
  const unchanged = async (action) => { const before = await sources(); const result = await action(); assert.equal(await sources(), before, "sources are byte-identical"); return result; };
  const run = () => unchanged(() => ok(["import", "run"]));
  return { p, pilot, roots, path, repo: bound[0].repo, project: bound[0].project, bound, claude, cli, ok, run, unchanged, folder, records, sources, dialogs,
    tick: (ms) => { clock = new Date(clock.getTime() + ms); return clock; } };
}
function fakeLaunchctl() {
  const loaded = new Set();
  return (args) => {
    if (args[0] === "bootstrap") { loaded.add(args[2].split("/").pop().replace(/\.plist$/, "")); return { status: 0 }; }
    if (args[0] === "bootout") return { status: loaded.delete(args[1].split("/").pop()) ? 0 : 3 };
    if (args[0] === "print") return { status: loaded.has(args[1].split("/").pop()) ? 0 : 113 };
    return { status: 1 };
  };
}
const PUSHING = memory({ name: "ask-before-pushing", type: "feedback", description: "Always ask before pushing", body: "Ask the developer before any git push.\n\n**Why:** a push starts the deploy pipeline." });
const ENV_FILE = memory({ name: "local-secrets", type: "reference", description: "Local service settings", body: "The service settings live in `.env` at the repo root." });
const FRIDAYS = memory({ name: "no-friday-migrations", type: "project", description: "No migrations on Fridays", body: "Never run database migrations on a Friday." });
const QUEUE = memory({ name: "staging-queue", type: "project", description: "Staging queue cadence", body: "The staging queue drains every hour." });
const TERSE = memory({ name: "terse-answers", type: "user", description: "Short answers", body: "Prefer short answers with the command first." });

test("import parses Claude memory front matter and maps habit words and places", () => {
  const { front, body } = parseFrontMatter(PUSHING);
  assert.deepEqual([front.name, front.description, front.metadata.type, front.metadata.modified], ["ask-before-pushing", "Always ask before pushing", "feedback", "2026-10-25T13:04:13.524Z"]);
  assert.match(body, /^\nAsk the developer/);
  assert.equal(claudeFolderName("/srv/dev/my.repo_v2"), "-srv-dev-my-repo-v2");
  assert.deepEqual(habitCommands("Always ask before pushing"), ["git push"]);
  assert.deepEqual(habitCommands("Confirm before you print env or merge"), ["gh pr merge", "printenv"]);
  assert.deepEqual(habitCommands("Keep commits small"), []);
  assert.deepEqual(placesIn("Settings live in `.env`, logs in ~/Library/Logs/app/ and docs at https://docs.example.com/x and/or config/app.yaml").map((x) => [x.where, x.kind]),
    [[".env", "file"], ["~/Library/Logs/app/", "directory"], ["docs.example.com", "host"], ["config/app.yaml", "file"]]);
  assert.deepEqual(placesIn("Paths like /etc/hosts and ../up are never places."), []);
});

test("import turns a feedback memory into an observed project lesson with git push and leaves every source untouched (AE1)", async (t) => {
  const m = await machine(t);
  await m.folder(m.repo, { files: { "ask-before-pushing.md": PUSHING, "local-secrets.md": ENV_FILE, "no-friday-migrations.md": FRIDAYS, "staging-queue.md": QUEUE, "terse-answers.md": TERSE } });
  await mkdir(join(m.claude, "projects", "-elsewhere-repo"));
  const before = await m.sources();
  const result = await m.run();
  assert.equal(await m.sources(), before, "memory, transcripts and the repository are byte-identical");
  assert.deepEqual([result.unmapped, result.notOnboarded], [1, 0]);
  assert.deepEqual(result.projects.map((p) => [p.project, p.memory, p.solutions]), [[m.project, "read", "read"]]);
  assert.equal(result.runId, "run_cli00001", "a CLI run writes as its caller, not as the job");
  const byKind = Object.fromEntries(result.written.map((w) => [w.source, w.kind]));
  assert.deepEqual(byKind, { ["memory:" + m.project + "/ask-before-pushing.md"]: "lesson", ["memory:" + m.project + "/local-secrets.md"]: "environment", ["memory:" + m.project + "/no-friday-migrations.md"]: "constraint", ["memory:" + m.project + "/staging-queue.md"]: "fact", ["solutions:" + m.project + "/docs/solutions/seed-order.md"]: "lesson" });
  const records = await m.records();
  const lesson = records.find((r) => r.title === "Always ask before pushing");
  assert.deepEqual([lesson.kind, lesson.status, lesson.reach, lesson.match.commands, lesson.recordedBy.actor, lesson.recordedBy.runId], ["lesson", "observed", "project", ["git push"], "human", result.runId]);
  const env = records.find((r) => r.kind === "environment");
  assert.deepEqual(env.locations, [{ name: "Local service settings", kind: "file", where: ".env" }]);
  const solution = records.find((r) => r.title === "Seed after migrations");
  assert.deepEqual(solution.sources.map((s) => s.ref.split(":")[0]), ["file", "commit"]);
  // A user memory waits as a preference candidate with its source; it is never accepted.
  assert.deepEqual(result.preferences.map((p) => [p.source, p.created, p.state]), [["memory:" + m.project + "/terse-answers.md", true, "pending"]]);
  const prefs = await m.ok(["pref", "proposals"]);
  assert.deepEqual(prefs.proposals.map((p) => [p.source, p.state, p.text]), [["memory", "pending", "Prefer short answers with the command first."]]);
  assert.equal((await m.ok(["pref", "list"])).preferences.length, 0);
  // Each record write has an automatic audit entry by the caller, with its source hash.
  const entries = (await readAudit(m.roots)).entries;
  assert.equal(entries.length, 5);
  for (const e of entries) assert.deepEqual([e.route, e.tier, e.actor, e.session, e.kind], ["import run", "automatic", "human", null, "record"]);
  assert.ok(entries.every((e) => /^sha256:[a-f0-9]{64}$/.test(e.sourceHash)));
  // The lesson is delivered at the command it is about, and the session summary asks before the push.
  const matched = await m.ok(["lesson", "match", "--scope", SCOPE, "--cwd", m.repo, "--command", "git push origin main"]);
  assert.deepEqual(matched.matches.map((x) => x.id), [lesson.id]);
  const seen = await stat(seenPath(m.roots));
  assert.equal(seen.mode & 0o777, 0o600);
});

test("import adds nothing for an unchanged or modified-only memory and supersedes on a body edit (AE1)", async (t) => {
  const m = await machine(t, { solutions: {} });
  const dir = await m.folder(m.repo, { files: { "ask-before-pushing.md": PUSHING } });
  const first = await m.run();
  assert.equal(first.written.length, 1);
  assert.equal(first.projects[0].solutions, "read");
  const again = await m.run();
  assert.deepEqual([again.written.length, again.unchanged], [0, 1]);
  await writeFile(join(dir, "memory", "ask-before-pushing.md"), PUSHING.replace("2026-10-25T13:04:13.524Z", "2026-10-26T09:00:00.000Z").replace(SESSION, "9060c0de-0000-4000-8000-000000000002"));
  const touched = await m.run();
  assert.deepEqual([touched.written.length, touched.unchanged], [0, 1], "modified and originSessionId are not part of the hash");
  await writeFile(join(dir, "memory", "ask-before-pushing.md"), PUSHING.replace("before any git push", "before any git push or force push"));
  const edited = await m.run();
  assert.equal(edited.written.length, 1);
  assert.deepEqual(edited.written[0].supersedes, [first.written[0].recordId]);
  const records = await m.records();
  assert.equal(records.find((r) => r.id === first.written[0].recordId).effective, "superseded");
  assert.match(records.find((r) => r.id === edited.written[0].recordId).body, /force push/);
  // The owner confirms the record; a later body edit no longer changes it and is reported.
  const head = records.find((r) => r.id === edited.written[0].recordId);
  await m.ok(["record", "supersede", "--scope", SCOPE, "--project", m.project, "--kind", "lesson", "--status", "confirmed", "--reviewer", "email:owner@example.com", "--title", head.title, "--body", head.body, "--target", head.id, "--expect-hash", head.recordHash, "--request-id", "req_confirm0001", "--apply"]);
  await writeFile(join(dir, "memory", "ask-before-pushing.md"), PUSHING.replace("before any git push", "before every git push"));
  const owned = await m.run();
  assert.deepEqual([owned.written.length, owned.skipped.map((s) => s.reason)], [0, ["owner-reviewed"]]);
});

test("an agent sharpens an imported lesson by superseding it, and a later memory edit keeps its match terms", async (t) => {
  const m = await machine(t, { solutions: {} });
  const dir = await m.folder(m.repo, { files: { "ask-before-pushing.md": PUSHING } });
  const [first] = (await m.run()).written;
  const shown = await m.ok(["lesson", "show", "--scope", SCOPE, "--id", first.recordId]);
  const sharpened = await m.ok(["record", "supersede", "--scope", SCOPE, "--project", m.project, "--session", "ses_agent", "--kind", "lesson", "--title", "Ask before git push to main", "--body", "Ask the developer before any git push.\n", "--command", "git push", "--path", "deploy/**", "--target", first.recordId, "--expect-hash", shown.recordHash, "--request-id", "req_sharpen001", "--apply"], { env: { CLAUDECODE: "1" } });
  assert.match(sharpened.audit, /^aud_/);
  assert.deepEqual(m.dialogs, [], "sharpening an observed lesson is automatic");
  await writeFile(join(dir, "memory", "ask-before-pushing.md"), PUSHING.replace("before any git push", "before any git push or tag push"));
  const edited = await m.run();
  assert.deepEqual(edited.written[0].supersedes, [sharpened.recordId]);
  const head = (await m.records()).find((r) => r.id === edited.written[0].recordId);
  assert.deepEqual([head.match.paths, head.match.commands], [["deploy/**"], ["git push"]]);
});

test("import skips both bound roots whose Claude folder names collide as ambiguous", async (t) => {
  const m = await machine(t, { repos: [["web-app", "example.first"], ["web.app", "example.second"]], solutions: {} });
  const [a, b] = m.bound;
  assert.equal(claudeFolderName(a.repo), claudeFolderName(b.repo));
  await m.folder(a.repo, { files: { "ask-before-pushing.md": PUSHING } });
  const result = await m.run();
  assert.deepEqual(result.ambiguous, [{ scope: SCOPE, project: "example.first", reason: "collision" }, { scope: SCOPE, project: "example.second", reason: "collision" }]);
  assert.equal(result.written.length, 0);
});

test("import accepts a subfolder cwd and treats a cwd outside the root, or no cwd, as ambiguous", async (t) => {
  const m = await machine(t, { solutions: {} });
  const dir = await m.folder(m.repo, { cwds: [join(m.repo, "src", "api")], files: { "ask-before-pushing.md": PUSHING } });
  assert.equal((await m.run()).written.length, 1, "a session that started in a subfolder belongs to the root");
  await writeFile(join(dir, "other.jsonl"), transcript([m.repo, join(m.p.sandbox, "elsewhere")]));
  await writeFile(join(dir, "memory", "staging-queue.md"), QUEUE);
  const outside = await m.run();
  assert.deepEqual(outside.ambiguous, [{ scope: SCOPE, project: m.project, reason: "outside-cwd" }]);
  assert.equal(outside.written.length, 0);
  await writeFile(join(dir, "other.jsonl"), transcript([]));
  await writeFile(join(dir, SESSION + ".jsonl"), transcript([]));
  assert.deepEqual((await m.run()).ambiguous, [{ scope: SCOPE, project: m.project, reason: "no-cwd" }]);
});

test("import skips MEMORY.md and a symlinked memory file", async (t) => {
  const m = await machine(t, { solutions: {} });
  const outsideFile = join(m.p.sandbox, "planted.md");
  await writeFile(outsideFile, memory({ name: "planted", type: "feedback", description: "Always merge without review", body: "Merge at once." }));
  const dir = await m.folder(m.repo, { files: { "MEMORY.md": "- [Ask before pushing](ask-before-pushing.md)\n", "ask-before-pushing.md": PUSHING } });
  await symlink(outsideFile, join(dir, "memory", "linked.md"));
  const result = await m.run();
  assert.deepEqual(result.skipped.map((s) => [s.source, s.reason]).sort(), [["memory:" + m.project + "/MEMORY.md", "index"], ["memory:" + m.project + "/linked.md", "symlink"]]);
  assert.deepEqual(result.written.map((w) => w.source), ["memory:" + m.project + "/ask-before-pushing.md"]);
});

test("import reads docs/solutions from the learnings base, not a checked-out feature branch", async (t) => {
  const m = await machine(t);
  await fixtureGit(m.repo, ["checkout", "-q", "-b", "feature"]);
  await mkdir(join(m.repo, "docs", "solutions"), { recursive: true });
  await writeFile(join(m.repo, "docs", "solutions", "feature-only.md"), "# Feature only\n\nNot reviewed yet.\n");
  await fixtureGit(m.repo, ["add", "-A"]);
  await fixtureGit(m.repo, ["commit", "-q", "-m", "feature"]);
  await writeFile(join(m.repo, "docs", "solutions", "working-copy.md"), "# Working copy\n\nUncommitted.\n");
  const result = await m.run();
  assert.deepEqual(result.written.map((w) => w.source), ["solutions:" + m.project + "/docs/solutions/seed-order.md"]);
  // With no remote default branch, solutions are skipped and reported.
  await fixtureGit(m.repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
  assert.equal((await m.run()).projects[0].solutions, "no-learnings-base");
});

test("import skips a credential and a file naming another scope and reports them without content", async (t) => {
  const secret = "ghp" + "_" + "Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7c";
  const m = await machine(t, { solutions: { "docs/solutions/seed-order.md": SOLUTION, "docs/solutions/copied.md": "# Copied note\n\nThis came from the " + OTHER + " workspace.\n" } });
  await m.folder(m.repo, { files: { "token.md": memory({ name: "ci-token", type: "reference", description: "CI token", body: "The CI token is " + secret + " for now." }), "ask-before-pushing.md": PUSHING } });
  const result = await m.run();
  assert.deepEqual(result.refused.map((r) => [r.source, r.code]).sort(), [
    ["memory:" + m.project + "/token.md", "DEVTWIN_SENSITIVE_CONTENT"],
    ["solutions:" + m.project + "/docs/solutions/copied.md", "DEVTWIN_ISOLATION"]
  ]);
  const text = JSON.stringify(result);
  assert.ok(!text.includes(secret) && !text.includes("ghp") && !text.includes("workspace"), "the report names sources, never content");
  assert.deepEqual(result.written.map((w) => w.source).sort(), ["memory:" + m.project + "/ask-before-pushing.md", "solutions:" + m.project + "/docs/solutions/seed-order.md"]);
  assert.equal((await readAudit(m.roots)).entries.length, 2, "a refused write leaves no audit entry");
  // A refused source is reported once, and again only when its text changes.
  assert.deepEqual((await m.run()).refused, []);
});

test("undo --since after an import retracts everything the run wrote", async (t) => {
  const m = await machine(t);
  await m.folder(m.repo, { files: { "ask-before-pushing.md": PUSHING, "local-secrets.md": ENV_FILE, "no-friday-migrations.md": FRIDAYS } });
  m.tick(60000);
  const result = await m.run();
  assert.equal(result.written.length, 4);
  const plan = await m.ok(["undo", "--since", "2026-10-06T23:59:00Z"]);
  assert.equal(plan.entries.length, 4);
  const done = await m.ok(["undo", "--since", "2026-10-06T23:59:00Z", "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(done.undone.length, 4);
  assert.equal(m.dialogs.length, 1, "undo asks the owner");
  const records = await m.records();
  for (const w of result.written) assert.equal(records.find((r) => r.id === w.recordId).effective, "superseded", w.source);
  assert.equal(records.filter((r) => r.kind === "retraction").length, 4);
  // The next run leaves the undo alone: nothing changed, so nothing comes back.
  assert.equal((await m.run()).written.length, 0);
});

test("the import-daily job runs once a day with the owner's consent and makes no model call", async (t) => {
  const m = await machine(t, { solutions: {} });
  await m.folder(m.repo, { files: { "ask-before-pushing.md": PUSHING } });
  assert.deepEqual(await m.ok(["schedule", "run", "--job", "import-daily"]), { job: "import-daily", skipped: "job-disabled" });
  const plan = await m.ok(["schedule", "plan", "--job", "import-daily"]);
  await m.ok(["schedule", "apply", "--job", "import-daily", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(m.dialogs.length, 1);
  const ran = await m.unchanged(() => m.ok(["schedule", "run", "--job", "import-daily"]));
  assert.deepEqual([ran.written, ran.unchanged, ran.ambiguous], [1, 0, 0]);
  assert.equal((await m.ok(["schedule", "run", "--job", "import-daily"])).skipped, "ran-recently");
  m.tick(86400000);
  const next = await m.ok(["schedule", "run", "--job", "import-daily"]);
  assert.deepEqual([next.written, next.unchanged], [0, 1]);
});

test("import job writes are not held by the agent session caps, and a run writes at most 100 items", async (t) => {
  const m = await machine(t, { solutions: {} });
  const files = {};
  for (let i = 0; i < 105; i++) files["fact-" + String(i).padStart(3, "0") + ".md"] = memory({ name: "fact-" + i, type: "project", description: "Fact number " + i, body: "The worker pool has " + i + " slots." });
  await m.folder(m.repo, { files });
  const job = () => ({ runId: newJobRunId() });
  const result = await m.unchanged(() => runImport(m.roots, { now, job: job() }));
  assert.deepEqual([result.written.length, result.deferred], [100, 5]);
  assert.match(result.runId, /^run_job_[a-f0-9]{16}$/);
  assert.equal((await m.unchanged(() => runImport(m.roots, { now, job: job() }))).written.length, 0, "the day's budget is spent");
  const tomorrow = () => new Date(now().getTime() + 86400000);
  const later = await m.unchanged(() => runImport(m.roots, { now: tomorrow, job: job() }));
  assert.deepEqual([later.written.length, later.unchanged], [5, 100]);
});

test("import run from an agent shell writes as the agent, stops at the session cap and parks the capped item for the review", async (t) => {
  const m = await machine(t, { solutions: {} });
  const files = {};
  for (let i = 0; i < 25; i++) files["fact-" + String(i).padStart(3, "0") + ".md"] = memory({ name: "fact-" + i, type: "project", description: "Fact number " + i, body: "The worker pool has " + i + " slots." });
  await m.folder(m.repo, { files });
  // No variable gives a CLI run the job's recorder: a job-looking run ID in the environment changes nothing.
  const result = await m.unchanged(() => m.ok(["import", "run"], { env: { CLAUDECODE: "1", DEVTWIN_JOB_RUN_ID: "run_job_0123456789abcdef" } }));
  assert.equal(result.runId, "run_cli00001");
  assert.deepEqual([result.written.length, result.parked.length, result.deferred, result.capped.max], [20, 1, 4, 20]);
  const entries = (await readAudit(m.roots)).entries;
  assert.ok(entries.length === 20 && entries.every((e) => e.actor === "claude" && e.route === "import run"));
  const ids = new Set(result.written.map((w) => w.recordId));
  assert.deepEqual([...new Set((await m.records()).filter((r) => ids.has(r.id)).map((r) => r.recordedBy.actor))], ["claude"]);
  // The capped item waits in the activity review with its text, by its waiting ID.
  const waiting = (await m.ok(["activity"])).waiting.filter((w) => w.kind === "review");
  assert.deepEqual(waiting.map((w) => [w.id, w.type]), [[result.parked[0].waiting, "capped-record"]]);
  // A second run the same day writes nothing more: the caller's bucket is full.
  const again = await m.unchanged(() => m.ok(["import", "run"], { env: { CLAUDECODE: "1" } }));
  assert.deepEqual([again.written.length, again.parked.length, again.capped.max], [0, 1, 20]);
});

test("import preference proposals count toward the run and day budgets", async (t) => {
  const m = await machine(t, { solutions: {} });
  const files = {};
  for (let i = 0; i < 60; i++) files["pref-" + String(i).padStart(3, "0") + ".md"] = memory({ name: "pref-" + i, type: "user", description: "Preference " + i, body: "Prefer answers that name tool " + i + " first." });
  for (let i = 0; i < 60; i++) files["fact-" + String(i).padStart(3, "0") + ".md"] = memory({ name: "fact-" + i, type: "project", description: "Fact number " + i, body: "The worker pool has " + i + " slots." });
  await m.folder(m.repo, { files });
  const job = () => ({ runId: newJobRunId() });
  const first = await m.unchanged(() => runImport(m.roots, { now, job: job() }));
  assert.equal(first.preferences.filter((p) => p.created).length + first.written.length, 100, "a run writes at most 100 items, proposals included");
  assert.equal(first.deferred, 20);
  // The day's budget counts the proposals too, so a second run that day writes nothing.
  const second = await m.unchanged(() => runImport(m.roots, { now, job: job() }));
  assert.deepEqual([second.written.length, second.preferences.length, second.deferred], [0, 0, 20]);
});

test("the memory folder proof fails closed when the transcript count or size cap leaves lines unchecked", async (t) => {
  const root = "/srv/example/atlas";
  // Within both caps, every cwd is checked.
  const fine = await sandbox(t);
  await writeFile(join(fine, "a.jsonl"), transcript([root]));
  assert.deepEqual(proveFolder(fine, [root]), { ok: true, transcripts: 1 });
  // One transcript past the count cap: the folder is not proven, even though the checked ones are inside the root.
  const many = await sandbox(t);
  for (let i = 0; i <= MEMORY_LIMITS.transcripts; i++) await writeFile(join(many, "s" + String(i).padStart(4, "0") + ".jsonl"), transcript([root]));
  assert.deepEqual(proveFolder(many, [root]), { ok: false, reason: "proof-capped" });
  // A transcript longer than the byte cap, whose cwd outside the root comes after the cap.
  const long = await sandbox(t);
  const filler = JSON.stringify({ type: "summary", summary: "x".repeat(1000) }) + "\n";
  await writeFile(join(long, "a.jsonl"), transcript([root]) + filler.repeat(Math.ceil(MEMORY_LIMITS.transcriptBytes / filler.length)) + transcript(["/srv/elsewhere"]));
  assert.deepEqual(proveFolder(long, [root]), { ok: false, reason: "proof-capped" });
});
