import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.mjs";
import { initPilot, makeRepo, draftFor, now, treeSnapshot, sandbox, fixtureGit, runCli } from "./helpers.mjs";
import { applyScopeAdd, writeBindingVersion, writeManifest } from "../src/config/store.mjs";
import { readRegistry, publishRegistry } from "../src/config/registry.mjs";
import { withPilotLock, registryLockPath } from "../src/storage/lock.mjs";
import { operationIdFor } from "../src/identity/ids.mjs";
import { addRecord, supersedeRecord, readSnapshot } from "../src/records/store.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { validateStackCatalog } from "../src/stack/catalog.mjs";
import { runStackCheck, seenStatePath, seenStateBody } from "../src/stack/check.mjs";
import { createFetcher } from "../src/stack/fetch.mjs";
import { ensurePrivatePath, atomicReplace } from "../src/storage/fsx.mjs";
import { canonicalJson } from "../src/storage/canonical.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const RSS = "https://changelog.example.com/feed.xml", ATOM = "https://updates.example.com/atom.xml", JSONF = "https://news.example.com/feed.json";
const RELEASES = "https://api.github.com/repos/example/acme-sdk/releases?per_page=10";
const OSV = "https://api.osv.dev/v1/query", EOL = "https://endoflife.date/api/acme-sdk.json", NPM = "https://registry.npmjs.org/acme-sdk/latest";
const CATALOG = { version: 1, items: [
  { name: "acme-sdk", terms: ["Acme SDK"], feeds: [RSS], github: ["example/acme-sdk"], endoflife: "acme-sdk", package: { ecosystem: "npm", name: "acme-sdk" } },
  { name: "widget", terms: ["Widget"], feeds: [ATOM] },
  { name: "gadget", terms: ["Gadget"], feeds: [JSONF] },
  { name: "pgdb", terms: ["PgDB"], endoflife: "pgdb", package: { ecosystem: "npm", name: "pgdb" } }
] };
const STACK = ["acme-sdk=4.1.0", "widget", "gadget", "lonely-tool"];
const PUBLIC = "93.184.216.34";
const BINDING_VALUE = ["fixture", "public", "read", "value", "51c0de"].join("-");
const AUTH = "authorization";
// Default fixture routes: every approved source answers with a synthetic fixture.
const ROUTES = {
  [RSS]: { type: "application/rss+xml", body: fixture("rss.xml") },
  [ATOM]: { type: "application/atom+xml", body: fixture("atom.xml") },
  [JSONF]: { type: "application/feed+json", body: fixture("feed.json") },
  [RELEASES]: { type: "application/json", body: fixture("releases.json") },
  [OSV]: { type: "application/json", body: fixture("osv.json") },
  [EOL]: { type: "application/json", body: fixture("eol.json") },
  [NPM]: { type: "application/json", body: fixture("npm-latest.json") }
};
function fakeNet(overrides = {}, { addresses = {} } = {}) {
  const log = [], lookups = [];
  const routes = { ...ROUTES, ...overrides };
  const lookup = async (host) => {
    lookups.push(host);
    const a = addresses[host];
    const value = typeof a === "function" ? a(lookups.filter((h) => h === host).length) : a ?? PUBLIC;
    return [{ address: value, family: value.includes(":") ? 6 : 4 }];
  };
  const request = async (options) => {
    log.push({ ...options, body: options.body ? options.body.toString() : undefined });
    const route = routes[options.url];
    if (!route) return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    const r = typeof route === "function" ? route(options) : route;
    return { status: r.status ?? 200, headers: { "content-type": r.type ?? "application/json", ...(r.headers ?? {}) }, body: Buffer.from(r.body ?? "") };
  };
  return { log, lookups, lookup, request };
}
async function setProfile(p, stackCurrent) {
  const profile = { stackCurrent };
  const plan = await planProfile(p.roots, { profile });
  await applyProfile(p.roots, { profile, fingerprint: plan.fingerprint }, { now });
}
async function cli(p, args, options = {}) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main([...args.slice(0, 2), "--pilot", p.path, ...args.slice(2)], { stdout, now, home: tmpdir(), env: options.env ?? {}, stackCatalog: CATALOG, ...options });
  return { code, json: JSON.parse(chunks.join("")), text: chunks.join("") };
}
async function approve(p, args = [], options = {}) {
  const plan = await cli(p, ["stack", "plan", ...args], options);
  assert.equal(plan.code, 0, plan.text);
  const out = await cli(p, ["stack", "approve", ...args, "--plan-fingerprint", plan.json.result.fingerprint], options);
  assert.equal(out.code, 0, out.text);
  return out.json.result;
}
// Two scopes, each with one committed project, as onboarding would leave them (no records yet).
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
const record = (p, scope, project, requestId, body, opts = {}) => addRecord(p.roots, draftFor(scope, project, { requestId, body, ...opts }), { now });
async function ready(t, { stack = STACK, args = [], options = {} } = {}) {
  const p = await seedScopes(t);
  await setProfile(p, stack);
  await approve(p, args, options);
  return p;
}
const deps = (net, extra = {}) => ({ catalog: validateStackCatalog(CATALOG), request: net.request, lookup: net.lookup, now, ...extra });
const check = (p, net, input = {}, extra = {}) => runStackCheck(p.roots, input, deps(net, extra));
const byTitle = (result, title) => result.entries.find((e) => e.title === title);
const STREAMING = "acme-sdk 4 adds streaming", OFFICE = "Quarterly office hours & community notes";
const failureOf = (result, item, kind) => result.failures.find((f) => f.item === item && (!kind || f.source === kind));

