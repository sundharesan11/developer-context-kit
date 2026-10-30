import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { makePilot, sandbox, makeRepo, fixtureGit, runCli, onboardFixture, draftFor, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot, skillDirsFor, agentDirsFor } from "../src/config/pilot.mjs";
import { AGENT_IDS, adapter, supportLevel, support, skillPeers, actorOf } from "../src/agents/adapters/index.mjs";
import { planHooks, applyHooks, hookStatus, expectedEntries, hookContext } from "../src/agents/hooks-install.mjs";
import { SKILL_NAMES } from "../src/agents/install.mjs";
import { OWNER_SETUP_STEPS, DENY_REASON, ownerAction } from "../src/hooks/owner-block.mjs";
import { STEPS, OWNER_STEPS } from "../src/setup/steps.mjs";
import { BATCH_ORDER } from "../src/setup/batch.mjs";
import { callerActor, ACTORS } from "../src/policy/actor.mjs";
import { applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord } from "../src/records/store.mjs";
import { rebuildIndex } from "../src/lessons/index.mjs";
import { writeKitReceipt } from "../src/hooks/receipt.mjs";
import { NOTICE } from "../src/hooks/commands.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
const BIN = join(KIT, "bin/devtwin.mjs");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const base = (cwd, event, extra = {}) => ({ session_id: "gem-session-0001", transcript_path: "/tmp/example/chat.json", cwd, hook_event_name: event, timestamp: "2026-10-07T00:00:00.000Z", ...extra });
const tool = (cwd, event, name, input, extra = {}) => base(cwd, event, { tool_name: name, tool_input: input, original_request_name: name, ...extra });
const OWNER_COMMAND = 'node "/opt/example-kit/bin/devtwin.mjs" live set-kit --pilot /x/live.json --kit /x/kit --apply --plan-fingerprint sha256:00';

test("agent registry: ordered ids, unknown ids refused, declared paths and support levels", () => {
  assert.deepEqual(AGENT_IDS, ["claude", "codex", "gemini"]);
  for (const id of ["antigravity", "", "Claude", undefined]) assert.throws(() => adapter(id), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "agent", String(id));
  const home = "/h/example";
  assert.deepEqual(skillDirsFor({ home, env: {} }), { claude: "/h/example/.claude/skills", codex: "/h/example/.agents/skills", gemini: "/h/example/.agents/skills" });
  assert.deepEqual(skillDirsFor({ home, env: { CLAUDE_CONFIG_DIR: "/h/example/cc" } }).claude, "/h/example/cc/skills");
  assert.deepEqual(agentDirsFor({ home, env: {} }), { claude: "/h/example/.claude", codex: "/h/example/.codex", gemini: "/h/example/.gemini" });
  assert.deepEqual(AGENT_IDS.map((id) => [adapter(id).instructions.file, adapter(id).hooks.file]), [["CLAUDE.md", "settings.json"], ["AGENTS.md", "hooks.json"], ["GEMINI.md", "settings.json"]]);
  assert.deepEqual(AGENT_IDS.map((id) => adapter(id).actor), AGENT_IDS);
  assert.deepEqual([skillPeers("claude"), skillPeers("codex"), skillPeers("gemini")], [[], ["gemini"], ["codex"]]);
  assert.deepEqual(adapter("codex").skills.legacy, [".codex/skills"]);
  // supportLevel: "full" needs skills, instructions and the owner-action block; any one missing makes it partial.
  const all = { skills: true, instructions: true, sessionStartContext: true, preToolContext: true, ownerBlock: true, stopHook: true };
  assert.equal(supportLevel(all), "full");
  for (const flag of ["skills", "instructions", "ownerBlock"]) assert.equal(supportLevel({ ...all, [flag]: false }), "partial", flag);
  for (const flag of ["sessionStartContext", "preToolContext", "stopHook"]) assert.equal(supportLevel({ ...all, [flag]: false }), "full", flag);
  assert.deepEqual(AGENT_IDS.map((id) => support(id).supportLevel), ["full", "full", "full"]);
  assert.deepEqual(support("gemini"), { agent: "gemini", name: "Gemini CLI", supportLevel: "full", capabilities: { skills: true, instructions: true, sessionStartContext: true, preToolContext: false, ownerBlock: true, stopHook: true } });
  // Actor detection, in registry order: CLAUDECODE wins over CODEX_*, and both over GEMINI_CLI.
  assert.deepEqual([actorOf({ GEMINI_CLI: "1" }), actorOf({ GEMINI_CLI: "1", CODEX_SANDBOX: "x" }), actorOf({ GEMINI_CLI: "1", CLAUDECODE: "1" }), actorOf({}), callerActor({ GEMINI_CLI: "1" })], ["gemini", "codex", "claude", "human", "gemini"]);
  assert.deepEqual(ACTORS, ["human", "claude", "codex", "gemini"]);
});

