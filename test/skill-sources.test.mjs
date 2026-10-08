import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { loadBundledCatalog, validateCatalog, listSources, getSource } from "../src/skill-sources/catalog.mjs";
import { checkSource } from "../src/skill-sources/github.mjs";
import { main } from "../src/cli.mjs";

const shaA = "a".repeat(40);
const shaB = "b".repeat(40);
const source = () => getSource(loadBundledCatalog(), "pm-skills");
const base = "/repos/phuryn/pm-skills";
function routesFor(tag = "v1", commit = shaA) {
  return {
    [base]: { full_name: "Phuryn/PM-SKILLS" },
    [`${base}/releases/latest`]: { draft: false, prerelease: false, tag_name: tag },
    [`${base}/git/ref/tags/${tag}`]: { ref: `refs/tags/${tag}`, object: { type: "commit", sha: commit } },
    [`${base}/git/commits/${commit}`]: { sha: commit }
  };
}
async function fixture(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url, accept: req.headers.accept, agent: req.headers["user-agent"] });
    const entry = routes[req.url] ?? { status: 404, body: {} };
    if (entry.hang) return;
    const body = entry.encodedBody ?? (typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body ?? entry));
    res.writeHead(entry.status ?? 200, { "content-type": entry.contentType ?? "application/json; charset=utf-8", ...entry.headers });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const request = (url, options) => {
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal);
    return fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, options);
  };
  return { seen, request };
}

const identities = [
  ["pm-skills", "phuryn/pm-skills"],
  ["openspec", "Fission-AI/OpenSpec"],
  ["last30days", "mvanhorn/last30days-skill"],
  ["ui-ux-pro-max", "nextlevelbuilder/ui-ux-pro-max-skill"],
  ["taste-skill", "Leonxlnx/taste-skill"],
  ["impeccable", "pbakaus/impeccable"],
  ["superpowers", "obra/superpowers"],
  ["mattpocock-skills", "mattpocock/skills"],
  ["understand-anything", "Egonex-AI/Understand-Anything"],
  ["marketing-skills", "coreyhaines31/marketingskills"],
  ["humanizer", "blader/humanizer"],
  ["claude-seo", "AgriciDaniel/claude-seo"]
];

test("skill source catalog has exactly twelve public unverified recipes", () => {
  const catalog = loadBundledCatalog();
  assert.equal(catalog.version, 1);
  assert.equal(catalog.preset, "requested-twelve");
  assert.deepEqual(catalog.sources.map((s) => [s.id, `${s.repository.owner}/${s.repository.name}`]), identities);
  assert.deepEqual(catalog.sources.map((s) => s.source.channel), Array(12).fill("stable-release"));
  assert.deepEqual(catalog.sources.map((s) => s.license).filter((s) => s === "Apache-2.0"), ["Apache-2.0"]);
  assert.ok(catalog.sources.every((s) => s.installation.status === "unverified"));
  assert.deepEqual(Object.keys(getSource(catalog, "taste-skill").source), ["channel"]);
  assert.equal(listSources(catalog).sources.length, 12);
  assert.throws(() => getSource(catalog, "missing"), { code: "DEVCTX_INVALID_INPUT" });
});

test("skill source catalog rejects malformed public recipes and isolates caller mutation", () => {
  const source = loadBundledCatalog();
  const variant = () => structuredClone(source);
  for (const mutate of [
    (c) => { c.sources[0].id = "__proto__"; },
    (c) => { c.sources[1].id = c.sources[0].id; },
    (c) => { c.sources[1].repository = { ...c.sources[0].repository }; },
    (c) => { c.sources[0].source.commit = "0".repeat(40); },
    (c) => { c.sources[0].source.channel = "branch"; },
    (c) => { c.sources[0].repository.owner = "bad/name"; },
    (c) => { c.sources[0].installation.note = ""; },
    (c) => { c.sources[0].installation.extra = true; },
    (c) => { c.sources[0].license = 12; },
    (c) => { c.sources.pop(); }
  ]) {
    const candidate = variant();
    mutate(candidate);
    assert.throws(() => validateCatalog(candidate), { code: "DEVCTX_INVALID_INPUT" });
  }
  const candidate = variant();
  const validated = validateCatalog(candidate);
  candidate.sources[0].installation.note = "changed";
  assert.notEqual(validated.sources[0].installation.note, "changed");
  assert.ok(Object.isFrozen(validated.sources[0].repository));
});

test("skill source moved tag is compared with supplied prior lock", async (t) => {
  const { request, seen } = await fixture(t, routesFor("v1", shaB));
  const priorLock = { sourceId: "pm-skills", channel: "stable-release", tag: "v1", commit: shaA };
  assert.deepEqual(await checkSource(source(), { request, priorLock }), {
    sourceId: "pm-skills", status: "moved_tag", channel: "stable-release", tag: "v1", commit: shaB,
    previous: { tag: "v1", commit: shaA }
  });
  assert.equal(seen.length, 4);
  assert.ok(seen.every((item) => item.accept === "application/vnd.github+json"));
});

