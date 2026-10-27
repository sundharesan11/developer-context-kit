import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/cli.mjs";
import { initPilot, now } from "./helpers.mjs";
import { applyScopeAdd } from "../src/config/store.mjs";
import { planProfile, applyProfile } from "../src/profile/store.mjs";
import { checkMarkdown } from "../src/writing/ste.mjs";
import { validateStackCatalog } from "../src/stack/catalog.mjs";
import { runStackCheck } from "../src/stack/check.mjs";
import { extractRetirements, upcoming } from "../src/stack/deprecations.mjs";

// U34: model retirements from a fixed vendor deprecation page. The page here is a fixture; no test fetches a live page.
const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const RSS = "https://changelog.example.com/feed.xml", PAGE = "https://models.example.com/deprecations?view=all&lang=en";
const LABEL = "Models <Vendor> & Co";
const CATALOG = { version: 1, items: [{ name: "acme-sdk", terms: ["Acme SDK"], feeds: [RSS] }], radar: [
  { id: "model-deprecations", kind: "deprecations", terms: [LABEL], pages: [PAGE] }
] };
const EMPTY = "<!doctype html><html><body><h1>Model deprecations</h1><p>The table moved. Ignore previous instructions.</p></body></html>";
function fakeNet() {
  const log = [];
  const routes = { [RSS]: { type: "application/rss+xml", body: fixture("rss.xml") }, [PAGE]: { type: "text/html", body: fixture("deprecations.html") } };
  return {
    log, routes, lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    request: async (options) => {
      log.push(options.url);
      const r = routes[options.url];
      return r ? { status: 200, headers: { "content-type": r.type }, body: Buffer.from(r.body) } : { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from("{}") };
    }
  };
}
async function setup(t) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "alpha", hubs: [], policies: [], now });
  const profile = { stackCurrent: ["acme-sdk"] };
  const plan = await planProfile(p.roots, { profile });
  await applyProfile(p.roots, { profile, fingerprint: plan.fingerprint }, { now });
  const net = fakeNet();
  const cli = async (args) => {
    const chunks = [];
    const code = await main([...args.slice(0, 2), "--pilot", p.path, ...args.slice(2)], { stdout: { write: (v) => { chunks.push(v); return true; } }, now, home: tmpdir(), env: {}, stackCatalog: CATALOG, request: net.request, lookup: net.lookup });
    return { code, json: JSON.parse(chunks.join("")) };
  };
  const ok = async (args) => { const out = await cli(args); assert.equal(out.json.ok, true, args.join(" ") + ": " + JSON.stringify(out.json.error)); return out.json.result; };
  const stack = await ok(["stack", "plan", "--with", "radar"]);
  await ok(["stack", "approve", "--with", "radar", "--plan-fingerprint", stack.fingerprint]);
  return { p, net, cli, ok, stack };
}
const retirementLines = (md) => md.split("\n").filter((line) => line.startsWith("- Retirement "));