test("a GitHub releases fixture yields one entry per published release with the release URL", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet());
  const releases = result.entries.filter((e) => e.sourceKind === "github-release");
  assert.deepEqual(releases.map((e) => e.link), ["https://github.com/example/acme-sdk/releases/tag/v4.1.0", "https://github.com/example/acme-sdk/releases/tag/v4.0.0"]);
  for (const e of releases) { assert.equal(e.linkLive, true); assert.equal(e.sourceUrl, RELEASES); assert.match(e.hash, /^sha256:[0-9a-f]{64}$/); assert.equal(e.item, "acme-sdk"); }
  const feeds = result.entries.filter((e) => e.sourceKind === "feed");
  assert.deepEqual(feeds.map((e) => e.item).sort(), ["acme-sdk", "acme-sdk", "gadget", "gadget", "widget"]);
  for (const e of result.entries) { assert.ok(e.title); assert.ok(e.sourceUrl); assert.ok("date" in e); }
});

test("with --scope alpha an entry matching a term in an accepted alpha.web record is grouped under alpha.web with the record ID, and an unmatched entry is background", async (t) => {
  const p = await ready(t);
  const a = await record(p, "alpha", "alpha.web", "req_alpha0001", "Uploads go through acme-sdk with retries.");
  await record(p, "alpha", "alpha.web", "req_alpha0002", "Nothing relevant here.");
  const result = await check(p, fakeNet(), { scope: "alpha" });
  const hit = byTitle(result, STREAMING);
  assert.equal(hit.level, "project");
  assert.deepEqual(hit.projects, [{ project: "alpha.web", recordIds: [a.recordId] }]);
  assert.equal(hit.link, "https://changelog.example.com/posts/streaming");
  assert.equal(hit.linkLive, true);
  assert.equal(byTitle(result, "Tips and tricks").level, "background");
  assert.equal(result.scope, "alpha");
  assert.ok(result.counts.background >= 1);
  assert.ok(!JSON.stringify(result).includes("Uploads go through"), "record text is never quoted");
});

test("without --scope the same entry is grouped under your stack, no project is named and no record is read", async (t) => {
  const p = await ready(t);
  await record(p, "alpha", "alpha.web", "req_alpha0001", "Uploads go through acme-sdk with retries.");
  let reads = 0;
  const reader = async (...args) => { reads++; return readSnapshot(...args); };
  const result = await check(p, fakeNet(), {}, { reader });
  assert.equal(reads, 0);
  const hit = byTitle(result, STREAMING);
  assert.equal(hit.level, "stack");
  assert.deepEqual(hit.projects, []);
  assert.equal(result.scope, null);
  assert.ok(!JSON.stringify(result).includes("alpha"));
  await check(p, fakeNet(), { scope: "alpha" }, { reader });
  assert.ok(reads > 0);
});

test("a superseded or proposed record does not create a project link", async (t) => {
  const p = await ready(t);
  const old = await record(p, "beta", "beta.web", "req_beta0001", "We use acme-sdk.");
  await supersedeRecord(p.roots, { ...draftFor("beta", "beta.web", { requestId: "req_beta0002", body: "Moved off that library." }), targets: [old.recordId], expectHashes: [old.recordHash] }, { now });
  await record(p, "beta", "beta.web", "req_beta0003", "Maybe adopt acme-sdk again.", { status: "proposed" });
  const result = await check(p, fakeNet(), { scope: "beta" });
  assert.equal(byTitle(result, STREAMING).level, "stack");
  assert.deepEqual(byTitle(result, STREAMING).projects, []);
});

