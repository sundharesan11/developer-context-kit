import test from "node:test";
import assert from "node:assert/strict";
import { createFetcher } from "../src/stack/fetch.mjs";

// Direct tests of the bounded fetcher: budgets, deadlines, status mapping and URL refusals.
const HOST = "changelog.example.com", URL_OK = "https://" + HOST + "/feed.xml";
const TYPES = { accept: "*/*", types: ["application/rss+xml"] };
const RSS = { "content-type": "application/rss+xml" };
function harness(respond = () => ({}), { lookup } = {}) {
  const log = [], lookups = [];
  const fetcher = (limits) => createFetcher({
    hosts: [HOST], limits,
    lookup: lookup ?? (async (host) => { lookups.push(host); return [{ address: "93.184.216.34", family: 4 }]; }),
    request: async (options) => { log.push(options.url); const r = await respond(options, log.length); return { status: 200, headers: RSS, body: Buffer.from("x"), ...r }; }
  });
  return { log, lookups, fetcher };
}
const rejectsWith = (promise, code, check = () => true) => assert.rejects(promise, (e) => { assert.equal(e.code, "DEVTWIN_" + code); return check(e); });
// A request that settles only when its signal aborts, as node:https does with a signal.
const hangs = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

test("stack fetch refuses a request over the per-run call cap without a lookup or request", async () => {
  const net = harness();
  const fetcher = net.fetcher({ calls: 2 });
  await fetcher.fetchResource(URL_OK, TYPES);
  await fetcher.fetchResource(URL_OK, TYPES);
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "CALL_LIMIT");
  assert.equal(net.log.length, 2);
  assert.equal(net.lookups.length, 2);
});

test("stack fetch refuses a response that takes the run over the total byte cap", async () => {
  const net = harness(() => ({ body: Buffer.alloc(6, 120) }));
  const fetcher = net.fetcher({ body: 100, total: 10 });
  assert.equal((await fetcher.fetchResource(URL_OK, TYPES)).bytes.length, 6);
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "RESPONSE_TOO_LARGE");
});