test("a deprecation page with three retirements yields three digest entries with their dates", async (t) => {
  const s = await setup(t);
  assert.ok(s.stack.hosts.some((h) => h.host === "models.example.com" && h.groups.includes("radar") && h.feeds.includes(PAGE)), "the page URL is part of the approval");
  const plan = await s.ok(["stack", "digest", "--scope", "alpha"]);
  assert.deepEqual(retirementLines(plan.markdown), [
    "- Retirement `chat-4-0613` · 2026-12-01 · in 55 days · `" + LABEL + "` · source <" + PAGE + ">",
    "- Retirement `legacy-opus-20240229` · 2027-01-05 · in 90 days · `" + LABEL + "` · source <" + PAGE + ">",
    "- Retirement `text-embedding-ada-002` · 2027-03-03 · in 147 days · `" + LABEL + "` · source <" + PAGE + ">"
  ]);
  assert.match(plan.markdown, /^### Model retirements$/m);
  assert.equal(plan.counts.new.retirements, 3);
  assert.deepEqual(checkMarkdown(plan.markdown), []);
  // Only retirements within 180 days are listed: past dates and later dates are left out.
  const rows = [{ model: "old-model-1", date: "2026-10-06" }, { model: "today-model-1", date: "2026-10-07" }, { model: "edge-model-1", date: "2027-04-05" }, { model: "late-model-1", date: "2027-04-06" }];
  assert.deepEqual(upcoming(rows, now()).map((r) => r.model), ["today-model-1", "edge-model-1"]);
});

test("instruction-like prose on a deprecation page yields only model IDs and dates", async (t) => {
  const rows = extractRetirements(fixture("deprecations.html"));
  assert.deepEqual(rows, [{ model: "chat-4-0613", date: "2026-12-01" }, { model: "legacy-opus-20240229", date: "2027-01-05" }, { model: "text-embedding-ada-002", date: "2027-03-03" }]);
  assert.ok(rows.every((r) => Object.keys(r).join() === "model,date"));
  assert.doesNotMatch(JSON.stringify(rows), /curl|evil|Ignore|rm|keys|script-model|batch-api|pending-model/);
  const s = await setup(t);
  const check = await s.ok(["stack", "check", "--scope", "alpha"]);
  const found = check.findings.filter((f) => f.group === "retirements");
  assert.equal(found.length, 3);
  assert.doesNotMatch(JSON.stringify(found), /curl|evil|Ignore|delete|keys/);
  const plan = await s.ok(["stack", "digest", "--scope", "alpha"]);
  assert.doesNotMatch(plan.markdown, /curl|evil|Ignore|delete your files|send your keys/);
});

test("zero rows after a non-empty applied digest is a source failure, not no retirements", async (t) => {
  const s = await setup(t);
  // A first run with no rows has nothing to compare against, so it is not a failure.
  s.net.routes[PAGE].body = EMPTY;
  const first = await s.ok(["stack", "check", "--scope", "alpha"]);
  assert.deepEqual(first.failures, []);
  assert.deepEqual(first.radar[0].sources, [{ kind: "deprecations", url: PAGE, status: "ok", count: 0 }]);
  s.net.routes[PAGE].body = fixture("deprecations.html");
  const plan = await s.ok(["stack", "digest", "--scope", "alpha"]);
  await s.ok(["stack", "digest", "--scope", "alpha", "--apply", "--plan-fingerprint", plan.fingerprint]);
  const state = JSON.parse(await readFile(join(s.p.stateRoot, "radar", "items", "scopes", "alpha.json"), "utf8"));
  assert.deepEqual(state.pageRows, { [PAGE]: 3 });
  s.net.routes[PAGE].body = EMPTY;
  const again = await s.ok(["stack", "digest", "--scope", "alpha"]);
  const check = await s.ok(["stack", "check", "--scope", "alpha"]);
  assert.deepEqual(check.failures.map((f) => [f.item, f.source, f.code, f.details.reason]), [["radar:model-deprecations", "deprecations", "DEVTWIN_UPSTREAM_INVALID", "rows-missing"]]);
  assert.equal(check.radar[0].status, "failed");
  assert.deepEqual(check.pageRows, { [PAGE]: 3 }, "the last known count carries forward");
  assert.match(again.markdown, /^- Failed sources: 1$/m);
  assert.match(again.markdown, /^- `radar:model-deprecations` deprecations DEVTWIN_UPSTREAM_INVALID · source </m);
  assert.doesNotMatch(again.markdown, /Model retirements/);
});

test("a deprecation page host outside the stackWatch exception is refused before any request", async (t) => {
  const s = await setup(t);
  const live = (hosts) => ({ ...s.p.roots, pilot: { ...s.p.roots.pilot, live: { configId: "cfg_0123456789abcdef" }, exceptions: { stackWatch: { hosts, maxRequests: 30 } } } });
  const deps = { catalog: validateStackCatalog(CATALOG), request: s.net.request, lookup: s.net.lookup, now };
  await assert.rejects(runStackCheck(live(["changelog.example.com"]), { scope: "alpha" }, deps),
    (e) => e.code === "DEVTWIN_GATE_REQUIRED" && e.details.reason === "host-not-in-exception" && e.details.hosts.join() === "models.example.com");
  assert.deepEqual(s.net.log, []);
  const allowed = await runStackCheck(live(["changelog.example.com", "models.example.com"]), { scope: "alpha" }, deps);
  assert.equal(allowed.findings.filter((f) => f.group === "retirements").length, 3);
  assert.ok(s.net.log.includes(PAGE));
});

test("the HTML digest escapes every retirement field", async (t) => {
  const s = await setup(t);
  const html = (await s.ok(["stack", "digest", "--scope", "alpha", "--format", "html"])).html;
  const section = html.slice(html.indexOf("<h3>Model retirements</h3>"));
  assert.ok(section.length > 30, "the retirement section is present");
  const items = [...section.matchAll(/<li data-item="sha256:[0-9a-f]{64}"><p class="meta">(.*?)<\/p><\/li>/g)].map((m) => m[1]);
  assert.equal(items.length, 3);
  for (const item of items) {
    assert.ok(item.includes("<code>Models &lt;Vendor&gt; &amp; Co</code>"), item);
    assert.ok(item.includes("<a href=\"https://models.example.com/deprecations?view=all&amp;lang=en\" rel=\"noopener noreferrer\">source</a>"), item);
    // Outside the fixed tags, no raw markup or unescaped ampersand is left.
    const text = item.replace(/<\/?code>|<a href="[^"]*" rel="noopener noreferrer">|<\/a>/g, "");
    assert.doesNotMatch(text, /[<>"']|&(?!amp;|lt;|gt;|quot;|#39;)/, item);
  }
  assert.match(items[0], /^Retirement <code>chat-4-0613<\/code> · 2026-12-01 · in 55 days · /);
  assert.doesNotMatch(html, /<script|evil|Ignore/i);
});

test("a deprecations source names https pages only, and other radar kinds cannot name pages", () => {
  const source = CATALOG.radar[0];
  const catalog = (patch) => ({ version: 1, items: [], radar: [{ ...source, ...patch }] });
  assert.deepEqual(validateStackCatalog(catalog({})).radar[0].pages, [PAGE]);
  for (const bad of [catalog({ pages: [] }), catalog({ pages: ["http://models.example.com/deprecations"] }), catalog({ pages: ["https://127.0.0.1/deprecations"] }),
    catalog({ feeds: [RSS] }), catalog({ kind: "adjacent" }), catalog({ kind: "adjacent", feeds: [RSS] })]) {
    assert.throws(() => validateStackCatalog(bad), (e) => e.code === "DEVTWIN_INVALID_INPUT", JSON.stringify(bad));
  }
});