test("fixture data with a newer major, an EOL date in 30 days and an OSV advisory for the declared version yields one medium and two high findings with URLs", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"] });
  const net = fakeNet();
  const result = await check(p, net);
  const opt = result.findings.filter((f) => f.group !== "announcements");
  assert.deepEqual(opt.map((f) => [f.kind, f.severity]).sort(), [["advisory", "high"], ["end-of-life", "high"], ["new-major-version", "medium"]]);
  for (const f of opt) { assert.match(f.url, /^https:\/\//); assert.match(f.sourceUrl, /^https:\/\//); assert.equal(f.fetchedAt, now().toISOString()); assert.match(f.hash, /^sha256:/); }
  assert.ok(!JSON.stringify(opt).toLowerCase().includes("breaking"));
  const osv = net.log.filter((r) => r.url === OSV);
  assert.equal(osv.length, 1);
  assert.equal(osv[0].method, "POST");
  assert.deepEqual(JSON.parse(osv[0].body), { package: { name: "acme-sdk", ecosystem: "npm" }, version: "4.1.0" });
});

test("a release note containing BREAKING: yields a quoted excerpt finding with the release URL", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet());
  const notes = result.findings.filter((f) => f.kind === "release-note");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].excerpt, "- BREAKING: the legacy upload method was removed");
  assert.equal(notes[0].url, "https://github.com/example/acme-sdk/releases/tag/v4.1.0");
  assert.equal(notes[0].sourceUrl, RELEASES);
});

test("a previously seen, unchanged entry is marked previously reported", async (t) => {
  const p = await ready(t);
  const first = await check(p, fakeNet());
  assert.ok(first.entries.every((e) => e.previouslyReported === false));
  const hash = byTitle(first, STREAMING).hash;
  ensurePrivatePath(p.stateRoot, ["stack", "seen"]);
  await atomicReplace(seenStatePath(p.roots, null), canonicalJson(seenStateBody(null, [hash])) + "\n");
  const second = await check(p, fakeNet());
  assert.equal(byTitle(second, STREAMING).previouslyReported, true);
  assert.equal(byTitle(second, "Tips and tricks").previouslyReported, false);
  assert.equal(second.counts.previouslyReported, 1);
  const changed = await check(p, fakeNet({ [RSS]: { type: "application/rss+xml", body: fixture("rss.xml").toString().replace("generally available", "available") } }));
  assert.equal(byTitle(changed, STREAMING).previouslyReported, false);
});

test("an entry seen in a --scope alpha run is new in a --scope beta run that links it to a beta project", async (t) => {
  const p = await ready(t);
  await record(p, "alpha", "alpha.web", "req_alpha0001", "acme-sdk is our upload client.");
  const b = await record(p, "beta", "beta.web", "req_beta0001", "acme-sdk handles media.");
  const alpha = await check(p, fakeNet(), { scope: "alpha" });
  const hash = byTitle(alpha, STREAMING).hash;
  ensurePrivatePath(p.stateRoot, ["stack", "seen", "scopes"]);
  await atomicReplace(seenStatePath(p.roots, "alpha"), canonicalJson(seenStateBody("alpha", [hash])) + "\n");
  assert.equal(byTitle(await check(p, fakeNet(), { scope: "alpha" }), STREAMING).previouslyReported, true);
  const beta = await check(p, fakeNet(), { scope: "beta" });
  const hit = byTitle(beta, STREAMING);
  assert.equal(hit.previouslyReported, false);
  assert.deepEqual(hit.projects, [{ project: "beta.web", recordIds: [b.recordId] }]);
  assert.notEqual(seenStatePath(p.roots, "alpha"), seenStatePath(p.roots, "beta"));
  assert.notEqual(seenStatePath(p.roots, "none"), seenStatePath(p.roots, null));
});

