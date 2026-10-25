import {join, posix} from "node:path";
import {DevtwinError} from "../errors.mjs";
import {LEGACY_SKILL_PREFIX, LEGACY_RECEIPT} from "../config/legacy.mjs";
import {digest, sha256} from "../storage/canonical.mjs";
import {readPrivateBytes} from "../storage/fsx.mjs";
import {assertSourceRel, isDeniedRel} from "../storage/source-read.mjs";
import {assertPackageRel, PACKAGE_LIMITS as L, SKILL_NAME, parseFrontmatter, checkPackageLinks} from "../skill-builder/validate.mjs";
import {inspectAcquisition} from "./staging.mjs";
import {gitBlobSha} from "./selection.mjs";

export const exact = (v, keys) => !!v && typeof v === "object" && [null, Object.prototype].includes(Object.getPrototypeOf(v)) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
export const fail = (code = "INVALID_INPUT") => { throw new DevtwinError(code, "Source package operation refused"); };
export async function sourceOperation(fn) {
  try { return await fn(); }
  catch (e) { throw new DevtwinError(e instanceof DevtwinError ? e.code : "STORAGE_ERROR", "Source package operation refused"); }
}
const legal = /^(LICENSE|NOTICE|COPYING)(\.md|\.txt)?$/;
export function assertSourcePackageRel(path) { if (legal.test(path)) return path; return assertPackageRel(path); }
function sourcePath(path) {
  assertSourceRel(path);
  if (isDeniedRel(path) || path.split("/").some((p) => p.length > 100 || p.endsWith(".")) || path.split("/").length > 16) fail();
  return path;
}
function paths(values, {nonempty = false} = {}) {
  if (!Array.isArray(values) || values.length > 24 || nonempty && !values.length) fail();
  values.forEach(sourcePath);
  if (new Set(values).size !== values.length) fail();
  return [...values].sort();
}
export function validateSourceMapping(value) {
  if (!exact(value, ["schemaVersion", "name", "skillRoot", "files", "requiredPaths", "licensePaths", "noticePaths", "dependencies", "compatibility", "review"]) || value.schemaVersion !== 1) fail();
  if (typeof value.name !== "string" || !SKILL_NAME.test(value.name) || value.name.length > 64 || value.name.startsWith("devtwin-") || value.name.startsWith(LEGACY_SKILL_PREFIX) || ["synced", "anthropic-skills"].includes(value.name)) fail();
  if (typeof value.skillRoot !== "string") fail();
  if (value.skillRoot) sourcePath(value.skillRoot);
  if (!Array.isArray(value.files) || !value.files.length || value.files.length > 24) fail();
  const requiredPaths = paths(value.requiredPaths, {nonempty: true}), licensePaths = paths(value.licensePaths, {nonempty: true}), noticePaths = paths(value.noticePaths);
  const legalSources = new Set([...licensePaths, ...noticePaths]), seen = new Set();
  const prefix = value.skillRoot ? value.skillRoot + "/" : "";
  const files = value.files.map((file) => {
    if (!exact(file, ["source", "target"])) fail();
    sourcePath(file.source); sourcePath(file.target);
    if (seen.has(file.source)) fail(); seen.add(file.source);
    const inside = !prefix || file.source.startsWith(prefix);
    const expected = inside ? file.source.slice(prefix.length) : posix.basename(file.source);
    if (file.target !== expected || !inside && (!legalSources.has(file.source) || !legal.test(file.target))) fail();
    if (file.target === ".devtwin-owned.json" || file.target === LEGACY_RECEIPT) fail();
    return {...file};
  }).sort((a, b) => a.source.localeCompare(b.source, "en"));
  const skill = prefix + "SKILL.md";
  if (!seen.has(skill) || !requiredPaths.includes(skill) || [...requiredPaths, ...legalSources].some((p) => !seen.has(p)) || [...legalSources].some((p) => !legal.test(files.find((f) => f.source === p).target))) fail();
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 24) fail();
  const dependencies = value.dependencies.map((d) => {
    if (!exact(d, ["name", "status"]) || typeof d.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,159}$/.test(d.name) || !["unreviewed", "missing", "user-confirmed-present"].includes(d.status)) fail();
    return {...d};
  }).sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (new Set(dependencies.map((d) => d.name)).size !== dependencies.length) fail();
  if (!exact(value.compatibility, ["claude", "codex"]) || Object.values(value.compatibility).some((v) => !["unreviewed", "unsupported", "user-reviewed-sandbox"].includes(v))) fail();
  if (!exact(value.review, ["fileCompleteness", "licensesAndNotices", "dependencies"]) || Object.values(value.review).some((v) => !["unreviewed", "user-reviewed"].includes(v))) fail();
  return {schemaVersion: 1, name: value.name, skillRoot: value.skillRoot, files, requiredPaths, licensePaths, noticePaths, dependencies, compatibility: {...value.compatibility}, review: {...value.review}};
}

