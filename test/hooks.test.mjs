import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile, realpath, utimes, readdir, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { onboardFixture, draftFor, runCli, fixtureGit, makeRepo, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyOnboard, planOnboard } from "../src/onboarding/onboard.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex, readIndex, indexPath } from "../src/lessons/index.mjs";
import { canonicalJson, digest } from "../src/storage/canonical.mjs";
import { writeKitReceipt, receiptPath } from "../src/hooks/receipt.mjs";
import { sessionKey, sessionsDir, hookLogPath } from "../src/hooks/session.mjs";
import { patchPaths, shellPaths, repoPaths } from "../src/hooks/paths.mjs";
import { NOTICE } from "../src/hooks/commands.mjs";

const SCOPE = "example", PROJECT = "example.atlas";
const FIXTURES = join(import.meta.dirname, "fixtures/hooks");
const BIN = join(import.meta.dirname, "../bin/devtwin.mjs");
const lesson = (requestId, extra = {}, { scope = SCOPE, project = PROJECT } = {}) => {
  const input = draftFor(scope, project, { requestId, kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
  input.draft = { ...input.draft, title: "Migrations before seeds", class: "lesson", reach: "project", match: { paths: ["db/migrations/**"], packages: ["pg"], topics: ["migrations"] }, ...extra };
  return input;
};
async function store(t, { receipt = true } = {}) {
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const added = await addRecord(s.roots, lesson("req_hooklsn01"), { now });
  await rebuildIndex(s.roots, SCOPE);
  if (receipt) await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  return { ...s, lessonId: added.recordId };
}
async function payload(name, cwd, patch = {}) {
  const text = (await readFile(join(FIXTURES, name + ".json"), "utf8")).replaceAll("{{cwd}}", cwd);
  return { ...JSON.parse(text), ...patch };
}
// One in-process hook call. Output is the agent JSON or empty, never the CLI envelope.
async function hook(s, agent, event, body) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main(["hook", "--event", event, "--agent", agent, "--pilot", s.path], { stdout, stdin: JSON.stringify(body), now });
  const out = chunks.join("");
  return { code, out, json: out ? JSON.parse(out) : null, context: out ? JSON.parse(out).hookSpecificOutput.additionalContext : "" };
}
const indexLines = (context) => context.split("\n").filter((l) => l.startsWith("- "));
async function matchLine(s, path) {
  const cli = await runCli(["lesson", "match", "--pilot", s.path, "--scope", SCOPE, "--path", path]);
  assert.equal(cli.code, 0, JSON.stringify(cli.json));
  return cli.json.result.matches;
}
async function hookLog(s) { try { return (await readFile(hookLogPath(s.stateRoot), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } }

test("hook delivers one index line for a Claude Code Edit on a matching file", async (t) => {
  const s = await store(t);
  const result = await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", s.repo));
  assert.equal(result.code, 0);
  assert.deepEqual(Object.keys(result.json), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(result.json.hookSpecificOutput).sort(), ["additionalContext", "hookEventName"]);
  assert.equal(result.json.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.ok(result.context.startsWith(NOTICE), result.context);
  const [expected] = await matchLine(s, "db/migrations/002_users.sql");
  assert.deepEqual(indexLines(result.context), ["- " + expected.line]);
  assert.equal(expected.id, s.lessonId);
  assert.doesNotMatch(result.out, /permissionDecision|"decision"/);
  // An unrelated file and a file outside the worktree give nothing.
  const other = await payload("claude-pre-tool-edit", s.repo, { session_id: "other-session" });
  for (const file of [join(s.repo, "src/ui/button.tsx"), join(s.sandbox, "elsewhere/db/migrations/1.sql")]) {
    const quiet = await hook(s, "claude", "pre-tool", { ...other, tool_input: { ...other.tool_input, file_path: file } });
    assert.deepEqual([quiet.code, quiet.out], [0, ""]);
  }
});

test("hook delivers the same line for a Codex apply_patch touching a matching path", async (t) => {
  const s = await store(t);
  const result = await hook(s, "codex", "pre-tool", await payload("codex-pre-tool-apply-patch", s.repo));
  assert.equal(result.code, 0);
  assert.equal(result.json.hookSpecificOutput.hookEventName, "PreToolUse");
  const [expected] = await matchLine(s, "db/migrations/002_users.sql");
  assert.deepEqual(indexLines(result.context), ["- " + expected.line]);
  assert.doesNotMatch(result.out, /permissionDecision|"decision"/);
  // A best-effort shell read in a new session finds the path too.
  const bash = await hook(s, "codex", "post-tool", await payload("codex-post-tool-bash", s.repo, { session_id: "thr_02example0002" }));
  assert.equal(bash.json.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.deepEqual(indexLines(bash.context), ["- " + expected.line]);
  const patch = (await payload("codex-pre-tool-apply-patch", s.repo)).tool_input.command;
  assert.deepEqual(patchPaths(patch), ["db/migrations/002_users.sql", "docs/users.md"]);
  assert.deepEqual(shellPaths("sed -n '1,40p' db/migrations/001_init.sql | head -n 5 > out/x.txt"), ["db/migrations/001_init.sql", "out/x.txt"]);
  assert.deepEqual(shellPaths("curl https://example.com/a.json --output=dl/a.json $HOME/x *.sql"), ["dl/a.json"]);
  assert.deepEqual(repoPaths("codex", { tool_name: "apply_patch", tool_input: { command: "*** Update File: ../outside/db/migrations/a.sql\n*** Update File: /etc/passwd\n" } }, { cwd: s.repo, root: s.repo }), []);
});

test("hook delivers a lesson for a package named in the prompt before any edit", async (t) => {
  const s = await store(t);
  const start = await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo));
  assert.equal(start.json.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.context, /^devtwin hook live: 1 lesson for example\.atlas\. Index lines arrive when work matches\. Session ID for lesson propose: ses_[a-f0-9]{24}\.$/);
  // The tag is the same for every start of one session, and differs between sessions and agents.
  const tag = /ses_[a-f0-9]{24}/.exec(start.context)[0];
  assert.equal(/ses_[a-f0-9]{24}/.exec((await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo))).context)[0], tag);
  assert.notEqual(/ses_[a-f0-9]{24}/.exec((await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo, { session_id: "s-other" }))).context)[0], tag);
  assert.ok(Buffer.byteLength(start.context) <= 400);
  for (const agent of ["claude", "codex"]) {
    const prompt = await hook(s, agent, "user-prompt", await payload(agent + "-user-prompt", s.repo));
    assert.equal(prompt.json.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.equal(indexLines(prompt.context).length, 1, agent);
    assert.ok(prompt.context.includes(s.lessonId), agent);
  }
  const unrelated = await hook(s, "claude", "user-prompt", await payload("claude-user-prompt", s.repo, { session_id: "s-unrelated", prompt: "Rename the button component." }));
  assert.equal(unrelated.out, "");
});