test("a feed that fails to fetch produces a failed item with a typed reason and no entries, and an unmapped item reports not watched", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet({ [ATOM]: { status: 503 } }));
  const widget = result.items.find((i) => i.name === "widget");
  assert.equal(widget.status, "failed");
  assert.equal(failureOf(result, "widget").code, "DEVTWIN_UPSTREAM_UNAVAILABLE");
  assert.equal(result.entries.filter((e) => e.item === "widget").length, 0);
  assert.deepEqual(result.notWatched, ["lonely-tool"]);
  const lonely = result.items.find((i) => i.name === "lonely-tool");
  assert.equal(lonely.status, "not-watched");
  assert.ok(!result.failures.some((f) => f.item === "lonely-tool"));
  assert.ok(result.entries.some((e) => e.item === "gadget"));
});

test("a feed with a DOCTYPE or over the byte, depth or entry caps fails that item with a typed code while other items still report", async (t) => {
  const p = await ready(t);
  const deep = "<x>".repeat(40) + "</x>".repeat(40);
  const cases = [
    [`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "b">]><rss version="2.0"><channel><item><title>&a;</title></item></channel></rss>`, "DEVTWIN_FEED_INVALID"],
    [`<rss version="2.0"><channel><item><title>${deep}</title></item></channel></rss>`, "DEVTWIN_FEED_LIMIT"],
    [`<rss version="2.0"><channel>${"<item><title>a</title></item>".repeat(201)}</channel></rss>`, "DEVTWIN_FEED_LIMIT"],
    ["<rss version=\"2.0\"><channel>" + " ".repeat(1048577) + "</channel></rss>", "DEVTWIN_RESPONSE_TOO_LARGE"]
  ];
  for (const [body, code] of cases) {
    const result = await check(p, fakeNet({ [ATOM]: { type: "application/atom+xml", body } }));
    assert.equal(failureOf(result, "widget").code, code);
    assert.ok(result.entries.some((e) => e.item === "gadget"));
    assert.ok(!JSON.stringify(result).includes("\"b\""));
  }
});

test("an entry link on a host other than its feed's host is emitted as inert text, not a live link", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet());
  const office = byTitle(result, OFFICE);
  assert.equal(office.link, "https://elsewhere.example.net/office-hours");
  assert.equal(office.linkLive, false);
  assert.equal(byTitle(result, STREAMING).linkLive, true);
});

test("a feed host that resolves to a loopback or private address is refused with PATH_UNSAFE before any request", async (t) => {
  const p = await ready(t);
  for (const address of ["127.0.0.1", "10.0.0.7", "fd00::1", "169.254.169.254"]) {
    const net = fakeNet({}, { addresses: { "updates.example.com": address } });
    const result = await check(p, net);
    assert.equal(failureOf(result, "widget").code, "DEVTWIN_PATH_UNSAFE");
    assert.ok(net.lookups.includes("updates.example.com"));
    assert.ok(!net.log.some((r) => r.url === ATOM), address);
  }
});

test("a lookup that answers public first and loopback second still connects only to the public address checked first", async (t) => {
  const p = await ready(t);
  const net = fakeNet({}, { addresses: { "updates.example.com": (n) => n === 1 ? PUBLIC : "127.0.0.1" } });
  const result = await check(p, net);
  const atom = net.log.filter((r) => r.url === ATOM);
  assert.equal(atom.length, 1);
  assert.equal(atom[0].address, PUBLIC);
  assert.equal(atom[0].family, 4);
  assert.ok(net.log.every((r) => r.address === PUBLIC));
  assert.equal(net.lookups.filter((h) => h === "updates.example.com").length, 1);
  assert.ok(result.entries.some((e) => e.item === "widget"));
});

test("a gzip response fails that item with a typed code and every request carries Accept-Encoding identity and the fixed user agent", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"] });
  const net = fakeNet({ [JSONF]: { type: "application/feed+json", headers: { "content-encoding": "gzip" }, body: "x" } });
  const result = await check(p, net);
  assert.equal(failureOf(result, "gadget").code, "DEVTWIN_ENCODING_REFUSED");
  assert.ok(net.log.length >= 6);
  for (const r of net.log) {
    assert.equal(r.headers["Accept-Encoding"], "identity");
    assert.equal(r.headers["User-Agent"], "devtwin-stack-check");
  }
});

test("a 429 from one host reports those items as rate limited while other items still report", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet({ [RELEASES]: { status: 429, headers: { "retry-after": "60" } } }));
  const failure = failureOf(result, "acme-sdk", "github-release");
  assert.equal(failure.code, "DEVTWIN_RATE_LIMITED");
  assert.equal(failure.details.retryAfterSeconds, 60);
  assert.equal(result.items.find((i) => i.name === "acme-sdk").status, "partial");
  assert.ok(result.entries.some((e) => e.item === "widget"));
  assert.ok(result.entries.some((e) => e.item === "acme-sdk" && e.sourceKind === "feed"));
});

