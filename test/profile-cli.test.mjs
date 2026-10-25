import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { access } from "node:fs/promises";
import { makePilot, initPilot, makeRepo, now, runCli, treeSnapshot } from "./helpers.mjs";
import { applyInit, applyScopeAdd } from "../src/config/store.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { addRecord, supersedeRecord, readSnapshot } from "../src/records/store.mjs";
import { readProfile } from "../src/profile/store.mjs";
import { parseStackEntry } from "../src/profile/commands.mjs";
const cli = (p, route, args = []) => runCli(["profile", route, "--pilot", p.path, ...args]);
async function planApply(p, args) {
  const plan = await cli(p, "plan", args);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  const applied = await cli(p, "apply", [...args, "--plan-fingerprint", plan.json.result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  return { plan: plan.json.result, applied: applied.json.result };
}
async function onboard(p, { project, repoName, files, accept }) {
  const repo = await makeRepo(join(p.reposDir, repoName), files);
  const input = { scope: "acme", project, repo, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept, requestId: "req_" + repoName + "0001" };
  const plan = await planOnboard(p.roots, p.pilot, input);
  await applyOnboard(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, now });
  return repo;
}
// atlas declares Node engines in an accepted package record; beacon is a Python project onboarded with --accept none.
async function twoProjects(t) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "acme", hubs: [], policies: [], now });
  await onboard(p, { project: "acme.atlas", repoName: "atlas", accept: "all", files: { "README.md": "# Atlas\nBilling API.\n", "package.json": '{"name":"atlas","engines":{"node":">=22.13"}}' } });
  await onboard(p, { project: "acme.beacon", repoName: "beacon", accept: "none", files: { "README.md": "# Beacon\n", "pyproject.toml": "[project]\nname = \"beacon\"\n" } });
  const packageRecord = (await readSnapshot(p.roots, "acme", "acme.atlas")).records.find((r) => r.title === "Package declarations");
  return { ...p, packageRecord };
}
const packageDraft = (requestId, body, status = "observed") => ({ scope: "acme", project: "acme.atlas", requestId, recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: "command", status, title: "Package declarations", body, sources: [{ ref: "user:email:owner@example.com" }], applicability: { level: "project" }, review: null } });
test("profile plan shows the full proposed profile, relative destination, size and fingerprint, and apply with that fingerprint succeeds", async (t) => {
  const p = await makePilot(t);
  const args = ["--work", "Backend services", "--stack-current", "node=22:high", "--stack-known", "go", "--preference", "explanationStyle=concise", "--writing", "tone=plain", "--writing", "formality.team=casual"];
  const plan = await cli(p, "plan", args);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  const result = plan.json.result;
  assert.equal(result.preview, true);
  assert.deepEqual(result.destination, { root: "configRoot", path: "profile" });
  assert.ok(!JSON.stringify(result).includes(p.configRoot));
  const expected = { workKind: "Backend services", stackCurrent: ["node=22:high"], stackKnown: ["go"], workingPreferences: { explanationStyle: "concise" }, writing: { tone: "plain", formality: { team: "casual" } } };
  assert.deepEqual(result.profile, expected);
  assert.equal(typeof result.size, "number");
  assert.equal(result.cap, 4096);
  assert.match(result.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.base.generation, 0);
  await assert.rejects(access(join(p.configRoot, "profile")));
  const applied = await cli(p, "apply", [...args, "--plan-fingerprint", result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
  assert.equal(applied.json.result.generation, 1);
  assert.deepEqual(applied.json.result.destination, { root: "configRoot", path: "profile" });
  assert.deepEqual((await readProfile(p.roots)).profile, expected);
  const shown = await cli(p, "show");
  assert.deepEqual(shown.json.result.profile, expected);
  assert.equal(shown.json.result.generation, 1);
});
test("profile plan builds on the current profile: given scalars replace, given lists replace whole, empty values clear", async (t) => {
  const p = await makePilot(t);
  await planApply(p, ["--work", "Backend", "--stack-current", "node", "--stack-current", "react", "--stack-known", "go", "--preference", "notes=one"]);
  const { plan } = await planApply(p, ["--stack-current", "deno=2", "--preference", "diagrams=prefer", "--stack-known="]);
  assert.deepEqual(plan.profile, { workKind: "Backend", stackCurrent: ["deno=2"], workingPreferences: { notes: ["one"], diagrams: "prefer" } });
  assert.deepEqual(plan.changes.map((c) => c.field).sort(), ["stackCurrent", "stackKnown", "workingPreferences.diagrams"]);
  const stack = plan.changes.find((c) => c.field === "stackCurrent");
  assert.deepEqual([stack.from, stack.to], [["node", "react"], ["deno=2"]]);
  const shown = await cli(p, "show", ["--generation", "1"]);
  assert.deepEqual(shown.json.result.profile.stackCurrent, ["node", "react"]);
  assert.equal((await cli(p, "show")).json.result.generation, 2);
});
test("profile export returns paste-ready markdown with every set field and writes nothing", async (t) => {
  const p = await makePilot(t);
  await planApply(p, ["--work", "Data pipelines", "--stack-current", "python=3.12:high", "--stack-known", "rust", "--preference", "autonomy=balanced", "--preference", "notes=Prefer small diffs", "--writing", "signOff=Thanks", "--writing", "avoidPhrases=circle back", "--writing", "formality.client=formal", "--writing", "spelling=en-GB"]);
  const before = await treeSnapshot(p.sandbox);
  const exported = await cli(p, "export");
  assert.equal(exported.code, 0);
  const md = exported.json.result.markdown;
  for (const text of ["Data pipelines", "python=3.12:high", "rust", "balanced", "Prefer small diffs", "Thanks", "circle back", "client: formal", "en-GB"]) assert.ok(md.includes(text), text);
  assert.match(md, /^# Personal profile/);
  assert.equal(await treeSnapshot(p.sandbox), before);
});
test("profile suggest-stack proposes runtimes cited by record and ecosystems cited by project, and only accepted entries are written", async (t) => {
  const p = await twoProjects(t);
  const before = await treeSnapshot(p.sandbox);
  const out = await cli(p, "suggest-stack", ["--scope", "acme"]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  assert.equal(await treeSnapshot(p.sandbox), before);
  const byName = Object.fromEntries(out.json.result.suggestions.map((s) => [s.name, s]));
  assert.equal(byName.node.entry, "node=>=22.13");
  assert.ok(byName.node.citations.some((c) => c.recordId === p.packageRecord.id && c.project === "acme.atlas"));
  assert.deepEqual(byName.python.citations, [{ project: "acme.beacon", source: "pyproject.toml" }]);
  assert.equal(byName.python.entry, "python");
  const { applied } = await planApply(p, ["--stack-current", byName.python.entry]);
  assert.equal(applied.generation, 1);
  assert.deepEqual((await readProfile(p.roots)).profile, { stackCurrent: ["python"] });
});
test("profile suggest-stack still suggests ecosystems for a project onboarded with accept none", async (t) => {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "acme", hubs: [], policies: [], now });
  await onboard(p, { project: "acme.atlas", repoName: "atlas", accept: "none", files: { "README.md": "# Atlas\n", "package.json": '{"name":"atlas","engines":{"node":">=22"}}', "go.mod": "module example.com/atlas\n" } });
  const out = await cli(p, "suggest-stack", ["--scope", "acme"]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  const names = out.json.result.suggestions.map((s) => s.name).sort();
  assert.deepEqual(names, ["go", "node"]);
  assert.ok(out.json.result.suggestions.every((s) => s.citations.every((c) => c.recordId === undefined && c.project === "acme.atlas")));
});
test("profile suggest-stack with no onboarded projects returns an empty list", async (t) => {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "acme", hubs: [], policies: [], now });
  const out = await cli(p, "suggest-stack", ["--scope", "acme"]);
  assert.equal(out.code, 0, JSON.stringify(out.json));
  assert.deepEqual(out.json.result.suggestions, []);
  assert.equal((await cli(p, "suggest-stack", ["--scope", "globex"])).json.error.code, "DEVTWIN_SCOPE_UNKNOWN");
});
test("profile suggest-stack ignores superseded and proposed records", async (t) => {
  const p = await twoProjects(t);
  const next = await supersedeRecord(p.roots, { ...packageDraft("req_pkgnext01", 'engines: {"node":">=24"}'), targets: [p.packageRecord.id], expectHashes: [p.packageRecord.recordHash] }, { now });
  await addRecord(p.roots, packageDraft("req_pkgprop01", 'engines: {"bun":">=1"}', "proposed"), { now });
  const out = await cli(p, "suggest-stack", ["--scope", "acme"]);
  const byName = Object.fromEntries(out.json.result.suggestions.map((s) => [s.name, s]));
  assert.equal(byName.bun, undefined);
  assert.equal(byName.node.entry, "node=>=24");
  const ids = byName.node.citations.map((c) => c.recordId).filter(Boolean);
  assert.deepEqual(ids, [next.recordId]);
});
test("profile stack-current parses a scoped package with version and care", async (t) => {
  assert.deepEqual(parseStackEntry("@scope/pkg=1.2.0:high"), { name: "@scope/pkg", version: "1.2.0", care: "high" });
  assert.deepEqual(parseStackEntry("node"), { name: "node" });
  assert.deepEqual(parseStackEntry("node:low"), { name: "node", care: "low" });
  assert.deepEqual(parseStackEntry("node:normal"), { name: "node", care: "normal" });
  assert.throws(() => parseStackEntry("node:medium"));
  const p = await makePilot(t);
  const plan = await cli(p, "plan", ["--stack-current", "@scope/pkg=1.2.0:high"]);
  assert.deepEqual(plan.json.result.profile.stackCurrent, ["@scope/pkg=1.2.0:high"]);
  assert.deepEqual(plan.json.result.stack.current, [{ name: "@scope/pkg", version: "1.2.0", care: "high" }]);
});
test("profile plan made with proposed-by agent shows the agent label in the preview", async (t) => {
  const p = await makePilot(t);
  const agent = await cli(p, "plan", ["--work", "Mobile apps", "--proposed-by", "agent"]);
  assert.equal(agent.json.result.proposedBy, "agent");
  assert.deepEqual(agent.json.result.changes, [{ field: "workKind", from: null, to: "Mobile apps", proposedBy: "agent" }]);
  assert.equal((await cli(p, "plan", ["--work", "Mobile apps"])).json.result.proposedBy, "user");
  assert.equal((await cli(p, "plan", ["--proposed-by", "robot"])).json.error.code, "DEVTWIN_INVALID_INPUT");
});
test("profile seed-from-init copies user.json preferences into the preview only", async (t) => {
  const p = await makePilot(t);
  assert.equal((await cli(p, "plan", ["--seed-from-init"])).json.error.code, "DEVTWIN_NOT_FOUND");
  await applyInit(p.roots, { actorRefs: [], preferences: { explanationStyle: "detailed", diagrams: "avoid", notes: ["Ask before refactors"] }, now });
  const before = await treeSnapshot(p.sandbox);
  const plan = await cli(p, "plan", ["--seed-from-init", "--preference", "diagrams=prefer"]);
  assert.equal(plan.code, 0, JSON.stringify(plan.json));
  assert.deepEqual(plan.json.result.profile.workingPreferences, { explanationStyle: "detailed", diagrams: "prefer", notes: ["Ask before refactors"] });
  assert.equal(await treeSnapshot(p.sandbox), before);
  const applied = await cli(p, "apply", ["--seed-from-init", "--preference", "diagrams=prefer", "--plan-fingerprint", plan.json.result.fingerprint]);
  assert.equal(applied.code, 0, JSON.stringify(applied.json));
});
test("profile apply without a plan fingerprint fails with PLAN_REQUIRED", async (t) => {
  const p = await makePilot(t);
  const out = await cli(p, "apply", ["--work", "Backend"]);
  assert.equal(out.json.error.code, "DEVTWIN_PLAN_REQUIRED");
  await assert.rejects(access(join(p.configRoot, "profile")));
});
test("profile malformed stack-current fails with INVALID_INPUT", async (t) => {
  const p = await makePilot(t);
  for (const bad of ["node=22:urgent", "=1.0", "node=", "two words", "node=1:high:low", "node==1 2"]) {
    const out = await cli(p, "plan", ["--stack-current", bad]);
    assert.equal(out.json.error.code, "DEVTWIN_INVALID_INPUT", bad);
  }
  for (const bad of [["--preference", "colour=blue"], ["--preference", "noequals"], ["--writing", "formality.Team=casual"]]) assert.equal((await cli(p, "plan", bad)).json.error.code, "DEVTWIN_INVALID_INPUT", bad.join(" "));
});
test("profile apply after another change landed since the preview fails with STALE_VERSION", async (t) => {
  const p = await makePilot(t);
  const stale = await cli(p, "plan", ["--work", "Backend"]);
  await planApply(p, ["--stack-current", "node"]);
  const out = await cli(p, "apply", ["--work", "Backend", "--plan-fingerprint", stale.json.result.fingerprint]);
  assert.equal(out.json.error.code, "DEVTWIN_STALE_VERSION");
  assert.equal((await cli(p, "apply", ["--work", "Other", "--plan-fingerprint", stale.json.result.fingerprint])).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.equal((await readProfile(p.roots)).generation, 1);
});
test("help lists the profile routes", async () => {
  const { json } = await runCli(["help"]);
  for (const route of ["profile show", "profile plan", "profile apply", "profile export", "profile suggest-stack"]) assert.ok(json.result.commands.includes(route), route);
});