test("hook does not repeat a lesson in one session and delivers it again after compaction", async (t) => {
  const s = await store(t);
  const edit = await payload("claude-pre-tool-edit", s.repo);
  assert.equal(indexLines((await hook(s, "claude", "pre-tool", edit)).context).length, 1);
  assert.equal((await hook(s, "claude", "post-tool", { ...edit, hook_event_name: "PostToolUse" })).out, "");
  assert.equal((await hook(s, "claude", "user-prompt", await payload("claude-user-prompt", s.repo))).out, "");
  const compact = await hook(s, "claude", "session-start", await payload("claude-session-start-compact", s.repo));
  assert.match(compact.context, /^devtwin hook live: 1 lesson/);
  assert.equal(indexLines((await hook(s, "claude", "pre-tool", edit)).context).length, 1);
  // Codex: PreCompact resets the session and returns no output.
  const patch = await payload("codex-pre-tool-apply-patch", s.repo);
  assert.equal(indexLines((await hook(s, "codex", "pre-tool", patch)).context).length, 1);
  assert.equal((await hook(s, "codex", "pre-tool", patch)).out, "");
  const pre = await hook(s, "codex", "pre-compact", await payload("codex-pre-compact", s.repo));
  assert.deepEqual([pre.code, pre.out], [0, ""]);
  assert.equal(indexLines((await hook(s, "codex", "pre-tool", patch)).context).length, 1);
  const report = await runCli(["budget", "report", "--pilot", s.path]);
  assert.equal(report.code, 0, JSON.stringify(report.json));
  assert.equal(report.json.result.agents.claude.compactions, 1);
  assert.equal(report.json.result.agents.codex.compactions, 1);
  assert.equal(report.json.result.totals.lines, 4);
});

