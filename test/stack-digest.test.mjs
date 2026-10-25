import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, chmod, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.mjs";
import { initPilot, makeRepo, draftFor, now, treeSnapshot, sandbox, fixtureGit, runCli } from "./helpers.mjs";
import { applyScopeAdd, writeBindingVersion, writeManifest } from "../src/config/store.mjs";
import { readRegistry, publishRegistry } from "../src/config/registry.mjs";
import { withPilotLock, registryLockPath } from "../src/storage/lock.mjs";
import { operationIdFor } from "../src/identity/ids.mjs";
import { addRecord } from "../src/records/store.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { seenStatePath, readSeenState } from "../src/stack/check.mjs";
import { fence, applyDigest } from "../src/stack/digest.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const RSS = "https://changelog.example.com/feed.xml", ATOM = "https://updates.example.com/atom.xml", JSONF = "https://news.example.com/feed.json";
const RELEASES = "https://api.github.com/repos/example/acme-sdk/releases?per_page=10";
const OSV = "https://api.osv.dev/v1/query", EOL = "https://endoflife.date/api/acme-sdk.json", NPM = "https://registry.npmjs.org/acme-sdk/latest";
const CATALOG = { version: 1, items: [
  { name: "acme-sdk", terms: ["Acme SDK"], feeds: [RSS], github: ["example/acme-sdk"], endoflife: "acme-sdk", package: { ecosystem: "npm", name: "acme-sdk" } },
  { name: "widget", terms: ["Widget"], feeds: [ATOM] },
  { name: "gadget", terms: ["Gadget"], feeds: [JSONF] }
] };
const STACK = ["acme-sdk=4.1.0", "widget", "gadget", "lonely-tool"];
const ROUTES = {
  [RSS]: { type: "application/rss+xml", body: fixture("rss.xml") },
  [ATOM]: { type: "application/atom+xml", body: fixture("atom.xml") },
  [JSONF]: { type: "application/feed+json", body: fixture("feed.json") },
  [RELEASES]: { type: "application/json", body: fixture("releases.json") },
  [OSV]: { type: "application/json", body: fixture("osv.json") },
  [EOL]: { type: "application/json", body: fixture("eol.json") },
  [NPM]: { type: "application/json", body: fixture("npm-latest.json") }
};
function fakeNet(overrides = {}) {
  const log = [], lookups = [];
  const routes = { ...ROUTES, ...overrides };
  const lookup = async (host) => { lookups.push(host); return [{ address: "93.184.216.34", family: 4 }]; };
  const request = async (options) => {
    log.push(options.url);
    const r = routes[options.url];
    if (!r) return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    return { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/json" }, body: Buffer.from(r.body ?? "") };
  };
  return { log, lookups, lookup, request };
}
async function cli(p, args, options = {}) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main([...args.slice(0, 2), "--pilot", p.path, ...args.slice(2)], { stdout, now, home: tmpdir(), env: {}, stackCatalog: CATALOG, ...options });
  return { code, json: JSON.parse(chunks.join("")), text: chunks.join("") };
}
async function seedScopes(t, pairs = [["alpha", "alpha.web", "atlas"], ["beta", "beta.web", "beacon"]]) {
  const p = await initPilot(t);
  const bindings = [], operations = [];
  for (const [scope, project, repoName] of pairs) {
    await applyScopeAdd(p.roots, { scope, hubs: [], policies: [], now });
    const repo = await makeRepo(join(p.reposDir, repoName), { "README.md": "# Fixture\n" });
    const requestId = "req_seed" + repoName;
    const operationId = operationIdFor({ scope, project, requestId });
    await withPilotLock(p.roots, registryLockPath(p.roots), { kind: "fixture-seed" }, async () => {
      const binding = { schemaVersion: 1, scope, project, version: 1, roots: [{ path: repo, commonDir: join(repo, ".git"), kind: "main" }], remotes: [], approvedSources: [], expectedRemotes: [], actorRefs: [], environments: [], createdAt: now().toISOString() };
      const bindingHash = await writeBindingVersion(p.roots, binding);
      const manifest = { schemaVersion: 1, operationId, kind: "onboard", requestId, requestHash: "sha256:" + "0".repeat(64), scope, project, bindingHash, planFingerprint: "sha256:" + "0".repeat(64), bundles: [] };
      const manifestHash = await writeManifest(p.roots, manifest);
      const { value } = await readRegistry(p.roots);
      bindings.push({ path: repo, commonDir: join(repo, ".git"), scope, project, bindingVersion: 1, bindingHash, operationId, manifestHash });
      operations.push({ operationId, requestId, requestHash: manifest.requestHash, scope, project, manifestHash, planFingerprint: manifest.planFingerprint, generation: value.generation + 1 });
      await publishRegistry(p.roots, { ...value, generation: value.generation + 1, bindings: [...bindings], operations: [...operations] }, { expectGeneration: value.generation });
    }, { destinations: [p.configRoot, p.dataRoot] });
  }
  return p;
}
async function ready(t, { args = [] } = {}) {
  const p = await seedScopes(t);
  const profile = { stackCurrent: STACK };
  const plan = await planProfile(p.roots, { profile });
  await applyProfile(p.roots, { profile, fingerprint: plan.fingerprint }, { now });
  const preview = await cli(p, ["stack", "plan", ...args]);
  assert.equal(preview.code, 0, preview.text);
  const approved = await cli(p, ["stack", "approve", ...args, "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(approved.code, 0, approved.text);
  return p;
}
const record = (p, scope, project, requestId, body) => addRecord(p.roots, draftFor(scope, project, { requestId, body }), { now });
// Preview through the CLI with a fake network; returns the parsed result.
async function preview(p, net, scopeArgs = []) {
  const out = await cli(p, ["stack", "digest", ...scopeArgs], { request: net.request, lookup: net.lookup });
  assert.equal(out.code, 0, out.text);
  return out.json.result;
}
async function apply(p, fingerprint, scopeArgs = [], net = fakeNet()) {
  return cli(p, ["stack", "digest", ...scopeArgs, "--apply", "--plan-fingerprint", fingerprint], { request: net.request, lookup: net.lookup });
}
const pendingDir = (p) => join(p.stateRoot, "stack", "pending");
const pendingFile = (p, fingerprint) => join(pendingDir(p), fingerprint.slice(7) + ".json");
const list = async (dir) => { try { return (await readdir(dir)).sort(); } catch (error) { if (error.code === "ENOENT") return []; throw error; } };
const STREAMING = "acme-sdk 4 adds streaming";

test("stack digest preview writes only the pending file and apply writes one 0600 digest and updates seen state", async (t) => {
  const p = await ready(t);
  const before = await treeSnapshot(p.dataRoot);
  const plan = await preview(p, fakeNet());
  assert.match(plan.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(plan.scope, null);
  assert.deepEqual(await list(pendingDir(p)), [plan.fingerprint.slice(7) + ".json"]);
  assert.equal((await stat(pendingFile(p, plan.fingerprint))).mode & 0o777, 0o600);
  assert.equal(await treeSnapshot(p.dataRoot), before, "preview writes nothing under dataRoot");
  assert.equal((await readSeenState(p.roots, null)).size, 0);
  const out = await apply(p, plan.fingerprint);
  assert.equal(out.code, 0, out.text);
  const dir = join(p.dataRoot, "digests", "stack");
  const files = await list(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^stack-2026-10-07-[0-9a-f]{12}\.md$/);
  assert.equal(out.json.result.destination.path, "digests/stack/" + files[0]);
  assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(dir, files[0]), "utf8"), plan.markdown);
  assert.ok((await readSeenState(p.roots, null)).size > 0);
  assert.deepEqual(await list(pendingDir(p)), []);
});

test("a --scope alpha digest apply writes under scopes/alpha/digests/stack and updates only alpha's seen state, and an unscoped apply writes under digests/stack", async (t) => {
  const p = await ready(t);
  const scoped = await preview(p, fakeNet(), ["--scope", "alpha"]);
  assert.equal(scoped.scope, "alpha");
  const out = await apply(p, scoped.fingerprint, ["--scope", "alpha"]);
  assert.equal(out.code, 0, out.text);
  assert.equal((await list(join(p.dataRoot, "scopes", "alpha", "digests", "stack"))).length, 1);
  assert.deepEqual(await list(join(p.dataRoot, "digests")), []);
  assert.ok((await readSeenState(p.roots, "alpha")).size > 0);
  assert.equal((await readSeenState(p.roots, "beta")).size, 0);
  assert.equal((await readSeenState(p.roots, null)).size, 0);
  const plain = await preview(p, fakeNet());
  assert.ok(plain.markdown.includes(STREAMING), "the unscoped seen state is separate");
  assert.equal((await apply(p, plain.fingerprint)).code, 0);
  assert.equal((await list(join(p.dataRoot, "digests", "stack"))).length, 1);
  assert.equal((await list(join(p.dataRoot, "scopes", "alpha", "digests", "stack"))).length, 1);
});

test("a title and summary containing backtick and tilde fences stay inside a longer backtick fence", async (t) => {
  const p = await ready(t);
  const hostile = fixture("rss.xml").toString()
    .replace("acme-sdk 4 adds streaming", "acme-sdk 4 ```` # Injected heading ~~~ [click](https://evil.example.org)")
    .replace("<![CDATA[<p>Streaming responses are now <b>generally available</b>.</p>]]>", "Close ``` early ~~~~ and ![img](https://evil.example.org/x.png) here");
  const plan = await preview(p, fakeNet({ [RSS]: { type: "application/rss+xml", body: hostile } }));
  const md = plan.markdown;
  const lines = md.split("\n");
  const opened = lines.findIndex((line) => line.includes("Injected heading"));
  assert.ok(opened > 0);
  // The excerpt sits inside a fence of five backticks: one longer than the four-backtick run in the title.
  const open = lines.slice(0, opened).map((line, i) => [line, i]).filter(([line]) => /^`{3,}/.test(line)).pop();
  assert.equal(open[0], "`````text");
  const close = lines.findIndex((line, i) => i > opened && /^`{3,}\s*$/.test(line));
  assert.equal(lines[close], "`````");
  assert.ok(lines.slice(open[1] + 1, close).some((line) => line.includes("Close ``` early ~~~~")));
  // Outside fences, no fetched text appears.
  let inFence = null;
  const live = [];
  for (const line of lines) {
    const m = /^(`{3,})/.exec(line);
    if (inFence) { if (m && m[1].length >= inFence.length && /^`+\s*$/.test(line)) inFence = null; continue; }
    if (m) { inFence = m[1]; continue; }
    live.push(line);
  }
  assert.equal(inFence, null);
  for (const text of ["Injected heading", "evil.example.org", "Close", "click"]) assert.ok(!live.some((line) => line.includes(text)), text);
  assert.equal(fence("plain"), "```"); assert.equal(fence("a `` b ```` c"), "`````"); assert.equal(fence("~~~~~"), "```");
});

test("a --scope alpha digest lists alpha.web first with the record ID, then your stack, then the background count", async (t) => {
  const p = await ready(t);
  const a = await record(p, "alpha", "alpha.web", "req_alpha0001", "Uploads go through acme-sdk with retries.");
  const md = (await preview(p, fakeNet(), ["--scope", "alpha"])).markdown;
  const at = (text) => { const i = md.indexOf(text); assert.ok(i >= 0, text); return i; };
  assert.ok(at("## Project alpha.web") < at("## Your stack"));
  assert.ok(at("## Your stack") < at("## Background"));
  assert.ok(md.includes(a.recordId));
  assert.ok(at(STREAMING) < at("## Your stack"));
  assert.match(md, /^New background entries \(counted, not listed\): [1-9]/m);
  assert.ok(!md.includes("Tips and tricks"), "background entries are counted, not listed");
  assert.match(md, /^- Scope: alpha$/m);
  assert.match(md, /^- Not watched: lonely-tool$/m);
  const plain = (await preview(p, fakeNet())).markdown;
  assert.ok(!plain.includes("alpha.web"));
  assert.match(plain, /^- Scope: none$/m);
  assert.ok(plain.indexOf(STREAMING) > plain.indexOf("## Your stack"));
});

test("a second digest run with unchanged entries says no new announcements", async (t) => {
  const p = await ready(t);
  const first = await preview(p, fakeNet());
  assert.equal((await apply(p, first.fingerprint)).code, 0);
  const second = await preview(p, fakeNet());
  assert.match(second.markdown, /No new announcements\./);
  assert.ok(!second.markdown.includes(STREAMING));
  assert.equal(second.counts.new.project + second.counts.new.stack + second.counts.new.background, 0);
});

test("a changed entry is reported again and an advisory whose severity changes is reported again", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories"] });
  const first = await preview(p, fakeNet());
  assert.match(first.markdown, /^### high$/m);
  assert.ok(first.markdown.includes("GHSA-exam-ple0-0001"));
  assert.equal((await apply(p, first.fingerprint)).code, 0);
  const changedRss = fixture("rss.xml").toString().replace("generally available", "available");
  const changedOsv = fixture("osv.json").toString().replace("HIGH", "CRITICAL");
  const second = await preview(p, fakeNet({ [RSS]: { type: "application/rss+xml", body: changedRss }, [OSV]: { type: "application/json", body: changedOsv } }));
  assert.ok(second.markdown.includes(STREAMING));
  assert.ok(!second.markdown.includes("Widget 2.3"), "unchanged entries are not repeated");
  assert.match(second.markdown, /^### critical$/m);
  assert.ok(second.markdown.includes("GHSA-exam-ple0-0001"));
  assert.ok(!/^### high$/m.test(second.markdown));
});

test("the digest contains no record text, only record IDs", async (t) => {
  const p = await ready(t);
  const a = await record(p, "alpha", "alpha.web", "req_alpha0001", "Private detail: acme-sdk proxies uploads for the ledger service.");
  const plan = await preview(p, fakeNet(), ["--scope", "alpha"]);
  assert.ok(plan.markdown.includes(a.recordId));
  for (const text of ["Private detail", "ledger service", "proxies uploads"]) assert.ok(!plan.markdown.includes(text), text);
  assert.ok(!readFileSync(pendingFile(p, plan.fingerprint), "utf8").includes("Private detail"));
});

test("stack digest apply with an unknown or stale fingerprint writes neither digest nor seen state", async (t) => {
  const p = await ready(t);
  const unknown = await apply(p, "sha256:" + "a".repeat(64));
  assert.equal(unknown.json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.equal((await apply(p, "../escape")).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  const missing = await cli(p, ["stack", "digest", "--apply"]);
  assert.equal(missing.json.error.code, "DEVTWIN_PLAN_REQUIRED");
  // Two previews against the same seen state; applying one makes the other stale.
  const a = await preview(p, fakeNet());
  const b = await preview(p, fakeNet({ [ATOM]: { status: 503 } }));
  assert.notEqual(a.fingerprint, b.fingerprint);
  assert.equal((await apply(p, a.fingerprint)).code, 0);
  const seenBefore = readFileSync(seenStatePath(p.roots, null));
  const digestsBefore = await list(join(p.dataRoot, "digests", "stack"));
  const stale = await apply(p, b.fingerprint);
  assert.equal(stale.json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.deepEqual(readFileSync(seenStatePath(p.roots, null)), seenBefore);
  assert.deepEqual(await list(join(p.dataRoot, "digests", "stack")), digestsBefore);
  // A preview for one scope cannot be applied as another.
  const scoped = await preview(p, fakeNet(), ["--scope", "alpha"]);
  assert.equal((await apply(p, scoped.fingerprint, ["--scope", "beta"])).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.equal((await apply(p, scoped.fingerprint)).json.error.code, "DEVTWIN_PLAN_MISMATCH");
  assert.deepEqual(await list(join(p.dataRoot, "scopes", "alpha", "digests", "stack")), []);
  assert.equal((await readSeenState(p.roots, "alpha")).size, 0);
});

test("stack digest apply never overwrites an existing digest", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const target = join(p.dataRoot, plan.destination.path);
  await mkdir(join(p.dataRoot, "digests", "stack"), { recursive: true, mode: 0o700 });
  await writeFile(target, "existing\n", { mode: 0o600 });
  const out = await apply(p, plan.fingerprint);
  assert.equal(out.json.error.code, "DEVTWIN_CONFLICT");
  assert.equal(await readFile(target, "utf8"), "existing\n");
  assert.equal((await readSeenState(p.roots, null)).size, 0);
});

test("stack digest apply makes no request through the injected request", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const net = fakeNet();
  const out = await apply(p, plan.fingerprint, [], net);
  assert.equal(out.code, 0, out.text);
  assert.equal(net.log.length + net.lookups.length, 0);
});

test("stack digest apply refuses a pending file whose bytes no longer match its hash with INTEGRITY", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const path = pendingFile(p, plan.fingerprint);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.markdown = value.markdown.replace("# Stack digest", "# Stack digest (edited)");
  await chmod(path, 0o600);
  await writeFile(path, JSON.stringify(value) + "\n");
  const out = await apply(p, plan.fingerprint);
  assert.equal(out.json.error.code, "DEVTWIN_INTEGRITY");
  assert.deepEqual(await list(join(p.dataRoot, "digests", "stack")), []);
  assert.equal((await readSeenState(p.roots, null)).size, 0);
});

test("every digest entry and finding line carries an https source URL", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"] });
  const md = (await preview(p, fakeNet())).markdown;
  const lines = md.split("\n").filter((line) => /^- (Entry|Finding) /.test(line));
  assert.ok(lines.length >= 5);
  for (const line of lines) assert.match(line, /source <https:\/\/[^>\s]+>/, line);
  assert.ok(lines.some((line) => line.includes("link <https://changelog.example.com/posts/streaming>")));
  assert.ok(md.includes("Approval: sha256:"));
});

test("an entry reported in a --scope alpha digest is reported as new in a --scope beta digest that links it to a beta project", async (t) => {
  const p = await ready(t);
  await record(p, "alpha", "alpha.web", "req_alpha0001", "acme-sdk is our upload client.");
  const b = await record(p, "beta", "beta.web", "req_beta0001", "acme-sdk handles media.");
  const alpha = await preview(p, fakeNet(), ["--scope", "alpha"]);
  assert.equal((await apply(p, alpha.fingerprint, ["--scope", "alpha"])).code, 0);
  assert.ok(!(await preview(p, fakeNet(), ["--scope", "alpha"])).markdown.includes(STREAMING));
  const beta = (await preview(p, fakeNet(), ["--scope", "beta"])).markdown;
  assert.ok(beta.indexOf(STREAMING) > beta.indexOf("## Project beta.web"));
  assert.ok(beta.indexOf(STREAMING) < beta.indexOf("## Your stack"));
  assert.ok(beta.includes(b.recordId));
});

test("stack digest is listed in help", async () => {
  const out = await runCli(["help"]);
  assert.ok(out.json.result.commands.includes("stack digest"));
});

test("with a live config stack digest preview and apply fail with GATE_REQUIRED and make no request", async (t) => {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const liveConfig = join(devtwin, "live.json");
  const run = (args, extra = {}) => { const chunks = []; return main(args, { stdout: { write(v) { chunks.push(v); return true; } }, now, home, env: {}, kitRoot: kit, ...extra }).then((code) => ({ code, json: JSON.parse(chunks.join("")) })); };
  const init = await run(["live", "init", "--pilot", liveConfig, "--agent", "claude"]);
  assert.equal(init.json.ok, true, JSON.stringify(init.json));
  const applied = await run(["live", "init", "--pilot", liveConfig, "--agent", "claude", "--apply", "--plan-fingerprint", init.json.result.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json));
  const net = fakeNet();
  const before = await treeSnapshot(devtwin);
  for (const extra of [[], ["--apply", "--plan-fingerprint", "sha256:" + "b".repeat(64)]]) {
    const out = await run(["stack", "digest", "--pilot", liveConfig, ...extra], { request: net.request, lookup: net.lookup, stackCatalog: CATALOG });
    assert.equal(out.json.ok, false);
    assert.equal(out.json.error.code, "DEVTWIN_GATE_REQUIRED");
    assert.equal(out.json.error.details.reason, "no-live-exception");
  }
  assert.equal(net.log.length + net.lookups.length, 0);
  assert.equal(await treeSnapshot(devtwin), before);
});

test("an apply that lands while a preview is fetching makes that preview stale with PLAN_MISMATCH", async (t) => {
  const p = await ready(t);
  const first = await preview(p, fakeNet());
  // The second preview's check reads seen state, then its first request applies the first preview.
  const base = fakeNet({ [ATOM]: { status: 503 } });
  let applied = null;
  const request = async (options) => { if (!applied) applied = await apply(p, first.fingerprint); return base.request(options); };
  const second = await cli(p, ["stack", "digest"], { request, lookup: base.lookup });
  assert.equal(second.code, 0, second.text);
  assert.equal(applied.code, 0, applied.text);
  const seenBefore = readFileSync(seenStatePath(p.roots, null));
  const digestsBefore = await list(join(p.dataRoot, "digests", "stack"));
  const stale = await apply(p, second.json.result.fingerprint);
  assert.equal(stale.json.error?.code, "DEVTWIN_PLAN_MISMATCH", stale.text);
  assert.deepEqual(readFileSync(seenStatePath(p.roots, null)), seenBefore);
  assert.deepEqual(await list(join(p.dataRoot, "digests", "stack")), digestsBefore);
});

test("a digest apply retried after a crash between the digest write and the seen update completes once", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const crash = new Error("simulated crash after digest");
  await assert.rejects(applyDigest(p.roots, { scope: null, fingerprint: plan.fingerprint }, { faults: { afterDigest: async () => { throw crash; } } }), (error) => error === crash);
  const target = join(p.dataRoot, plan.destination.path);
  assert.equal(await readFile(target, "utf8"), plan.markdown);
  assert.equal((await readSeenState(p.roots, null)).size, 0);
  assert.deepEqual(await list(pendingDir(p)), [plan.fingerprint.slice(7) + ".json"]);
  const retried = await apply(p, plan.fingerprint);
  assert.equal(retried.code, 0, retried.text);
  assert.equal(retried.json.result.seen.added, plan.seen.add.length);
  assert.equal((await readSeenState(p.roots, null)).size, plan.seen.add.length);
  assert.deepEqual(await list(pendingDir(p)), []);
  assert.deepEqual(await list(join(p.dataRoot, "digests", "stack")), [plan.destination.path.split("/").pop()]);
});

test("a digest apply keeps CONFLICT when the existing digest has the planned bytes but a wider mode", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const target = join(p.dataRoot, plan.destination.path);
  await mkdir(join(p.dataRoot, "digests", "stack"), { recursive: true, mode: 0o700 });
  await writeFile(target, plan.markdown, { mode: 0o644 });
  await chmod(target, 0o644);
  const out = await apply(p, plan.fingerprint);
  assert.equal(out.json.error?.code, "DEVTWIN_CONFLICT", out.text);
  assert.equal((await readSeenState(p.roots, null)).size, 0);
  assert.deepEqual(await list(pendingDir(p)), [plan.fingerprint.slice(7) + ".json"]);
});

test("stack digest apply after the stack approval changed since preview fails with PLAN_MISMATCH and writes neither digest nor seen state", async (t) => {
  const p = await ready(t);
  const plan = await preview(p, fakeNet());
  const changed = await cli(p, ["stack", "plan", "--with", "advisories"]);
  assert.equal(changed.code, 0, changed.text);
  const approved = await cli(p, ["stack", "approve", "--with", "advisories", "--plan-fingerprint", changed.json.result.fingerprint]);
  assert.equal(approved.code, 0, approved.text);
  const out = await apply(p, plan.fingerprint);
  assert.equal(out.json.error?.code, "DEVTWIN_PLAN_MISMATCH", out.text);
  assert.match(out.json.error.message, /approval changed/);
  assert.deepEqual(await list(join(p.dataRoot, "digests", "stack")), []);
  assert.equal((await readSeenState(p.roots, null)).size, 0);
  assert.deepEqual(await list(join(p.stateRoot, "stack", "seen")), []);
});
