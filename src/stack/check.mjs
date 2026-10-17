import { join } from "node:path";
import { DevctxError } from "../errors.mjs";
import { digest } from "../storage/canonical.mjs";
import { readPrivateJson } from "../storage/fsx.mjs";
import { assertScopeId } from "../identity/ids.mjs";
import { readSnapshot } from "../records/store.mjs";
import { planStack, assertStackApproved, readStackApproval, noPublicReadBinding, MODE, GITHUB_HOST, OSV_HOST, EOL_HOST, REGISTRY_HOSTS, OSV_ECOSYSTEMS, EXACT_VERSION } from "./plan.mjs";
import { parseFeed, decodeUtf8, reduceHtml, plainText, cleanLink, FEED_LIMITS } from "./feed.mjs";
import { createFetcher, httpsRequest, systemLookup } from "./fetch.mjs";
import { itemTerms, readScopeRecords, classifyEntry } from "./match.mjs";

// U5: the bounded announcement watch. runStackCheck fetches from the approved hosts only, parses, matches and marks
// entries already in this scope's seen state. It writes nothing; U6's digest reuses it and owns every write.
const FEED_TYPES = ["application/rss+xml", "application/x-rss+xml", "application/atom+xml", "application/feed+json", "application/xml", "text/xml", "application/json"];
const JSON_TYPES = ["application/json"];
const RELEASES_PER_PAGE = 10;
const EXCERPT = 300;
const BREAKING_LINE = /\b(?:breaking|deprecat(?:e|ed|es|ion|ions)|remov(?:e|ed|es|al))\b/i;
const HASH = /^sha256:[0-9a-f]{64}$/;
const LEVELS = ["project", "stack", "background"];
const SEVERITIES = { critical: "critical", high: "high", moderate: "medium", medium: "medium", low: "low" };
const DAY = 86400000;
const upstream = (message) => { throw new DevctxError("UPSTREAM_INVALID", message); };
function json(bytes) {
  try { return JSON.parse(decodeUtf8(bytes)); } catch { return upstream("Invalid JSON response"); }
}
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const major = (version) => { const m = /^v?(\d{1,9})(?:\.|$)/.exec(String(version ?? "")); return m ? Number(m[1]) : null; };
const VERSION_TEXT = /^v?[0-9A-Za-z.+-]{1,64}$/;