test("gemini parse normalizes SessionStart, BeforeAgent, BeforeTool, AfterTool, PreCompress, AfterAgent and SessionEnd payloads", () => {
  const { parse } = adapter("gemini").hooks, cwd = "/w/example";
  const pick = (n) => ({ event: n.event, sessionId: n.sessionId, cwd: n.cwd, toolKind: n.toolKind, toolName: n.toolName, command: n.command, paths: n.paths, edit: n.edit });
  assert.deepEqual(pick(parse(base(cwd, "SessionStart", { source: "startup" }))), { event: "SessionStart", sessionId: "gem-session-0001", cwd, toolKind: null, toolName: undefined, command: undefined, paths: [], edit: false });
  assert.equal(parse(base(cwd, "SessionStart", { source: "resume" })).source, "resume");
  assert.deepEqual([parse(base(cwd, "BeforeAgent", { prompt: "fix the migrations" })).event, parse(base(cwd, "BeforeAgent", { prompt: "fix the migrations" })).prompt], ["UserPromptSubmit", "fix the migrations"]);
  assert.deepEqual(pick(parse(tool(cwd, "BeforeTool", "run_shell_command", { command: "npm test -- db/seed.sql", description: "run" }))),
    { event: "PreToolUse", sessionId: "gem-session-0001", cwd, toolKind: "shell", toolName: "run_shell_command", command: "npm test -- db/seed.sql", paths: ["db/seed.sql"], edit: false });
  assert.deepEqual(pick(parse(tool(cwd, "BeforeTool", "read_file", { file_path: cwd + "/db/migrations/002_users.sql" }))),
    { event: "PreToolUse", sessionId: "gem-session-0001", cwd, toolKind: "read", toolName: "read_file", command: undefined, paths: [cwd + "/db/migrations/002_users.sql"], edit: false });
  for (const [name, input] of [["replace", { file_path: "db/x.sql", old_string: "a", new_string: "b", instruction: "fix" }], ["write_file", { file_path: "db/x.sql", content: "x" }]]) {
    const n = parse(tool(cwd, "AfterTool", name, input, { tool_response: { llmContent: "ok", returnDisplay: "ok" } }));
    assert.deepEqual([n.event, n.toolKind, n.paths, n.edit], ["PostToolUse", "edit", ["db/x.sql"], true], name);
  }
  assert.deepEqual(parse(tool(cwd, "AfterTool", "read_many_files", { include: ["db/a.sql", "src/**/*.ts", 7], recursive: true })).paths, ["db/a.sql"]);
  assert.deepEqual(parse(tool(cwd, "AfterTool", "grep_search", { pattern: "users", dir_path: "db" })).paths, ["db"]);
  assert.deepEqual([parse(base(cwd, "PreCompress", { trigger: "auto" })).event, parse(base(cwd, "AfterAgent", { prompt: "p", prompt_response: "r", stop_hook_active: false })).event], ["PreCompact", "Stop"]);
  // SessionEnd has no devtwin event: its name stays as sent, so it never matches an installed event.
  assert.equal(parse(base(cwd, "SessionEnd", { reason: "exit" })).event, "SessionEnd");
  // Claude Code and Codex names keep their own meaning in their own adapters only.
  assert.equal(parse(tool(cwd, "BeforeTool", "Bash", { command: "ls" })).toolKind, null);
  assert.equal(adapter("claude").hooks.parse(tool(cwd, "PreToolUse", "run_shell_command", { command: "ls" })).toolKind, null);
});

