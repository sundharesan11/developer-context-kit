import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";
import { DevctxError } from "../errors.mjs";
import { assertNoSensitive } from "../records/redact.mjs";

const CATALOG_PATH = fileURLToPath(new URL("../../catalog/stack-sources.json", import.meta.url));
const CATALOG_LIMIT = 64 * 1024;
const ITEM_KEYS = ["name", "aliases", "terms", "feeds", "github", "endoflife", "package"];
export const ECOSYSTEMS = Object.freeze(["npm", "pypi", "crates"]);
export const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,79}$/;
export const IDENTIFIERS = Object.freeze({
  github: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/,
  endoflife: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  npm: /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]{0,213}$/,
  pypi: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/,
  crates: /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
});
const bad = (field) => { throw new DevctxError("INVALID_INPUT", "Invalid stack catalog", { field }); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const freeze = (value) => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
};
// KTD17 static rules: https, no user info, default port, DNS host name with at least two labels, no IP literal or
// localhost. Private-address checks after DNS resolution happen before each request (U5), not here.
export function checkFeedUrl(text, field = "feed") {
  const fail = () => { throw new DevctxError("INVALID_INPUT", "Invalid feed URL", { field }); };
  if (typeof text !== "string" || !text.length || text.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(text)) fail();
  let url;
  try { url = new URL(text); } catch { fail(); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || /@/.test(text.split("/")[2] ?? "")) fail();
  const host = url.hostname;
  if (!host || host.startsWith("[") || isIP(host) || /^[0-9.]+$/.test(host) || host.endsWith(".")) fail();
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) fail();
  if (labels.at(-1) === "localhost" || /^[0-9]+$/.test(labels.at(-1))) fail();
  assertNoSensitive(text);
  return url.href;
}
export function checkIdentifier(kind, id, field) {
  if (!Object.hasOwn(IDENTIFIERS, kind)) throw new DevctxError("INVALID_INPUT", "Unknown identifier kind", { field, allowed: Object.keys(IDENTIFIERS) });
  if (typeof id !== "string" || !IDENTIFIERS[kind].test(id) || id.endsWith(".git")) throw new DevctxError("INVALID_INPUT", "Invalid identifier", { field });
  return id;
}
function strings(value, field, { max, length, check = (item) => item }) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) bad(field);
  const out = value.map((item, index) => {
    if (typeof item !== "string" || !item.length || item.length > length) bad(`${field}[${index}]`);
    return check(item, `${field}[${index}]`);
  });
  if (new Set(out).size !== out.length) bad(field);
  return out;
}
function validateItem(entry, field) {
  if (!isObject(entry)) bad(field);
  for (const key of Object.keys(entry)) if (!ITEM_KEYS.includes(key)) bad(`${field}.${key}`);
  if (typeof entry.name !== "string" || !NAME.test(entry.name)) bad(`${field}.name`);
  const aliases = strings(entry.aliases, `${field}.aliases`, { max: 10, length: 80, check: (item, f) => NAME.test(item) ? item : bad(f) });
  const terms = strings(entry.terms, `${field}.terms`, { max: 20, length: 80, check: (item, f) => /^[^\r\n]+$/.test(item) ? item : bad(f) });
  if (!terms.length) bad(`${field}.terms`);
  const feeds = strings(entry.feeds, `${field}.feeds`, { max: 5, length: 2048, check: (item, f) => checkFeedUrl(item, f) === item ? item : bad(f) });
  const github = strings(entry.github, `${field}.github`, { max: 5, length: 140, check: (item, f) => checkIdentifier("github", item, f) });
  const item = { name: entry.name, aliases, terms, feeds, github };
  if (entry.endoflife !== undefined) item.endoflife = checkIdentifier("endoflife", entry.endoflife, `${field}.endoflife`);
  if (entry.package !== undefined) {
    const pkg = entry.package;
    if (!isObject(pkg) || Object.keys(pkg).length !== 2 || !Object.hasOwn(pkg, "ecosystem") || !Object.hasOwn(pkg, "name")) bad(`${field}.package`);
    if (!ECOSYSTEMS.includes(pkg.ecosystem)) throw new DevctxError("INVALID_INPUT", "Unknown identifier kind", { field: `${field}.package.ecosystem`, allowed: ECOSYSTEMS });
    item.package = { ecosystem: pkg.ecosystem, name: checkIdentifier(pkg.ecosystem, pkg.name, `${field}.package.name`) };
  }
  return item;
}
// Shape: {version: 1, items: [{name, aliases?, terms, feeds?, github?, endoflife?, package?: {ecosystem, name}}]}.
// Names and aliases are lowercase and unique across the catalog; feeds and github serve the default group only.
export function validateStackCatalog(value) {
  if (!isObject(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 200) bad("catalog");
  const names = new Set();
  const items = value.items.map((entry, index) => {
    const item = validateItem(entry, `items[${index}]`);
    for (const name of [item.name, ...item.aliases]) {
      if (names.has(name)) bad(`items[${index}].name`);
      names.add(name);
    }
    return item;
  });
  return freeze({ version: 1, items });
}
export function loadStackCatalog() {
  const info = statSync(CATALOG_PATH);
  if (!info.isFile() || info.size > CATALOG_LIMIT) bad("catalog size");
  const bytes = readFileSync(CATALOG_PATH);
  if (bytes.byteLength > CATALOG_LIMIT) bad("catalog size");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { bad("catalog JSON"); }
  return validateStackCatalog(parsed);
}
export function findCatalogItem(catalog, name) {
  const key = name.toLowerCase();
  return catalog.items.find((item) => item.name === key || item.aliases.includes(key)) ?? null;
}
