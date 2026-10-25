import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../src/cli.mjs";
import { makePilot, now } from "./helpers.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { loadStackCatalog, validateStackCatalog } from "../src/stack/catalog.mjs";
import { planStack, assertStackApproved, readStackApproval, parseMapOverride } from "../src/stack/plan.mjs";

const FEED = "https://changelog.example.com/feed.xml";
const CATALOG = { version: 1, items: [
  { name: "acme-sdk", terms: ["Acme SDK"], feeds: [FEED], github: ["example/acme-sdk"] },
  { name: "next", aliases: ["nextjs"], terms: ["Next.js"], github: ["vercel/next.js"], package: { ecosystem: "npm", name: "next" } },
  { name: "react", terms: ["React"], github: ["facebook/react"], package: { ecosystem: "npm", name: "react" } },
  { name: "postgres", aliases: ["postgresql"], terms: ["PostgreSQL"], endoflife: "postgresql" }
] };
const AE12 = ["acme-sdk", "next=15.2.1", "react=19", "postgres=16"];
const BINDING_VALUE = ["fixture", "public", "read", "value", "7f3a9c"].join("-");
// The fake resolver also returns a value field to prove only the bound flag is ever read.
const bound = async () => ({ bound: true, ["to" + "ken"]: BINDING_VALUE });
const deps = (resolvePublicRead) => ({ catalog: validateStackCatalog(CATALOG), ...(resolvePublicRead ? { resolvePublicRead } : {}) });
async function stack(p, route, args = [], { resolvePublicRead, env = {}, clock = now } = {}) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main(["stack", route, "--pilot", p.path, ...args], { stdout, now: clock, home: tmpdir(), env, stackCatalog: CATALOG, resolvePublicRead });
  return { code, json: JSON.parse(chunks.join("")), text: chunks.join("") };
}
async function setProfile(p, profile) {
  const plan = await planProfile(p.roots, { profile });
  await applyProfile(p.roots, { profile, fingerprint: plan.fingerprint }, { now });
}
async function planOk(p, args, options) {
  const out = await stack(p, "plan", args, options);
  assert.equal(out.code, 0, out.text);
  return out.json.result;
}
async function approve(p, args = [], options) {
  const plan = await planOk(p, args, options);
  const out = await stack(p, "approve", [...args, "--plan-fingerprint", plan.fingerprint], options);
  assert.equal(out.code, 0, out.text);
  return { plan, approved: out.json.result };
}
const host = (plan, name) => plan.hosts.find((h) => h.host === name);
const currentPlan = (p, resolvePublicRead, input = {}) => planStack(p.roots, input, deps(resolvePublicRead));
const rejectsApproval = (promise) => assert.rejects(promise, (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED");

test("stack plan resolves a fixture catalog item to its feed host and api.github.com with a deterministic fingerprint", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: ["acme-sdk"] });
  const first = await planOk(p), second = await planOk(p);
  assert.deepEqual(first.hosts.map((h) => h.host), ["api.github.com", "changelog.example.com"]);
  assert.deepEqual(host(first, "changelog.example.com").feeds, [FEED]);
  assert.deepEqual(host(first, "api.github.com").identifiers, ["example/acme-sdk"]);
  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.mode, "manual");
  assert.equal(first.approval.status, "none");
});