test("hook sends four index lines then one overflow line at the session cap", async (t) => {
  const s = await store(t);
  const ids = [];
  for (let i = 2; i <= 6; i++) ids.push((await addRecord(s.roots, lesson("req_hooklsn0" + i, { title: "Feature lesson " + i, match: { paths: ["src/feature/**"] } }), { now })).recordId);
  await rebuildIndex(s.roots, SCOPE);
  const edit = await payload("claude-pre-tool-edit", s.repo);
  const first = await hook(s, "claude", "pre-tool", { ...edit, tool_input: { ...edit.tool_input, file_path: join(s.repo, "src/feature/a.mjs") } });
  const lines = indexLines(first.context);
  assert.equal(lines.length, 4);
  for (const line of lines) assert.ok(Buffer.byteLength(line) <= 242, line);
  assert.equal(first.context.split("\n").at(-1), "1 more lesson matches; run `devtwin lesson match`");
  assert.equal(first.context.split("\n").length, 6);
  // The cap holds for the rest of the session, and the overflow line is sent once.
  const second = await hook(s, "claude", "pre-tool", edit);
  assert.equal(second.out, "");
  const report = (await runCli(["budget", "report", "--pilot", s.path])).json.result;
  assert.deepEqual([report.totals.events, report.totals.lines, report.totals.overflow, report.totals.bytes], [1, 4, 1, Buffer.byteLength(first.context)]);
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].session, sessionKey("claude", edit.session_id));
  assert.equal(report.sessions[0].agent, "claude");
  const start = await hook(s, "codex", "session-start", await payload("codex-session-start", s.repo));
  const after = (await runCli(["budget", "report", "--pilot", s.path])).json.result;
  assert.equal(after.totals.bytes, Buffer.byteLength(first.context) + Buffer.byteLength(start.context));
  assert.equal(after.agents.codex.lines, 0);
});

test("hook gives a linked worktree of a bound project that project's lessons", async (t) => {
  const s = await store(t);
  const linked = join(s.reposDir, "atlas-linked");
  await fixtureGit(s.repo, ["worktree", "add", "-q", "-b", "child", linked]);
  const worktree = await realpath(linked);
  const result = await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", worktree));
  assert.deepEqual(indexLines(result.context).length, 1);
  assert.ok(result.context.includes(s.lessonId));
  const start = await hook(s, "codex", "session-start", await payload("codex-session-start", join(worktree, ".")));
  assert.match(start.context, /1 lesson for example\.atlas/);
});