test("skill source resolves slash tags and annotated tags without branch fallback", async (t) => {
  const slash = routesFor("release/v1", shaA);
  slash[`${base}/git/ref/tags/release/v1`] = { ref: "refs/tags/release/v1", object: { type: "tag", sha: shaB } };
  slash[`${base}/git/tags/${shaB}`] = { tag: "release/v1", object: { type: "commit", sha: shaA } };
  const { request, seen } = await fixture(t, slash);
  assert.equal((await checkSource(source(), { request })).status, "untracked");
  assert.ok(seen.some((item) => item.path === `${base}/git/ref/tags/release/v1`));
  const noRelease = { [base]: { full_name: "phuryn/pm-skills" }, [`${base}/releases/latest`]: { status: 404, body: {} } };
  const absent = await fixture(t, noRelease);
  assert.deepEqual(await checkSource(source(), { request: absent.request }), { sourceId: "pm-skills", status: "no_release", channel: "stable-release" });
});

test("skill source stable and changed releases are neutral observations", async (t) => {
  const { request } = await fixture(t, routesFor("v2", shaB));
  const priorLock = { sourceId: "pm-skills", channel: "stable-release", tag: "v1", commit: shaA };
  assert.equal((await checkSource(source(), { request, priorLock })).status, "release_changed");
  assert.equal((await checkSource(source(), { request, priorLock: { ...priorLock, tag: "v2", commit: shaB } })).status, "stable");
});

test("skill source annotated tags stop at four objects and reject cycles", async (t) => {
  const tagShas = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(40));
  const routes = routesFor("v1", shaA);
  routes[`${base}/git/ref/tags/v1`] = { ref: "refs/tags/v1", object: { type: "tag", sha: tagShas[0] } };
  for (let index = 0; index < 4; index++) {
    routes[`${base}/git/tags/${tagShas[index]}`] = {
      tag: "v1", object: { type: index === 3 ? "commit" : "tag", sha: index === 3 ? shaA : tagShas[index + 1] }
    };
  }
  const accepted = await fixture(t, routes);
  assert.equal((await checkSource(source(), { request: accepted.request })).commit, shaA);
  routes[`${base}/git/tags/${tagShas[3]}`] = { tag: "v1", object: { type: "tag", sha: tagShas[4] } };
  const excessive = await fixture(t, routes);
  await assert.rejects(checkSource(source(), { request: excessive.request }), { code: "DEVCTX_UPSTREAM_INVALID" });
  routes[`${base}/git/tags/${tagShas[1]}`] = { tag: "v1", object: { type: "tag", sha: tagShas[0] } };
  const cycle = await fixture(t, routes);
  await assert.rejects(checkSource(source(), { request: cycle.request }), { code: "DEVCTX_UPSTREAM_INVALID" });
});

test("skill source HTTP fixture refuses redirects and oversized bodies", async (t) => {
  for (const [route, entry, code] of [
    [base, { status: 301, headers: { location: "https://elsewhere.invalid" }, body: {} }, "DEVCTX_SOURCE_MOVED"],
    [`${base}/releases/latest`, { status: 302, body: {} }, "DEVCTX_REDIRECT_REFUSED"],
    [`${base}/releases/latest`, { headers: { "content-length": "262145" }, body: {} }, "DEVCTX_UPSTREAM_INVALID"],
    [`${base}/releases/latest`, { body: "x".repeat(262145) }, "DEVCTX_UPSTREAM_INVALID"]
  ]) {
    const routes = { ...routesFor(), [route]: entry };
    const { request } = await fixture(t, routes);
    await assert.rejects(checkSource(source(), { request }), (error) => error.code === code && !JSON.stringify(error.details).includes("elsewhere"));
  }
});

test("skill source maps HTTP, protocol, timeout, and transport failures", async (t) => {
  const cases = [
    [base, { status: 404, body: {} }, "DEVCTX_SOURCE_NOT_FOUND"],
    [base, { status: 401, body: {} }, "DEVCTX_GITHUB_UNAUTHORIZED"],
    [base, { status: 403, headers: { "x-ratelimit-remaining": "0", "retry-after": "12" }, body: {} }, "DEVCTX_RATE_LIMITED"],
    [base, { status: 403, body: {} }, "DEVCTX_GITHUB_FORBIDDEN"],
    [base, { status: 429, body: {} }, "DEVCTX_RATE_LIMITED"],
    [base, { status: 500, body: {} }, "DEVCTX_UPSTREAM_UNAVAILABLE"],
    [`${base}/releases/latest`, { body: { draft: false, prerelease: true, tag_name: "v1" } }, "DEVCTX_NO_STABLE_RELEASE"],
    [`${base}/releases/latest`, { contentType: "text/plain", body: "bad" }, "DEVCTX_UPSTREAM_INVALID"],
    [`${base}/releases/latest`, { body: "{" }, "DEVCTX_UPSTREAM_INVALID"],
    [`${base}/git/ref/tags/v1`, { status: 404, body: {} }, "DEVCTX_UPSTREAM_INVALID"],
    [`${base}/git/ref/tags/v1`, { body: { ref: "refs/tags/v1", object: { type: "tag", sha: shaB } } }, "DEVCTX_UPSTREAM_INVALID"],
    [`${base}/git/commits/${shaA}`, { body: { sha: shaB } }, "DEVCTX_UPSTREAM_INVALID"]
  ];
  for (const [route, entry, code] of cases) {
    const { request } = await fixture(t, { ...routesFor(), [route]: entry });
    await assert.rejects(checkSource(source(), { request }), (error) => error.code === code && !JSON.stringify(error.details).includes("bad"));
  }
  const hanging = await fixture(t, { [base]: { hang: true } });
  await assert.rejects(checkSource(source(), { request: hanging.request, timeoutMs: 20 }), { code: "DEVCTX_NETWORK_TIMEOUT" });
  await assert.rejects(checkSource(source(), { request: () => { throw new Error("offline"); } }), { code: "DEVCTX_NETWORK_UNAVAILABLE" });
});

