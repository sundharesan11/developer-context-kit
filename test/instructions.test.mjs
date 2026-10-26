import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { makePilot, now } from "./helpers.mjs";
import { main } from "../src/cli.mjs";
import { applyInit } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { addPersonalRecord } from "../src/records/personal.mjs";
import { MARKERS } from "../src/storage/owned-file.mjs";
import { renderBlock, RULES, BLOCK_CHARS, OWNED_FILE } from "../src/agents/instructions.mjs";

const KIT = realpathSync(join(import.meta.dirname, ".."));
// A disposable pilot whose first fake agent home has Claude and Codex folders approved as instruction targets.
async function setup(t, { claudeMd, agentsMd, approve = true } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0];
  const paths = { claudeMd: join(home, ".claude", "CLAUDE.md"), owned: join(home, ".claude", OWNED_FILE), agentsMd: join(home, ".codex", "AGENTS.md") };
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  if (claudeMd !== undefined) await writeFile(paths.claudeMd, claudeMd, { mode: 0o644 });
  if (agentsMd !== undefined) await writeFile(paths.agentsMd, agentsMd, { mode: 0o644 });
  const path = await p.with(approve ? { writeClasses: { instructionTargets: [paths.claudeMd, paths.owned, paths.agentsMd] } } : {});
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, kitRoot: KIT, env: {} }));
  await applyInit(await roots(), { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  const dialogs = [];
  const cli = async (args) => {
    const chunks = [];
    const code = await main([...args, "--pilot", path, "--home", home], { now, home: p.fakeHome, env: {}, kitRoot: KIT, ownerDialog: async (c) => { dialogs.push(c); return "approved"; }, stdout: { write: (v) => { chunks.push(v); return true; } } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => { const out = await cli(args); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const apply = async (extra = []) => { const plan = await ok(["instructions", "plan", ...extra]); return { plan, result: await ok(["instructions", "apply", ...extra, "--plan-fingerprint", plan.fingerprint]) }; };
  const pref = async (n, text, title = "Rule " + n) => addPersonalRecord(await roots(), { requestId: "req_prefrule" + String(n).padStart(4, "0"), recordedBy: { actor: "human", runId: "run_cli00001" }, draft: { kind: "preference", class: "lesson", reach: "personal", status: "observed", title, body: text + "\n" } }, { now: () => new Date(now().getTime() + n * 1000) });
  return { p, home, paths, cli, ok, apply, pref, dialogs, pilotPath: path };
}

test("instructions apply puts the preference into both agents' user-level files (AE8)", async (t) => {
  const s = await setup(t);
  await s.pref(1, "Use Playwright for browser checks, not a manual browser.", "Browser tests");
  const { plan, result } = await s.apply();
  assert.deepEqual(plan.actions.map((a) => [a.agent, a.role, a.status]), [["claude", "owned-file", "create"], ["claude", "import", "create"], ["codex", "block", "create"]]);
  assert.equal(result.applied, true);
  assert.equal(s.dialogs.length, 1, "apply shows the owner dialog");
  assert.match(s.dialogs[0].body, /Browser tests: Use Playwright/);
  const owned = await readFile(s.paths.owned, "utf8"), claude = await readFile(s.paths.claudeMd, "utf8"), codex = await readFile(s.paths.agentsMd, "utf8");
  for (const text of [owned, codex]) assert.match(text, /Browser tests: Use Playwright for browser checks/);
  assert.equal(claude, MARKERS.begin + "\n@" + s.paths.owned + "\n" + MARKERS.end + "\n", "CLAUDE.md imports the owned file");
  // A second plan has nothing to do.
  assert.deepEqual((await s.ok(["instructions", "plan"])).actions.map((a) => a.status), ["unchanged", "unchanged", "unchanged"]);
});

test("the rendered block holds the conflict-stop, guidance-only, one-new-format and lookup lines", () => {
  const { text } = renderBlock([], { kitRoot: "/kit", pilotPath: "/p/live.json" });
  for (const rule of RULES) assert.ok(text.includes(rule), rule);
  assert.match(text, /stop before the change/);
  assert.match(text, /guidance about approach/);
  assert.match(text, /one new output format/);
  assert.match(text, /lesson match --pilot "\/p\/live\.json"/);
  assert.ok(text.length <= BLOCK_CHARS);
});

test("text outside the markers round-trips byte for byte, and remove takes only the block out", async (t) => {
  const claudeMd = "# My rules\r\n\r\nKeep answers short.\n\n\n", agentsMd = "Personal Codex notes\nwithout a final newline";
  const s = await setup(t, { claudeMd, agentsMd });
  await s.pref(1, "Prefer small pull requests.");
  await s.apply();
  const claude = await readFile(s.paths.claudeMd, "utf8"), codex = await readFile(s.paths.agentsMd, "utf8");
  assert.ok(claude.startsWith(claudeMd));
  assert.ok(codex.startsWith(agentsMd + "\n" + MARKERS.begin));
  assert.equal((await stat(s.paths.claudeMd)).mode & 0o777, 0o644, "the file keeps its own mode");
  // Text the developer adds after the block survives an update.
  await writeFile(s.paths.agentsMd, codex + "Later note\n");
  await s.pref(2, "Explain trade-offs in a short table.");
  await s.apply();
  const updated = await readFile(s.paths.agentsMd, "utf8");
  assert.ok(updated.startsWith(agentsMd + "\n" + MARKERS.begin) && updated.endsWith(MARKERS.end + "\nLater note\n"));
  assert.match(updated, /Explain trade-offs/);
  await s.apply(["--remove"]);
  assert.equal(await readFile(s.paths.claudeMd, "utf8"), claudeMd);
  assert.equal(await readFile(s.paths.agentsMd, "utf8"), agentsMd + "\nLater note\n");
});

test("a block over the cap leaves out the oldest preferences and warns", async (t) => {
  const s = await setup(t);
  for (let n = 1; n <= 12; n++) await s.pref(n, "Rule number " + n + " keeps a fairly long sentence here so that the block fills up after a few of them.");
  const plan = await s.ok(["instructions", "plan"]);
  assert.ok(plan.chars <= BLOCK_CHARS);
  assert.equal(plan.warnings[0].code, "PREFERENCES_DROPPED");
  const dropped = plan.warnings[0].dropped.map((d) => d.title);
  assert.equal(dropped[0], "Rule 1", "the oldest goes first");
  assert.ok(!dropped.includes("Rule 12"), "the newest stays");
  assert.match(plan.block, /Rule 12:/);
  assert.doesNotMatch(plan.block, /Rule 1:/);
});

test("a block that fills the cap exactly is kept whole", () => {
  const context = { kitRoot: "/kit", pilotPath: "/p/live.json" };
  const base = renderBlock([{ id: "rec_a", title: "T", text: "x" }], context).text.length;
  const exact = { id: "rec_a", title: "T", text: "x".repeat(1 + BLOCK_CHARS - base) };
  const fit = renderBlock([exact], context);
  assert.equal(fit.text.length, BLOCK_CHARS);
  assert.deepEqual(fit.dropped, []);
  assert.deepEqual(renderBlock([{ ...exact, text: exact.text + "x" }], context).dropped.map((d) => d.id), ["rec_a"]);
});

test("a preference that fails a check at render time is left out with a warning", async (t) => {
  const s = await setup(t);
  await s.pref(1, "Use the Zephyr staging runner first.", "Staging");
  await s.pref(2, "Prefer small pull requests.", "Small PRs");
  const { applyScopeAdd } = await import("../src/config/store.mjs");
  await applyScopeAdd(rootsFromPilot(await loadPilot(s.pilotPath, { home: s.p.fakeHome, kitRoot: KIT, env: {} })), { scope: "zephyr", hubs: [], policies: [], now });
  const plan = await s.ok(["instructions", "plan"]);
  assert.doesNotMatch(plan.block, /Zephyr/);
  assert.match(plan.block, /Small PRs/);
  assert.deepEqual(plan.warnings.map((w) => [w.code, w.refused?.map((r) => [r.title, r.code])]), [["PREFERENCES_REFUSED", [["Staging", "DEVTWIN_ISOLATION"]]]]);
});

test("a repository AGENTS.md is never a target, and an unapproved file is blocked", async (t) => {
  const p = await makePilot(t);
  // The write class refuses any path that is not one of the agent-home shapes.
  const repoAgents = join(p.reposDir, "atlas", "AGENTS.md");
  const bad = await p.with({ writeClasses: { instructionTargets: [repoAgents] } });
  await assert.rejects(loadPilot(bad, { home: p.fakeHome, kitRoot: KIT, env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED");
  const s = await setup(t, { approve: false });
  const plan = await s.ok(["instructions", "plan"]);
  assert.deepEqual(plan.actions.map((a) => a.status), ["blocked", "blocked", "blocked"]);
  assert.ok(plan.actions.every((a) => !a.path.includes("repos")));
  const out = await s.cli(["instructions", "apply", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(out.json.error.code, "DEVTWIN_CONFLICT");
  assert.equal(s.dialogs.length, 0, "a refused apply shows no dialog");
});

test("malformed markers are a conflict and the file stays", async (t) => {
  const broken = "notes\n" + MARKERS.begin + "\nhalf a block\n";
  const s = await setup(t, { agentsMd: broken });
  const plan = await s.ok(["instructions", "plan", "--agent", "codex"]);
  assert.deepEqual(plan.actions.map((a) => [a.status, a.reason]), [["conflict", "markers"]]);
  assert.equal((await s.cli(["instructions", "apply", "--agent", "codex", "--plan-fingerprint", plan.fingerprint])).json.error.code, "DEVTWIN_CONFLICT");
  assert.equal(await readFile(s.paths.agentsMd, "utf8"), broken);
});
