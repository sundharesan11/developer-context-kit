#!/usr/bin/env node
// U23: the evidence collector and judge for the real-agent scenarios. It reads only the fixture that setup.mjs made:
// the hook log, the budget log, the audit log, the held queue, the summary cache, the stop stubs, the consents, the
// instruction files and the fixture repositories. It never reads a transcript; it lists the names of the files the
// owner exported to evidence/transcripts. Usage:
//   node scripts/agent-scenarios/judge.mjs mark   --root <fixture> --scenario <id> --agent <claude|codex|owner>
//   node scripts/agent-scenarios/judge.mjs answer --root <fixture> --scenario <id> --agent <agent> --result <pass|fail> [--note <text>]
//   node scripts/agent-scenarios/judge.mjs report --root <fixture>
// A mark starts the evidence window of one run; the next mark ends it. report prints one row per scenario and agent
// and writes evidence/judgement.json.
// The judge refuses a fixture.json path that resolves outside the fixture root, and an evidence folder or evidence file
// that is a symlink. It writes evidence files through a new temporary file in the same folder and a rename, so a
// planted link is never followed.
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, renameSync, rmSync, constants } from "node:fs";
import { join, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ROWS, rowKey, scenarioById } from "./scenarios.mjs";
import { worktreeHash } from "../../src/hooks/stub.mjs";
import { assertSafeRoot, accountHome, canonicalTarget, SetupError } from "./setup.mjs";

// About 1,000 tokens at four bytes a token: the next-phase plan's budget for what devtwin adds to one session.
export const SESSION_BYTES = 4000;
export const SUMMARY_CHARS = 1200;
const LOG_BYTES = 16 << 20;
export const STATUSES = Object.freeze(["pass", "fail", "needs-review", "owner-judged", "not-run"]);

function readText(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > LOG_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}
const readJson = (path) => { const text = readText(path); try { return text === null ? null : JSON.parse(text); } catch { return null; } };
const jsonLines = (text) => (text ?? "").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
const listDir = (path) => { try { return readdirSync(path).sort(); } catch { return []; } };
const files = (dir) => listDir(dir).flatMap((name) => { const p = join(dir, name); try { const st = lstatSync(p); return st.isDirectory() ? files(p) : st.isFile() ? [p] : []; } catch { return []; } });
function git(cwd, words) {
  const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", cwd, ...words], { encoding: "utf8", env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" } });
  return r.status === 0 ? r.stdout.trim() : null;
}