test("skill source rejects a 200 JSON string that resembles no-release", async (t) => {
  const { request } = await fixture(t, { ...routesFor(), [`${base}/releases/latest`]: { body: '"no_release"' } });
  await assert.rejects(checkSource(source(), { request }), { code: "DEVCTX_UPSTREAM_INVALID" });
});

test("skill source accepts bounded gzip JSON with wire content-length", async (t) => {
  const body = gzipSync(JSON.stringify({ full_name: "phuryn/pm-skills" }));
  const { request } = await fixture(t, {
    ...routesFor(), [base]: { encodedBody: body, headers: { "content-encoding": "gzip", "content-length": String(body.byteLength) } }
  });
  assert.equal((await checkSource(source(), { request })).status, "untracked");
});

test("skill source refuses malformed direct recipes before transport", async () => {
  let calls = 0;
  const request = () => { calls++; throw new Error("transport called"); };
  for (const repository of [{ owner: "phuryn", name: "." }, { owner: "-bad", name: "repo" }, { owner: "phuryn", name: "repo.git" }]) {
    await assert.rejects(checkSource({ ...source(), repository }, { request }), { code: "DEVCTX_INVALID_INPUT" });
  }
  assert.equal(calls, 0);
});

async function cli(args, options = {}) {
  let output = "";
  const code = await main(args, { stdout: { write: (chunk) => { output += chunk; } }, ...options });
  return { code, json: JSON.parse(output) };
}

test("skill source CLI is root-free while existing writes remain pilot-bound", async (t) => {
  const catalog = await cli(["skill-sources", "catalog"]);
  assert.equal(catalog.code, 0);
  assert.equal(catalog.json.result.sources.length, 12);
  assert.deepEqual(catalog.json.result.sources.map((item) => item.id), identities.map((item) => item[0]));
  const help = await cli(["help"]);
  assert.ok(help.json.result.commands.includes("skill-sources catalog"));
  assert.ok(help.json.result.commands.includes("skill-sources check"));
  const oldRoute = await cli(["skill", "discover"]);
  assert.equal(oldRoute.json.error.code, "DEVCTX_GATE_REQUIRED");
  const { request } = await fixture(t, routesFor());
  const checked = await cli(["skill-sources", "check", "--source", "pm-skills"], { request });
  assert.equal(checked.code, 0);
  assert.equal(checked.json.result.status, "untracked");
});

test("skill source CLI rejects root options and malformed command options", async () => {
  for (const route of [["skill-sources", "catalog"], ["skill-sources", "check", "--source", "pm-skills"]]) {
    for (const flag of ["pilot", "config-root", "data-root", "state-root"]) {
      for (const suffix of [[`--${flag}`, "anything"], [`--${flag}=anything`]]) {
        const result = await cli([...route, ...suffix]);
        assert.equal(result.code, 2);
        assert.equal(result.json.error.code, "DEVCTX_USAGE");
      }
    }
  }
  for (const args of [
    ["skill-sources", "catalog", "--unknown"],
    ["skill-sources", "check"],
    ["skill-sources", "check", "--source", "pm-skills", "--source", "openspec"],
    ["skill-sources", "check", "--source", "pm-skills", "--prior-lock-json", "{"],
    ["skill-sources", "check", "--source", "pm-skills", "--prior-lock-json", "é".repeat(600)],
    ["skill-sources", "check", "--source", "pm-skills", "--prior-lock-json", "{}", "--prior-lock-json", "{}"]
  ]) {
    const result = await cli(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.json.error.code, "DEVCTX_USAGE");
  }
  const unknown = await cli(["skill-sources", "check", "--source", "missing"]);
  assert.equal(unknown.json.error.code, "DEVCTX_INVALID_INPUT");
  const invalid = await cli(["skill-sources", "check", "--source", "pm-skills", "--prior-lock-json", "{}"]);
  assert.equal(invalid.json.error.code, "DEVCTX_INVALID_INPUT");
});
