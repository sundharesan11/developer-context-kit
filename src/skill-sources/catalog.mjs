import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";

const CATALOG_PATH = fileURLToPath(new URL("../../catalog/skill-sources.json", import.meta.url));
const bad = (field) => { throw new DevtwinError("INVALID_INPUT", `Invalid ${field}`); };
const record = (value, keys, field) => {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) bad(field);
};
const text = (value, pattern, field) => {
  if (typeof value !== "string" || !pattern.test(value)) bad(field);
  return value;
};
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

export function validateSourceRecipe(entry, field = "source") {
    record(entry, ["id", "repository", "license", "source", "installation"], field);
    const id = text(entry.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${field}.id`);
    if (id.length < 3 || id.length > 64 || ["prototype", "constructor", "__proto__"].includes(id)) bad(`${field}.id`);
    record(entry.repository, ["owner", "name"], `${field}.repository`);
    const owner = text(entry.repository.owner, /^[A-Za-z0-9-]{1,39}$/, `${field}.repository.owner`);
    if (owner.startsWith("-") || owner.endsWith("-")) bad(`${field}.repository.owner`);
    const name = text(entry.repository.name, /^[A-Za-z0-9._-]{1,100}$/, `${field}.repository.name`);
    if (name === "." || name === ".." || name.toLowerCase().endsWith(".git")) bad(`${field}.repository.name`);
    if (!["MIT", "Apache-2.0"].includes(entry.license)) bad(`${field}.license`);
    record(entry.source, ["channel"], `${field}.source`);
    if (entry.source.channel !== "stable-release") bad(`${field}.source.channel`);
    record(entry.installation, ["status", "note"], `${field}.installation`);
    if (entry.installation.status !== "unverified") bad(`${field}.installation.status`);
    const note = entry.installation.note;
    if (typeof note !== "string" || note.length < 1 || note.length > 200 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(note)) bad(`${field}.installation.note`);
    return freeze({ id, repository: { owner, name }, license: entry.license, source: { channel: "stable-release" }, installation: { status: "unverified", note } });
}

export function validateCatalog(value) {
  record(value, ["version", "preset", "sources"], "catalog");
  if (value.version !== 1) bad("version");
  if (value.preset !== "requested-twelve") bad("preset");
  if (!Array.isArray(value.sources) || value.sources.length !== 12) bad("sources");
  const ids = new Set();
  const repositories = new Set();
  const sources = value.sources.map((entry, index) => {
    const source = validateSourceRecipe(entry, `sources[${index}]`);
    if (ids.has(source.id.toLowerCase())) bad(`sources[${index}].id`);
    ids.add(source.id.toLowerCase());
    const repositoryKey = `${source.repository.owner}/${source.repository.name}`.toLowerCase();
    if (repositories.has(repositoryKey)) bad(`sources[${index}].repository`);
    repositories.add(repositoryKey);
    return source;
  });
  return freeze({ version: 1, preset: "requested-twelve", sources });
}

export function loadBundledCatalog() {
  const info = statSync(CATALOG_PATH);
  if (!info.isFile() || info.size > 64 * 1024) bad("catalog size");
  const bytes = readFileSync(CATALOG_PATH);
  if (bytes.byteLength > 64 * 1024) bad("catalog size");
  let parsed;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { bad("catalog JSON"); }
  return validateCatalog(parsed);
}

export function listSources(catalog) {
  return { preset: catalog.preset, sources: catalog.sources };
}

export function getSource(catalog, id) {
  const source = catalog.sources.find((item) => item.id === id);
  if (!source) bad("source id");
  return source;
}
