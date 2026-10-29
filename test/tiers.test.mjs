import test from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/cli.mjs";
import { TIERS, READ, TIER_TABLE, tierOf, tierRule, alwaysAskRoutes, dialogOnlyRoutes, targetsWithTier } from "../src/policy/tiers.mjs";
import { STATUSES } from "../src/records/schema.mjs";
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
  // setup apply maps every setup step and the one-approval batch, and lesson accept every lesson target.
  assert.deepEqual(Object.keys(TIER_TABLE["setup apply"].targets).sort(), [...STEPS.map((s) => s.id), "batch"].sort());
  assert.deepEqual(Object.keys(TIER_TABLE["lesson accept"].targets).sort(), [...TARGETS].sort());
  assert.equal(tierOf({ route: "lesson accept", target: "project" }), "automatic");
  assert.equal(tierOf({ route: "lesson accept", target: "hub" }), "consented");
  assert.deepEqual(tierRule({ route: "lesson accept", target: "hub" }), { tier: "consented", consent: "hub-publish" });
  assert.deepEqual(tierRule({ route: "lesson accept", target: "general" }), { tier: "always-ask", via: "activity review" });
  for (const route of ["handoff export", "project onboard"]) assert.equal(tierOf({ route }), "automatic", route);
  for (const route of ["pref accept", "consent grant", "consent revoke", "undo"]) assert.equal(tierOf({ route }), "always-ask", route);
  // A record's target is its status: observed and proposed are automatic; confirmed, disputed and replacing a
  // confirmed or disputed record need the owner dialog, whoever calls.
  for (const route of ["record add", "record supersede"]) {
    assert.deepEqual(Object.keys(TIER_TABLE[route].targets).filter((k) => !k.startsWith("replaces-")).sort(), [...STATUSES].sort(), route);
    for (const status of ["observed", "proposed"]) assert.equal(tierOf({ route, target: status }), "automatic", route + " " + status);
    for (const status of ["confirmed", "disputed"]) assert.deepEqual(tierRule({ route, target: status }), { tier: "always-ask", dialog: true }, route + " " + status);
  }
  for (const target of ["replaces-confirmed", "replaces-disputed"]) assert.deepEqual(tierRule({ route: "record supersede", target }), { tier: "always-ask", dialog: true }, target);
  assert.equal(tierOf({ route: "activity" }), "read");
});

test("tierOf throws for an unknown route, target or source", () => {
  const bad = [{ route: "lesson delete" }, { route: "lesson accept" }, { route: "lesson accept", target: "everywhere" }, { route: "lesson accept", target: "project", source: "fetched" },
    { route: "record add" }, { route: "record add", target: "hub" }, { route: "record add", target: "observed", source: "synced" }, { route: "record add", target: "replaces-confirmed" }, { route: "record add", target: "replaces-disputed" }, { route: "setup apply", target: "nope" }, { route: "toString" }, { route: "__proto__" }, {}, undefined];
  for (const action of bad) assert.throws(() => tierOf(action), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "tier", JSON.stringify(action));
  assert.ok(Object.isFrozen(TIER_TABLE));
  assert.throws(() => { TIER_TABLE["record add"].targets.observed.tier = "always-ask"; }, TypeError);
  assert.throws(() => { TIER_TABLE["record add"].targets.confirmed = { tier: "automatic" }; }, TypeError);
  assert.equal(tierOf({ route: "record add", target: "observed" }), "automatic");
});

test("always-ask routes in the tier table are exactly the owner-block actions and owner setup steps", () => {
  // The setup routes are blocked through the setup step list and the terminal loop rule, not through OWNER_ACTIONS.
  const ask = alwaysAskRoutes();
  assert.deepEqual(ask.filter((route) => route !== "setup" && route !== "setup apply"), OWNER_ACTIONS.map((a) => a.words.join(" ")).sort());
  assert.ok(ask.includes("undo"), "every undo is owner-only");
  // The record routes' always-ask targets are gated by the owner dialog alone: the hook cannot tell a confirmed write
  // from an observed one by its words, so they are not owner-block actions.
  assert.deepEqual(dialogOnlyRoutes(), ["record add", "record supersede"]);
  assert.ok(!ask.includes("record add") && !ask.includes("record supersede"));
  assert.deepEqual(targetsWithTier("record supersede", "always-ask"), ["confirmed", "disputed", "replaces-confirmed", "replaces-disputed"]);
  assert.ok(ask.includes("setup") && ask.includes("setup apply"));
  assert.ok(!ask.includes("lesson accept"), "lesson accept left the owner-only list");
  assert.deepEqual(targetsWithTier("setup apply", "always-ask"), [...OWNER_SETUP_STEPS, "batch"].sort(), "the owner steps and the one-approval batch");
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