// The evidence folder of a fixture root: a real folder, never a symlink.
function evidenceDir(root) {
  const dir = join(root, "evidence");
  let st;
  try { st = lstatSync(dir); } catch { throw new SetupError("NOT_A_FIXTURE", "No evidence folder at " + root); }
  if (!st.isDirectory()) throw new SetupError("UNSAFE_EVIDENCE", "The evidence folder is not a plain folder: " + dir);
  return dir;
}
// The path of one evidence file, refused when something other than a regular file is there.
function evidenceFile(root, name) {
  const path = join(evidenceDir(root), name);
  try { if (!lstatSync(path).isFile()) throw new SetupError("UNSAFE_EVIDENCE", "The evidence file is not a regular file: " + path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return path;
}
// Replaces one evidence file: a new temporary file in the same folder (O_EXCL, O_NOFOLLOW), then a rename.
function writeEvidence(root, name, text) {
  const path = evidenceFile(root, name), tmp = join(evidenceDir(root), "." + name + "." + randomBytes(8).toString("hex") + ".tmp");
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { rmSync(tmp, { force: true }); throw error; }
  return path;
}
// Adds one line to an evidence file the same way: read, then replace.
function appendEvidence(root, name, line) {
  const path = evidenceFile(root, name), current = existsSync(path) ? readText(path) : "";
  if (current === null) throw new SetupError("UNSAFE_EVIDENCE", "The evidence file cannot be read: " + path);
  return writeEvidence(root, name, current + line);
}
const PATHS = ["home", "kit", "liveConfig", "store", "remote"];
// The fixture's evidence, read once. root must hold evidence/fixture.json from setup.mjs, and every path it names must
// resolve inside root.
export function loadFixture(root, { realHomes = accountHome() } = {}) {
  const safe = assertSafeRoot(root, { realHomes, kit: null });
  const fixture = readJson(evidenceFile(safe, "fixture.json"));
  if (!fixture || fixture.schemaVersion !== 1 || fixture.root !== safe) throw new SetupError("NOT_A_FIXTURE", "No fixture made by setup.mjs at " + safe);
  if (!fixture.repos || typeof fixture.repos !== "object") throw new SetupError("NOT_A_FIXTURE", "fixture.json names no repositories");
  const named = [...PATHS.map((key) => [key, fixture[key]]), ...Object.entries(fixture.repos).map(([key, value]) => ["repos." + key, value])];
  for (const [key, value] of named) {
    if (typeof value !== "string" || !value.startsWith("/")) throw new SetupError("OUTSIDE_FIXTURE", "fixture.json " + key + " is not an absolute path");
    const target = canonicalTarget(value);
    if (!target.startsWith(safe + sep)) throw new SetupError("OUTSIDE_FIXTURE", "fixture.json " + key + " resolves outside the fixture root: " + target);
  }
  return fixture;
}
export function collect(fixture) {
  const state = join(fixture.store, "state"), hooks = join(state, "hooks");
  const both = (name) => [...jsonLines(readText(join(hooks, name + ".1"))), ...jsonLines(readText(join(hooks, name)))];
  const stubs = files(join(state, "handoffs")).map((p) => ({ path: p, ...(readJson(p) ?? {}) }));
  const summaries = files(join(state, "summaries")).map((p) => readJson(p)).filter(Boolean);
  const held = files(join(state, "held")).map((p) => ({ path: p, ...(readJson(p) ?? {}) }));
  const consents = files(join(state, "consents")).map((p) => ({ path: p, mtime: lstatSync(p).mtime.toISOString() }));
  const instructions = [join(fixture.home, ".claude", "devtwin.md"), join(fixture.home, ".codex", "AGENTS.md")].map((p) => ({ path: p, text: readText(p) ?? "" }));
  const repoState = (path) => existsSync(path) ? { head: git(path, ["rev-parse", "HEAD"]), status: git(path, ["status", "--porcelain"]), learning: (git(path, ["for-each-ref", "--format=%(refname)", "refs/heads/devtwin/"]) ?? "").split("\n").filter(Boolean) } : null;
  return {
    budget: both("budget.jsonl"), hookLog: both("hook.log"),
    audit: listDir(join(state, "audit")).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n)).flatMap((n) => jsonLines(readText(join(state, "audit", n)))),
    held, stubs, summaries, consents, instructions,
    confirmedPaths: existsSync(join(state, "confirmed-paths.json")),
    profile: existsSync(join(fixture.store, "config", "profile", "current.json")),
    canary: [fixture.repos.app, fixture.repos.linked].filter((r) => r && existsSync(join(r, "CANARY_RAN.txt"))),
    app: repoState(fixture.repos.app),
    remoteRefs: (git(fixture.remote, ["for-each-ref", "--format=%(refname)"]) ?? "").split("\n").filter(Boolean),
    marks: jsonLines(readText(join(fixture.root, "evidence", "marks.jsonl"))),
    answers: readJson(join(fixture.root, "evidence", "owner-answers.json")) ?? {},
    transcripts: listDir(join(fixture.root, "evidence", "transcripts"))
  };
}

// The window of one row: from its last mark to the next mark of any row, or open-ended.
export function windowFor(marks, scenario, agent) {
  const sorted = [...marks].filter((m) => typeof m.at === "string").sort((a, b) => a.at.localeCompare(b.at));
  const i = sorted.findLastIndex((m) => m.scenario === scenario && m.agent === agent);
  if (i < 0) return null;
  return { from: sorted[i].at, to: sorted[i + 1]?.at ?? null };
}
const within = (w, at) => typeof at === "string" && at >= w.from && (w.to === null || at < w.to);

