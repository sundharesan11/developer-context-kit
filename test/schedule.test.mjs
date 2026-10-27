import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile, chmod } from "node:fs/promises";
import { basename, join } from "node:path";
import { main } from "../src/cli.mjs";
import { makePilot, sandbox, makeRepo, fixtureGit, now } from "./helpers.mjs";
import { applyInit, applyScopeAdd } from "../src/config/store.mjs";
import { loadPilot, rootsFromPilot, recordApprovedDigest } from "../src/config/pilot.mjs";
import { ensureRoots } from "../src/config/roots.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { ensurePrivatePath } from "../src/storage/fsx.mjs";
import { ownerAction } from "../src/hooks/owner-block.mjs";
import { osascriptArgs, notificationText } from "../src/schedule/notify.mjs";
import { receiptPath } from "../src/schedule/jobs.mjs";
import { appendEntry } from "../src/audit/log.mjs";
import { createFetcher } from "../src/stack/fetch.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const RSS = "https://changelog.example.com/feed.xml", OSV = "https://api.osv.dev/v1/query";
const CATALOG = { version: 1, items: [{ name: "acme-sdk", terms: ["Acme SDK"], feeds: [RSS], package: { ecosystem: "npm", name: "acme-sdk" } }] };
const PAYLOAD = "x\"; do shell script \"touch /tmp/pwned\" --";
const OSV_BODY = JSON.stringify({ vulns: [{ id: "GHSA-aaaa-bbbb-cccc", summary: PAYLOAD + " <script>alert(1)</script>", database_specific: { severity: "HIGH" } }] });
function fakeNet() {
  const log = [];
  return {
    log, lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (options) => {
      log.push(options.url);
      if (options.url === RSS) return { status: 200, headers: { "content-type": "application/rss+xml" }, body: fixture("rss.xml") };
      if (options.url === OSV) return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(OSV_BODY) };
      return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    }
  };
}
// launchctl that remembers what is loaded.
function fakeLaunchctl() {
  const loaded = new Set(), calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === "bootstrap") { loaded.add(basename(args[2], ".plist")); return { status: 0 }; }
    if (args[0] === "bootout") { const label = args[1].split("/").pop(); return { status: loaded.delete(label) ? 0 : 3 }; }
    if (args[0] === "print") return { status: loaded.has(args[1].split("/").pop()) ? 0 : 113 };
    return { status: 1 };
  };
  return { run, loaded, calls };
}
const JOB_LABELS = ["devtwin.radar-weekly", "devtwin.advisory-hourly", "devtwin.review-monthly", "devtwin.activity-weekly"];
// A disposable pilot whose fake agent home has the three job plists approved, with a stack approval for acme-sdk.
async function setup(t, { labels = JOB_LABELS, groups = ["advisories"] } = {}) {
  const p = await makePilot(t), home = p.agentHomes[0], agents = join(home, "Library", "LaunchAgents");
  await mkdir(agents, { recursive: true });
  const path = await p.with({ writeClasses: { launchAgents: labels.map((l) => join(agents, l + ".plist")) } });
  const roots = async () => rootsFromPilot(await loadPilot(path, { home: p.fakeHome, env: {} }));
  await applyInit(await roots(), { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  await applyScopeAdd(await roots(), { scope: "alpha", hubs: [], policies: [], now });
  const profile = { stackCurrent: ["acme-sdk=4.1.0"] };
  const plan = await planProfile(await roots(), { profile });
  await applyProfile(await roots(), { profile, fingerprint: plan.fingerprint }, { now });
  const net = fakeNet(), launchctl = fakeLaunchctl(), notes = [], dialogs = [];
  let clock = now();
  const cli = async (args) => {
    const chunks = [];
    const code = await main([...args.slice(0, 2), "--pilot", path, ...args.slice(2)], { stdout: { write: (v) => { chunks.push(v); return true; } }, now: () => clock, home: p.fakeHome, env: {},
      stackCatalog: CATALOG, request: net.request, lookup: net.lookup, launchctl: launchctl.run, notifier: (a) => { notes.push(a); return { status: 0 }; }, ownerDialog: async (c) => { dialogs.push(c); return "approved"; } });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => { const out = await cli(args); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const stack = await ok(["stack", "plan", ...groups.flatMap((g) => ["--with", g])]);
  await ok(["stack", "approve", ...groups.flatMap((g) => ["--with", g]), "--plan-fingerprint", stack.fingerprint]);
  const on = async (job) => { const plan = await ok(["schedule", "plan", "--job", job]); return ok(["schedule", "apply", "--job", job, "--plan-fingerprint", plan.fingerprint]); };
  const off = async (job) => { const plan = await ok(["schedule", "off", "--job", job]); return ok(["schedule", "off", "--job", job, "--apply", "--plan-fingerprint", plan.fingerprint]); };
  const digests = async () => { try { return await readdir(join(p.dataRoot, "scopes", "alpha", "digests", "stack")); } catch { return []; } };
  return { p, path, agents, roots, cli, ok, on, off, net, launchctl, notes, dialogs, digests, advance: (ms) => { clock = new Date(clock.getTime() + ms); } };
}
const DAY = 86400000;

test("a disabled radar job makes no request and writes no digest, and the advisory job stops too (AE7)", async (t) => {
  const s = await setup(t);
  await s.on("radar-weekly");
  await s.on("advisory-hourly");
  assert.equal(s.dialogs.length, 2, "each job asks the owner");
  assert.deepEqual([...s.launchctl.loaded].sort(), ["devtwin.advisory-hourly", "devtwin.radar-weekly"]);
  const first = await s.ok(["schedule", "run", "--job", "radar-weekly"]);
  assert.equal(first.digests.length, 1);
  assert.equal((await s.digests()).length, 1);
  assert.match(s.notes.at(-1).at(-2), /^Your weekly digest is ready: \d+ new items in 1 digest\.$/);
  const off = await s.off("radar-weekly");
  assert.deepEqual(off.results.map((r) => [r.job, r.enabled, r.removed]), [["radar-weekly", false, true], ["advisory-hourly", false, true]]);
  assert.equal(s.launchctl.loaded.size, 0);
  assert.deepEqual(await readdir(s.agents), []);
  const requests = s.net.log.length, notes = s.notes.length;
  s.advance(8 * DAY);
  assert.deepEqual(await s.ok(["schedule", "run", "--job", "radar-weekly"]), { job: "radar-weekly", skipped: "job-disabled" });
  assert.deepEqual(await s.ok(["schedule", "run", "--job", "advisory-hourly"]), { job: "advisory-hourly", skipped: "job-disabled" });
  assert.equal(s.net.log.length, requests);
  assert.equal(s.notes.length, notes);
  assert.equal((await s.digests()).length, 1);
});

test("two runs inside one period produce one digest", async (t) => {
  const s = await setup(t);
  await s.on("radar-weekly");
  await s.ok(["schedule", "run", "--job", "radar-weekly"]);
  s.advance(2 * DAY);
  const again = await s.ok(["schedule", "run", "--job", "radar-weekly"]);
  assert.equal(again.skipped, "ran-recently");
  assert.equal((await s.digests()).length, 1);
  s.advance(5 * DAY);
  assert.equal((await s.ok(["schedule", "run", "--job", "radar-weekly"])).digests.length, 1, "a run after the period writes the next digest");
});

test("an advisory with a quote and a script payload is shown as plain text and runs nothing", async (t) => {
  const s = await setup(t);
  await s.on("radar-weekly");
  await s.on("advisory-hourly");
  const run = await s.ok(["schedule", "run", "--job", "advisory-hourly"]);
  assert.deepEqual(run.alerts.map((a) => [a.id, a.severity]), [["GHSA-aaaa-bbbb-cccc", "high"]]);
  assert.ok(s.net.log.every((url) => url === OSV), "the advisory job fetches only advisories");
  const args = s.notes.at(-1);
  assert.deepEqual(args.slice(0, 6), ["-e", "on run argv", "-e", "display notification (item 1 of argv) with title (item 2 of argv)", "-e", "end run"]);
  assert.equal(args.length, 8);
  // The same advisory never alerts twice.
  s.advance(2 * 3600000);
  assert.deepEqual((await s.ok(["schedule", "run", "--job", "advisory-hourly"])).alerts, []);
  const built = osascriptArgs({ title: PAYLOAD, message: "<script>alert(1)</script> \"quoted\" `tick` \\ end\u0007" });
  assert.deepEqual(built.slice(0, 6), args.slice(0, 6), "the script lines never change");
  assert.equal(built[6], "<script>alert(1)</script> quoted tick end");
  assert.equal(built[7], "x; do shell script touch /tmp/pwned --");
  assert.ok(built.slice(6).every((a) => !/["'`\\\p{Cc}]/u.test(a)));
  assert.equal([...notificationText("a".repeat(500), 200)].length, 200);
});

test("a plist outside the approved launch agents is refused", async (t) => {
  const s = await setup(t, { labels: ["devtwin.other"] });
  const out = await s.cli(["schedule", "plan", "--job", "radar-weekly"]);
  assert.deepEqual([out.json.error.code, out.json.error.details.field], ["DEVTWIN_GATE_REQUIRED", "writeClasses.launchAgents"]);
  const p = await makePilot(t);
  const bad = await p.with({ writeClasses: { launchAgents: [join(p.agentHomes[0], "Documents", "devtwin.radar-weekly.plist")] } });
  await assert.rejects(loadPilot(bad, { home: p.fakeHome, env: {} }), (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.field === "writeClasses.launchAgents");
});

test("the advisory job needs the radar job and an advisories approval, and the radar job needs a stack approval", async (t) => {
  const s = await setup(t);
  assert.equal((await s.cli(["schedule", "plan", "--job", "advisory-hourly"])).json.error.code, "DEVTWIN_CONFLICT");
  const plain = await setup(t, { groups: [] });
  await plain.on("radar-weekly");
  assert.equal((await plain.cli(["schedule", "plan", "--job", "advisory-hourly"])).json.error.details.remedy, "stack plan --with advisories, then stack approve");
  const p = await makePilot(t);
  const out = await (async () => {
    const chunks = [];
    await main(["schedule", "plan", "--pilot", p.path, "--job", "radar-weekly"], { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home: p.fakeHome, env: {} });
    return JSON.parse(chunks.join(""));
  })();
  assert.ok(["DEVTWIN_APPROVAL_REQUIRED", "DEVTWIN_GATE_REQUIRED"].includes(out.error.code));
  assert.equal((await s.cli(["schedule", "plan", "--job", "nightly"])).json.error.code, "DEVTWIN_INVALID_INPUT");
});

test("status reports installed, loaded and last run for each job", async (t) => {
  const s = await setup(t);
  await s.on("radar-weekly");
  await s.on("review-monthly");
  await s.ok(["schedule", "run", "--job", "review-monthly"]);
  assert.match(s.notes.at(-1).at(-2), /^Your monthly setup review is available with 0 suggestions\./);
  const { jobs } = await s.ok(["schedule", "status"]);
  assert.deepEqual(jobs.map((j) => [j.job, j.enabled, j.installed, j.loaded, j.lastRunAt, j.result]), [
    ["radar-weekly", true, true, true, null, null],
    ["advisory-hourly", false, false, false, null, null],
    ["review-monthly", true, true, true, now().toISOString(), "ok"],
    ["activity-weekly", false, false, false, null, null]
  ]);
  assert.equal(s.net.log.length, 0, "the review job and status make no request");
});

test("the weekly activity job sends one notification with learned, held and waiting counts and does nothing else", async (t) => {
  const s = await setup(t);
  const roots = await s.roots();
  await appendEntry(roots, { kind: "record", tier: "automatic", route: "record add", home: "project", scope: "alpha", project: "alpha.atlas", recordIds: ["rec_" + "c".repeat(24)], actor: "claude", session: "ses_week", requestId: "req_weekly001" }, { now });
  const plan = await s.ok(["schedule", "plan", "--job", "activity-weekly"]);
  assert.match(plan.runs, /weekly notification/);
  await s.on("activity-weekly");
  const before = s.notes.length;
  const run = await s.ok(["schedule", "run", "--job", "activity-weekly"]);
  assert.deepEqual(run.counts, { learned: 1, held: 0, waiting: 0 });
  assert.equal(s.notes.length, before + 1);
  assert.equal(s.notes.at(-1).at(-1), "devtwin activity");
  assert.equal(s.notes.at(-1).at(-2), "This week devtwin learned 1 item, holds 0 for sending and has 0 waiting for you. Run devtwin activity to see them.");
  assert.equal((await s.ok(["schedule", "run", "--job", "activity-weekly"])).skipped, "ran-recently");
  assert.equal(s.notes.length, before + 1);
  assert.equal(s.net.log.length, 0, "the activity job makes no request");
  assert.deepEqual(await s.digests(), []);
  s.advance(8 * DAY);
  assert.deepEqual((await s.ok(["schedule", "run", "--job", "activity-weekly"])).counts, { learned: 0, held: 0, waiting: 0 });
});

test("a job with a failing live gate records a failed receipt and makes no request", async (t) => {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin"), store = join(devtwin, "store");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(store, { recursive: true, mode: 0o700 });
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const kitCommit = (await fixtureGit(kit, ["rev-parse", "HEAD"])).trim();
  const config = join(devtwin, "live.json");
  await writeFile(config, JSON.stringify({ schemaVersion: 1, pilotRoot: store, configRoot: join(store, "config"), dataRoot: join(store, "data"), stateRoot: join(store, "state"), inputsRoot: join(store, "inputs"), agentHomes: [], repos: [], forbidden: [], live: { configId: "cfg_0123456789abcdef", home, skillDirs: { claude: join(home, ".claude/skills") }, kitRoot: kit, kitCommit } }), { mode: 0o600 });
  const roots = rootsFromPilot(await loadPilot(config, { home, env: {}, kitRoot: kit, liveGate: { approval: false } }));
  ensureRoots(roots);
  await recordApprovedDigest(roots);
  ensurePrivatePath(roots.stateRoot, ["schedule", "receipts"]);
  // The kit now has a local change, so the live gate refuses every command.
  await writeFile(join(kit, "README.md"), "changed\n");
  const net = fakeNet(), chunks = [];
  await main(["schedule", "run", "--pilot", config, "--job", "radar-weekly"], { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home, env: {}, kitRoot: kit, request: net.request, lookup: net.lookup, stackCatalog: CATALOG });
  const out = JSON.parse(chunks.join(""));
  assert.deepEqual([out.ok, out.error.code], [false, "DEVTWIN_GATE_REQUIRED"]);
  const receipt = JSON.parse(await readFile(receiptPath(roots, "radar-weekly"), "utf8"));
  assert.deepEqual([receipt.result, receipt.code, receipt.lastRunAt], ["failed", "DEVTWIN_GATE_REQUIRED", null]);
  assert.equal(net.log.length, 0);
});

test("schedule apply and schedule off --apply are owner actions; their previews and schedule run stay open", () => {
  const shell = (command) => ownerAction("claude", { tool_name: "Bash", tool_input: { command } });
  assert.equal(shell("devtwin schedule apply --job radar-weekly --plan-fingerprint s"), "schedule apply");
  assert.equal(shell("devtwin schedule off --job radar-weekly --apply --plan-fingerprint s"), "schedule off --apply");
  for (const open of ["devtwin schedule plan --job radar-weekly", "devtwin schedule off --job radar-weekly", "devtwin schedule run --job radar-weekly", "devtwin schedule status"]) assert.equal(shell(open), null, open);
});

test("a failed run does not block the next run of its period", async (t) => {
  const s = await setup(t);
  await s.on("radar-weekly");
  // A new stack item makes the approval out of date, so every scope fails.
  const roots = await s.roots(), profile = { stackCurrent: ["acme-sdk=4.1.0", "widget"] };
  const plan = await planProfile(roots, { profile });
  await applyProfile(roots, { profile, fingerprint: plan.fingerprint }, { now });
  const failed = await s.cli(["schedule", "run", "--job", "radar-weekly"]);
  assert.equal(failed.json.error.code, "DEVTWIN_APPROVAL_REQUIRED");
  const receipt = JSON.parse(await readFile(receiptPath(roots, "radar-weekly"), "utf8"));
  assert.deepEqual([receipt.result, receipt.lastRunAt], ["failed", null]);
  const stack = await s.ok(["stack", "plan", "--with", "advisories"]);
  await s.ok(["stack", "approve", "--with", "advisories", "--plan-fingerprint", stack.fingerprint]);
  s.advance(3600000);
  assert.equal((await s.ok(["schedule", "run", "--job", "radar-weekly"])).digests.length, 1);
});

test("the runs of one job share one request budget and one answer for each source", async () => {
  const urls = ["https://a.example.com/1", "https://a.example.com/2", "https://a.example.com/3"], log = [];
  const request = async ({ url }) => { log.push(url); return url.endsWith("/1") ? { status: 500, headers: {}, body: Buffer.from("") } : { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from("{}") }; };
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const cache = new Map(), make = () => createFetcher({ request, lookup, hosts: ["a.example.com"], limits: { calls: 2 }, cache });
  const codes = async (fetcher) => Promise.all(urls.map((u) => fetcher.fetchResource(u, { accept: "application/json", types: ["application/json"] }).then(() => "ok", (e) => e.code)));
  assert.deepEqual(await codes(make()), ["DEVTWIN_UPSTREAM_UNAVAILABLE", "ok", "DEVTWIN_CALL_LIMIT"]);
  assert.deepEqual(await codes(make()), ["DEVTWIN_UPSTREAM_UNAVAILABLE", "ok", "DEVTWIN_CALL_LIMIT"], "the second scope adds no request");
  assert.equal(log.length, 2);
});
