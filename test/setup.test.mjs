import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { mkdir, chmod, readFile, readdir, lstat } from "node:fs/promises";
import { sandbox, makeRepo, fixtureGit, runCli, treeSnapshot, initPilot, makePilot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { SKILL_NAMES } from "../src/agents/install.mjs";
import { ownerAction, OWNER_ACTIONS, OWNER_SETUP_STEPS } from "../src/hooks/owner-block.mjs";
import { STEPS, OWNER_STEPS } from "../src/setup/steps.mjs";
import { readPersonalSnapshot } from "../src/records/personal.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";

const SKILLS = join(import.meta.dirname, "..", "skills");
const COMPOSE = "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n";
const REPO_FILES = {
  "README.md": "# Atlas\nBilling API.\n",
  "package.json": '{"name":"atlas","scripts":{"test":"node --test"},"dependencies":{"pg":"8.0.0"}}',
  "docker-compose.yml": COMPOSE,
  "Dockerfile": "FROM node:22\n"
};
// A fresh fixture home: a private ~/.devtwin with a pinned kit clone that holds the bundled skills, the agent folders,
// and one repository with services. live init and init run through the CLI, as the owner runs them before setup.
async function setupHome(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills", ".codex"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kitFiles = { "README.md": "kit\n" };
  for (const name of SKILL_NAMES) kitFiles["skills/" + name + "/SKILL.md"] = await readFile(join(SKILLS, name, "SKILL.md"), "utf8");
  const kit = await makeRepo(join(devtwin, "kit"), kitFiles);
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const repo = await makeRepo(join(sb, "work/atlas"), REPO_FILES);
  const liveConfig = join(devtwin, "live.json");
  // The owner steps that show the owner dialog (paths-confirm) get an approving fake; no test shows a real dialog.
  const cli = async (args) => runCli(args, { home, env: {}, kitRoot: kit, ownerDialog: () => "approved" });
  const ok = async (args) => {
    const out = await cli(args);
    assert.equal(out.json.ok, true, args.slice(0, 2).join(" ") + ": " + JSON.stringify(out.json.error));
    return out.json.result;
  };
  const initArgs = ["--pilot", liveConfig, "--agent", "claude", "--agent", "codex", "--repo", repo];
  const preview = await ok(["live", "init", ...initArgs]);
  await ok(["live", "init", ...initArgs, "--apply", "--plan-fingerprint", preview.fingerprint]);
  await ok(["init", "--pilot", liveConfig, "--actor", "email:owner@example.com", "--apply"]);
  const inputs = ["--work", "Backend services", "--preference", "autonomy=ask-first", "--scope", "example", "--project", "example.atlas", "--repo", repo, "--accept", "all"];
  const context = { home, env: {}, kitRoot: kit };
  const roots = async () => rootsFromPilot(await loadPilot(liveConfig, context));
  return { sb, home, devtwin, kit, repo, liveConfig, cli, ok, inputs, roots, store: join(devtwin, "store") };
}
// Every file below the home, relative, except the store's own files.
async function homeFiles(home) {
  const out = [];
  async function walk(dir, rel) {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), r = rel ? rel + "/" + name : name, st = await lstat(path);
      if (r === ".devtwin/store" || r === ".devtwin/kit") continue;
      if (st.isDirectory()) await walk(path, r); else out.push(r);
    }
  }
  await walk(home, "");
  return out;
}
// Drives the terminal loop with injected streams. Each "Apply step <id>? [y/N]" prompt gets answers[id] or "y".
async function drive(h, answers = {}, { tty = true, args = h.inputs } = {}) {
  const input = new PassThrough(), asked = [];
  let text = "";
  const output = new Writable({ write(chunk, _encoding, done) {
    text += chunk;
    const m = /Apply step ([a-z0-9-]+)\? \[y\/N\] $/.exec(text);
    if (m) { asked.push(m[1]); input.write((answers[m[1]] ?? "y") + "\n"); }
    done();
  } });
  input.isTTY = tty;
  output.isTTY = tty;
  const code = await main(["setup", "--pilot", h.liveConfig, ...args], { stdin: input, stdout: output, now, home: h.home, env: {}, kitRoot: h.kit, ownerDialog: () => "approved" });
  input.end();
  return { code, text, asked };
}
const available = () => STEPS.filter((s) => s.available === true).map((s) => s.id);