// Seen state is kept per scope, keyed by entry and finding hash (KTD18). Unscoped runs use seen/none.json; a scope's
// state sits under seen/scopes/ so a scope named "none" can never share the unscoped file.
export const seenStatePath = (roots, scope) => scope ? join(roots.stateRoot, "stack", "seen", "scopes", assertScopeId(scope) + ".json") : join(roots.stateRoot, "stack", "seen", "none.json");
export function seenStateBody(scope, hashes) {
  const body = { schemaVersion: 1, kind: "stack-seen", scope: scope ?? null, hashes: [...new Set(hashes)].sort() };
  return { ...body, recordHash: digest(body) };
}
export async function readSeenState(roots, scope) {
  let value;
  try { value = await readPrivateJson(seenStatePath(roots, scope), 4194304); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const { recordHash, ...body } = isObject(value) ? value : {};
  if (!isObject(value) || Object.keys(value).length !== 5 || body.schemaVersion !== 1 || body.kind !== "stack-seen" || body.scope !== (scope ?? null) ||
      !Array.isArray(body.hashes) || body.hashes.some((h) => typeof h !== "string" || !HASH.test(h)) || recordHash !== digest(body)) throw new DevctxError("INTEGRITY", "Stack seen state invalid");
  return new Set(body.hashes);
}

function entryOf(item, sourceKind, sourceUrl, liveHost, raw) {
  const body = { item, sourceKind, sourceUrl, id: raw.id, title: raw.title, link: raw.link, date: raw.date, summary: raw.summary };
  let linkLive = false;
  if (raw.link) { const url = new URL(raw.link); linkLive = url.protocol === "https:" && url.hostname === liveHost; }
  return { ...body, linkLive, hash: digest(body) };
}
function findingOf(item, group, kind, severity, fields, fetchedAt) {
  const body = { item, group, kind, severity, ...fields };
  return { ...body, fetchedAt, hash: digest(body) };
}
function releaseData(bytes) {
  const list = json(bytes);
  if (!Array.isArray(list)) upstream("Invalid GitHub releases");
  if (list.length > FEED_LIMITS.entries) throw new DevctxError("FEED_LIMIT", "Feed exceeds a parser limit", { reason: "entries" });
  return list.filter((r) => isObject(r) && r.draft !== true).map((r) => {
    const body = typeof r.body === "string" ? r.body.slice(0, FEED_LIMITS.nodeText) : "";
    const raw = {
      title: reduceHtml(typeof r.name === "string" && r.name.trim() ? r.name : String(r.tag_name ?? ""), FEED_LIMITS.title),
      link: cleanLink(r.html_url), id: plainText(String(r.id ?? r.tag_name ?? ""), FEED_LIMITS.id) || null,
      date: typeof r.published_at === "string" && Number.isFinite(Date.parse(r.published_at)) ? new Date(Date.parse(r.published_at)).toISOString() : null,
      summary: reduceHtml(body, FEED_LIMITS.summary)
    };
    const lines = body.split(/\r?\n/).filter((line) => BREAKING_LINE.test(line)).slice(0, 3).map((line) => reduceHtml(line, EXCERPT)).filter(Boolean);
    return { raw, lines };
  });
}
function osvFindings(item, bytes, fetchedAt, sourceUrl) {
  const value = json(bytes);
  if (!isObject(value) || (value.vulns !== undefined && !Array.isArray(value.vulns))) upstream("Invalid OSV response");
  return (value.vulns ?? []).slice(0, FEED_LIMITS.entries).filter((v) => isObject(v) && typeof v.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(v.id)).map((v) => {
    const severity = SEVERITIES[String(v.database_specific?.severity ?? "").toLowerCase()] ?? "unknown";
    return findingOf(item, "advisories", "advisory", severity, { id: v.id, title: "Security advisory " + v.id, excerpt: plainText(typeof v.summary === "string" ? v.summary : "", EXCERPT), url: "https://osv.dev/vulnerability/" + encodeURIComponent(v.id), sourceUrl }, fetchedAt);
  });
}
function lifecycleFindings(item, version, id, bytes, now, fetchedAt, sourceUrl) {
  const cycles = json(bytes);
  if (!Array.isArray(cycles)) upstream("Invalid lifecycle response");
  const match = cycles.slice(0, 500).filter((c) => isObject(c) && (typeof c.cycle === "string" || typeof c.cycle === "number"))
    .map((c) => ({ ...c, cycle: String(c.cycle) })).filter((c) => version === c.cycle || version.startsWith(c.cycle + "."))
    .sort((a, b) => b.cycle.length - a.cycle.length)[0];
  if (!match) return { findings: [], notes: [{ group: "lifecycle", note: "cycle not found" }] };
  const url = "https://" + EOL_HOST + "/" + encodeURIComponent(id);
  if (match.eol === true) return { findings: [findingOf(item, "lifecycle", "end-of-life", "high", { cycle: match.cycle, eolDate: null, title: item + " " + match.cycle + " has reached end of life", url, sourceUrl }, fetchedAt)], notes: [] };
  if (typeof match.eol !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(match.eol) || !Number.isFinite(Date.parse(match.eol))) return { findings: [], notes: [] };
  const days = Math.ceil((Date.parse(match.eol) - now.getTime()) / DAY);
  const severity = days <= 90 ? "high" : days <= 365 ? "medium" : null;
  if (!severity) return { findings: [], notes: [] };
  const title = days <= 0 ? item + " " + match.cycle + " reached end of life on " + match.eol : item + " " + match.cycle + " reaches end of life on " + match.eol;
  return { findings: [findingOf(item, "lifecycle", "end-of-life", severity, { cycle: match.cycle, eolDate: match.eol, title, url, sourceUrl }, fetchedAt)], notes: [] };
}
const registryUrl = ({ ecosystem, name }) => ecosystem === "npm" ? "https://" + REGISTRY_HOSTS.npm + "/" + (name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name)) + "/latest"
  : ecosystem === "pypi" ? "https://" + REGISTRY_HOSTS.pypi + "/pypi/" + encodeURIComponent(name) + "/json" : "https://" + REGISTRY_HOSTS.crates + "/api/v1/crates/" + encodeURIComponent(name);