test("gemini format prints the exact Gemini CLI JSON for context and for a deny", () => {
  const { format } = adapter("gemini").hooks;
  assert.deepEqual(format({ kind: "deny", reason: DENY_REASON }), { stdout: { decision: "deny", reason: DENY_REASON }, exitCode: 0 });
  for (const [event, name] of [["SessionStart", "SessionStart"], ["UserPromptSubmit", "BeforeAgent"], ["PostToolUse", "AfterTool"]]) {
    assert.deepEqual(format({ kind: "context", event, text: "line" }), { stdout: { hookSpecificOutput: { hookEventName: name, additionalContext: "line" } }, exitCode: 0 }, event);
  }
  // Claude Code and Codex keep their PreToolUse deny shape.
  for (const id of ["claude", "codex"]) assert.deepEqual(adapter(id).hooks.format({ kind: "deny", reason: DENY_REASON }).stdout, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } });
});

// The owner-action block through the real hook entry point: a Gemini BeforeTool payload for an owner route gets a
// Gemini deny, in process and from the bin script, with no receipt and no valid store.
test("gemini owner-action block: a BeforeTool shell call that runs an owner route gets a Gemini deny", async (t) => {
  const p = await makePilot(t), cwd = p.reposDir;
  const payload = tool(cwd, "BeforeTool", "run_shell_command", { command: OWNER_COMMAND, description: "switch the kit" });
  assert.equal(ownerAction("gemini", payload), "live set-kit --apply");
  const chunks = [];
  const code = await main(["hook", "--event", "pre-tool", "--agent", "gemini", "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(payload), now });
  assert.equal(code, 0);
  assert.equal(chunks.join(""), JSON.stringify({ decision: "deny", reason: DENY_REASON }) + "\n");
  const run = spawnSync(process.execPath, [BIN, "hook", "--event", "pre-tool", "--agent", "gemini", "--pilot", p.path], { input: JSON.stringify(payload), env: { PATH: process.env.PATH, HOME: p.fakeHome }, encoding: "utf8" });
  assert.deepEqual([run.status, JSON.parse(run.stdout)], [0, { decision: "deny", reason: DENY_REASON }]);
  // Previews, other tools and a payload for another event are not denied.
  for (const body of [tool(cwd, "BeforeTool", "run_shell_command", { command: OWNER_COMMAND.replace(" --apply", "") }), tool(cwd, "BeforeTool", "write_file", { file_path: "x.sh", content: OWNER_COMMAND }), { ...payload, hook_event_name: "AfterTool" }]) {
    const out = [];
    await main(["hook", "--event", "pre-tool", "--agent", "gemini", "--pilot", p.path], { stdout: { write: (v) => { out.push(v); return true; } }, stdin: JSON.stringify(body), now });
    assert.equal(out.join(""), "", JSON.stringify(body.tool_input));
  }
});

// Lessons: Gemini reads no context from BeforeTool, so a matching file gives nothing there and its line on AfterTool.
test("gemini gets file and command lessons on AfterTool and none on BeforeTool", async (t) => {
  const SCOPE = "example", PROJECT = "example.atlas";
  const s = await onboardFixture(t, { scope: SCOPE, project: PROJECT });
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  const input = draftFor(SCOPE, PROJECT, { requestId: "req_gemlsn01", kind: "lesson", body: "Do run migrations before seeding the test database.\n" });
  input.draft = { ...input.draft, title: "Migrations before seeds", class: "lesson", reach: "project", match: { paths: ["db/migrations/**"], commands: ["npm run seed"], topics: ["migrations"] } };
  await addRecord(s.roots, input, { now });
  await rebuildIndex(s.roots, SCOPE);
  await writeKitReceipt(s.roots, { pilotPath: s.path, now: now() });
  const hook = async (event, body) => {
    const chunks = [];
    assert.equal(await main(["hook", "--event", event, "--agent", "gemini", "--pilot", s.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(body), now }), 0);
    const out = chunks.join("");
    return out ? JSON.parse(out) : null;
  };
  const file = join(s.repo, "db/migrations/002_users.sql");
  assert.equal(await hook("pre-tool", tool(s.repo, "BeforeTool", "read_file", { file_path: file })), null, "BeforeTool gives no context");
  assert.equal(await hook("pre-tool", tool(s.repo, "BeforeTool", "run_shell_command", { command: "npm run seed" })), null);
  const start = await hook("session-start", base(s.repo, "SessionStart", { source: "startup" }));
  assert.equal(start.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(start.hookSpecificOutput.additionalContext, /devtwin hook live: 1 lesson for example\.atlas/);
  const after = await hook("post-tool", tool(s.repo, "AfterTool", "replace", { file_path: file, old_string: "a", new_string: "b" }, { tool_response: { llmContent: "ok" } }));
  assert.deepEqual(Object.keys(after), ["hookSpecificOutput"]);
  assert.equal(after.hookSpecificOutput.hookEventName, "AfterTool");
  assert.ok(after.hookSpecificOutput.additionalContext.startsWith(NOTICE));
  assert.match(after.hookSpecificOutput.additionalContext, /Migrations before seeds/);
  // A shell command lesson arrives after the command, in a new session.
  const shell = await hook("post-tool", tool(s.repo, "AfterTool", "run_shell_command", { command: "npm run seed" }, { session_id: "gem-session-0002" }));
  assert.match(shell.hookSpecificOutput.additionalContext, /Migrations before seeds/);
  // AfterAgent writes the stop stub and prints nothing.
  assert.equal(await hook("stop", base(s.repo, "AfterAgent", { prompt: "p", prompt_response: "r", stop_hook_active: false })), null);
});

// A disposable pilot whose fake agent home has a Gemini folder approved as a hook target.
async function geminiPilot(t, settings) {
  const p = await makePilot(t), home = p.agentHomes[0], path = join(home, ".gemini/settings.json");
  await mkdir(join(home, ".gemini"), { recursive: true });
  if (settings !== undefined) await writeFile(path, settings, { mode: 0o644 });
  const pilotPath = await p.with({ writeClasses: { hookTargets: [path], instructionTargets: [join(home, ".gemini/GEMINI.md")] } });
  const pilot = await loadPilot(pilotPath, { home: p.fakeHome, kitRoot: "/nonexistent-kit", env: {} });
  return { ...p, home, settings: path, pilotPath, pilot, roots: rootsFromPilot(pilot) };
}
const hookInput = (h, mode = "install") => ({ targetHome: h.home, agents: ["gemini"], mode, kitRoot: KIT });
async function geminiHooks(h, mode, runId) {
  const plan = await planHooks(h.pilot, hookInput(h, mode));
  return { plan, result: await applyHooks(h.roots, h.pilot, hookInput(h, mode), { fingerprint: plan.fingerprint, runId, now: now() }) };
}

test("gemini hooks install into settings.json keeps other keys and hooks, is idempotent, and uninstall removes only devtwin's", async (t) => {
  const other = { matcher: "write_file|replace", hooks: [{ name: "security-check", type: "command", command: "example-check.sh", timeout: 5000 }] };
  const original = json({ mcpServers: { example: { command: "example-mcp" } }, hooks: { BeforeTool: [other] }, ui: { theme: "Default" } });
  const h = await geminiPilot(t, original);
  const context = hookContext(h.pilot, KIT), expected = expectedEntries("gemini", context), pilotPath = realpathSync(h.pilotPath);
  assert.deepEqual(Object.keys(expected), ["SessionStart", "BeforeAgent", "BeforeTool", "AfterTool", "PreCompress", "AfterAgent"]);
  assert.deepEqual(expected.BeforeTool, [{ matcher: "^run_shell_command$", hooks: [{ name: "devtwin-pre-tool", type: "command", command: 'node "' + KIT + '/bin/devtwin.mjs" hook --event pre-tool --agent gemini --pilot "' + pilotPath + '"', timeout: 10000 }] }]);
  assert.equal(expected.AfterTool[0].matcher, "^(run_shell_command|read_file|read_many_files|write_file|replace|glob|grep_search|search_file_content)$");
  assert.deepEqual(expected.SessionStart, [{ hooks: [{ name: "devtwin-session-start", type: "command", command: 'node "' + KIT + '/bin/devtwin.mjs" hook --event session-start --agent gemini --pilot "' + pilotPath + '"', timeout: 10000 }] }]);
  const { plan, result } = await geminiHooks(h, "install", "run_gemhook01");
  assert.deepEqual([plan.actions[0].agent, plan.actions[0].status, plan.notes], ["gemini", "update", []]);
  assert.equal(result.applied, true);
  const written = JSON.parse(await readFile(h.settings, "utf8"));
  assert.deepEqual(written, { mcpServers: { example: { command: "example-mcp" } }, hooks: { BeforeTool: [other, ...expected.BeforeTool], SessionStart: expected.SessionStart, BeforeAgent: expected.BeforeAgent, AfterTool: expected.AfterTool, PreCompress: expected.PreCompress, AfterAgent: expected.AfterAgent }, ui: { theme: "Default" } });
  // Idempotent: a second plan has nothing to write.
  const again = await planHooks(h.pilot, hookInput(h));
  assert.deepEqual(again.actions.map((a) => a.status), ["installed"]);
  let status = await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() });
  assert.deepEqual(status.agents.map((a) => [a.agent, a.status]), [["claude", "not-approved"], ["codex", "not-approved"], ["gemini", "installed"]]);
  // An edited devtwin entry shows as modified; a missing one as partial.
  const edited = structuredClone(written);
  edited.hooks.AfterAgent[0].hooks[0].timeout = 99;
  await writeFile(h.settings, json(edited));
  status = await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() });
  assert.equal(status.agents.find((a) => a.agent === "gemini").status, "modified");
  delete edited.hooks.AfterAgent;
  await writeFile(h.settings, json(edited));
  status = await hookStatus(h.pilot, { targetHome: h.home, kitRoot: KIT, now: now() });
  assert.equal(status.agents.find((a) => a.agent === "gemini").status, "partial");
  // Uninstall removes devtwin's entries only; the other tool's hook and every other key stay.
  await geminiHooks(h, "uninstall", "run_gemhook02");
  assert.deepEqual(JSON.parse(await readFile(h.settings, "utf8")), { mcpServers: { example: { command: "example-mcp" } }, hooks: { BeforeTool: [other] }, ui: { theme: "Default" } });
});