test("hook returns empty output with exit 0 for a missing receipt, corrupt index or killed run, and lesson match still works", async (t) => {
  const s = await store(t, { receipt: false });
  const edit = await payload("claude-pre-tool-edit", s.repo);
  assert.deepEqual(Object.values(await hook(s, "claude", "pre-tool", edit)).slice(0, 2), [0, ""]);
  const start = await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo));
  assert.equal(start.context, "devtwin hook: kit not verified (missing); run `devtwin hook verify`. Lessons are off.");
  // With no receipt, the hook writes nothing under stateRoot.
  await assert.rejects(readdir(join(s.stateRoot, "hooks")), { code: "ENOENT" });
  // An expired receipt, and one for a changed pilot file, are not trusted.
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date("2026-09-01T00:00:00.000Z") });
  assert.equal((await hook(s, "claude", "pre-tool", edit)).out, "");
  const verify = await runCli(["hook", "verify", "--pilot", s.path]);
  assert.equal(verify.code, 0, JSON.stringify(verify.json));
  assert.equal(verify.json.result.path, receiptPath(s.stateRoot));
  assert.equal(verify.json.result.kitCommit, null);
  const raw = await readFile(s.path, "utf8");
  await writeFile(s.path, raw + "\n");
  assert.equal((await hook(s, "claude", "pre-tool", edit)).out, "");
  assert.match((await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo))).context, /kit not verified \(pilot-changed\)/);
  await writeFile(s.path, raw);
  assert.equal(indexLines((await hook(s, "claude", "pre-tool", edit)).context).length, 1);
  // Killed mid-run: a partial temp file and a cut-short session file.
  const sessions = sessionsDir(s.stateRoot), key = sessionKey("claude", "killed-session");
  await writeFile(join(sessions, ".devtwin-0123456789abcdef.tmp"), "{\"schema", { mode: 0o600 });
  await writeFile(join(sessions, key + ".json"), "{\"schemaVersion\":1,\"agent\":\"cla", { mode: 0o600 });
  const killed = { ...edit, session_id: "killed-session" };
  assert.deepEqual(Object.values(await hook(s, "claude", "pre-tool", killed)).slice(0, 2), [0, ""]);
  assert.ok((await hookLog(s)).some((e) => e.code === "session-corrupt"));
  assert.equal(indexLines((await hook(s, "claude", "pre-tool", killed)).context).length, 1);
  const old = new Date(now().getTime() - 2 * 3600 * 1000);
  await utimes(join(sessions, ".devtwin-0123456789abcdef.tmp"), old, old);
  await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo, { session_id: "prune-session" }));
  assert.ok(!(await readdir(sessions)).includes(".devtwin-0123456789abcdef.tmp"));
  // A corrupt index stops delivery; a following lesson match reads the records and succeeds.
  const path = indexPath(s.roots, SCOPE);
  await writeFile(path, "{\"schemaVersion\":1,\"scope\":\"example\",\"entries\":[", { mode: 0o600 });
  const corrupt = await hook(s, "claude", "pre-tool", { ...edit, session_id: "after-corrupt" });
  assert.deepEqual([corrupt.code, corrupt.out], [0, ""]);
  assert.ok((await hookLog(s)).some((e) => e.code === "DEVTWIN_INTEGRITY"));
  assert.deepEqual((await matchLine(s, "db/migrations/002_users.sql")).map((m) => m.id), [s.lessonId]);
  // Bad payloads and options fail open too, and a wrong event name in the payload is refused.
  for (const [args, body] of [[["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", s.path], "not json"], [["hook", "--event", "nope", "--agent", "claude", "--pilot", s.path], "{}"], [["hook", "--event", "pre-tool", "--agent", "other", "--pilot", s.path], "{}"], [["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", s.path, "--extra"], "{}"], [["hook", "--event", "user-prompt", "--agent", "claude", "--pilot", s.path], JSON.stringify(edit)]]) {
    const chunks = [];
    const code = await main(args, { stdout: { write: (v) => chunks.push(v) }, stdin: body, now });
    assert.deepEqual([code, chunks.join("")], [0, ""], args.join(" "));
  }
  const gate = await runCli(["hook", "--event", "pre-tool", "--agent", "claude"]);
  assert.equal(gate.json.error.code, "DEVTWIN_GATE_REQUIRED");
});

async function addScope(s, scope, project, repoName) {
  await applyScopeAdd(s.roots, { scope, hubs: [], policies: [], now });
  const repo = await makeRepo(join(s.reposDir, repoName), { "README.md": "# Fixture\n" });
  const input = { scope, project, repo, approvedDocs: [], expectedRemotes: [], environments: ["staging"], actorRefs: [], accept: "all", requestId: "req_" + repoName + "0001" };
  const plan = await planOnboard(s.roots, s.pilot, input);
  await applyOnboard(s.roots, s.pilot, input, { fingerprint: plan.fingerprint, now });
  return repo;
}

test("hook in a scope A repo never shows a scope B lesson (AE4)", async (t) => {
  const s = await store(t);
  const repoB = await addScope(s, "sample", "sample.beacon", "beacon");
  const other = await addRecord(s.roots, lesson("req_hooklsnb1", { title: "Scope B lesson" }, { scope: "sample", project: "sample.beacon" }), { now });
  await rebuildIndex(s.roots, "sample");
  const inA = await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", s.repo));
  assert.ok(inA.context.includes(s.lessonId));
  assert.ok(!inA.context.includes(other.recordId));
  assert.ok(!inA.context.includes("Scope B lesson"));
  const inB = await hook(s, "codex", "pre-tool", await payload("codex-pre-tool-apply-patch", repoB));
  assert.ok(inB.context.includes(other.recordId));
  assert.ok(!inB.context.includes(s.lessonId));
  assert.match(inB.context, /--scope sample /);
});

async function writeIndex(s, index) {
  const { fingerprint, ...body } = index;
  await writeFile(indexPath(s.roots, index.scope), canonicalJson({ ...body, fingerprint: digest(body) }) + "\n", { mode: 0o600 });
}

test("hook emits nothing for a root bound in two scopes", async (t) => {
  const s = await store(t);
  const own = await readIndex(s.roots, SCOPE);
  await writeIndex(s, { ...own, scope: "sample", roots: own.roots.map((r) => ({ ...r, scope: "sample", project: "sample.atlas" })), fingerprint: null });
  const result = await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", s.repo));
  assert.deepEqual([result.code, result.out], [0, ""]);
  assert.ok((await hookLog(s)).some((e) => e.code === "ambiguous-root"));
  const start = await hook(s, "claude", "session-start", await payload("claude-session-start", s.repo));
  assert.equal(start.context, "devtwin hook: this folder is bound in more than one scope, so lessons are off.");
});

