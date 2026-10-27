import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/cli.mjs";
import { TIERS, READ, TIER_TABLE, tierOf, tierRule, alwaysAskRoutes, targetsWithTier } from "../src/policy/tiers.mjs";
import { callerActor, cliRecorder } from "../src/policy/actor.mjs";
import { OWNER_ACTIONS, OWNER_SETUP_STEPS } from "../src/hooks/owner-block.mjs";
import { STEPS, OWNER_STEPS } from "../src/setup/steps.mjs";
import { TARGETS } from "../src/lessons/publish.mjs";

const rules = (line) => line.targets ? Object.values(line.targets) : [line];

test("tier table has one line for every CLI route and no other", () => {
  assert.deepEqual(Object.keys(TIER_TABLE).sort(), Object.keys(COMMANDS).sort());
  for (const [route, line] of Object.entries(TIER_TABLE)) {
    assert.ok(Object.isFrozen(line), route);
    for (const rule of rules(line)) {
      assert.ok([...TIERS, READ].includes(rule.tier), route + ": " + rule.tier);
      if (rule.consent) assert.equal(rule.tier, "consented", route);
      if (rule.via) assert.ok(Object.hasOwn(TIER_TABLE, rule.via) || rule.via === "activity review", route + " via " + rule.via);
    }
    // Each line gives a tier for its own targets.
    if (line.targets) for (const target of Object.keys(line.targets)) assert.equal(tierOf({ route, target }), line.targets[target].tier, route + " " + target);
    else assert.equal(tierOf({ route }), line.tier, route);
  }
  // setup apply maps every setup step, and lesson accept every lesson target.
  assert.deepEqual(Object.keys(TIER_TABLE["setup apply"].targets).sort(), STEPS.map((s) => s.id).sort());
  assert.deepEqual(Object.keys(TIER_TABLE["lesson accept"].targets).sort(), [...TARGETS].sort());
  assert.equal(tierOf({ route: "lesson accept", target: "project" }), "automatic");
  assert.equal(tierOf({ route: "lesson accept", target: "hub" }), "consented");
  assert.deepEqual(tierRule({ route: "lesson accept", target: "hub" }), { tier: "consented", consent: "hub-publish" });
  assert.deepEqual(tierRule({ route: "lesson accept", target: "general" }), { tier: "always-ask", via: "activity review" });
  for (const route of ["record add", "record supersede", "handoff export", "project onboard"]) assert.equal(tierOf({ route }), "automatic", route);
  for (const route of ["pref accept", "consent grant", "consent revoke"]) assert.equal(tierOf({ route }), "always-ask", route);
  assert.equal(tierOf({ route: "activity" }), "read");
});

test("tierOf throws for an unknown route, target or source", () => {
  const bad = [{ route: "lesson delete" }, { route: "lesson accept" }, { route: "lesson accept", target: "everywhere" }, { route: "lesson accept", target: "project", source: "fetched" },
    { route: "record add", target: "hub" }, { route: "record add", source: "synced" }, { route: "setup apply", target: "nope" }, { route: "toString" }, { route: "__proto__" }, {}, undefined];
  for (const action of bad) assert.throws(() => tierOf(action), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "tier", JSON.stringify(action));
  assert.ok(Object.isFrozen(TIER_TABLE));
  assert.throws(() => { TIER_TABLE["record add"].tier = "always-ask"; }, TypeError);
  assert.equal(tierOf({ route: "record add" }), "automatic");
});

test("always-ask routes in the tier table are exactly the owner-block actions and owner setup steps", () => {
  // The setup routes are blocked through the setup step list and the terminal loop rule, not through OWNER_ACTIONS.
  const ask = alwaysAskRoutes();
  // An owner action whose second word is a flag (undo --since) blocks one target of a one-word route.
  const routeOf = (words) => words[1].startsWith("--") ? words[0] : words.join(" ");
  assert.deepEqual(ask.filter((route) => route !== "setup" && route !== "setup apply"), OWNER_ACTIONS.map((a) => routeOf(a.words)).sort());
  assert.deepEqual(targetsWithTier("undo", "always-ask"), ["other", "since"]);
  assert.deepEqual(targetsWithTier("undo", "automatic"), ["session"]);
  assert.ok(ask.includes("setup") && ask.includes("setup apply"));
  assert.ok(!ask.includes("lesson accept"), "lesson accept left the owner-only list");
  assert.deepEqual(targetsWithTier("setup apply", "always-ask"), [...OWNER_SETUP_STEPS].sort());
  assert.deepEqual([...OWNER_SETUP_STEPS].sort(), [...OWNER_STEPS].sort());
  for (const route of ask) assert.equal(COMMANDS[route] !== undefined, true, route);
});

test("caller actor comes from the agent environment", () => {
  assert.equal(callerActor({}), "human");
  assert.equal(callerActor({ CLAUDECODE: "1" }), "claude");
  assert.equal(callerActor({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(callerActor({ CODEX_THREAD_ID: "t1" }), "codex");
  assert.equal(callerActor({ CLAUDECODE: "1", CODEX_COMPANION_SESSION_ID: "x" }), "claude", "Claude Code wins over a plugin's CODEX_ variable");
  assert.equal(callerActor({ CODEX_SANDBOX: "" }), "human", "an empty variable does not count");
  assert.deepEqual(cliRecorder({ CLAUDECODE: "1" }), { actor: "claude", runId: "run_cli00001" });
});