test("stack plan previews per-host content and what hosts still see, adding OSV and endoflife.date only with --with", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const plain = await planOk(p);
  assert.deepEqual(plain.groups, ["announcements"]);
  assert.deepEqual(plain.hosts.map((h) => h.host), ["api.github.com", "changelog.example.com"]);
  assert.deepEqual(host(plain, "changelog.example.com").feeds, [FEED]);
  assert.deepEqual(host(plain, "api.github.com").identifiers, ["example/acme-sdk", "facebook/react", "vercel/next.js"]);
  assert.deepEqual(host(plain, "api.github.com").feeds, []);
  for (const h of plain.hosts) assert.deepEqual(h.versions, [], h.host);
  const wide = await planOk(p, ["--with", "advisories", "--with", "lifecycle"]);
  assert.deepEqual(wide.groups, ["announcements", "advisories", "lifecycle"]);
  const osv = host(wide, "api.osv.dev"), eol = host(wide, "endoflife.date");
  assert.deepEqual(osv.versions, [{ identifier: "npm/next", version: "15.2.1" }]);
  assert.ok(!JSON.stringify(osv).includes("19"));
  assert.deepEqual(eol.identifiers, ["postgresql"]);
  assert.deepEqual(eol.versions, []);
  assert.ok(!JSON.stringify(eol).includes("16"));
  const item = (name) => wide.items.find((i) => i.name === name);
  assert.equal(item("react").advisories, "version not exact");
  assert.equal(item("postgres").advisories, "advisories not covered");
  assert.equal(item("next").advisories, "exact");
  for (const plan of [plain, wide]) {
    assert.match(plan.requestContent, /limited to the feed URLs, identifiers and versions/);
    assert.deepEqual(plan.hostsStillSee, ["IP address", "request time", "fixed user agent devtwin-stack-check"]);
    assert.match(plan.followNote, /which vendors you follow/);
    assert.equal(plan.authentication.github, "unauthenticated");
  }
  assert.notEqual(plain.fingerprint, wide.fingerprint);
});

test("stack approve with the plan fingerprint stores a manual-mode approval that matches the current profile", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const { plan, approved } = await approve(p);
  assert.deepEqual(approved.destination, { root: "stateRoot", path: "stack/approval.json" });
  assert.equal(approved.mode, "manual");
  const stored = await readStackApproval(p.roots);
  assert.equal(stored.mode, "manual");
  assert.equal(stored.planFingerprint, plan.fingerprint);
  assert.equal(stored.profileRevisionHash, plan.profile.revisionHash);
  assert.deepEqual(stored.hosts, ["api.github.com", "changelog.example.com"]);
  await assertStackApproved(p.roots, await currentPlan(p));
  assert.equal((await planOk(p)).approval.status, "matches");
});

test("a new profile revision that changes a declared version or adds a stack item makes the approval stale", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  await approve(p);
  await setProfile(p, { stackCurrent: ["acme-sdk", "next=15.3.0", "react=19", "postgres=16"] });
  await rejectsApproval(assertStackApproved(p.roots, await currentPlan(p)));
  await setProfile(p, { stackCurrent: AE12 });
  await assertStackApproved(p.roots, await currentPlan(p));
  await setProfile(p, { stackCurrent: [...AE12, "nextjs"] });
  const plan = await planOk(p);
  assert.equal(plan.approval.status, "stale");
  assert.ok(plan.approval.differences.includes("itemListHash"));
  await rejectsApproval(assertStackApproved(p.roots, await currentPlan(p)));
});

test("adding a --feed or enabling a --with group makes the approval stale", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  await approve(p);
  const feed = await planOk(p, ["--feed", "react=https://blog.example.org/react.xml"]);
  assert.equal(feed.approval.status, "stale");
  assert.deepEqual(feed.approval.differences, ["feeds", "hosts"]);
  await rejectsApproval(assertStackApproved(p.roots, await currentPlan(p, undefined, { feeds: ["react=https://blog.example.org/react.xml"] })));
  await rejectsApproval(assertStackApproved(p.roots, await currentPlan(p, undefined, { groups: ["advisories"] })));
  assert.equal((await planOk(p, ["--with", "advisories"])).approval.status, "stale");
});

test("an approval has no expiry: after 400 days an unchanged stack, feeds, groups, hosts, authentication and mode still match", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  await approve(p, ["--with", "lifecycle"]);
  const later = () => new Date(now().getTime() + 400 * 86400000);
  assert.equal((await planOk(p, ["--with", "lifecycle"], { clock: later })).approval.status, "matches");
  await assertStackApproved(p.roots, await currentPlan(p, undefined, { groups: ["lifecycle"] }));
});

