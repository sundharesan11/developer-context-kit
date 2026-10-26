import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DevtwinError } from "../errors.mjs";
import { USER_AGENT, GITHUB_HOST } from "./plan.mjs";

// KTD8 and KTD17: every request goes through an injected request(options) and lookup(host). The lookup result is
// checked for private addresses and the request connects to exactly that address; redirects are never followed.
export const FETCH_LIMITS = Object.freeze({ body: 1048576, total: 8388608, calls: 64, timeoutMs: 10000, runMs: 120000 });
const fail = (code, message, details = {}) => { throw new DevtwinError(code, message, details); };
const v4 = (address) => address.split(".").map(Number);
function unsafeV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
function expandV6(address) {
  let text = address.toLowerCase().split("%")[0];
  const tail = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail) { const [a, b, c, d] = v4(tail[1]); text = text.slice(0, -tail[1].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16); }
  const [head, rest] = text.includes("::") ? text.split("::") : [text, null];
  const left = head ? head.split(":") : [], right = rest ? rest.split(":") : [];
  const groups = rest === null ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return groups.map((g) => parseInt(g || "0", 16));
}
// Loopback, private, link-local, unique-local, unspecified, shared, multicast and reserved ranges are refused.
export function isUnsafeAddress(address) {
  const kind = isIP(address);
  if (kind === 4) return unsafeV4(v4(address));
  if (kind !== 6) return true;
  const g = expandV6(address);
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return true;
  if (g.slice(0, 7).every((x) => x === 0)) return true; // :: and ::1
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return unsafeV4([g[6] >> 8, g[6] & 255, g[7] >> 8]); // IPv4-mapped or -compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return unsafeV4([g[6] >> 8, g[6] & 255, g[7] >> 8]); // NAT64
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0 || (g[0] & 0xff00) === 0xff00 || (g[0] === 0x2001 && g[1] === 0xdb8);
}
// Production lookup: every address the resolver returns, so one private answer refuses the host.
export const systemLookup = (host) => dnsLookup(host, { all: true, verbatim: true });
// Production request: node:https with a lookup that returns only the checked address. TLS keeps the host name for
// SNI and certificate checks. Resolves {status, headers, body (async iterable), cancel}.
export function httpsRequest({ url, method, headers, body, address, family, signal }, { transport = https } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const pinned = (_host, options, callback) => options?.all ? callback(null, [{ address, family }]) : callback(null, address, family);
    const req = transport.request({ protocol: "https:", hostname: target.hostname, servername: target.hostname, port: 443, path: target.pathname + target.search, method, headers, agent: false, lookup: pinned, signal },
      (res) => resolve({ status: res.statusCode, headers: res.headers, body: res, cancel: () => res.destroy() }));
    req.on("error", reject);
    req.end(body);
  });
}
const header = (headers, name) => {
  if (!headers) return null;
  if (typeof headers.get === "function") return headers.get(name);
  const value = headers[name] ?? headers[name.toLowerCase()];
  return value === undefined ? null : Array.isArray(value) ? value.join(", ") : String(value);
};
function retryDetails(headers) {
  const details = {};
  const after = header(headers, "retry-after");
  if (after !== null && /^\d{1,5}$/.test(after) && Number(after) <= 86400) details.retryAfterSeconds = Number(after);
  const reset = header(headers, "x-ratelimit-reset");
  if (reset !== null && /^\d{1,12}$/.test(reset) && Number(reset) <= 253402300799) details.resetAt = new Date(Number(reset) * 1000).toISOString();
  return details;
}
function statusFailure(status, headers) {
  if (status >= 300 && status < 400) fail("REDIRECT_REFUSED", "Redirect refused", { status });
  const details = retryDetails(headers);
  if (status === 429 || (status === 403 && (header(headers, "x-ratelimit-remaining") === "0" || Object.hasOwn(details, "retryAfterSeconds")))) fail("RATE_LIMITED", "Rate limit reached", details);
  if (status === 401 || status === 403) fail("UPSTREAM_FORBIDDEN", "Source refused the request", { status });
  if (status === 404 || status === 410) fail("UPSTREAM_NOT_FOUND", "Source not found", { status });
  if (status >= 500) fail("UPSTREAM_UNAVAILABLE", "Source is unavailable", { status });
  fail("UPSTREAM_HTTP", "Source returned an HTTP error", { status });
}
async function* chunksOf(body) {
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try { while (true) { const item = await reader.read(); if (item.done) return; yield item.value; } }
    finally { try { await reader.cancel(); } catch { /* already closed */ } }
  } else if (body && typeof body[Symbol.asyncIterator] === "function") yield* body;
  else if (body instanceof Uint8Array || typeof body === "string") yield typeof body === "string" ? Buffer.from(body) : body;
  else fail("UPSTREAM_INVALID", "Missing response body");
}
// One fetcher per run: it holds the approved host set, the call and byte budgets and the optional bearer value for
// api.github.com. fetchResource returns {bytes, contentType, url} or throws a typed DevtwinError for that source only.
// cache (U20): an optional Map shared by the runs of one scheduled job, so each source is fetched once for all scopes.
// A cached answer or failure is not a request. The call cap counts the requests of every run that shares the cache.
export function createFetcher({ request = httpsRequest, lookup = systemLookup, hosts, bearer = null, limits = {}, cache = null } = {}) {
  const caps = { ...FETCH_LIMITS, ...limits };
  const allowed = new Set(hosts);
  const started = Date.now();
  let calls = 0, transferred = 0;
  async function fetchResource(target, { method = "GET", body, accept, types, auth = false } = {}) {
    const url = new URL(target);
    if (url.protocol !== "https:" || url.username || url.password || url.port || !allowed.has(url.hostname)) fail("HOST_NOT_APPROVED", "Host is not in the approval", { host: url.hostname });
    const key = method + " " + url.href + " " + (body ?? "");
    if (cache?.has(key)) { const hit = cache.get(key); if (hit.error) throw hit.error; return hit; }
    const budget = cache ? (cache.budget ??= { calls: 0 }) : null;
    if (budget ? ++budget.calls > caps.calls : ++calls > caps.calls) fail("CALL_LIMIT", "Per-run request limit reached");
    if (budget) calls++;
    try { return await request1(url, { method, body, accept, types, auth }); }
    catch (error) { if (cache && error instanceof DevtwinError && error.code !== "DEVTWIN_CALL_LIMIT") cache.set(key, { error }); throw error; }
  }
  async function request1(url, { method, body, accept, types, auth }) {
    const key = method + " " + url.href + " " + (body ?? "");
    if (Date.now() - started >= caps.runMs) fail("NETWORK_TIMEOUT", "Run deadline exceeded");
    let answers;
    try { answers = await lookup(url.hostname); } catch { fail("NETWORK_UNAVAILABLE", "Host could not be resolved"); }
    const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean);
    if (!list.length || list.some((a) => typeof a.address !== "string" || isUnsafeAddress(a.address))) fail("PATH_UNSAFE", "Host resolves to a private or reserved address", { host: url.hostname });
    const { address } = list[0];
    const headers = { "User-Agent": USER_AGENT, Accept: accept, "Accept-Encoding": "identity" };
    if (auth && bearer && url.hostname === GITHUB_HOST) headers.authorization = "Bearer " + bearer;
    const payload = body === undefined ? undefined : Buffer.from(body);
    if (payload) { headers["Content-Type"] = "application/json"; headers["Content-Length"] = String(payload.byteLength); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(caps.timeoutMs, caps.runMs - (Date.now() - started))));
    let response;
    try {
      try { response = await request({ url: url.href, method, headers, body: payload, address, family: isIP(address), signal: controller.signal }); }
      catch { fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "NETWORK_UNAVAILABLE", "Request failed"); }
      if (!response || !Number.isInteger(response.status)) fail("UPSTREAM_INVALID", "Invalid response");
      if (response.status < 200 || response.status >= 300) statusFailure(response.status, response.headers);
      const encoding = (header(response.headers, "content-encoding") ?? "identity").trim().toLowerCase();
      if (encoding !== "identity") fail("ENCODING_REFUSED", "Encoded response refused", { encoding: encoding.slice(0, 32) });
      const contentType = (header(response.headers, "content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
      if (!types.includes(contentType)) fail("CONTENT_TYPE_REFUSED", "Unexpected content type", { contentType: contentType.slice(0, 64) });
      const declared = header(response.headers, "content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > caps.body) fail("RESPONSE_TOO_LARGE", "Response too large");
      const parts = [];
      let size = 0;
      try {
        for await (const chunk of chunksOf(response.body)) {
          size += chunk.byteLength; transferred += chunk.byteLength;
          if (size > caps.body || transferred > caps.total) fail("RESPONSE_TOO_LARGE", "Response too large");
          parts.push(chunk);
        }
      } catch (error) {
        if (error instanceof DevtwinError) throw error;
        fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "UPSTREAM_INVALID", "Response body read failed");
      }
      if (declared !== null && /^\d+$/.test(declared) && size !== Number(declared)) fail("UPSTREAM_INVALID", "Truncated response");
      const result = { bytes: Buffer.concat(parts, size), contentType, url: url.href };
      cache?.set(key, result);
      return result;
    } finally {
      clearTimeout(timer);
      try { response?.cancel?.(); } catch { /* already closed */ }
    }
  }
  return { fetchResource, get calls() { return calls; } };
}