test("oversized bodies, redirects and unexpected content types fail per item with typed codes", async (t) => {
  const p = await ready(t);
  const result = await check(p, fakeNet({
    [ATOM]: { status: 302, headers: { location: "https://elsewhere.example.net/atom.xml" } },
    [JSONF]: { type: "text/html", body: "<html></html>" },
    [RSS]: { type: "application/rss+xml", body: "x".repeat(1048577) }
  }));
  assert.equal(failureOf(result, "widget").code, "DEVTWIN_REDIRECT_REFUSED");
  assert.equal(failureOf(result, "gadget").code, "DEVTWIN_CONTENT_TYPE_REFUSED");
  assert.equal(failureOf(result, "acme-sdk", "feed").code, "DEVTWIN_RESPONSE_TOO_LARGE");
  assert.ok(result.entries.some((e) => e.sourceKind === "github-release"));
});

test("every request goes to an approved host and carries only an approved feed URL, a catalog identifier or, for OSV only, an exact version", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"] });
  await record(p, "alpha", "alpha.web", "req_alpha0001", "Project canary PRIVATE-ALPHA-7731 uses acme-sdk.");
  const net = fakeNet();
  await check(p, net, { scope: "alpha" });
  const approved = new Set(["changelog.example.com", "updates.example.com", "news.example.com", "api.github.com", "api.osv.dev", "endoflife.date", "registry.npmjs.org"]);
  const allowedUrls = new Set([RSS, ATOM, JSONF, RELEASES, OSV, EOL, NPM]);
  for (const r of net.log) {
    assert.ok(approved.has(new URL(r.url).hostname), r.url);
    assert.ok(allowedUrls.has(r.url), r.url);
    const text = JSON.stringify(r);
    for (const leak of ["PRIVATE-ALPHA", "alpha", "web", p.sandbox, "lonely"]) assert.ok(!text.includes(leak), leak + " in " + r.url);
    if (r.url !== OSV) { assert.equal(r.body, undefined); assert.ok(!text.includes("4.1.0"), r.url); }
  }
  assert.equal(net.log.filter((r) => r.method !== "GET").map((r) => r.url).join(), OSV);
});

test("with no --with no request reaches api.osv.dev, endoflife.date or any registry", async (t) => {
  const p = await ready(t);
  const net = fakeNet();
  const result = await check(p, net);
  const hosts = new Set(net.log.map((r) => new URL(r.url).hostname));
  for (const host of ["api.osv.dev", "endoflife.date", "registry.npmjs.org", "pypi.org", "crates.io"]) assert.ok(!hosts.has(host), host);
  assert.deepEqual(result.groups, ["announcements"]);
});

test("an item declared as a major line makes no OSV request and reports version not exact, and an item without a version reports version unknown", async (t) => {
  const p = await ready(t, { stack: ["pgdb=16", "acme-sdk"], args: ["--with", "advisories"] });
  const net = fakeNet();
  const result = await check(p, net);
  assert.ok(!net.log.some((r) => r.url === OSV));
  const notes = (name) => result.items.find((i) => i.name === name).notes;
  assert.ok(notes("pgdb").some((n) => n.group === "advisories" && n.note === "version not exact"));
  assert.ok(notes("acme-sdk").some((n) => n.group === "advisories" && n.note === "version unknown"));
});