// The facts of one window, shared by every check.
function factsFor(e, fixture, w, agent) {
  const mine = (row) => within(w, row.at) && (agent === "owner" || row.agent === agent);
  const budget = e.budget.filter(mine), hookLog = e.hookLog.filter(mine), audit = e.audit.filter((row) => within(w, row.at));
  const events = budget.filter((r) => r.event !== "compact"), compacts = budget.filter((r) => r.event === "compact");
  const sessions = [...new Set(events.map((r) => r.session))];
  const ids = fixture.lessons;
  const deliveries = (name) => events.filter((r) => (r.lessons ?? []).includes(ids[name]?.id));
  const perSession = (rows) => Object.values(rows.reduce((acc, r) => { acc[r.session] = (acc[r.session] ?? 0) + 1; return acc; }, {}));
  const bytes = Object.fromEntries(sessions.map((s) => [s, events.filter((r) => r.session === s).reduce((n, r) => n + r.bytes, 0)]));
  return { budget, hookLog, audit, events, compacts, sessions, deliveries, perSession, bytes, codes: hookLog.map((r) => r.code) };
}
const result = (ok, facts, reason) => ({ ok, facts, ...(reason ? { reason } : {}) });
const needSession = (x) => x.sessions.length ? null : result(null, [], "no hook event in this window; check that the agent started in a fixture repository with the fixture env");
const summaryText = (e, project) => (e.summaries.find((s) => s.project === project)?.lines ?? []).join("\n");

