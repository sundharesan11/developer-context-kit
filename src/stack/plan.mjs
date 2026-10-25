import { join } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { atomicReplace, ensurePrivatePath, readPrivateJson } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readProfile } from "../profile/store.mjs";
import { parseStackEntry } from "../profile/validate.mjs";
import { checkFeedUrl, checkIdentifier, findCatalogItem } from "./catalog.mjs";

export const GROUPS = Object.freeze(["advisories", "lifecycle", "versions"]);
export const MAP_KINDS = Object.freeze(["github", "endoflife", "npm", "pypi", "crates"]);
export const MODE = "manual";
export const GITHUB_HOST = "api.github.com", OSV_HOST = "api.osv.dev", EOL_HOST = "endoflife.date";
export const REGISTRY_HOSTS = Object.freeze({ npm: "registry.npmjs.org", pypi: "pypi.org", crates: "crates.io" });
export const OSV_ECOSYSTEMS = Object.freeze({ npm: "npm", pypi: "PyPI", crates: "crates.io" });
export const EXACT_VERSION = /^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?$/;
export const USER_AGENT = "devtwin-stack-check";
export const REQUEST_CONTENT = "Request content is limited to the feed URLs, identifiers and versions listed for each host. No profile text, record, path, scope, project name or local identifier is sent.";
export const FOLLOW_NOTE = "The set of fetched feed URLs, tied to your IP address, shows which vendors you follow.";
// Without routing's binding the seam reports none; no environment variable is ever read for a token.
export const noPublicReadBinding = async () => ({ bound: false });
export const stackApprovalPath = (roots) => join(roots.stateRoot, "stack", "approval.json");
export const stackLockPath = (roots) => join(roots.stateRoot, "locks", "stack.lock");
const invalid = (field, message = "Invalid stack plan input") => { throw new DevtwinError("INVALID_INPUT", message, { field }); };
const sorted = (values) => [...new Set(values)].sort();
const nameOf = (text, field) => {
  const entry = parseStackEntry(text);
  if (entry.version !== undefined || entry.care !== undefined) invalid(field);
  return entry.name.toLowerCase();
};
function parsePair(text, field) {
  const at = typeof text === "string" ? text.indexOf("=") : -1;
  if (at < 1) invalid(field);
  return [nameOf(text.slice(0, at), field), text.slice(at + 1)];
}
export function parseFeedOverride(text) {
  const [name, url] = parsePair(text, "feed");
  return { name, url: checkFeedUrl(url, "feed") };
}
export function parseMapOverride(text) {
  const [name, rest] = parsePair(text, "map");
  const at = rest.indexOf(":");
  if (at < 0) invalid("map", "Map overrides use name=kind:identifier");
  const kind = rest.slice(0, at);
  if (!MAP_KINDS.includes(kind)) throw new DevtwinError("INVALID_INPUT", "Unknown map kind", { field: "map", allowed: MAP_KINDS });
  return { name, kind, id: checkIdentifier(kind, rest.slice(at + 1), "map") };
}
export function parseGroups(values = []) {
  for (const value of values) if (!GROUPS.includes(value)) throw new DevtwinError("INVALID_INPUT", "Unknown source group", { field: "with", allowed: GROUPS });
  return ["announcements", ...GROUPS.filter((group) => values.includes(group))];
}
const overrideKey = (o) => canonicalJson(o);
const normalizeOverrides = ({ feeds = [], maps = [] }) => ({
  feeds: [...new Map(feeds.map((o) => [overrideKey(o), o])).values()].sort((a, b) => overrideKey(a) < overrideKey(b) ? -1 : 1),
  maps: [...new Map(maps.map((o) => [overrideKey(o), o])).values()].sort((a, b) => overrideKey(a) < overrideKey(b) ? -1 : 1)
});
const APPROVAL_KEYS = ["schemaVersion", "kind", "pilotDigest", "planFingerprint", "itemListHash", "items", "feeds", "identifiers", "overrides", "groups", "hosts", "hostDetail", "authentication", "mode", "profileRevisionHash", "approvedAt", "recordHash"];
export async function readStackApproval(roots) {
  let value;
  try { value = await readPrivateJson(stackApprovalPath(roots), 131072); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { recordHash, ...body } = value ?? {};
  if (!value || typeof value !== "object" || Object.keys(value).length !== APPROVAL_KEYS.length || APPROVAL_KEYS.some((key) => !Object.hasOwn(value, key)) ||
      value.schemaVersion !== 1 || value.kind !== "stack-sources" || value.pilotDigest !== roots.pilot.digest || recordHash !== digest(body)) throw new DevtwinError("INTEGRITY", "Stack approval invalid");
  return value;
}
// Overrides given on this call replace the set; with none given, the current approval's overrides carry forward
// unless --clear-overrides drops them (KTD7). Carried overrides for items no longer declared are dropped and listed.
function chooseOverrides(given, approval, clear, declared) {
  if (given.feeds.length || given.maps.length) {
    for (const o of [...given.feeds, ...given.maps]) if (!declared.has(o.name)) invalid(o.url ? "feed" : "map", "Override names an undeclared stack item");
    return { status: "given", ...normalizeOverrides(given), dropped: [] };
  }
  if (clear) return { status: approval && (approval.overrides.feeds.length || approval.overrides.maps.length) ? "cleared" : "none", feeds: [], maps: [], dropped: [] };
  if (!approval || (!approval.overrides.feeds.length && !approval.overrides.maps.length)) return { status: "none", feeds: [], maps: [], dropped: [] };
  const keep = (o) => declared.has(o.name);
  const all = [...approval.overrides.feeds, ...approval.overrides.maps];
  return { status: "carried-forward", ...normalizeOverrides({ feeds: approval.overrides.feeds.filter(keep), maps: approval.overrides.maps.filter(keep) }), dropped: all.filter((o) => !keep(o)) };
}
function resolveItem(entry, catalog, overrides, groups) {
  const key = entry.name.toLowerCase();
  const found = findCatalogItem(catalog, key);
  const feeds = [...(found?.feeds ?? [])], github = [...(found?.github ?? [])];
  let endoflife = found?.endoflife ?? null, pkg = found?.package ?? null;
  const feedOverrides = overrides.feeds.filter((o) => o.name === key), mapOverrides = overrides.maps.filter((o) => o.name === key);
  for (const o of feedOverrides) feeds.push(o.url);
  for (const o of mapOverrides) {
    if (o.kind === "github") github.push(o.id);
    else if (o.kind === "endoflife") endoflife = o.id;
    else pkg = { ecosystem: o.kind, name: o.id };
  }
  const sources = { feeds: sorted(feeds), github: sorted(github), endoflife, package: pkg };
  const exact = entry.version !== undefined && EXACT_VERSION.test(entry.version);
  const item = { name: entry.name, version: entry.version ?? null, care: entry.care ?? "normal", cataloged: Boolean(found), overridden: Boolean(feedOverrides.length || mapOverrides.length), terms: found?.terms ?? [entry.name], sources };
  const fetches = [];
  for (const url of sources.feeds) fetches.push({ host: new URL(url).hostname, group: "announcements", feed: url });
  for (const id of sources.github) fetches.push({ host: GITHUB_HOST, group: "announcements", identifier: id });
  if (groups.includes("advisories")) {
    item.advisories = !pkg ? "advisories not covered" : exact ? "exact" : "version not exact";
    if (pkg) fetches.push({ host: OSV_HOST, group: "advisories", identifier: OSV_ECOSYSTEMS[pkg.ecosystem] + "/" + pkg.name, ...(exact ? { version: entry.version.replace(/^v(?=\d)/, "") } : {}) });
  }
  if (groups.includes("lifecycle")) {
    item.lifecycle = endoflife ? "covered" : "lifecycle not covered";
    if (endoflife) fetches.push({ host: EOL_HOST, group: "lifecycle", identifier: endoflife });
  }
  if (groups.includes("versions")) {
    item.versions = pkg ? "covered" : "versions not covered";
    if (pkg) fetches.push({ host: REGISTRY_HOSTS[pkg.ecosystem], group: "versions", identifier: pkg.name });
  }
  item.watched = fetches.length > 0;
  if (!item.watched) item.reason = found || item.overridden ? "no source in the enabled groups" : "not in the catalog; add --feed or --map";
  return { item, fetches };
}
function hostsFrom(fetches) {
  const map = new Map();
  for (const f of fetches) {
    const host = map.get(f.host) ?? { host: f.host, groups: [], feeds: [], identifiers: [], versions: [] };
    host.groups.push(f.group);
    if (f.feed) host.feeds.push(f.feed);
    if (f.identifier) host.identifiers.push(f.identifier);
    if (f.version) host.versions.push({ identifier: f.identifier, version: f.version });
    map.set(f.host, host);
  }
  return [...map.values()].sort((a, b) => a.host < b.host ? -1 : 1).map((h) => ({ ...h, groups: sorted(h.groups), feeds: sorted(h.feeds), identifiers: sorted(h.identifiers), versions: [...new Map(h.versions.map((v) => [canonicalJson(v), v])).values()].sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : 1) }));
}
// Item-list hash covers names and versions only, so a care-level change keeps the approval (KTD12).
export const itemListHash = (entries) => digest(entries.map((e) => ({ name: e.name, version: e.version ?? null })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
// input: {feeds, maps, groups, clearOverrides} as CLI strings; deps: {catalog, resolvePublicRead}.
export async function planStack(roots, input = {}, { catalog, resolvePublicRead = noPublicReadBinding } = {}) {
  if (!catalog) throw new DevtwinError("INVALID_INPUT", "Stack catalog required");
  const groups = parseGroups(input.groups ?? []);
  const given = { feeds: (input.feeds ?? []).map(parseFeedOverride), maps: (input.maps ?? []).map(parseMapOverride) };
  const current = await readProfile(roots);
  const entries = (current.profile?.stackCurrent ?? []).map(parseStackEntry);
  const declared = new Set(entries.map((e) => e.name.toLowerCase()));
  const approval = await readStackApproval(roots);
  const overrides = chooseOverrides(given, approval, input.clearOverrides === true, declared);
  const resolved = entries.map((entry) => resolveItem(entry, catalog, overrides, groups));
  const hosts = hostsFrom(resolved.flatMap((r) => r.fetches));
  // Only whether the binding exists is asked; any other field the resolver returns is ignored and never stored.
  // A typed refusal from the resolver (for example TOKEN_TOO_BROAD) means GitHub requests stay unauthenticated.
  let bound = false, refused = null;
  if (hosts.some((h) => h.host === GITHUB_HOST)) {
    try { bound = (await resolvePublicRead({ purpose: "public-read", host: GITHUB_HOST }))?.bound === true; }
    catch (error) { if (!(error instanceof DevtwinError)) throw error; refused = error.code; }
  }
  const authentication = bound ? "routed-public-read" : "unauthenticated";
  const items = resolved.map((r) => r.item);
  return finalizePlan({
    preview: true, kind: "stack-sources", mode: MODE,
    profile: { generation: current.generation, revisionHash: current.revisionHash },
    itemListHash: itemListHash(entries), items, notWatched: items.filter((i) => !i.watched).map((i) => i.name),
    groups, overrides, hosts,
    authentication: { github: authentication, ...(refused ? { refused } : {}), note: bound ? "GitHub requests are authenticated as the GitHub account of the routed public-read binding; that account is visible to GitHub." : refused ? "The routed public-read binding was refused; GitHub requests are unauthenticated." : "GitHub requests are unauthenticated." },
    requestContent: REQUEST_CONTENT,
    hostsStillSee: ["IP address", "request time", "fixed user agent " + USER_AGENT, ...(bound ? ["the GitHub account of the routed public-read binding (" + GITHUB_HOST + " only)"] : [])],
    followNote: FOLLOW_NOTE,
    approvable: hosts.length > 0
  });
}
// The terms an approval binds and stack check compares (KTD7, KTD13). The profile revision hash is provenance only.
export function approvalTerms(plan, mode = MODE) {
  return {
    itemListHash: plan.itemListHash,
    feeds: sorted(plan.hosts.flatMap((h) => h.feeds)),
    identifiers: sorted(plan.hosts.flatMap((h) => h.identifiers.map((id) => h.host + " " + id))),
    groups: [...plan.groups],
    hosts: plan.hosts.map((h) => h.host),
    authentication: plan.authentication.github,
    mode
  };
}
export function approvalDifferences(approval, plan, { mode = MODE } = {}) {
  if (!approval) return ["approval"];
  const terms = approvalTerms(plan, mode);
  return Object.keys(terms).filter((key) => canonicalJson(terms[key]) !== canonicalJson(approval[key]));
}
// For stack check (U5): throws APPROVAL_REQUIRED unless the stored approval matches this plan and mode.
export async function assertStackApproved(roots, plan, { mode = MODE } = {}) {
  const approval = await readStackApproval(roots);
  const differences = approvalDifferences(approval, plan, { mode });
  if (differences.length) throw new DevtwinError("APPROVAL_REQUIRED", "Stack source plan needs approval", { differences });
  return approval;
}
export async function approveStack(roots, input, deps, { fingerprint, now = () => new Date() } = {}) {
  if (!fingerprint) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  const path = stackApprovalPath(roots), dir = join(roots.stateRoot, "stack");
  assertWritable(roots, [dir, path]);
  return withPilotLock(roots, stackLockPath(roots), { kind: "stack-approve" }, async () => {
    const plan = await planStack(roots, input, deps);
    assertFingerprint(plan, fingerprint);
    if (!plan.approvable) throw new DevtwinError("CONFLICT", "An empty source plan cannot be approved", { notWatched: plan.notWatched });
    const terms = approvalTerms(plan, MODE);
    const body = { schemaVersion: 1, kind: "stack-sources", pilotDigest: roots.pilot.digest, planFingerprint: plan.fingerprint, ...terms,
      items: plan.items.map((i) => ({ name: i.name, version: i.version })), overrides: { feeds: plan.overrides.feeds, maps: plan.overrides.maps },
      hostDetail: plan.hosts, profileRevisionHash: plan.profile.revisionHash, approvedAt: now().toISOString() };
    ensurePrivatePath(roots.stateRoot, ["stack"]);
    await atomicReplace(path, canonicalJson({ ...body, recordHash: digest(body) }) + "\n");
    return { kind: "stack-sources", destination: { root: "stateRoot", path: "stack/approval.json" }, planFingerprint: plan.fingerprint, ...terms, approvedAt: body.approvedAt };
  }, { destinations: [dir, path] });
}