test("gemini instructions write a marker block to GEMINI.md", async (t) => {
  const h = await geminiPilot(t);
  const { applyInit } = await import("../src/config/store.mjs");
  await applyInit(h.roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  const dialogs = [];
  const cli = async (args) => {
    const chunks = [];
    await main([...args, "--pilot", h.pilotPath, "--home", h.home, "--agent", "gemini"], { now, home: h.fakeHome, env: {}, kitRoot: KIT, ownerDialog: async (c) => { dialogs.push(c); return "approved"; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return JSON.parse(chunks.join(""));
  };
  const plan = (await cli(["instructions", "plan"])).result;
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.role, a.path, a.status]), [["gemini", "block", join(h.home, ".gemini/GEMINI.md"), "create"]]);
  assert.equal((await cli(["instructions", "apply", "--plan-fingerprint", plan.fingerprint])).ok, true);
  assert.match(dialogs[0].body, /Every Claude Code, Codex and Gemini CLI session/);
  const text = await readFile(join(h.home, ".gemini/GEMINI.md"), "utf8");
  assert.ok(text.includes(plan.block), "the block itself, not an import");
});

test("setup lists skills-gemini and hooks-gemini as owner steps generated from the registry", () => {
  for (const id of AGENT_IDS) for (const step of ["skills-" + id, "hooks-" + id]) {
    assert.ok(STEPS.some((s) => s.id === step && s.agent === id), step);
    assert.ok(OWNER_STEPS.includes(step) && OWNER_SETUP_STEPS.includes(step) && BATCH_ORDER.includes(step), step);
  }
  assert.ok(BATCH_ORDER.indexOf("skills-gemini") < BATCH_ORDER.indexOf("paths-confirm") && BATCH_ORDER.indexOf("hooks-gemini") > BATCH_ORDER.indexOf("paths-confirm"));
  // An agent shell may not apply the Gemini owner steps alone.
  const shell = (command) => ({ session_id: "s", cwd: "/w", hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command } });
  for (const id of ["skills-gemini", "hooks-gemini"]) assert.equal(ownerAction("gemini", shell("devtwin setup apply --pilot /x/live.json --step " + id + " --plan-fingerprint sha256:00")), "setup apply --step " + id);
});