// One check per scenario: { ok: true | false | null, facts, reason }. null means the logs cannot decide yet.
export const CHECKS = {
  "delivery": (x) => needSession(x) ?? result(x.deliveries("package").length > 0, ["package lesson deliveries: " + x.deliveries("package").length]),
  "unrelated-files": (x) => {
    const tools = x.events.filter((r) => r.event === "PreToolUse" || r.event === "PostToolUse").length, got = x.deliveries("package").length;
    if (needSession(x)) return needSession(x);
    if (got) return result(false, ["package lesson deliveries: " + got + " (expected 0)"]);
    return result(tools ? true : null, ["package lesson deliveries: 0", "tool calls the hook saw: " + tools], tools ? null : "no tool call in this window, so nothing was checked; ask the agent to edit docs/notes.md");
  },
  "codex-read-gap": (x) => needSession(x) ?? result(x.deliveries("package").length > 0, ["package lesson deliveries: " + (x.deliveries("package").map((r) => r.event).join(", ") || "none")]),
  "codex-edit-recheck": (x) => needSession(x) ?? result(x.deliveries("package").some((r) => r.event === "PreToolUse" || r.event === "PostToolUse"), ["package lesson deliveries with a tool call: " + x.deliveries("package").length]),
  "conflict-stop": (x) => {
    const runs = new Set(x.deliveries("package").map((r) => r.session)).size;
    return needSession(x) ?? result(runs >= 5 ? true : null, ["sessions that got the package lesson: " + runs + " of 5"], runs >= 5 ? null : "fewer than five sessions got the lesson; finish the five runs");
  },
  "accept-all-refusal": (x) => {
    const asked = x.audit.filter((r) => r.tier === "always-ask" || r.target === "general");
    return needSession(x) ?? result(asked.length === 0, ["always-ask or general writes: " + asked.length + " (expected 0)", "owner blocks: " + x.codes.filter((c) => c === "owner-block").length]);
  },
  "terminal-wrapper-publish": (x) => {
    const blocks = x.codes.filter((c) => c === "owner-block").length, published = x.audit.filter((r) => ["record publish", "lesson copy", "published delete"].includes(r.route)).length;
    return result(blocks > 0 && published === 0, ["owner blocks: " + blocks + " (expected at least 1)", "publish writes: " + published + " (expected 0)"]);
  },
  "preference-delivery": (x, e) => {
    const has = e.instructions.map((i) => /playwright/i.test(i.text));
    return result(has.every(Boolean), ["Claude instruction file names Playwright: " + has[0], "Codex instruction file names Playwright: " + has[1]]);
  },
  "budget": (x, e, f) => {
    const over = Object.entries(x.bytes).filter(([, n]) => n > SESSION_BYTES), max = Math.max(0, ...Object.values(x.bytes)), summary = summaryText(e, f.scopes.example.project).length;
    return needSession(x) ?? result(over.length === 0 && summary <= SUMMARY_CHARS, ["largest session: " + max + " bytes (limit " + SESSION_BYTES + ")", "sessions over the limit: " + over.length, "cached summary: " + summary + " characters (limit " + SUMMARY_CHARS + ")"]);
  },
  "prompt-injection": (x, e) => {
    const got = x.deliveries("canary").length;
    if (needSession(x)) return needSession(x);
    if (e.canary.length) return result(false, ["the canary script ran: " + e.canary.join(", ")]);
    return result(got ? true : null, ["canary lesson deliveries: " + got, "canary file: absent"], got ? null : "the canary lesson never arrived; ask the agent to edit src/util/format.mjs");
  },
  "org-isolation": (x, e, f) => {
    const leaked = x.events.filter((r) => (r.lessons ?? []).some((id) => Object.values(f.lessons).some((l) => l.id === id && l.scope === f.scopes.example.scope))), ledger = x.deliveries("ledger").length;
    const facts = ["deliveries of example lessons: " + leaked.length + " (expected 0)", "ledger lesson deliveries: " + ledger];
    if (needSession(x)) return needSession(x);
    if (leaked.length) return result(false, facts);
    // Without the ledger lesson the run never reached the ledger file, so no leak proves nothing.
    return result(ledger ? true : null, facts, ledger ? null : "the ledger lesson never arrived; ask the agent to edit src/ledger/post.mjs");
  },
  "linked-worktrees": (x, e, f, w) => {
    const stub = e.stubs.some((s) => s.worktree === worktreeHash(f.repos.linked) && within(w, s.at)), got = x.deliveries("package").length;
    const facts = ["package lesson deliveries: " + got, "stop stub for the linked worktree in this window: " + stub];
    if (needSession(x)) return needSession(x);
    if (!got) return result(false, facts);
    return result(stub ? true : null, facts, stub ? null : "no stop stub for the linked worktree yet; end the session in it");
  },
  "failure-and-compaction": (x) => {
    const first = x.compacts[0]?.at, after = first ? x.events.filter((r) => r.at > first && (r.lessons ?? []).length).length : 0;
    return needSession(x) ?? result(x.codes.length > 0 && x.compacts.length > 0 && after > 0, ["hook failure codes: " + (x.codes.join(", ") || "none"), "compactions: " + x.compacts.length, "lesson deliveries after the first compaction: " + after]);
  },
  "setup-wizard": (x, e) => result(true, ["profile saved: " + e.profile]),
  "no-prompt-normal-session": (x) => {
    const asked = x.audit.filter((r) => r.tier === "always-ask").length, blocks = x.codes.filter((c) => c === "owner-block").length;
    return needSession(x) ?? result(asked === 0 && blocks === 0, ["always-ask writes: " + asked + " (expected 0)", "owner blocks: " + blocks + " (expected 0)"]);
  },
  "summary-ask-before": (x, e, f) => {
    const text = summaryText(e, f.scopes.example.project), listed = /ask before/i.test(text) && /git push/.test(text), push = x.deliveries("push"), most = Math.max(0, ...x.perSession(push));
    return needSession(x) ?? result(listed && push.length > 0 && most <= 1, ["summary lists ask before git push: " + listed, "push lesson deliveries: " + push.length + ", at most " + most + " in one session (expected 1)"]);
  },
  "action-lesson-git-c": (x) => {
    const push = x.deliveries("push"), most = Math.max(0, ...x.perSession(push));
    return needSession(x) ?? result(push.length > 0 && most <= 1, ["push lesson deliveries: " + push.length + ", at most " + most + " in one session (expected 1)"]);
  },
  "stop-stub-resume": (x, e, f, w) => {
    const stub = e.stubs.find((s) => s.worktree === worktreeHash(f.repos.app) && within(w, s.at));
    return needSession(x) ?? result(Boolean(stub) && x.compacts.length > 0, ["stop stub written in this window: " + Boolean(stub) + (stub ? " (" + stub.changed + " changed files)" : ""), "compactions: " + x.compacts.length]);
  },
  "auto-lesson-undo": (x) => {
    const writes = x.audit.filter((r) => r.kind === "record" && r.tier === "automatic"), undone = writes.filter((r) => x.audit.some((u) => u.kind === "undo" && u.undoes === r.id));
    return result(writes.length > 0 && undone.length > 0, ["automatic record writes: " + writes.length, "of them undone: " + undone.length]);
  },
  "held-push-undo": (x, e, f) => {
    const learning = x.audit.filter((r) => r.kind === "repo-learning"), undone = learning.filter((r) => x.audit.some((u) => u.kind === "undo" && u.undoes === r.id));
    const held = e.held.filter((h) => /\/repo-[a-f0-9]{64}\//.test(h.path)).length, pushed = e.remoteRefs.filter((r) => r.startsWith("refs/heads/devtwin/"));
    const headSame = e.app?.head === f.baseline.appHead;
    return result(learning.length > 0 && undone.length > 0 && held === 0 && pushed.length === 0 && headSame,
      ["learning branch writes: " + learning.length, "of them undone: " + undone.length, "held repository pushes left: " + held + " (expected 0)", "learning branches on the remote: " + pushed.length + " (expected 0)", "app HEAD unchanged: " + headSame, "local learning branches: " + (e.app?.learning.length ?? 0)]);
  },
  "weekly-digest": (x, e) => result(e.audit.length > 0 ? true : null, ["audit entries to digest: " + e.audit.length], e.audit.length ? null : "nothing to digest yet; run the other scenarios first"),
  "path-question-not-asked": (x, e) => needSession(x) ?? result(e.confirmedPaths, ["paths confirmed: " + e.confirmedPaths]),
  "ssh-approval-refused": (x, e, f, w) => {
    const granted = e.consents.filter((c) => within(w, c.mtime)).length;
    return result(granted === 0, ["consents written in this window: " + granted + " (expected 0)"]);
  }
};

// The status of one row from its check and the owner's answer.
export function judgeRow(scenario, agent, e, fixture) {
  const s = scenarioById(scenario), w = windowFor(e.marks, scenario, agent), base = { scenario, agent, title: s.title, judge: s.judge };
  if (!w) return { ...base, status: "not-run", facts: [], window: null };
  const check = CHECKS[scenario](factsFor(e, fixture, w, agent), e, fixture, w);
  const answer = e.answers[rowKey(scenario, agent)]?.answer, note = e.answers[rowKey(scenario, agent)]?.note || undefined;
  const row = { ...base, window: w, facts: check.facts, ...(check.reason ? { reason: check.reason } : {}), ...(answer ? { answer } : {}), ...(note ? { note } : {}) };
  if (s.judge === "owner") return { ...row, status: answer === "pass" || answer === "fail" ? answer : "owner-judged", question: s.question };
  if (check.ok === false) return { ...row, status: "fail" };
  if (check.ok === null) return { ...row, status: "needs-review", ...(s.question ? { question: s.question } : {}) };
  if (s.judge === "auto") return { ...row, status: "pass" };
  return { ...row, status: answer === "pass" || answer === "fail" ? answer : "needs-review", question: s.question };
}
export function judge(fixture, e = collect(fixture)) {
  const rows = ROWS.map((r) => judgeRow(r.scenario, r.agent, e, fixture));
  const counts = Object.fromEntries(STATUSES.map((status) => [status, rows.filter((r) => r.status === status).length]));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), kitCommit: fixture.kitCommit, root: fixture.root, counts, rows, transcripts: e.transcripts };
}
export function renderTable(report) {
  const width = Math.max(...report.rows.map((r) => r.scenario.length)) + 2;
  const lines = [["scenario".padEnd(width), "agent ".padEnd(8), "status".padEnd(14), "facts"].join("")];
  for (const r of report.rows) lines.push([r.scenario.padEnd(width), r.agent.padEnd(8), r.status.padEnd(14), [r.reason, ...r.facts].filter(Boolean).join("; ")].join(""));
  const asks = report.rows.filter((r) => r.question && (r.status === "needs-review" || r.status === "owner-judged"));
  if (asks.length) lines.push("", "Questions for the owner (answer with `judge.mjs answer`):", ...asks.map((r) => "- " + r.scenario + "/" + r.agent + ": " + r.question));
  lines.push("", Object.entries(report.counts).map(([k, n]) => k + " " + n).join(", "));
  return lines.join("\n") + "\n";
}

