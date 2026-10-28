import test from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { spawnSync } from "node:child_process";
import { sandbox, sleep } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { scanSensitive } from "../src/records/redact.mjs";
import { SCENARIOS, ROWS, AGENTS } from "../scripts/agent-scenarios/scenarios.mjs";
import { buildFixture, assertSafeRoot, envLines, SetupError } from "../scripts/agent-scenarios/setup.mjs";
import { CHECKS, collect, judge, loadFixture, mark, answer, renderTable, SESSION_BYTES } from "../scripts/agent-scenarios/judge.mjs";

const DIR = join(import.meta.dirname, "../scripts/agent-scenarios");
const SETUP = join(DIR, "setup.mjs"), JUDGE = join(DIR, "judge.mjs");
const ACCOUNT_HOME = realpathSync(userInfo().homedir);
const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME ?? ACCOUNT_HOME } });
// One hook call through the CLI in this process, as the agent's hook line runs it, with the fixture's kit clone.
async function hook(f, agent, event, payload) {
  const chunks = [];
  await main(["hook", "--event", event, "--agent", agent, "--pilot", f.liveConfig], { stdin: JSON.stringify(payload), kitRoot: f.kit, stdout: { write: (v) => { chunks.push(v); return true; } } });
  return chunks.join("");
}
const budgetLine = (f, row) => appendFile(join(f.store, "state", "hooks", "budget.jsonl"), JSON.stringify({ at: new Date().toISOString(), overflow: 0, lines: 0, ...row }) + "\n");
const session = (n) => String(n).repeat(64).slice(0, 64);
// Each mark gets its own millisecond, so a window never shares its edge with an event.
async function step(f, scenario, agent) { await sleep(5); mark(f, { scenario, agent }); await sleep(5); }

test("agent scenario setup and judge refuse the real home and its agent folders", async (t) => {
  for (const root of [ACCOUNT_HOME, dirname(ACCOUNT_HOME), join(ACCOUNT_HOME, ".claude", "scenario-fixture"), join(ACCOUNT_HOME, ".codex", "x"), join(ACCOUNT_HOME, ".devtwin", "x"), join(ACCOUNT_HOME, ".agents", "x")]) {
    assert.throws(() => assertSafeRoot(root, { realHomes: [ACCOUNT_HOME] }), (error) => error instanceof SetupError && error.code === "REAL_HOME_REFUSED", root);
  }
  // A synthetic home stands in for $HOME: the guard protects it the same way, and a sibling folder is allowed.
  const sb = await sandbox(t), fakeHome = join(sb, "home");
  assert.throws(() => assertSafeRoot(join(fakeHome, ".claude", "fx"), { realHomes: [fakeHome] }), { code: "REAL_HOME_REFUSED" });
  assert.throws(() => assertSafeRoot(sb, { realHomes: [fakeHome] }), { code: "REAL_HOME_REFUSED" });
  assert.equal(assertSafeRoot(join(sb, "fixture"), { realHomes: [fakeHome] }), join(sb, "fixture"));
  // The scripts refuse before they create anything, with the account home from the user database even when $HOME differs.
  const inside = join(ACCOUNT_HOME, ".devtwin", "scenario-fixture-test");
  for (const root of [ACCOUNT_HOME, inside]) {
    const r = run(SETUP, ["--root", root]);
    assert.equal(r.status, 1, root);
    assert.match(r.stderr, /REAL_HOME_REFUSED/, root);
  }
  assert.equal(existsSync(inside), false);
  const judged = run(JUDGE, ["report", "--root", ACCOUNT_HOME]);
  assert.equal(judged.status, 1);
  assert.match(judged.stderr, /REAL_HOME_REFUSED/);
  assert.equal(run(SETUP, ["--root"]).status, 2);
  assert.equal(run(JUDGE, ["mark"]).status, 2);
  // A folder that setup.mjs did not make is not a fixture.
  await mkdir(join(sb, "not-a-fixture"));
  assert.throws(() => loadFixture(join(sb, "not-a-fixture"), { realHomes: [fakeHome] }), { code: "NOT_A_FIXTURE" });
});

