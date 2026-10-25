import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { parseFeed, reduceHtml, FEED_LIMITS } from "../src/stack/feed.mjs";
import { hasTerm, classifyEntry, itemTerms } from "../src/stack/match.mjs";
import { isUnsafeAddress, httpsRequest, createFetcher } from "../src/stack/fetch.mjs";

const fixture = (name) => readFileSync(new URL("./fixtures/stack/" + name, import.meta.url));
const rejectsCode = (fn, code) => assert.throws(fn, (e) => e.code === "DEVTWIN_" + code, code);
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${items}</channel></rss>`;

test("an RSS fixture, an Atom fixture and a JSON Feed fixture each yield their entries with title, link, date and hash inputs", () => {
  const a = parseFeed(fixture("rss.xml"));
  assert.equal(a.format, "rss");
  assert.equal(a.entries.length, 2);
  assert.deepEqual(a.entries[0], { title: "acme-sdk 4 adds streaming", link: "https://changelog.example.com/posts/streaming", id: "acme-post-0001", date: "2026-10-06T09:00:00.000Z", summary: "Streaming responses are now generally available ." });
  assert.equal(a.entries[1].title, "Quarterly office hours & community notes");
  const b = parseFeed(fixture("atom.xml"));
  assert.equal(b.format, "atom");
  assert.deepEqual(b.entries, [{ title: "Widget 2.3 released", link: "https://updates.example.com/widget-2-3", id: "urn:example:widget-2-3", date: "2026-10-04T12:00:00.000Z", summary: "Faster builds and a new config flag." }]);
  const c = parseFeed(fixture("feed.json"));
  assert.equal(c.format, "json-feed");
  assert.deepEqual(c.entries.map((e) => [e.title, e.link, e.date]), [["Gadget 5 preview", "https://news.example.com/gadget-5", "2026-10-03T08:00:00.000Z"], ["Tips and tricks", "https://news.example.com/gadget-tips", "2026-10-02T08:00:00.000Z"]]);
});

test("a feed containing <!DOCTYPE or <!ENTITY fails with FEED_INVALID and no entity is expanded", () => {
  const bomb = `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY lol "lol">]><rss version="2.0"><channel><item><title>&lol;</title></item></channel></rss>`;
  rejectsCode(() => parseFeed(bomb), "FEED_INVALID");
  rejectsCode(() => parseFeed(rss(`<!ENTITY x "y"><item><title>a</title></item>`)), "FEED_INVALID");
  const custom = parseFeed(rss(`<item><title>&custom; &#65;&#x42; &lt;ok&gt;</title></item>`));
  assert.equal(custom.entries[0].title, "&custom; AB");
  for (const bad of ["<rss version=\"2.0\"><channel>", "<rss version=\"2.0\"><channel></rss>", "not a feed", "{\"version\":\"x\",\"items\":[]}", "<html><body/></html>"]) rejectsCode(() => parseFeed(bad), "FEED_INVALID");
});

test("a feed over the depth or entry caps fails with FEED_LIMIT", () => {
  const deep = "<x>".repeat(FEED_LIMITS.depth + 2) + "</x>".repeat(FEED_LIMITS.depth + 2);
  rejectsCode(() => parseFeed(rss(`<item><title>${deep}</title></item>`)), "FEED_LIMIT");
  rejectsCode(() => parseFeed(rss("<item><title>a</title></item>".repeat(FEED_LIMITS.entries + 1))), "FEED_LIMIT");
  assert.equal(parseFeed(rss("<item><title>a</title></item>".repeat(FEED_LIMITS.entries))).entries.length, FEED_LIMITS.entries);
});

test("an entry title with a Markdown image, a link, an HTML tag and a bidirectional control character is plain, capped text", () => {
  const title = "![pixel](https://tracker.example.net/p.png) [click](https://evil.example.net) <img src=x onerror=alert(1)>Run‮now⁦ " + "z".repeat(400);
  const out = parseFeed(rss(`<item><title><![CDATA[${title}]]></title></item>`)).entries[0].title;
  assert.ok(!/[‪-‮⁦-⁩]/.test(out));
  assert.ok(!out.includes("<img"));
  assert.ok(!out.includes("onerror"));
  assert.ok([...out].length <= FEED_LIMITS.title);
  assert.ok(out.startsWith("![pixel](https://tracker.example.net/p.png) [click](https://evil.example.net) Run now"));
});

test("an RSS summary whose only acme-sdk occurrence is inside an HTML attribute does not match", () => {
  const [, second] = parseFeed(fixture("rss.xml")).entries;
  assert.ok(!second.summary.includes("acme-sdk"));
  const terms = itemTerms([{ name: "acme-sdk", terms: ["Acme SDK"] }]);
  assert.equal(classifyEntry(second, terms).level, "background");
});