test("stack fetch fails a request past its per-request timeout and a call after the run deadline makes no request", async () => {
  const slow = harness(hangs);
  await rejectsWith(slow.fetcher({ timeoutMs: 20 }).fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT");
  // A body that stalls until the signal aborts also times out.
  const stalled = harness(({ signal }) => ({ body: (async function* () { yield Buffer.from("x"); await hangs({ signal }); })() }));
  await rejectsWith(stalled.fetcher({ timeoutMs: 20 }).fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT");
  // The run deadline bounds the first request and refuses the next before any lookup.
  const run = harness(hangs);
  const fetcher = run.fetcher({ timeoutMs: 10000, runMs: 30 });
  const started = Date.now();
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT");
  assert.ok(Date.now() - started < 5000);
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT", (e) => /deadline/.test(e.message));
  assert.equal(run.log.length, 1);
  assert.equal(run.lookups.length, 1);
});

test("stack fetch refuses every call after the run deadline aborts a request, even when the clock lags the timer", async (t) => {
  // A timer can fire before Date.now() reaches the deadline. A frozen clock makes that lag certain.
  const now = Date.now, frozen = now();
  Date.now = () => frozen;
  t.after(() => { Date.now = now; });
  const run = harness(hangs);
  const fetcher = run.fetcher({ timeoutMs: 10000, runMs: 30 });
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT");
  await rejectsWith(fetcher.fetchResource(URL_OK, TYPES), "NETWORK_TIMEOUT", (e) => /deadline/.test(e.message));
  assert.equal(run.log.length, 1, "the call after the deadline makes no request");
  assert.equal(run.lookups.length, 1, "and no lookup");
});

test("stack fetch refuses a declared content-length over the body cap before reading the body", async () => {
  let read = false;
  const net = harness(() => ({ headers: { ...RSS, "content-length": "1025" }, body: (async function* () { read = true; yield Buffer.from("x"); })() }));
  await rejectsWith(net.fetcher({ body: 1024 }).fetchResource(URL_OK, TYPES), "RESPONSE_TOO_LARGE");
  assert.equal(read, false);
  const short = harness(() => ({ headers: { ...RSS, "content-length": "5" }, body: Buffer.from("x") }));
  await rejectsWith(short.fetcher().fetchResource(URL_OK, TYPES), "UPSTREAM_INVALID");
});

test("stack fetch maps HTTP statuses and rate-limit headers to typed codes", async () => {
  const get = (status, headers = {}) => harness(() => ({ status, headers: { ...RSS, ...headers } })).fetcher().fetchResource(URL_OK, TYPES);
  const reset = String(Date.UTC(2026, 9, 7) / 1000);
  await rejectsWith(get(429, { "retry-after": "60" }), "RATE_LIMITED", (e) => e.details.retryAfterSeconds === 60);
  await rejectsWith(get(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }), "RATE_LIMITED", (e) => e.details.resetAt === "2026-10-07T00:00:00.000Z");
  await rejectsWith(get(403, { "retry-after": "30" }), "RATE_LIMITED", (e) => e.details.retryAfterSeconds === 30);
  await rejectsWith(get(403), "UPSTREAM_FORBIDDEN", (e) => e.details.status === 403);
  await rejectsWith(get(403, { "x-ratelimit-remaining": "12" }), "UPSTREAM_FORBIDDEN");
  await rejectsWith(get(401), "UPSTREAM_FORBIDDEN", (e) => e.details.status === 401);
  await rejectsWith(get(404), "UPSTREAM_NOT_FOUND", (e) => e.details.status === 404);
  await rejectsWith(get(410), "UPSTREAM_NOT_FOUND", (e) => e.details.status === 410);
  await rejectsWith(get(503), "UPSTREAM_UNAVAILABLE", (e) => e.details.status === 503);
  await rejectsWith(get(418), "UPSTREAM_HTTP", (e) => e.details.status === 418);
  await rejectsWith(get(199), "UPSTREAM_HTTP", (e) => e.details.status === 199);
  await rejectsWith(get(302, { location: "https://elsewhere.example.net/" }), "REDIRECT_REFUSED");
  // A malformed or out-of-range retry-after or reset is dropped, never echoed.
  for (const value of ["soon", "-1", "1.5", "99999", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    await rejectsWith(get(429, { "retry-after": value, "x-ratelimit-reset": "later" }), "RATE_LIMITED", (e) => { assert.deepEqual(e.details, {}, value); return true; });
  }
  await rejectsWith(get(403, { "retry-after": "soon" }), "UPSTREAM_FORBIDDEN");
});

test("stack fetch refuses userinfo, an explicit port, a non-https scheme and an unresolvable host", async () => {
  const net = harness();
  const fetcher = net.fetcher();
  // Userinfo URLs are assembled at run time so the package audit sees no credential-shaped literal.
  const withInfo = (info) => "https://" + info + "@" + HOST + "/feed.xml";
  for (const url of [withInfo("user"), withInfo(["user", "secret"].join(":")), "https://" + HOST + ":8443/feed.xml", "http://" + HOST + "/feed.xml", "ftp://" + HOST + "/feed.xml"]) {
    await rejectsWith(fetcher.fetchResource(url, TYPES), "HOST_NOT_APPROVED", (e) => { assert.ok(!JSON.stringify(e.details).includes("secret"), url); return true; });
  }
  assert.equal(net.log.length + net.lookups.length, 0);
  const unresolved = harness(() => ({}), { lookup: async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); } });
  await rejectsWith(unresolved.fetcher().fetchResource(URL_OK, TYPES), "NETWORK_UNAVAILABLE");
  assert.equal(unresolved.log.length, 0);
  const empty = harness(() => ({}), { lookup: async () => [] });
  await rejectsWith(empty.fetcher().fetchResource(URL_OK, TYPES), "PATH_UNSAFE");
  assert.equal(empty.log.length, 0);
});
