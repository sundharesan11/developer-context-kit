import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { sandbox, makeRepo, fixtureGit, makePilot, draftFor, now } from "./helpers.mjs";
import { loadPilot, rootsFromPilot, recordApprovedDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { applyInit, applyScopeAdd, writeBindingVersion, writeManifest } from "../src/config/store.mjs";
import { readRegistry, publishRegistry } from "../src/config/registry.mjs";
import { withPilotLock, registryLockPath } from "../src/storage/lock.mjs";
import { operationIdFor } from "../src/identity/ids.mjs";
import { addRecord } from "../src/records/store.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const RSS = "https://changelog.example.com/feed.xml", ATOM = "https://updates.example.com/atom.xml", JSONF = "https://news.example.com/feed.json";
const HOSTS = ["changelog.example.com", "news.example.com", "updates.example.com"];
const CATALOG = { version: 1, items: [
  { name: "acme-sdk", terms: ["Acme SDK"], feeds: [RSS] },
  { name: "widget", terms: ["Widget"], feeds: [ATOM] },
  { name: "gadget", terms: ["Gadget"], feeds: [JSONF] }
] };
const ROUTES = {
  [RSS]: { type: "application/rss+xml", body: fixture("rss.xml") },
  [ATOM]: { type: "application/atom+xml", body: fixture("atom.xml") },
  [JSONF]: { type: "application/feed+json", body: fixture("feed.json") }
};
function fakeNet() {
  const log = [], lookups = [];
  const lookup = async (host) => { lookups.push(host); return [{ address: "93.184.216.34", family: 4 }]; };
  const request = async (options) => {
    log.push(options);
    const r = ROUTES[options.url];
    if (!r) return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    return { status: 200, headers: { "content-type": r.type }, body: Buffer.from(r.body) };
  };
  return { log, lookups, lookup, request };
}
// A live config whose running kit is a clean detached checkout, approved as written.
async function liveSetup(t) {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const kitCommit = (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim();
  const config = join(devtwin, "live.json");
  const raw = { schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills") }, kitRoot: kit, kitCommit } };
  await writeFile(config, JSON.stringify(raw), { mode: 0o600 });
  const context = { home, env: {}, kitRoot: kit };
  const first = rootsFromPilot(await loadPilot(config, { ...context, liveGate: { approval: false } }));
  ensureRoots(first);
  await recordApprovedDigest(first);
  const roots = async () => rootsFromPilot(await loadPilot(config, context));
  await applyInit(await roots(), { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  const cli = async (args, extra = {}) => {
    const chunks = [];
    const code = await main([...args.slice(0, 2), "--pilot", config, ...args.slice(2)], { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home, env: {}, kitRoot: kit, stackCatalog: CATALOG, ...extra });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args, extra) => { const out = await cli(args, extra); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const applied = async (args, extra) => { const plan = await ok(args, extra); return ok([...args, "--apply", "--plan-fingerprint", plan.fingerprint], extra); };
  return { sb, home, config, kit, roots, cli, ok, applied };
}
// Scopes alpha and beta with one project each, registered directly as in test/stack-digest.test.mjs.
async function seedScopes(s) {
  for (const [scope, project, repoName] of [["alpha", "alpha.web", "atlas"], ["beta", "beta.web", "beacon"]]) {
    const roots = await s.roots();
    await applyScopeAdd(roots, { scope, hubs: [], policies: [], now });
    const repo = await makeRepo(join(s.sb, "work", repoName), { "README.md": "# Fixture\n" });
    const requestId = "req_seed" + repoName, operationId = operationIdFor({ scope, project, requestId });
    await withPilotLock(roots, registryLockPath(roots), { kind: "fixture-seed" }, async () => {
      const binding = { schemaVersion: 1, scope, project, version: 1, roots: [{ path: repo, commonDir: join(repo, ".git"), kind: "main" }], remotes: [], approvedSources: [], expectedRemotes: [], actorRefs: [], environments: [], createdAt: now().toISOString() };
      const bindingHash = await writeBindingVersion(roots, binding);
      const manifest = { schemaVersion: 1, operationId, kind: "onboard", requestId, requestHash: "sha256:" + "0".repeat(64), scope, project, bindingHash, planFingerprint: "sha256:" + "0".repeat(64), bundles: [] };
      const manifestHash = await writeManifest(roots, manifest);
      const { value } = await readRegistry(roots);
      await publishRegistry(roots, { ...value, generation: value.generation + 1,
        bindings: [...value.bindings, { path: repo, commonDir: join(repo, ".git"), scope, project, bindingVersion: 1, bindingHash, operationId, manifestHash }],
        operations: [...value.operations, { operationId, requestId, requestHash: manifest.requestHash, scope, project, manifestHash, planFingerprint: manifest.planFingerprint, generation: value.generation + 1 }] }, { expectGeneration: value.generation });
    }, { destinations: [roots.configRoot, roots.dataRoot] });
  }
}
async function ready(t, { hosts = HOSTS, maxRequests } = {}) {
  const s = await liveSetup(t);
  await s.applied(["live", "stack-watch", ...hosts.flatMap((h) => ["--host", h]), ...(maxRequests ? ["--max-requests", String(maxRequests)] : [])]);
  await seedScopes(s);
  const roots = await s.roots(), profile = { stackCurrent: ["acme-sdk", "widget", "gadget"] };
  const plan = await planProfile(roots, { profile });
  await applyProfile(roots, { profile, fingerprint: plan.fingerprint }, { now });
  const stack = await s.ok(["stack", "plan"]);
  await s.ok(["stack", "approve", "--plan-fingerprint", stack.fingerprint]);
  return s;
}

test("with the stackWatch exception approved, stack check runs in live mode for one scope, unauthenticated and inside the cap", async (t) => {
  const s = await ready(t);
  const net = fakeNet();
  const bound = async () => ({ bound: true, value: "fixture-public-read-value" });
  const out = await s.ok(["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup, resolvePublicRead: bound });
  assert.deepEqual(out.live, { exception: "stackWatch", maxRequests: 30 });
  assert.equal(out.authentication.used, "unauthenticated");
  assert.ok(out.entries.length > 0);
  assert.ok(net.log.length > 0 && net.log.every((r) => HOSTS.includes(new URL(r.url).hostname) && !r.headers.authorization));
  const config = JSON.parse(await readFile(s.config, "utf8"));
  assert.deepEqual(config.exceptions, { stackWatch: { hosts: HOSTS, maxRequests: 30 } });
});

test("without the exception the old GATE_REQUIRED stays, and live mode needs a scope and every approved host in the exception", async (t) => {
  const s = await liveSetup(t);
  const net = fakeNet();
  const none = await s.cli(["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.deepEqual([none.json.error.code, none.json.error.details.field, none.json.error.details.reason], ["DEVTWIN_GATE_REQUIRED", "live", "no-live-exception"]);
  const narrow = await ready(t, { hosts: ["changelog.example.com"] });
  const missing = await narrow.cli(["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.equal(missing.json.error.details.reason, "host-not-in-exception");
  assert.deepEqual(missing.json.error.details.hosts, ["news.example.com", "updates.example.com"]);
  const unscoped = await narrow.cli(["stack", "digest"], { request: net.request, lookup: net.lookup });
  assert.equal(unscoped.json.error.details.reason, "scope-required");
  assert.equal(net.log.length + net.lookups.length, 0);
});

test("the exception's request cap limits one run", async (t) => {
  const s = await ready(t, { maxRequests: 2 });
  const net = fakeNet();
  const out = await s.ok(["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.equal(net.log.length, 2);
  assert.deepEqual(out.failures.map((f) => f.code), ["DEVTWIN_CALL_LIMIT"]);
});

test("one scope's live digest never lists another scope's project names", async (t) => {
  const s = await ready(t);
  const roots = await s.roots();
  const b = await addRecord(roots, draftFor("beta", "beta.web", { requestId: "req_beta0001", body: "Uploads go through acme-sdk with retries." }), { now });
  const net = fakeNet();
  const beta = await s.ok(["stack", "digest", "--scope", "beta"], { request: net.request, lookup: net.lookup });
  assert.match(beta.markdown, /^## Project beta\.web$/m);
  assert.ok(beta.markdown.includes(b.recordId));
  const alpha = await s.ok(["stack", "digest", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.doesNotMatch(alpha.markdown, /beta/);
  assert.ok(!alpha.markdown.includes(b.recordId));
  const done = await s.ok(["stack", "digest", "--scope", "alpha", "--apply", "--plan-fingerprint", alpha.fingerprint]);
  assert.equal(done.destination.path.startsWith("scopes/alpha/digests/stack/"), true);
});

test("a stack approval made before a live config change asks for approval again instead of failing", async (t) => {
  const s = await ready(t);
  await s.applied(["live", "stack-watch", ...HOSTS.flatMap((h) => ["--host", h]), "--max-requests", "20"]);
  const net = fakeNet();
  const out = await s.cli(["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.equal(out.json.error.code, "DEVTWIN_APPROVAL_REQUIRED");
  assert.equal((await s.ok(["stack", "plan"])).approval.status, "none");
  assert.equal(net.log.length, 0);
});

test("live stack-watch refuses bad input, --off removes the exception, and a disposable pilot cannot hold one", async (t) => {
  const s = await liveSetup(t);
  for (const args of [["--host", "localhost"], ["--host", "10.0.0.1"], ["--host", "changelog.example.com", "--max-requests", "51"], ["--host", "changelog.example.com", "--max-requests", "0"], [], ["--off"]]) {
    const out = await s.cli(["live", "stack-watch", ...args]);
    assert.equal(out.json.ok, false, args.join(" "));
    assert.ok(["DEVTWIN_INVALID_INPUT", "DEVTWIN_GATE_REQUIRED"].includes(out.json.error.code), args.join(" "));
  }
  await s.applied(["live", "stack-watch", "--host", "changelog.example.com"]);
  const off = await s.ok(["live", "stack-watch", "--off"]);
  assert.deepEqual(off.stackWatch, { from: { hosts: ["changelog.example.com"], maxRequests: 30 }, to: null });
  await s.ok(["live", "stack-watch", "--off", "--apply", "--plan-fingerprint", off.fingerprint]);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(s.config, "utf8")), "exceptions"), false);
  const p = await makePilot(t);
  const path = await p.with({ exceptions: { stackWatch: { hosts: ["changelog.example.com"], maxRequests: 5 } } });
  await assert.rejects(loadPilot(path, { home: p.fakeHome, env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "exceptions");
});

test("live stack-watch --apply is an owner action, and its preview stays open", () => {
  const shell = (command) => ownerAction("claude", { tool_name: "Bash", tool_input: { command } });
  assert.equal(shell("devtwin live stack-watch --pilot x --host a.example.com --apply --plan-fingerprint s"), "live stack-watch --apply");
  assert.equal(shell("devtwin live stack-watch --pilot x --host a.example.com"), null);
});