// A fixture home with a live config for Codex and Gemini CLI, which share ~/.agents/skills.
async function liveHome(t, agents) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".codex", ".gemini"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const files = { "README.md": "kit\n" };
  for (const name of SKILL_NAMES) files["skills/" + name + "/SKILL.md"] = await readFile(join(KIT, "skills", name, "SKILL.md"), "utf8");
  const kit = await makeRepo(join(devtwin, "kit"), files);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), { "README.md": "# Atlas\n" });
  const liveConfig = join(devtwin, "live.json");
  const ok = async (args) => {
    const out = await runCli(args, { home, env: {}, kitRoot: kit, ownerDialog: () => "approved" });
    assert.equal(out.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(out.json.error));
    return out.json.result;
  };
  const init = ["--pilot", liveConfig, ...agents.flatMap((a) => ["--agent", a]), "--repo", repo];
  const preview = await ok(["live", "init", ...init]);
  await ok(["live", "init", ...init, "--apply", "--plan-fingerprint", preview.fingerprint]);
  await ok(["init", "--pilot", liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  return { home, liveConfig, ok, skills: join(home, ".agents/skills"), preview };
}
const entries = async (dir) => (await readdir(dir)).filter((n) => n.startsWith("devtwin-")).sort();

test("live init accepts gemini, and Codex and Gemini share one skills install that an uninstall of one keeps", async (t) => {
  const h = await liveHome(t, ["codex", "gemini"]);
  assert.deepEqual(h.preview.config.live.skillDirs, { codex: h.skills, gemini: h.skills });
  const steps = (await h.ok(["setup", "status", "--pilot", h.liveConfig])).steps;
  assert.deepEqual(steps.filter((s) => s.agent).map((s) => [s.id, s.supportLevel, s.skipped ?? null]),
    [["skills-claude", "full", "agent not in the live config"], ["skills-codex", "full", null], ["skills-gemini", "full", null], ["hooks-claude", "full", "agent not in the live config"], ["hooks-codex", "full", null], ["hooks-gemini", "full", null]]);
  const args = ["agents", "install", "--pilot", h.liveConfig, "--agent", "codex", "--agent", "gemini"];
  const plan = await h.ok(args);
  assert.deepEqual(plan.agents, ["codex", "gemini"]);
  assert.deepEqual(plan.shared, [{ agent: "gemini", dir: h.skills, with: "codex" }]);
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.status]), SKILL_NAMES.map(() => ["codex", "create"]), "one write per skill, not two");
  await h.ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint]);
  assert.deepEqual(await entries(h.skills), [...SKILL_NAMES].sort());
  assert.ok((await h.ok(["agents", "install", "--pilot", h.liveConfig, "--agent", "gemini"])).actions.every((a) => a.agent === "gemini" && a.status === "installed"));
  // Uninstall for Gemini alone keeps the entries Codex still reads, and writes nothing.
  const bytes = await readFile(join(h.skills, "devtwin-record/SKILL.md"), "utf8");
  const remove = await h.ok(["agents", "uninstall", "--pilot", h.liveConfig, "--agent", "gemini"]);
  assert.ok(remove.actions.every((a) => a.status === "preserve" && a.reason === "shared-folder"), JSON.stringify(remove.actions));
  assert.deepEqual(remove.shared, [{ agent: "gemini", dir: h.skills, keptFor: ["codex"] }]);
  assert.equal((await h.ok(["agents", "uninstall", "--pilot", h.liveConfig, "--agent", "gemini", "--apply", "--plan-fingerprint", remove.fingerprint])).applied, false);
  assert.equal(await readFile(join(h.skills, "devtwin-record/SKILL.md"), "utf8"), bytes);
  const status = await h.ok(["agents", "status", "--pilot", h.liveConfig]);
  assert.deepEqual(status.support.map((s) => [s.agent, s.supportLevel]), [["claude", "full"], ["codex", "full"], ["gemini", "full"]]);
  assert.ok(status.actions.every((a) => a.status === "installed"));
  // Uninstall for both removes each entry once.
  const both = await h.ok(["agents", "uninstall", "--pilot", h.liveConfig, "--agent", "codex", "--agent", "gemini"]);
  assert.deepEqual(both.actions.map((a) => [a.agent, a.status]), SKILL_NAMES.map(() => ["codex", "remove"]));
  await h.ok(["agents", "uninstall", "--pilot", h.liveConfig, "--agent", "codex", "--agent", "gemini", "--apply", "--plan-fingerprint", both.fingerprint]);
  assert.deepEqual(await entries(h.skills), []);
});

test("doctor reports each agent's support level and capability flags", async (t) => {
  const p = await makePilot(t);
  const out = await runCli(["doctor", "--pilot", p.path], { home: p.fakeHome, env: {} });
  const agents = out.json.result.checks.find((c) => c.id === "agents");
  assert.equal(agents.status, "ok");
  assert.deepEqual(agents.detail.map((a) => [a.agent, a.supportLevel, a.capabilities.ownerBlock, a.capabilities.preToolContext]), [["claude", "full", true, true], ["codex", "full", true, true], ["gemini", "full", true, false]]);
});