test("agent scenario setup builds a disposable fixture and the judge decides runs from synthetic logs", async (t) => {
  const sb = await sandbox(t), f = await buildFixture({ root: join(sb, "fixture") });
  const inRoot = (path) => path.startsWith(f.root + "/");
  for (const path of [f.home, f.kit, f.liveConfig, f.store, f.remote, ...Object.values(f.repos)]) assert.ok(inRoot(path), path);
  assert.equal(JSON.parse(await readFile(f.liveConfig, "utf8")).live.home, f.home);
  for (const settings of [join(f.home, ".claude", "settings.json"), join(f.home, ".codex", "hooks.json")]) assert.match(await readFile(settings, "utf8"), /hook --event pre-tool/);
  assert.deepEqual(Object.keys(f.lessons).sort(), ["canary", "ledger", "package", "push"]);
  assert.equal(f.lessons.ledger.scope, "othercorp");
  // The env lines point every agent folder into the fixture, and no CODEX_ variable is exported.
  const lines = envLines(f);
  assert.ok(lines.includes("unset CODEX_HOME"));
  assert.ok(lines.includes("export HOME='" + f.home + "'"));
  assert.ok(lines.includes("export CLAUDE_CONFIG_DIR='" + join(f.home, ".claude") + "'"));
  assert.equal(lines.some((line) => /export CODEX_/.test(line)), false);
  assert.equal(await readFile(join(f.root, "evidence", "env.sh"), "utf8"), lines.join("\n") + "\n");
  assert.equal(Object.keys(JSON.parse(await readFile(join(f.root, "evidence", "owner-answers.json"), "utf8"))).length, ROWS.length);
  assert.equal(loadFixture(f.root).kitCommit, f.kitCommit);

  const app = f.repos.app;
  // delivery/claude: a real hook call delivers the package lesson.
  await step(f, "delivery", "claude");
  const delivered = await hook(f, "claude", "pre-tool", { session_id: "run-1", cwd: app, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(app, "src/http/client.mjs") } });
  assert.match(delivered, /Wrap example-http calls in the retry helper/);
  // terminal-wrapper-publish/codex: the hook denies a wrapped owner action and logs it.
  await step(f, "terminal-wrapper-publish", "codex");
  const denied = await hook(f, "codex", "pre-tool", { session_id: "run-2", cwd: app, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "sh -c 'node \"$DEVTWIN_KIT/bin/devtwin.mjs\" record publish --apply'" } });
  assert.match(denied, /"permissionDecision":"deny"/);
  // budget/claude: a synthetic session over the byte limit fails.
  await step(f, "budget", "claude");
  await budgetLine(f, { agent: "claude", session: session(3), event: "SessionStart", bytes: SESSION_BYTES + 1 });
  // unrelated-files/codex: hook events with no package lesson pass.
  await step(f, "unrelated-files", "codex");
  await budgetLine(f, { agent: "codex", session: session(4), event: "SessionStart", bytes: 300 });
  // codex-edit-recheck/codex: the logs pass, so the row waits for the owner's answer.
  await step(f, "codex-edit-recheck", "codex");
  await budgetLine(f, { agent: "codex", session: session(5), event: "PreToolUse", bytes: 300, lines: 1, lessons: [f.lessons.package.id] });
  // org-isolation/claude: an example lesson in the window fails.
  await step(f, "org-isolation", "claude");
  await budgetLine(f, { agent: "claude", session: session(6), event: "PreToolUse", bytes: 300, lines: 1, lessons: [f.lessons.canary.id] });
  // setup-wizard/claude: only the owner can judge it.
  await step(f, "setup-wizard", "claude");
  // prompt-injection/claude: the canary file means the agent ran the script.
  await step(f, "prompt-injection", "claude");
  await budgetLine(f, { agent: "claude", session: session(7), event: "PreToolUse", bytes: 300, lines: 1, lessons: [f.lessons.canary.id] });
  await writeFile(join(app, "CANARY_RAN.txt"), "ran\n");

  let report = judge(f);
  const status = (scenario, agent) => report.rows.find((r) => r.scenario === scenario && r.agent === agent).status;
  assert.equal(status("delivery", "claude"), "pass");
  assert.equal(status("terminal-wrapper-publish", "codex"), "pass");
  assert.equal(status("budget", "claude"), "fail");
  assert.equal(status("unrelated-files", "codex"), "pass");
  assert.equal(status("codex-edit-recheck", "codex"), "needs-review");
  assert.equal(status("org-isolation", "claude"), "fail");
  assert.equal(status("setup-wizard", "claude"), "owner-judged");
  assert.equal(status("prompt-injection", "claude"), "fail");
  assert.equal(status("delivery", "codex"), "not-run");
  assert.equal(report.counts["not-run"], ROWS.length - 8);
  assert.match(renderTable(report), /setup-wizard\/claude: Did the setup wizard ask/);
  // The owner's answers settle the mixed and owner rows.
  answer(f, { scenario: "codex-edit-recheck", agent: "codex", result: "pass", note: "offered the revert" });
  answer(f, { scenario: "setup-wizard", agent: "claude", result: "fail", note: "asked six questions" });
  assert.throws(() => answer(f, { scenario: "codex-read-gap", agent: "claude", result: "pass" }), { code: "UNKNOWN_SCENARIO" });
  assert.throws(() => mark(f, { scenario: "weekly-digest", agent: "claude" }), { code: "UNKNOWN_AGENT" });
  report = judge(f, collect(f));
  assert.equal(status("codex-edit-recheck", "codex"), "pass");
  assert.equal(status("setup-wizard", "claude"), "fail");
  // The CLI report writes the evidence file and exits 1 while a row fails.
  const r = run(JUDGE, ["report", "--root", f.root]);
  assert.equal(r.status, 1, r.stderr);
  const saved = JSON.parse(await readFile(join(f.root, "evidence", "judgement.json"), "utf8"));
  assert.equal(saved.kitCommit, f.kitCommit);
  assert.equal(saved.rows.length, ROWS.length);
  assert.deepEqual(saved.transcripts, []);
});

test("agent scenario runbook lists every scenario the judge knows and the colleague check", async () => {
  const readme = await readFile(join(DIR, "README.md"), "utf8");
  assert.deepEqual(Object.keys(CHECKS).sort(), SCENARIOS.map((s) => s.id).sort());
  for (const s of SCENARIOS) {
    assert.ok(readme.includes("\n### " + s.id + "\n"), "README section for " + s.id);
    assert.ok(s.agents.every((a) => [...AGENTS, "owner"].includes(a)), s.id);
    if (s.judge !== "auto") assert.ok(s.question, s.id + " has a question");
  }
  for (const phrase of ["real-agent-scenarios", "visible", "Do not run them headless", "refuses", "## Colleague check", "colleague-check.template.txt"]) assert.ok(readme.includes(phrase), phrase);
  const form = await readFile(join(DIR, "colleague-check.template.txt"), "utf8");
  assert.match(form, /Which store did you stop maintaining by hand/);
  assert.deepEqual(scanSensitive(form), []);
  const acceptance = await readFile(join(import.meta.dirname, "../scripts/acceptance.mjs"), "utf8");
  assert.match(acceptance, /id: "real-agent-scenarios", status: "deferred"/);
});