test("setup runs every available step on a fixture home and reaches a working brief", async (t) => {
  const h = await setupHome(t);
  const repoBefore = await treeSnapshot(h.repo), filesBefore = await homeFiles(h.home);
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig, ...h.inputs]);
  assert.deepEqual(status.steps.map((s) => s.id), STEPS.map((s) => s.id));
  for (const id of available()) {
    const plan = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--step", id, ...h.inputs]);
    assert.equal(plan.problem, undefined, id + ": " + JSON.stringify(plan.problem));
    if (plan.step.done || plan.fingerprint === null) continue;
    const applied = await h.ok(["setup", "apply", "--pilot", h.liveConfig, "--step", id, ...h.inputs, "--plan-fingerprint", plan.fingerprint]);
    assert.equal(applied.step.id, id);
  }
  const after = await h.ok(["setup", "status", "--pilot", h.liveConfig, ...h.inputs]);
  // In solo mode (no --hub-remote) the hub steps are skipped, not done.
  for (const step of after.steps) assert.equal(step.done || /^(?:solo mode|no hub joined|no --push-repo|launch agent not approved)/.test(step.skipped ?? ""), step.available === true, step.id);
  const brief = await h.ok(["context", "brief", "--pilot", h.liveConfig, "--scope", "example", "--cwd", h.repo]);
  assert.equal(brief.project, "example.atlas");
  assert.ok(brief.records.length > 0, "the brief holds the onboarded records");
  assert.equal(brief.receipt.profile.generation, 1, "the brief carries the setup profile");
  // Writes outside the store land only in approved places: devtwin skill entries, the two hook targets and live.json.
  const added = (await homeFiles(h.home)).filter((f) => !filesBefore.includes(f));
  for (const file of added) assert.match(file, /^(?:\.claude\/skills\/devtwin-[a-z-]+\/|\.agents\/skills\/devtwin-[a-z-]+\/|\.claude\/settings\.json$|\.codex\/hooks\.json$)/, file);
  assert.ok(added.includes(".claude/settings.json") && added.includes(".codex/hooks.json"));
  assert.equal(await treeSnapshot(h.repo), repoBefore, "setup never writes into the repository");
  const config = JSON.parse(await readFile(h.liveConfig, "utf8"));
  assert.deepEqual(config.writeClasses, { hookTargets: [join(h.home, ".claude/settings.json"), join(h.home, ".codex/hooks.json")] });
  const personal = await readPersonalSnapshot(await h.roots());
  assert.ok(personal.records.some((r) => r.kind === "preference" && r.requestId.startsWith("req_setup_starter_")));
  assert.ok(personal.records.some((r) => r.kind === "preference" && r.requestId.startsWith("req_setup_sandbox_")));
});

test("setup terminal loop with injected answers applies a yes, skips a no, and passes the hub step in solo mode", async (t) => {
  const h = await setupHome(t);
  const run = await drive(h, { profile: "n", "skills-codex": "n" });
  assert.equal(run.code, 0, run.text);
  assert.ok(!run.asked.includes("hub-join"), "the hub step is not offered");
  assert.ok(run.asked.includes("profile") && run.asked.includes("sandbox"));
  assert.ok(run.asked.indexOf("sandbox") > run.asked.indexOf("profile"));
  assert.match(run.text, /\[hub-join\][^\n]*\n\s*Skipped: solo mode/);
  assert.match(run.text, /\[job-hub-sync\][^\n]*\n\s*Skipped: no hub joined/);
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig, ...h.inputs]);
  const done = Object.fromEntries(status.steps.map((s) => [s.id, s.done]));
  assert.equal(done.profile, false, "a no writes nothing");
  assert.equal(done["skills-codex"], false);
  assert.equal(done["skills-claude"], true);
  assert.equal(done.sandbox, true, "steps after the hub step still run");
  assert.equal(done["hub-join"], false);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses), ["hookTargets"], "no hub root: solo mode");
  assert.equal((await h.ok(["profile", "show", "--pilot", h.liveConfig])).generation, 0);
});