test("a request to a host not in the approval is never made", async (t) => {
  const p = await ready(t);
  // The catalog now names a new feed, so the approval no longer matches and nothing is fetched.
  const changed = { version: 1, items: CATALOG.items.map((i) => i.name === "widget" ? { ...i, feeds: ["https://other.example.org/atom.xml"] } : i) };
  const net = fakeNet();
  await assert.rejects(runStackCheck(p.roots, {}, { ...deps(net), catalog: validateStackCatalog(changed) }), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED");
  assert.equal(net.log.length, 0);
  assert.equal(net.lookups.length, 0);
  const result = await check(p, net);
  assert.ok(net.log.every((r) => new URL(r.url).hostname !== "other.example.org"));
  assert.ok(result.requests > 0);
  const direct = fakeNet();
  const fetcher = createFetcher({ request: direct.request, lookup: direct.lookup, hosts: ["changelog.example.com"] });
  for (const url of ["https://other.example.org/atom.xml", "http://changelog.example.com/feed.xml", "https://changelog.example.com:8443/feed.xml"]) {
    await assert.rejects(fetcher.fetchResource(url, { accept: "*/*", types: ["application/rss+xml"] }), (e) => e.code === "DEVTWIN_HOST_NOT_APPROVED", url);
  }
  assert.equal(direct.log.length + direct.lookups.length, 0);
});

test("the routed public-read value goes only to api.github.com and never appears in output or entries", async (t) => {
  let reveals = 0;
  const resolvePublicRead = async (q) => { if (q.reveal) reveals++; return q.reveal ? { bound: true, value: BINDING_VALUE } : { bound: true }; };
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"], options: { resolvePublicRead } });
  const net = fakeNet();
  const result = await check(p, net, {}, { resolvePublicRead });
  assert.equal(reveals, 1);
  assert.equal(result.authentication.used, "routed-public-read");
  assert.ok(!JSON.stringify(result).includes(BINDING_VALUE));
  for (const r of net.log) {
    if (new URL(r.url).hostname === "api.github.com") assert.equal(r.headers[AUTH], "Bearer " + BINDING_VALUE);
    else { assert.ok(!(AUTH in r.headers), r.url); assert.ok(!JSON.stringify(r).includes(BINDING_VALUE), r.url); }
  }
  const out = await cli(p, ["stack", "check"], { resolvePublicRead, request: net.request, lookup: net.lookup });
  assert.equal(out.code, 0, out.text);
  assert.ok(!out.text.includes(BINDING_VALUE));
});

test("with GH_TOKEN, GITHUB_TOKEN and DEVTWIN_GITHUB_TOKEN set and no routed binding, no request carries an Authorization header", async (t) => {
  const names = ["GH_TOKEN", "GITHUB_TOKEN", "DEVTWIN_GITHUB_TOKEN"];
  const saved = names.map((n) => [n, process.env[n]]);
  t.after(() => { for (const [n, v] of saved) if (v === undefined) delete process.env[n]; else process.env[n] = v; });
  const env = {};
  for (const n of names) { process.env[n] = BINDING_VALUE; env[n] = BINDING_VALUE; }
  const p = await ready(t);
  const net = fakeNet();
  const out = await cli(p, ["stack", "check"], { env, request: net.request, lookup: net.lookup });
  assert.equal(out.code, 0, out.text);
  assert.ok(net.log.length > 0);
  for (const r of net.log) assert.ok(!Object.keys(r.headers).some((h) => h.toLowerCase() === AUTH), r.url);
  assert.ok(!out.text.includes(BINDING_VALUE));
  assert.equal(out.json.result.authentication.used, "unauthenticated");
});

test("when the resolver refuses the public-read value with TOKEN_TOO_BROAD the run falls back to unauthenticated, reports once and the next run asks for approval", async (t) => {
  let refused = false;
  const resolvePublicRead = async (q) => {
    if (q.reveal || refused) { refused = true; const { DevtwinError } = await import("../src/errors.mjs"); throw new DevtwinError("TOKEN_TOO_BROAD", "Binding can see a private repository"); }
    return { bound: true };
  };
  const p = await ready(t, { options: { resolvePublicRead } });
  const net = fakeNet();
  const result = await check(p, net, {}, { resolvePublicRead });
  assert.equal(result.authentication.used, "unauthenticated");
  assert.equal(result.authentication.refused, "DEVTWIN_TOKEN_TOO_BROAD");
  assert.equal(JSON.stringify(result).split("DEVTWIN_TOKEN_TOO_BROAD").length - 1, 1);
  assert.ok(net.log.some((r) => r.url === RELEASES));
  for (const r of net.log) assert.ok(!(AUTH in r.headers));
  await assert.rejects(check(p, fakeNet(), {}, { resolvePublicRead }), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED" && e.details.differences.includes("authentication"));
});

test("stack check refuses with APPROVAL_REQUIRED when there is no approval and makes no request", async (t) => {
  const p = await seedScopes(t);
  await setProfile(p, STACK);
  const net = fakeNet();
  const out = await cli(p, ["stack", "check"], { request: net.request, lookup: net.lookup });
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "DEVTWIN_APPROVAL_REQUIRED");
  assert.equal(net.log.length + net.lookups.length, 0);
});

test("stack check writes no file under any pilot root", async (t) => {
  const p = await ready(t, { args: ["--with", "advisories", "--with", "lifecycle", "--with", "versions"] });
  await record(p, "alpha", "alpha.web", "req_alpha0001", "acme-sdk");
  const before = await treeSnapshot(p.sandbox);
  const net = fakeNet();
  const out = await cli(p, ["stack", "check", "--scope", "alpha"], { request: net.request, lookup: net.lookup });
  assert.equal(out.code, 0, out.text);
  await check(p, fakeNet({ [ATOM]: { status: 500 } }));
  assert.equal(await treeSnapshot(p.sandbox), before);
  assert.equal(out.json.result.kind, "stack-check");
});

test("stack check is listed in help", async () => {
  const out = await runCli(["help"]);
  assert.ok(out.json.result.commands.includes("stack check"));
});

test("with a live config and before the watch's live-mode entry lands, stack check fails with GATE_REQUIRED and makes no request", async (t) => {
  const sb = await sandbox(t), home = join(sb, "home"), devtwin = join(home, ".devtwin");
  for (const rel of [".claude/skills", ".agents/skills"]) await mkdir(join(home, rel), { recursive: true });
  await mkdir(devtwin);
  await chmod(devtwin, 0o700);
  const kit = await makeRepo(join(devtwin, "kit"), { "README.md": "kit\n" });
  await fixtureGit(kit, ["checkout", "-q", "--detach"]);
  const liveConfig = join(devtwin, "live.json");
  const run = (args, extra = {}) => { const chunks = []; return main(args, { stdout: { write(v) { chunks.push(v); return true; } }, now, home, env: {}, kitRoot: kit, ...extra }).then((code) => ({ code, json: JSON.parse(chunks.join("")) })); };
  const preview = await run(["live", "init", "--pilot", liveConfig, "--agent", "claude"]);
  assert.equal(preview.json.ok, true, JSON.stringify(preview.json));
  const applied = await run(["live", "init", "--pilot", liveConfig, "--agent", "claude", "--apply", "--plan-fingerprint", preview.json.result.fingerprint]);
  assert.equal(applied.json.ok, true, JSON.stringify(applied.json));
  const net = fakeNet();
  const out = await run(["stack", "check", "--pilot", liveConfig], { request: net.request, lookup: net.lookup, stackCatalog: CATALOG });
  assert.equal(out.json.ok, false);
  assert.equal(out.json.error.code, "DEVTWIN_GATE_REQUIRED");
  assert.equal(out.json.error.details.field, "live");
  assert.equal(out.json.error.details.reason, "no-live-exception");
  assert.equal(net.log.length + net.lookups.length, 0);
});

test("a v-prefixed version matches its lifecycle cycle and OSV receives the bare version", async (t) => {
  const p = await ready(t, { stack: ["acme-sdk=v4.1.0"], args: ["--with", "advisories", "--with", "lifecycle"] });
  const net = fakeNet();
  const result = await check(p, net);
  const item = result.items.find((i) => i.name === "acme-sdk");
  assert.ok(!item.notes.some((n) => n.group === "lifecycle"), JSON.stringify(item.notes));
  assert.deepEqual(result.findings.filter((f) => f.group === "lifecycle").map((f) => [f.cycle, f.severity]), [["4", "high"]]);
  const osv = net.log.filter((r) => r.url === OSV);
  assert.equal(osv.length, 1);
  assert.equal(JSON.parse(osv[0].body).version, "4.1.0");
  const plan = await cli(p, ["stack", "plan", "--with", "advisories", "--with", "lifecycle"]);
  assert.deepEqual(plan.json.result.hosts.find((h) => h.host === "api.osv.dev").versions, [{ identifier: "npm/acme-sdk", version: "4.1.0" }]);
});

test("a range version reports lifecycle version not exact and makes no lifecycle request", async (t) => {
  const p = await ready(t, { stack: ["acme-sdk=>=4"], args: ["--with", "lifecycle"] });
  const net = fakeNet();
  const result = await check(p, net);
  const item = result.items.find((i) => i.name === "acme-sdk");
  assert.ok(item.notes.some((n) => n.group === "lifecycle" && n.note === "version not exact"), JSON.stringify(item.notes));
  assert.ok(!net.log.some((r) => r.url === EOL));
  assert.equal(result.findings.filter((f) => f.group === "lifecycle").length, 0);
});