function sourceFrontmatter(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") fail();
  const end = lines.indexOf("---", 1);
  if (end < 2) fail();
  const keys = new Set();
  let governingKey;
  for (const line of lines.slice(1, end)) {
    // YAML folds indented continuations into a plain scalar, including across blank lines.
    if (governingKey === "name" && /^\s+\S/.test(line)) fail();
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (line.includes("\t") || /^\s*(?:["'?&*!{\[%]|<<:|---|\.\.\.)/.test(line) || /:\s*[{\[]/.test(line) || /(?:^|:\s*|\s)[&*!][A-Za-z0-9_-]+/.test(line)) fail();
    if (!line.startsWith(" ")) {
      const match = /^([A-Za-z0-9_-]+):(?:\s|$)/.exec(line);
      if (!match || keys.has(match[1])) fail();
      keys.add(match[1]);
      governingKey = match[1];
    }
  }
  if (!keys.has("name")) fail();
  const parsed = parseFrontmatter(text, {nameOnly: true});
  if (!parsed.body.trim()) fail();
  return parsed;
}

export async function loadSourcePackage(roots, {stageRunId, mapping: input}) {
  return sourceOperation(async () => {
    const stage = await inspectAcquisition(roots, stageRunId), mapping = validateSourceMapping(input);
    if (digest(mapping.files.map((f) => f.source).sort()) !== digest(stage.manifest.selection)) fail();
    const holds = new Set(), disclosures = new Set(["NAME_ONLY_FRONTMATTER", "CALLER_UNVERIFIED_PIN", "ACQUISITION_ASSESSMENT"]);
    if (Object.values(mapping.review).includes("unreviewed")) holds.add("REVIEW_REQUIRED");
    if (!Object.values(mapping.compatibility).includes("user-reviewed-sandbox")) holds.add("NO_REVIEWED_HOST");
    for (const d of mapping.dependencies) if (d.status !== "user-confirmed-present") holds.add(d.status === "missing" ? "DEPENDENCY_MISSING" : "DEPENDENCY_UNREVIEWED");
    const files = Object.create(null), texts = Object.create(null), roles = new Map(), rows = [], relocations = [];
    let total = 0;
    for (const mapped of mapping.files) {
      const metadata = stage.files.find((f) => f.path === mapped.source);
      const bytes = await readPrivateBytes(join(roots.dataRoot, "skill-sources/staging", stageRunId, "files", mapped.source), L.fileBytes);
      if (bytes.length !== metadata.size || sha256(bytes) !== metadata.sha256 || gitBlobSha(bytes) !== metadata.blob) fail("INTEGRITY");
      total += bytes.length;
      if (total > L.totalBytes) holds.add("PACKAGE_LIMIT");
      try { assertSourcePackageRel(mapped.target); } catch { holds.add("UNSUPPORTED_LAYOUT"); }
      const parts = mapped.target.split("/");
      for (let i = 1; i <= parts.length; i++) {
        const rel = parts.slice(0, i).join("/"), key = rel.toLowerCase(), role = i === parts.length ? "file" : "directory", prior = roles.get(key);
        if (prior && (prior.rel !== rel || prior.role !== role || role === "file")) {
          if (legal.test(mapped.target) && prior.rel === mapped.target && role === "file") holds.add("LEGAL_TARGET_COLLISION");
          else fail("SELECTION_CONFLICT");
        }
        roles.set(key, {rel, role});
      }
      files[mapped.target] = bytes;
      try { const text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); if (text.includes("\0")) throw new Error("binary"); texts[mapped.target] = text; }
      catch { holds.add("BINARY_CONTENT"); }
      rows.push({...mapped, size: metadata.size, mode: metadata.mode, blob: metadata.blob, sha256: metadata.sha256});
      if (metadata.mode === "100755") disclosures.add("EXECUTABLE_MODE_NOT_ACTIVATED");
      if (mapped.target.startsWith("scripts/")) disclosures.add("INERT_UNVERIFIED_HELPERS");
      if (mapping.skillRoot && !mapped.source.startsWith(mapping.skillRoot + "/")) { relocations.push({...mapped}); disclosures.add("LEGAL_RELOCATION"); }
    }
    let parsed;
    if (Object.hasOwn(texts, "SKILL.md")) {
      try { parsed = sourceFrontmatter(texts["SKILL.md"]); if (parsed.meta.name !== mapping.name) throw new Error("name"); }
      catch { holds.add("UNSUPPORTED_NAME"); }
    }
    let missing = [], unchecked = [];
    if (parsed && !holds.has("BINARY_CONTENT")) {
      ({missing, unchecked} = checkPackageLinks(texts, assertSourcePackageRel, {skillBody: parsed.body}));
      if (missing.length) holds.add("MISSING_LINK");
      if (unchecked.length) holds.add("UNCHECKED_LINK");
    }
    const final = await inspectAcquisition(roots, stageRunId);
    if (digest(stage) !== digest(final)) fail("INTEGRITY");
    const body = {schemaVersion: 1, stageRunId, sourceId: stage.manifest.sourceId, repository: stage.manifest.repository, pin: stage.manifest.pin, tree: stage.manifest.tree, acquisitionFingerprint: stage.fingerprint, acquisitionAssessment: stage.assessment, mapping, files: rows, relocations,
      validation: {frontmatter: "name-only-unverified", missing, unchecked}, holds: [...holds].sort().map((code) => ({code})), disclosures: [...disclosures].sort().map((code) => ({code}))};
    return {review: {...body, packageDigest: digest(body)}, files};
  });
}
export async function reviewSourcePackage(roots, input) { return (await loadSourcePackage(roots, input)).review; }