test("setup re-run shows completed steps as done and changes nothing", async (t) => {
  const h = await setupHome(t);
  const first = await drive(h);
  assert.equal(first.code, 0, first.text);
  const before = await treeSnapshot(h.home);
  const again = await drive(h);
  assert.equal(again.code, 0, again.text);
  assert.deepEqual(again.asked, []);
  for (const id of available()) assert.match(again.text, new RegExp("\\[" + id + "\\][^\\n]*\\n[^\\n]*(?:done|Skipped: (?:solo mode|no hub joined|no --push-repo|launch agent not approved))", "m"), id);
  assert.equal(await treeSnapshot(h.home), before);
  const status = await h.ok(["setup", "status", "--pilot", h.liveConfig, ...h.inputs]);
  assert.deepEqual(status.steps.filter((s) => s.available === true && !s.done && !s.skipped).map((s) => s.id), []);
  assert.equal(await treeSnapshot(h.home), before);
});

test("setup previews show what, why and undo for each step before any write", async (t) => {
  const h = await setupHome(t);
  const before = await treeSnapshot(h.home);
  for (const step of STEPS) {
    const plan = await h.ok(["setup", "plan", "--pilot", h.liveConfig, "--step", step.id, ...h.inputs]);
    for (const key of ["what", "why", "undo"]) assert.ok(typeof plan.step[key] === "string" && plan.step[key].length > 10, step.id + " " + key);
    assert.equal(plan.step.available, step.available);
    if (step.available !== true) assert.match(step.available, /^not available yet \(P[345]\)$/);
  }
  assert.equal(await treeSnapshot(h.home), before, "plans write nothing");
  // In the terminal loop, each prompt comes after the step's what, why, undo and preview.
  const run = await drive(h, Object.fromEntries(STEPS.map((s) => [s.id, "n"])));
  assert.ok(run.asked.length > 5, run.text);
  for (const id of run.asked) {
    const at = run.text.indexOf("Apply step " + id + "?"), start = run.text.lastIndexOf("[" + id + "]", at);
    const screen = run.text.slice(start, at);
    for (const label of ["What:", "Why:", "Undo:", "Preview:"]) assert.ok(screen.includes(label), id + " " + label);
  }
  assert.equal(await treeSnapshot(h.home), before, "a no to every step writes nothing");
  // An unknown step and a stale fingerprint are refused.
  assert.equal((await h.cli(["setup", "plan", "--pilot", h.liveConfig, "--step", "nope"])).json.error.code, "DEVTWIN_INVALID_INPUT");
  const stale = await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--step", "profile", ...h.inputs, "--plan-fingerprint", "sha256:" + "0".repeat(64)]);
  assert.equal(stale.json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.equal((await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--step", "starter-templates", "--plan-fingerprint", "sha256:00"])).json.error.code, "DEVTWIN_UNAVAILABLE");
  assert.equal((await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--step", "job-radar", "--plan-fingerprint", "sha256:00"])).json.error.code, "DEVTWIN_GATE_REQUIRED", "a job without an approved plist is skipped");
  assert.equal((await h.cli(["setup", "apply", "--pilot", h.liveConfig, "--step", "hub-join", "--plan-fingerprint", "sha256:00"])).json.error.code, "DEVTWIN_GATE_REQUIRED", "solo mode skips the hub step");
  assert.equal((await h.ok(["profile", "show", "--pilot", h.liveConfig])).generation, 0, "a refused apply writes no profile");
});

test("setup terminal loop without a TTY refuses and points to the setup skill", async (t) => {
  const h = await setupHome(t);
  const before = await treeSnapshot(h.home);
  const out = await h.cli(["setup", "--pilot", h.liveConfig]);
  assert.equal(out.code, 1);
  assert.equal(out.json.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.match(out.json.error.details.remedy, /devtwin-setup/);
  assert.match(out.json.error.details.remedy, /setup status/);
  const piped = await drive(h, {}, { tty: false });
  assert.equal(piped.code, 1);
  assert.equal(JSON.parse(piped.text).error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(await treeSnapshot(h.home), before);
});

test("live write-classes previews, applies, clears and refuses a path outside the allowed shapes", async (t) => {
  const h = await setupHome(t);
  const settings = join(h.home, ".claude/settings.json"), codex = join(h.home, ".codex/hooks.json");
  const before = await readFile(h.liveConfig, "utf8");
  const args = ["live", "write-classes", "--pilot", h.liveConfig, "--hook-target", settings, "--hook-target", codex];
  const preview = await h.ok(args);
  assert.equal(preview.preview, true);
  assert.deepEqual(preview.writeClasses, { from: null, to: { hookTargets: [settings, codex] } });
  assert.equal(await readFile(h.liveConfig, "utf8"), before, "preview writes nothing");
  assert.equal((await h.cli([...args, "--apply"])).json.error.code, "DEVTWIN_PLAN_REQUIRED");
  assert.equal((await h.cli([...args, "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)])).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  const applied = await h.ok([...args, "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.equal(applied.applied, true);
  assert.deepEqual(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses, { hookTargets: [settings, codex] });
  // The config still loads with its approval, and the same request again is refused as a no-op.
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig])).json.ok, true);
  assert.equal((await h.cli(args)).json.error.code, "DEVTWIN_INVALID_INPUT");
  // A path outside the class shapes is refused, and nothing changes.
  const approved = await readFile(h.liveConfig, "utf8");
  for (const bad of [join(h.home, ".claude/settings.local.json"), join(h.sb, "elsewhere/settings.json"), "relative/settings.json"]) {
    const out = await h.cli(["live", "write-classes", "--pilot", h.liveConfig, "--hook-target", bad]);
    assert.equal(out.json.ok, false, bad);
    assert.ok(["DEVTWIN_GATE_REQUIRED", "DEVTWIN_PATH_UNSAFE"].includes(out.json.error.code), bad + " " + out.json.error.code);
  }
  assert.equal((await h.cli(["live", "write-classes", "--pilot", h.liveConfig, "--clear", "nope"])).json.error.code, "DEVTWIN_INVALID_INPUT");
  assert.equal((await h.cli(["live", "write-classes", "--pilot", h.liveConfig])).json.error.code, "DEVTWIN_INVALID_INPUT");
  assert.equal(await readFile(h.liveConfig, "utf8"), approved);
  const clear = await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--clear", "hookTargets"]);
  assert.deepEqual(clear.writeClasses, { from: { hookTargets: [settings, codex] }, to: null });
  await h.ok(["live", "write-classes", "--pilot", h.liveConfig, "--clear", "hookTargets", "--apply", "--plan-fingerprint", clear.fingerprint]);
  assert.equal(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses, undefined);
});

test("live write-classes approves a backup folder with --backup-target", async (t) => {
  const h = await setupHome(t);
  const backups = join(h.home, "devtwin-backups");
  const args = ["live", "write-classes", "--pilot", h.liveConfig, "--backup-target", backups];
  const preview = await h.ok(args);
  assert.deepEqual(preview.writeClasses, { from: null, to: { backupTargets: [backups] } });
  await h.ok([...args, "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.deepEqual(JSON.parse(await readFile(h.liveConfig, "utf8")).writeClasses, { backupTargets: [backups] });
  assert.equal((await h.cli(["doctor", "--pilot", h.liveConfig])).json.ok, true);
});

test("owner block denies live write-classes apply, owner setup steps and the setup loop from an agent shell", async (t) => {
  const p = await makePilot(t);
  const bash = (command) => ({ session_id: "s-setup", cwd: p.reposDir, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "toolu_01Example" });
  const KIT = 'node "$DEVTWIN_KIT/bin/devtwin.mjs"';
  assert.ok(OWNER_ACTIONS.some((a) => a.words.join(" ") === "live write-classes" && a.apply === true));
  assert.deepEqual([...OWNER_SETUP_STEPS].sort(), [...OWNER_STEPS].sort(), "the hook list matches the owner steps");
  const denied = [
    `${KIT} live write-classes --pilot '/x/live.json' --hook-target '/h/.claude/settings.json' --apply --plan-fingerprint 'sha256:00'`,
    "script -q /dev/null devtwin live write-classes --apply",
    ...OWNER_STEPS.map((id) => `${KIT} setup apply --pilot '/x/live.json' --step '${id}' --plan-fingerprint 'sha256:00'`),
    `${KIT} setup apply --pilot /x/live.json --step=skills-claude`,
    `${KIT} setup --pilot '/x/live.json'`,
    "unbuffer devtwin setup --pilot /x/live.json"
  ];
  for (const command of denied) {
    assert.ok(ownerAction("claude", bash(command)), command);
    const chunks = [];
    await main(["hook", "--event", "pre-tool", "--agent", "claude", "--pilot", p.path], { stdout: { write: (v) => { chunks.push(v); return true; } }, stdin: JSON.stringify(bash(command)), now });
    assert.equal(JSON.parse(chunks.join("")).hookSpecificOutput.permissionDecision, "deny", command);
  }
  for (const command of [
    `${KIT} live write-classes --pilot '/x/live.json' --hook-target '/h/.claude/settings.json'`,
    `${KIT} setup status --pilot '/x/live.json'`,
    `${KIT} setup plan --pilot '/x/live.json' --step skills-claude`,
    `${KIT} setup apply --pilot '/x/live.json' --step profile --plan-fingerprint 'sha256:00'`,
    `${KIT} setup apply --pilot '/x/live.json' --step sandbox --repo /r --plan-fingerprint 'sha256:00'`
  ]) assert.equal(ownerAction("claude", bash(command)), null, command);
});

test("setup sandbox recommendations for a repository with a compose file include a container note and write nothing", async (t) => {
  const p = await initPilot(t);
  const repo = await makeRepo(join(p.reposDir, "atlas"), { ...REPO_FILES, ".env.example": "DATABASE_URL=postgres://localhost/example\n" });
  const plain = await makeRepo(join(p.reposDir, "beacon"), { "README.md": "# Beacon\n" });
  const cli = async (args) => (await runCli([...args, "--pilot", p.path])).json;
  const before = await treeSnapshot(p.sandbox);
  const plan = await cli(["setup", "plan", "--step", "sandbox", "--repo", repo]);
  assert.equal(plan.ok, true, JSON.stringify(plan.error));
  const recs = plan.result.preview.recommendations;
  const ids = recs.map((r) => r.id);
  assert.ok(ids.includes("container"), ids.join(","));
  assert.ok(ids.includes("claude-sandbox") && ids.includes("codex-sandbox"));
  const container = recs.find((r) => r.id === "container");
  assert.match(container.text, /docker compose/i);
  assert.deepEqual(plan.result.preview.signals.services.sort(), ["postgres", "redis"]);
  assert.ok(plan.result.preview.signals.files.includes("docker-compose.yml"));
  assert.ok(plan.result.preview.signals.files.includes(".env.example"));
  assert.match(recs.find((r) => r.id === "codex-sandbox").text, /--sandbox workspace-write/);
  assert.equal(plan.result.preview.writesAgentSettings, false);
  assert.equal(JSON.stringify(plan.result).includes("postgres://"), false, "env values are never read");
  assert.equal(await treeSnapshot(p.sandbox), before, "the preview writes nothing");
  const none = await cli(["setup", "plan", "--step", "sandbox", "--repo", plain]);
  assert.ok(!none.result.preview.recommendations.some((r) => r.id === "container"));
  // Accepting one recommendation records it as a personal preference and writes no agent setting.
  const one = await cli(["setup", "plan", "--step", "sandbox", "--repo", repo, "--recommendation", "container"]);
  assert.deepEqual(one.result.preview.records.map((r) => r.recommendation), ["container"]);
  const applied = await cli(["setup", "apply", "--step", "sandbox", "--repo", repo, "--recommendation", "container", "--plan-fingerprint", one.result.fingerprint]);
  assert.equal(applied.ok, true, JSON.stringify(applied.error));
  const prefs = (await readPersonalSnapshot(p.roots)).records;
  assert.deepEqual(prefs.map((r) => [r.kind, r.reach]), [["preference", "personal"]]);
  for (const home of p.agentHomes) assert.deepEqual(await readdir(home), [], "no agent setting");
  assert.equal((await cli(["setup", "status", "--repo", repo])).result.steps.find((s) => s.id === "sandbox").done, true);
  assert.equal((await cli(["setup", "plan", "--step", "sandbox", "--repo", repo, "--recommendation", "nope"])).result.problem.code, "DEVTWIN_INVALID_INPUT");
  assert.equal((await cli(["setup", "plan", "--step", "sandbox", "--repo", join(p.sandbox, "elsewhere")])).result.problem.code, "DEVTWIN_GATE_REQUIRED");
});