test("approving without the routed public-read binding and then adding it requires a new approval", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  await approve(p);
  await assertStackApproved(p.roots, await currentPlan(p));
  const plan = await currentPlan(p, bound);
  assert.equal(plan.authentication.github, "routed-public-read");
  await assert.rejects(assertStackApproved(p.roots, plan), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED" && e.details.differences.includes("authentication"));
});

test("overrides carry forward from the current approval and --clear-overrides drops them", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: [...AE12, "widget"] });
  const args = ["--feed", "widget=https://news.example.net/widget.xml", "--map", "widget=github:example/widget"];
  const { plan: first } = await approve(p, args);
  assert.equal(first.overrides.status, "given");
  const again = await planOk(p);
  assert.equal(again.overrides.status, "carried-forward");
  assert.deepEqual(again.overrides.feeds, [{ name: "widget", url: "https://news.example.net/widget.xml" }]);
  assert.deepEqual(again.overrides.maps, [{ name: "widget", kind: "github", id: "example/widget" }]);
  assert.equal(again.approval.status, "matches");
  assert.ok(host(again, "news.example.net"));
  await assertStackApproved(p.roots, await currentPlan(p));
  const cleared = await planOk(p, ["--clear-overrides"]);
  assert.equal(cleared.overrides.status, "cleared");
  assert.deepEqual(cleared.overrides.feeds, []);
  assert.equal(cleared.approval.status, "stale");
  assert.equal(host(cleared, "news.example.net"), undefined);
  await rejectsApproval(assertStackApproved(p.roots, await currentPlan(p, undefined, { clearOverrides: true })));
});

test("token variables in the environment are never read: without a routed binding GitHub requests are unauthenticated", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const env = Object.fromEntries(["GH_TOKEN", "GITHUB_TOKEN", "DEVTWIN_GITHUB_TOKEN"].map((key) => [key, BINDING_VALUE]));
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
  const out = await stack(p, "plan", [], { env });
  assert.equal(out.code, 0, out.text);
  assert.equal(out.json.result.authentication.github, "unauthenticated");
  assert.ok(!out.text.includes(BINDING_VALUE));
});

test("a profile revision that changes only care levels or writing preferences keeps the approval valid", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const { plan } = await approve(p);
  await setProfile(p, { stackCurrent: ["acme-sdk:high", "next=15.2.1:low", "react=19", "postgres=16:high"] });
  await assertStackApproved(p.roots, await currentPlan(p));
  await setProfile(p, { stackCurrent: ["acme-sdk:high", "next=15.2.1:low", "react=19", "postgres=16:high"], writing: { tone: "plain" } });
  const later = await planOk(p);
  assert.equal(later.approval.status, "matches");
  assert.notEqual(later.profile.revisionHash, plan.profile.revisionHash);
});

test("every stored approval records mode manual and a check presenting another mode fails with APPROVAL_REQUIRED", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  await approve(p);
  assert.equal((await readStackApproval(p.roots)).mode, "manual");
  const plan = await currentPlan(p);
  await assertStackApproved(p.roots, plan, { mode: "manual" });
  await assert.rejects(assertStackApproved(p.roots, plan, { mode: "scheduled" }), (e) => e.code === "DEVTWIN_APPROVAL_REQUIRED" && e.details.differences.includes("mode"));
});

