import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { digest } from "../storage/canonical.mjs";
import { isDeniedRel } from "../storage/source-read.mjs";
import { getSource, loadBundledCatalog, validateSourceRecipe } from "./catalog.mjs";
import { validatePriorLock } from "./github.mjs";

export const ACQUISITION_LIMITS = Object.freeze({
  files: 24, fileBytes: 131072, totalBytes: 1048576, pathBytes: 200, depth: 16,
  treeEntries: 10000, metadataBodyBytes: 2097152, blobBodyBytes: 262144,
  responseTotalBytes: 8388608, requests: 26, requestMs: 5000,
  operationMs: 30000, receiptBytes: 65536
});
export const ASSESSMENT = Object.freeze({pin: "caller-supplied-unverified", content: "selected-files-only", safety: "unreviewed", compatibility: "unverified", dependencies: "unreviewed", installation: "not-installed", redistribution: "unreviewed"});
const fail = (code, field) => { throw new DevtwinError(code, "Invalid acquisition input", {field}); };
const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));

export function validateSelection(source, pin, files) {
  source = validateSourceRecipe(source);
  const bundled = getSource(loadBundledCatalog(), source.id);
  if (digest(source) !== digest(bundled)) fail("INVALID_INPUT", "source");
  pin = validatePriorLock(pin, source.id);
  if (!Array.isArray(files) || !files.length) fail("INVALID_INPUT", "files");
  if (files.length > ACQUISITION_LIMITS.files) fail("LIMIT", "files");
  const roles = new Map();
  for (const path of files) {
    if (typeof path !== "string" || !/^[A-Za-z0-9._/-]{1,200}$/.test(path)) fail("INVALID_INPUT", "files");
    const parts = path.split("/");
    if (parts.length > ACQUISITION_LIMITS.depth || parts.some((p) => !p || p.length > 100 || p === "." || p === ".." || p.endsWith(".") || p.toLowerCase() === ".git")) fail("INVALID_INPUT", "files");
    if (isDeniedRel(path)) fail("INVALID_INPUT", "files");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/"), key = rel.toLowerCase(), role = i === parts.length ? "file" : "directory";
      const prior = roles.get(key);
      if (prior && (prior.rel !== rel || prior.role !== role || role === "file")) fail("SELECTION_CONFLICT", "files");
      roles.set(key, {rel, role});
    }
  }
  return {pin, files: [...files].sort()};
}

export function validateManifest(value) {
  if (!exact(value, ["schemaVersion", "sourceId", "repository", "pin", "tree", "selection", "files", "totalBytes"]) || value.schemaVersion !== 1) fail("INVALID_INPUT", "manifest");
  const source = getSource(loadBundledCatalog(), value.sourceId);
  if (!exact(value.repository, ["owner", "name"]) || digest(value.repository) !== digest(source.repository) || !sha(value.tree)) fail("INVALID_INPUT", "manifest");
  const selected = validateSelection(source, value.pin, value.selection);
  if (JSON.stringify(selected.files) !== JSON.stringify(value.selection) || !Array.isArray(value.files) || value.files.length !== selected.files.length) fail("INVALID_INPUT", "manifest.files");
  let totalBytes = 0;
  const files = value.files.map((file, i) => {
    if (!exact(file, ["path", "blob", "mode", "size"]) || file.path !== selected.files[i] || !sha(file.blob) || !["100644", "100755"].includes(file.mode) || !Number.isSafeInteger(file.size) || file.size < 0) fail("INVALID_INPUT", "manifest.files");
    if (file.size > ACQUISITION_LIMITS.fileBytes) fail("LIMIT", "fileBytes");
    totalBytes += file.size;
    return {...file};
  });
  if (totalBytes > ACQUISITION_LIMITS.totalBytes) fail("LIMIT", "totalBytes");
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes !== totalBytes) fail("INVALID_INPUT", "manifest.totalBytes");
  return {schemaVersion: 1, sourceId: source.id, repository: {...source.repository}, pin: selected.pin, tree: value.tree, selection: selected.files, files, totalBytes};
}
export const manifestFingerprint = (value) => digest(validateManifest(value));
export const gitBlobSha = (bytes) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