test("a term appearing only inside another word does not match", () => {
  assert.equal(hasTerm("upgrade acme-sdkx today", "acme-sdk"), false);
  assert.equal(hasTerm("the xacme-sdk tool", "acme-sdk"), false);
  assert.equal(hasTerm("ACME-SDK 4 is out", "acme-sdk"), true);
  assert.equal(hasTerm("Next.js 16, released", "Next.js"), true);
  assert.equal(classifyEntry({ title: "acme-sdkx 1.0", summary: "" }, itemTerms([{ name: "acme-sdk", terms: [] }])).level, "background");
});

test("loopback, private, link-local and unique-local addresses are unsafe and public addresses are not", () => {
  for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "224.0.0.1", "not-an-ip"]) assert.equal(isUnsafeAddress(a), true, a);
  for (const a of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111", "::ffff:93.184.216.34"]) assert.equal(isUnsafeAddress(a), false, a);
});

test("the production request uses node https with a lookup that returns only the checked address and keeps the host name for TLS", async () => {
  let seen;
  const transport = { request(options, onResponse) {
    seen = options;
    const req = new EventEmitter();
    req.end = (body) => {
      seen.body = body;
      options.lookup("changelog.example.com", {}, (err, address, family) => { seen.single = [err, address, family]; });
      options.lookup("changelog.example.com", { all: true }, (err, list) => { seen.all = [err, list]; });
      onResponse(Object.assign(new EventEmitter(), { statusCode: 200, headers: { "content-type": "application/rss+xml" }, destroy() { seen.destroyed = true; }, async *[Symbol.asyncIterator]() { yield Buffer.from("ok"); } }));
    };
    return req;
  } };
  const res = await httpsRequest({ url: "https://changelog.example.com/feed.xml?x=1", method: "GET", headers: { "Accept-Encoding": "identity" }, address: "93.184.216.34", family: 4 }, { transport });
  assert.equal(seen.hostname, "changelog.example.com");
  assert.equal(seen.servername, "changelog.example.com");
  assert.equal(seen.port, 443);
  assert.equal(seen.path, "/feed.xml?x=1");
  assert.equal(seen.agent, false);
  assert.deepEqual(seen.single, [null, "93.184.216.34", 4]);
  assert.deepEqual(seen.all, [null, [{ address: "93.184.216.34", family: 4 }]]);
  assert.equal(res.status, 200);
  res.cancel();
  assert.equal(seen.destroyed, true);
});

test("a fetch with a body over the cap, a redirect, an unexpected content type or an encoded body fails with a typed code", async () => {
  const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
  const respond = (r) => async () => ({ status: 200, headers: { "content-type": "application/rss+xml" }, body: Buffer.from("x"), ...r });
  const get = (r, limits) => createFetcher({ request: respond(r), lookup, hosts: ["changelog.example.com"], limits }).fetchResource("https://changelog.example.com/feed.xml", { accept: "*/*", types: ["application/rss+xml"] });
  const code = async (promise, want) => assert.rejects(promise, (e) => e.code === "DEVTWIN_" + want, want);
  await code(get({ body: Buffer.alloc(2048) }, { body: 1024 }), "RESPONSE_TOO_LARGE");
  await code(get({ headers: { "content-type": "application/rss+xml", "content-length": "999999999" } }), "RESPONSE_TOO_LARGE");
  await code(get({ status: 301, headers: { location: "https://elsewhere.example.net/" } }), "REDIRECT_REFUSED");
  await code(get({ headers: { "content-type": "text/html" } }), "CONTENT_TYPE_REFUSED");
  await code(get({ headers: { "content-type": "application/rss+xml", "content-encoding": "gzip" } }), "ENCODING_REFUSED");
  await code(get({ status: 500 }), "UPSTREAM_UNAVAILABLE");
  const ok = await get({});
  assert.equal(ok.bytes.toString(), "x");
});
test("HTML reduction keeps its output and stays linear on unclosed markup", () => {
  const cases = [["<p>Hi <b>there</b></p>", "Hi there"], ["a<script type=x>bad()</script >b", "a b"], ["x<!-- c -->y", "x y"], ["a < b", "a b"], ["<STYLE>p{}</STYLE>ok", "ok"], ["x<!-- open", "x !-- open"], ["<script>unclosed", "unclosed"], ["1 &amp; 2 &lt;tag&gt;", "1 & 2 <tag>"], ["</b> ip<<script>/</script>", "ip"], ["AA<!--<script>-<b></script>-</script>a", "AA a"]];
  for (const [input, expected] of cases) assert.equal(reduceHtml(input, 100), expected, input);
  const started = Date.now();
  for (const input of ["<".repeat(FEED_LIMITS.nodeText), "<script ".repeat(FEED_LIMITS.nodeText / 8), "<!--".repeat(FEED_LIMITS.nodeText / 4)]) reduceHtml(input, FEED_LIMITS.summary);
  assert.ok(Date.now() - started < 2000, "reduction took " + (Date.now() - started) + " ms");
});