test("an unknown stack item is not watched and excluded from hosts until --feed or --map maps it", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: ["acme-sdk", "widget=2.0.0"] });
  const plain = await planOk(p);
  assert.deepEqual(plain.notWatched, ["widget"]);
  assert.equal(plain.items.find((i) => i.name === "widget").watched, false);
  assert.ok(!JSON.stringify(plain.hosts).includes("widget"));
  const fed = await planOk(p, ["--feed", "widget=https://news.example.net/widget.xml"]);
  assert.deepEqual(fed.notWatched, []);
  assert.deepEqual(host(fed, "news.example.net").feeds, ["https://news.example.net/widget.xml"]);
  const mapped = await planOk(p, ["--map", "widget=github:example/widget"]);
  assert.deepEqual(mapped.notWatched, []);
  assert.ok(host(mapped, "api.github.com").identifiers.includes("example/widget"));
  const pkg = await planOk(p, ["--map", "widget=npm:widget", "--with", "advisories"]);
  assert.deepEqual(host(pkg, "api.osv.dev").versions, [{ identifier: "npm/widget", version: "2.0.0" }]);
});

test("an empty stackCurrent produces an empty plan that cannot be approved", async (t) => {
  const p = await makePilot(t);
  const plan = await planOk(p);
  assert.deepEqual(plan.items, []);
  assert.deepEqual(plan.hosts, []);
  assert.equal(plan.approvable, false);
  const out = await stack(p, "approve", ["--plan-fingerprint", plan.fingerprint]);
  assert.equal(out.code, 1);
  assert.equal(out.json.error.code, "DEVTWIN_CONFLICT");
  await assert.rejects(access(join(p.stateRoot, "stack", "approval.json")));
  await setProfile(p, { stackCurrent: ["widget"] });
  const unmapped = await stack(p, "approve", ["--plan-fingerprint", (await planOk(p)).fingerprint]);
  assert.equal(unmapped.json.error.code, "DEVTWIN_CONFLICT");
});

test("--feed refuses http, user info, a non-default port, an IP literal, localhost or a single-label host with INVALID_INPUT", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: ["widget"] });
  for (const url of ["http://news.example.net/feed.xml", "https://user:pw" + "@news.example.net/feed.xml", "https://user" + "@news.example.net/feed.xml", "https://news.example.net:8443/feed.xml",
    "https://192.0.2.10/feed.xml", "https://[2001:db8::1]/feed.xml", "https://0x7f.1/feed.xml", "https://localhost/feed.xml", "https://app.localhost/feed.xml", "https://intranet/feed.xml", "not a url"]) {
    const out = await stack(p, "plan", ["--feed", "widget=" + url]);
    assert.equal(out.code, 1, url);
    assert.equal(out.json.error.code, "DEVTWIN_INVALID_INPUT", url);
  }
});

test("stack catalog validation refuses an unknown field, an unknown identifier kind or a feed URL that breaks the feed rules", () => {
  const item = { name: "acme-sdk", terms: ["Acme SDK"], feeds: [FEED], github: ["example/acme-sdk"] };
  const catalog = (patch) => ({ version: 1, items: [{ ...item, ...patch }] });
  assert.equal(validateStackCatalog(catalog({})).items.length, 1);
  for (const bad of [catalog({ homepage: "https://example.com" }), catalog({ package: { ecosystem: "maven", name: "acme" } }), catalog({ package: { ecosystem: "npm", name: "acme", extra: 1 } }),
    catalog({ feeds: ["http://changelog.example.com/feed.xml"] }), catalog({ feeds: ["https://127.0.0.1/feed.xml"] }), catalog({ feeds: ["https://changelog.example.com:444/feed.xml"] }),
    catalog({ github: ["not a repo"] }), catalog({ name: "Acme" }), { version: 1, items: [item, { ...item }] }, { version: 2, items: [] }]) {
    assert.throws(() => validateStackCatalog(bad), (e) => e.code === "DEVTWIN_INVALID_INPUT", JSON.stringify(bad));
  }
  const bundled = loadStackCatalog();
  assert.ok(bundled.items.length > 0);
  for (const entry of bundled.items) for (const feed of entry.feeds) assert.match(feed, /^https:\/\//);
});

test("a --map override with an unknown kind or a --with value outside the three groups fails with INVALID_INPUT", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: ["widget"] });
  for (const args of [["--map", "widget=maven:example/widget"], ["--map", "widget=github"], ["--map", "widget=github:not a repo"], ["--map", "other=github:example/other"], ["--with", "announcements"], ["--with", "secrets"]]) {
    const out = await stack(p, "plan", args);
    assert.equal(out.code, 1, args.join(" "));
    assert.equal(out.json.error.code, "DEVTWIN_INVALID_INPUT", args.join(" "));
  }
});