// A live-mode-shaped store: one bound project plus three more scopes of 300 lessons each, read on every call.
async function largeStore(t) {
  const s = await store(t, { receipt: false });
  const own = await readIndex(s.roots, SCOPE);
  for (const scope of ["sample", "sample-two", "sample-three"]) {
    const entries = Array.from({ length: 300 }, (_, i) => ({ ...own.entries[0], id: "rec_" + digest({ scope, i }).slice(7, 31), scope, project: scope + ".app", title: "Lesson " + i, match: { paths: ["src/area" + i + "/**"], packages: ["pkg-" + i], topics: ["topic" + i] } }));
    await writeIndex(s, { ...own, scope, entries, roots: [{ root: join(s.sandbox, scope), commonDir: join(s.sandbox, scope, ".git"), kind: "main", scope, project: scope + ".app" }], fingerprint: null });
  }
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: new Date() });
  return s;
}

test("hook end-to-end p95 including Node startup stays under the bound", async (t) => {
  const s = await largeStore(t);
  const edit = await payload("claude-pre-tool-edit", s.repo);
  const env = { PATH: process.env.PATH, HOME: s.fakeHome };
  // Each hook run is paired with a bare Node start, so machine load slows both sides of the comparison alike.
  const times = [], bare = [];
  for (let i = 0; i < 25; i++) {
    const input = JSON.stringify({ ...edit, session_id: "timing-" + i });
    let started = performance.now();
    spawnSync(process.execPath, ["-e", ""], { env, encoding: "utf8" });
    bare.push(performance.now() - started);
    started = performance.now();
    const run = spawnSync(process.execPath, [BIN, "hook", "--event", "pre-tool", "--agent", "claude", "--pilot", s.path], { input, env, encoding: "utf8" });
    times.push(performance.now() - started);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(indexLines(JSON.parse(run.stdout).hookSpecificOutput.additionalContext).length, 1);
  }
  const p95 = (list) => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1];
  const median = (list) => [...list].sort((a, b) => a - b)[12];
  const hookP95 = p95(times), overhead = median(times) - median(bare);
  t.diagnostic("hook p95 " + hookP95.toFixed(1) + " ms, cold " + times[0].toFixed(1) + " ms, median " + median(times).toFixed(1) + " ms, bare Node median " + median(bare).toFixed(1) + " ms");
  // The target is 200 ms end to end on an idle developer machine. The test bounds the hook's own median cost above a
  // bare Node start, and keeps a loose absolute ceiling; both measured values are reported.
  assert.ok(overhead < (process.env.CI ? 400 : 150), "hook median overhead " + overhead.toFixed(1) + " ms");
  assert.ok(hookP95 < (process.env.CI ? 2000 : 1000), "hook p95 " + hookP95.toFixed(1) + " ms");
});

test("hook state and logs are private files under stateRoot/hooks", async (t) => {
  const s = await store(t);
  await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", s.repo));
  const { lstat } = await import("node:fs/promises");
  const mode = async (p) => (await lstat(p)).mode & 0o777;
  assert.equal(await mode(join(s.stateRoot, "hooks")), 0o700);
  assert.equal(await mode(sessionsDir(s.stateRoot)), 0o700);
  assert.equal(await mode(receiptPath(s.stateRoot)), 0o600);
  assert.equal(await mode(join(s.stateRoot, "hooks/budget.jsonl")), 0o600);
  const [file] = (await readdir(sessionsDir(s.stateRoot))).filter((n) => n.endsWith(".json"));
  assert.equal(await mode(join(sessionsDir(s.stateRoot), file)), 0o600);
  // The budget log holds counts and the hashed session key, never prompt text or paths.
  const log = await readFile(join(s.stateRoot, "hooks/budget.jsonl"), "utf8");
  assert.ok(!log.includes("db/migrations") && !log.includes(s.repo));
  await chmod(receiptPath(s.stateRoot), 0o644);
  assert.equal((await hook(s, "claude", "pre-tool", await payload("claude-pre-tool-edit", s.repo, { session_id: "loose" }))).out, "");
});