const packagePage = ({ ecosystem, name }) => ecosystem === "npm" ? "https://www.npmjs.com/package/" + name : ecosystem === "pypi" ? "https://pypi.org/project/" + name + "/" : "https://crates.io/crates/" + name;
function versionFindings(item, version, pkg, bytes, fetchedAt, sourceUrl) {
  const value = json(bytes);
  if (!isObject(value)) upstream("Invalid registry response");
  const latest = pkg.ecosystem === "npm" ? value.version : pkg.ecosystem === "pypi" ? value.info?.version : value.crate?.max_stable_version ?? value.crate?.newest_version;
  if (typeof latest !== "string" || !VERSION_TEXT.test(latest)) upstream("Invalid registry version");
  const findings = [], notes = [];
  const url = packagePage(pkg);
  if (pkg.ecosystem === "npm" && typeof value.deprecated === "string" && value.deprecated.trim()) findings.push(findingOf(item, "versions", "deprecated", "high", { latest, title: item + " " + latest + " is deprecated", excerpt: plainText(value.deprecated, EXCERPT), url, sourceUrl }, fetchedAt));
  if (version === null) notes.push({ group: "versions", note: "version unknown" });
  else if (major(latest) !== null && major(version) !== null && major(latest) > major(version)) findings.push(findingOf(item, "versions", "new-major-version", "medium", { latest, title: item + " " + latest + " is a new major version", url, sourceUrl }, fetchedAt));
  // Minor and patch releases are patch-level noise and are not reported (R25).
  return { findings, notes };
}
function failureOf(item, source, url, error) {
  const code = error instanceof DevctxError ? error.code : "DEVCTX_NETWORK_UNAVAILABLE";
  const details = {};
  for (const key of ["status", "retryAfterSeconds", "resetAt", "reason", "contentType", "encoding"]) if (error?.details && Object.hasOwn(error.details, key)) details[key] = error.details[key];
  return { item, source, host: new URL(url).hostname, url, code, reason: error instanceof DevctxError ? error.message : "Request failed", details };
}
// Called once per run, only when the approval says GitHub requests use the routed public-read binding. reveal: true
// asks routing's resolver for the value itself; a typed refusal (such as TOKEN_TOO_BROAD) means unauthenticated.
async function publicReadValue(approval, resolvePublicRead) {
  if (approval.authentication !== "routed-public-read") return { bearer: null, refused: null };
  try {
    const result = await resolvePublicRead({ purpose: "public-read", host: GITHUB_HOST, reveal: true });
    if (result?.bound === true && typeof result.value === "string" && result.value.length && !/[\s\p{Cc}]/u.test(result.value)) return { bearer: result.value, refused: null };
    return { bearer: null, refused: "DEVCTX_BINDING_UNAVAILABLE" };
  } catch (error) {
    if (!(error instanceof DevctxError)) throw error;
    return { bearer: null, refused: error.code };
  }
}
// deps: {catalog, resolvePublicRead, request, lookup, now, reader (record snapshot reader), limits}.
export async function runStackCheck(roots, { scope = null } = {}, deps = {}) {
  const { catalog, resolvePublicRead = noPublicReadBinding, request = httpsRequest, lookup = systemLookup, now = () => new Date(), reader = readSnapshot, limits } = deps;
  // Live mode stays offline until the watch's entry lands in the "Live-mode exceptions" section (U5 live-mode step).
  if (roots.pilot?.live) throw new DevctxError("GATE_REQUIRED", "Stack watch is not allowed in live mode yet", { field: "live", reason: "no-live-exception" });
  if (scope !== null) assertScopeId(scope);
  const stored = await readStackApproval(roots);
  const plan = await planStack(roots, { groups: (stored?.groups ?? []).filter((g) => g !== "announcements") }, { catalog, resolvePublicRead });
  const approval = await assertStackApproved(roots, plan);
  const projects = scope !== null ? await readScopeRecords(roots, scope, { reader }) : null;
  const seen = await readSeenState(roots, scope);
  const { bearer, refused } = await publicReadValue(approval, resolvePublicRead);
  const fetcher = createFetcher({ request, lookup, hosts: approval.hosts, bearer, limits });
  const clock = now(), fetchedAt = clock.toISOString();
  const terms = itemTerms(plan.items);
  const groups = approval.groups;
  const items = [], entries = [], findings = [], failures = [];
  for (const planned of plan.items) {
    const { name, sources } = planned;
    const version = planned.version ?? null;
    const record = { name, version, watched: planned.watched, sources: [], notes: [] };
    const attempt = async (kind, url, run) => {
      try { const n = await run(); record.sources.push({ kind, url, status: "ok", count: n }); }
      catch (error) { const failure = failureOf(name, kind, url, error); failures.push(failure); record.sources.push({ kind, url, status: "failed", code: failure.code }); }
    };
    for (const feed of sources.feeds) await attempt("feed", feed, async () => {
      const { bytes } = await fetcher.fetchResource(feed, { accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, application/json;q=0.8", types: FEED_TYPES });
      const parsed = parseFeed(bytes).entries.map((raw) => entryOf(name, "feed", feed, new URL(feed).hostname, raw));
      entries.push(...parsed);
      return parsed.length;
    });
    for (const id of sources.github) {
      const [owner, repo] = id.split("/");
      const url = "https://" + GITHUB_HOST + "/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo) + "/releases?per_page=" + RELEASES_PER_PAGE;
      await attempt("github-release", url, async () => {
        const { bytes } = await fetcher.fetchResource(url, { accept: "application/vnd.github+json", types: JSON_TYPES, auth: true });
        const releases = releaseData(bytes);
        for (const { raw, lines } of releases) {
          const entry = entryOf(name, "github-release", url, "github.com", raw);
          entries.push(entry);
          // A matching release-note line is quoted as an inert excerpt with its release URL; nothing else claims a break.
          for (const excerpt of lines) findings.push(findingOf(name, "announcements", "release-note", "info", { title: "Release note line from " + (raw.title || "a release"), excerpt, url: entry.linkLive ? raw.link : null, sourceUrl: url }, fetchedAt));
        }
        return releases.length;
      });
    }
    const pkg = sources.package;
    if (groups.includes("advisories")) {
      if (!pkg) record.notes.push({ group: "advisories", note: "advisories not covered" });
      else if (version === null) record.notes.push({ group: "advisories", note: "version unknown" });
      else if (!EXACT_VERSION.test(version)) record.notes.push({ group: "advisories", note: "version not exact" });
      else {
        const url = "https://" + OSV_HOST + "/v1/query";
        // The only request that carries a version, and only an exact one (KTD12).
        const body = JSON.stringify({ package: { name: pkg.name, ecosystem: OSV_ECOSYSTEMS[pkg.ecosystem] }, version });
        await attempt("advisories", url, async () => {
          const { bytes } = await fetcher.fetchResource(url, { method: "POST", body, accept: "application/json", types: JSON_TYPES });
          const found = osvFindings(name, bytes, fetchedAt, url);
          findings.push(...found);
          return found.length;
        });
      }
    }
    if (groups.includes("lifecycle")) {
      if (!sources.endoflife) record.notes.push({ group: "lifecycle", note: "lifecycle not covered" });
      else if (version === null) record.notes.push({ group: "lifecycle", note: "version unknown" });
      else {
        const url = "https://" + EOL_HOST + "/api/" + encodeURIComponent(sources.endoflife) + ".json";
        await attempt("lifecycle", url, async () => {
          const { bytes } = await fetcher.fetchResource(url, { accept: "application/json", types: JSON_TYPES });
          const out = lifecycleFindings(name, version, sources.endoflife, bytes, clock, fetchedAt, url);
          findings.push(...out.findings); record.notes.push(...out.notes);
          return out.findings.length;
        });
      }
    }
    if (groups.includes("versions")) {
      if (!pkg) record.notes.push({ group: "versions", note: "versions not covered" });
      else {
        const url = registryUrl(pkg);
        await attempt("versions", url, async () => {
          const { bytes } = await fetcher.fetchResource(url, { accept: "application/json", types: JSON_TYPES });
          const out = versionFindings(name, version, pkg, bytes, fetchedAt, url);
          findings.push(...out.findings); record.notes.push(...out.notes);
          return out.findings.length;
        });
      }
    }
    const failed = record.sources.filter((s) => s.status === "failed").length;
    record.status = !record.sources.length ? (planned.watched ? "ok" : "not-watched") : failed === record.sources.length ? "failed" : failed ? "partial" : "ok";
    if (!planned.watched) record.reason = planned.reason;
    items.push(record);
  }
  const classified = entries.map((entry) => ({ ...entry, ...classifyEntry(entry, terms, projects), previouslyReported: seen.has(entry.hash) }))
    .sort((a, b) => LEVELS.indexOf(a.level) - LEVELS.indexOf(b.level) || (b.date ?? "").localeCompare(a.date ?? "") || (a.hash < b.hash ? -1 : 1));
  const marked = findings.map((f) => ({ ...f, previouslyReported: seen.has(f.hash) }));
  const count = (level) => classified.filter((e) => e.level === level).length;
  return {
    kind: "stack-check", mode: MODE, scope, fetchedAt,
    approval: { planFingerprint: approval.planFingerprint, recordHash: approval.recordHash },
    groups: [...groups],
    authentication: { approved: approval.authentication, used: bearer ? "routed-public-read" : "unauthenticated",
      ...(refused ? { refused, note: "The routed public-read binding was refused; GitHub requests ran unauthenticated and the approval's authentication state no longer matches, so the next run asks for approval again." } : {}) },
    ...(projects ? { projectsUnavailable: projects.filter((p) => p.unavailable).map((p) => ({ project: p.project, code: p.unavailable })) } : {}),
    items, entries: classified, findings: marked, notWatched: plan.notWatched, failures,
    counts: { entries: classified.length, project: count("project"), stack: count("stack"), background: count("background"),
      previouslyReported: classified.filter((e) => e.previouslyReported).length + marked.filter((f) => f.previouslyReported).length, findings: marked.length, failures: failures.length },
    requests: fetcher.calls
  };
}