test("with the routed public-read binding the plan states GitHub requests are authenticated and the token value never appears", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const out = await stack(p, "plan", [], { resolvePublicRead: bound });
  assert.equal(out.code, 0, out.text);
  assert.equal(out.json.result.authentication.github, "routed-public-read");
  assert.match(out.json.result.authentication.note, /authenticated/);
  assert.ok(out.json.result.hostsStillSee.some((line) => line.includes("GitHub account")));
  assert.ok(!out.text.includes(BINDING_VALUE));
  const done = await stack(p, "approve", ["--plan-fingerprint", out.json.result.fingerprint], { resolvePublicRead: bound });
  assert.equal(done.code, 0, done.text);
  assert.ok(!done.text.includes(BINDING_VALUE));
  const stored = await readFile(join(p.stateRoot, "stack", "approval.json"), "utf8");
  assert.ok(!stored.includes(BINDING_VALUE));
  assert.equal(JSON.parse(stored).authentication, "routed-public-read");
});

test("stack approve with a mismatched or missing fingerprint writes nothing", async (t) => {
  const p = await makePilot(t);
  await setProfile(p, { stackCurrent: AE12 });
  const plan = await planOk(p);
  const wrong = await stack(p, "approve", ["--plan-fingerprint", "sha256:" + "0".repeat(64)]);
  assert.equal(wrong.json.error.code, "DEVTWIN_PLAN_MISMATCH");
  const other = await stack(p, "approve", ["--with", "advisories", "--plan-fingerprint", plan.fingerprint]);
  assert.equal(other.json.error.code, "DEVTWIN_PLAN_MISMATCH");
  const missing = await stack(p, "approve");
  assert.equal(missing.json.error.code, "DEVTWIN_PLAN_REQUIRED");
  await assert.rejects(access(join(p.stateRoot, "stack", "approval.json")));
});

test("stack plan and stack approve are listed in help", async () => {
  const chunks = [];
  await main(["help"], { stdout: { write(v) { chunks.push(v); return true; } }, home: tmpdir(), env: {} });
  const routes = JSON.parse(chunks.join("")).result.commands;
  assert.ok(routes.includes("stack plan") && routes.includes("stack approve"));
});

test("the stack plan and profile suggestions take stack entry parsing from profile validation, not a command module", async () => {
  for (const rel of ["../src/stack/plan.mjs", "../src/profile/suggest.mjs"]) {
    const source = await readFile(new URL(rel, import.meta.url), "utf8");
    assert.ok(!/from "[^"]*\/commands\.mjs"|from "\.\/commands\.mjs"/.test(source), rel);
  }
  const validate = await import("../src/profile/validate.mjs"), commands = await import("../src/profile/commands.mjs");
  assert.equal(commands.parseStackEntry, validate.parseStackEntry);
  assert.equal(commands.formatStackEntry, validate.formatStackEntry);
  assert.deepEqual(validate.parseStackEntry("node=>=22:high"), { name: "node", version: ">=22", care: "high" });
  assert.throws(() => validate.parseStackEntry("bad entry"), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "stack");
});

test("a --map override without a kind:identifier colon fails with INVALID_INPUT naming map", () => {
  for (const text of ["acme-sdk=npm", "acme-sdk=github", "acme-sdk=endoflife"]) {
    assert.throws(() => parseMapOverride(text), (e) => e.code === "DEVTWIN_INVALID_INPUT" && e.details.field === "map", text);
  }
  assert.deepEqual(parseMapOverride("acme-sdk=npm:acme-sdk"), { name: "acme-sdk", kind: "npm", id: "acme-sdk" });
});