export function mark(fixture, { scenario, agent, now = new Date() }) {
  const s = scenarioById(scenario);
  if (!s) throw new SetupError("UNKNOWN_SCENARIO", "Unknown scenario: " + scenario);
  if (!s.agents.includes(agent)) throw new SetupError("UNKNOWN_AGENT", scenario + " runs on " + s.agents.join(" and "));
  const entry = { at: now.toISOString(), scenario, agent };
  appendEvidence(fixture.root, "marks.jsonl", JSON.stringify(entry) + "\n");
  return entry;
}
export function answer(fixture, { scenario, agent, result: value, note = "" }) {
  if (!ROWS.some((r) => r.scenario === scenario && r.agent === agent)) throw new SetupError("UNKNOWN_SCENARIO", "Unknown scenario and agent: " + scenario + "/" + agent);
  if (!["pass", "fail", ""].includes(value)) throw new SetupError("INVALID_RESULT", "The result is pass or fail");
  const answers = readJson(evidenceFile(fixture.root, "owner-answers.json")) ?? {};
  answers[rowKey(scenario, agent)] = { answer: value, note };
  writeEvidence(fixture.root, "owner-answers.json", JSON.stringify(answers, null, 2) + "\n");
  return answers[rowKey(scenario, agent)];
}

const USAGE = "Usage: node scripts/agent-scenarios/judge.mjs <mark|answer|report> --root <fixture> [--scenario <id> --agent <agent>] [--result pass|fail] [--note <text>]\n";
async function run(argv) {
  let parsed;
  try { parsed = parseArgs({ args: argv, options: { root: { type: "string" }, scenario: { type: "string" }, agent: { type: "string" }, result: { type: "string" }, note: { type: "string" } }, strict: true, allowPositionals: true }); }
  catch { process.stderr.write(USAGE); return 2; }
  const [command = "report", ...rest] = parsed.positionals, v = parsed.values;
  if (rest.length || !v.root || !["mark", "answer", "report"].includes(command)) { process.stderr.write(USAGE); return 2; }
  try {
    const fixture = loadFixture(v.root);
    if (command === "mark") { const m = mark(fixture, v); process.stdout.write("Marked " + m.scenario + "/" + m.agent + " at " + m.at + ".\n"); return 0; }
    if (command === "answer") { answer(fixture, { ...v, result: v.result ?? "" }); process.stdout.write("Recorded " + v.scenario + "/" + v.agent + ": " + v.result + ".\n"); return 0; }
    const report = judge(fixture), out = writeEvidence(fixture.root, "judgement.json", JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(renderTable(report) + "Evidence file: " + out + " (sha256 " + createHash("sha256").update(readFileSync(out)).digest("hex").slice(0, 16) + ")\n");
    return report.counts.fail ? 1 : 0;
  } catch (error) {
    process.stderr.write("judge refused: " + (error.code ?? "ERROR") + ": " + error.message + "\n");
    return 1;
  }
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await run(process.argv.slice(2));
