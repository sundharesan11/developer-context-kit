import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { ACQUISITION_LIMITS as L, ASSESSMENT, validateSelection, validateManifest, manifestFingerprint, gitBlobSha } from "./selection.mjs";

const fail = (code, message, details = {}) => { throw new DevtwinError(code, message, details); };
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const asciiFold = (v) => v.replace(/[A-Z]/g, (c) => c.toLowerCase());
function httpError(status, headers) {
  if (status >= 300 && status < 400) fail("REDIRECT_REFUSED", "GitHub redirect refused");
  if (status === 404) fail("SOURCE_NOT_FOUND", "Pinned GitHub object not found");
  if (status === 401) fail("GITHUB_UNAUTHORIZED", "GitHub denied the request");
  const details = {};
  const after = headers.get("retry-after"), reset = headers.get("x-ratelimit-reset");
  if (after !== null && /^\d{1,5}$/.test(after) && Number(after) <= 86400) details.retryAfterSeconds = Number(after);
  if (reset !== null && /^\d{1,12}$/.test(reset) && Number(reset) <= 253402300799) details.resetAt = new Date(Number(reset) * 1000).toISOString();
  if (status === 429 || (status === 403 && (headers.get("x-ratelimit-remaining") === "0" || Object.hasOwn(details, "retryAfterSeconds")))) fail("RATE_LIMITED", "GitHub rate limit reached", details);
  if (status === 403) fail("GITHUB_FORBIDDEN", "GitHub forbade the request");
  if (status >= 500) fail("UPSTREAM_UNAVAILABLE", "GitHub unavailable");
  fail("UPSTREAM_HTTP", "GitHub HTTP failure", {status});
}

function client(source, request) {
  const stem = `https://api.github.com/repos/${encodeURIComponent(source.repository.owner)}/${encodeURIComponent(source.repository.name)}/git`;
  const started = performance.now();
  let calls = 0, transferred = 0;
  return async (path, blob = false) => {
    if (++calls > L.requests) fail("LIMIT", "Request limit exceeded");
    const remaining = Math.min(L.requestMs, L.operationMs - (performance.now() - started));
    if (remaining <= 0) fail("NETWORK_TIMEOUT", "GitHub operation deadline exceeded");
    const controller = new AbortController();
    let timeoutReject;
    const timeout = new Promise((_, reject) => { timeoutReject = reject; });
    const timer = setTimeout(() => { controller.abort(); timeoutReject(new DevtwinError("NETWORK_TIMEOUT", "GitHub request deadline exceeded")); }, remaining);
    let response, reader;
    try {
      try {
        response = await Promise.race([request(stem + path, {headers: {Accept: "application/vnd.github+json", "User-Agent": "devtwin-skill-sources"}, signal: controller.signal, redirect: "manual"}), timeout]);
      } catch (e) {
        if (e instanceof DevtwinError) throw e;
        fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "NETWORK_UNAVAILABLE", "GitHub request failed");
      }
      if (!response || !Number.isInteger(response.status) || typeof response.headers?.get !== "function") fail("UPSTREAM_INVALID", "Invalid GitHub response");
      if (response.status < 200 || response.status >= 300) httpError(response.status, response.headers);
      if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") fail("UPSTREAM_INVALID", "Invalid GitHub media type");
      const limit = blob ? L.blobBodyBytes : L.metadataBodyBytes;
      const declared = response.headers.get("content-length");
      if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) fail("UPSTREAM_INVALID", "Invalid GitHub body length");
      if (declared !== null && Number(declared) > limit) fail("LIMIT", "GitHub body limit exceeded");
      if (typeof response.body?.getReader !== "function") fail("UPSTREAM_INVALID", "Missing GitHub body");
      reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (true) {
        let chunk;
        try { chunk = await Promise.race([reader.read(), timeout]); }
        catch (e) { if (e instanceof DevtwinError) throw e; fail(controller.signal.aborted ? "NETWORK_TIMEOUT" : "UPSTREAM_INVALID", "GitHub body read failed"); }
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) fail("UPSTREAM_INVALID", "Invalid GitHub body chunk");
        size += chunk.value.byteLength; transferred += chunk.value.byteLength;
        if (size > limit || transferred > L.responseTotalBytes) fail("LIMIT", "GitHub body limit exceeded");
        chunks.push(chunk.value);
      }
      if ((response.headers.get("content-encoding") ?? "identity").toLowerCase() === "identity" && declared !== null && size !== Number(declared)) fail("UPSTREAM_INVALID", "Truncated GitHub response");
      try { return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, size))); }
      catch { fail("UPSTREAM_INVALID", "Invalid GitHub JSON"); }
    } finally {
      clearTimeout(timer);
      // Cancellation must not extend the operation deadline on an uncooperative stream.
      try { const canceled = reader ? reader.cancel() : response?.body?.cancel(); canceled?.catch(() => undefined); } catch { /* no live body */ }
    }
  };
}

async function preview(source, selected, get) {
  const commit = await get(`/commits/${selected.pin.commit}`);
  if (!object(commit) || commit.sha !== selected.pin.commit || !sha(commit.tree?.sha)) fail("UPSTREAM_INVALID", "Invalid pinned commit");
  const tree = await get(`/trees/${commit.tree.sha}?recursive=1`);
  if (!object(tree) || tree.sha !== commit.tree.sha || tree.truncated !== false || !Array.isArray(tree.tree)) fail("UPSTREAM_INVALID", "Invalid or truncated GitHub tree");
  if (tree.tree.length > L.treeEntries) fail("LIMIT", "GitHub tree entry limit exceeded");
  const needed = new Map();
  for (const path of selected.files) {
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) needed.set(parts.slice(0, i).join("/"), i === parts.length ? "blob" : "tree");
  }
  const folded = new Map([...needed.keys()].map((p) => [asciiFold(p), p]));
  const found = new Map();
  const known = {"040000": "tree", "100644": "blob", "100755": "blob", "100664": "blob", "120000": "blob", "160000": "commit"};
  for (const entry of tree.tree) {
    if (!object(entry) || typeof entry.path !== "string" || entry.path.length < 1 || entry.path.length > 4096 || entry.path.includes("\0") || entry.path.split("/").some((p) => !p || p === "." || p === "..") || !sha(entry.sha) || typeof entry.mode !== "string" || !entry.mode || typeof entry.type !== "string" || !entry.type || (Object.hasOwn(known, entry.mode) && known[entry.mode] !== entry.type) || (entry.type === "blob" && (!Number.isSafeInteger(entry.size) || entry.size < 0))) fail("UPSTREAM_INVALID", "Invalid GitHub tree entry");
    const key = asciiFold(entry.path), neededPath = folded.get(key);
    if (selected.files.some((p) => key.startsWith(asciiFold(p) + "/"))) fail("SELECTION_CONFLICT", "Tree file/directory collision");
    if (neededPath !== undefined) {
      if (neededPath !== entry.path || found.has(entry.path)) fail("SELECTION_CONFLICT", "Ambiguous GitHub path");
      found.set(entry.path, entry);
    }
  }
  for (const [path, type] of needed) {
    const entry = found.get(path);
    if (!entry) fail("SELECTION_MISSING", "Selected GitHub path missing");
    if (entry.type !== type || !(type === "tree" ? entry.mode === "040000" : ["100644", "100755"].includes(entry.mode))) fail("UNSUPPORTED_ENTRY", "Selected GitHub entry unsupported");
  }
  const files = selected.files.map((path) => { const e = found.get(path); return {path, blob: e.sha, mode: e.mode, size: e.size}; });
  const manifest = validateManifest({schemaVersion: 1, sourceId: source.id, repository: {...source.repository}, pin: selected.pin, tree: tree.sha, selection: selected.files, files, totalBytes: files.reduce((n, f) => n + f.size, 0)});
  return {status: "previewed", manifest, fingerprint: manifestFingerprint(manifest), assessment: {...ASSESSMENT}};
}
export async function previewAcquisition(source, {pin, files}, {request = fetch} = {}) {
  const selected = validateSelection(source, pin, files);
  return preview(source, selected, client(source, request));
}
export async function downloadAcquisition(source, {pin, files, fingerprint}, {request = fetch} = {}) {
  const selected = validateSelection(source, pin, files);
  if (typeof fingerprint !== "string" || !/^sha256:[0-9a-f]{64}$/.test(fingerprint)) fail("INVALID_INPUT", "Invalid preview fingerprint");
  const get = client(source, request);
  const observed = await preview(source, selected, get);
  if (fingerprint !== observed.fingerprint) fail("PREVIEW_CHANGED", "Acquisition preview changed");
  const blobs = [];
  for (const expected of observed.manifest.files) {
    const value = await get(`/blobs/${expected.blob}`, true);
    if (!object(value) || value.sha !== expected.blob || value.size !== expected.size || value.encoding !== "base64" || typeof value.content !== "string") fail("UPSTREAM_INVALID", "Invalid GitHub blob");
    const compact = value.content.replace(/[\r\n]/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) fail("UPSTREAM_INVALID", "Invalid GitHub blob encoding");
    const bytes = Buffer.from(compact, "base64");
    if (bytes.toString("base64") !== compact || bytes.length !== expected.size) fail("UPSTREAM_INVALID", "Invalid GitHub blob size or encoding");
    if (gitBlobSha(bytes) !== expected.blob) fail("INTEGRITY", "Git blob hash mismatch");
    blobs.push({path: expected.path, bytes, sha256: "sha256:" + createHash("sha256").update(bytes).digest("hex")});
  }
  return {preview: observed, blobs};
}
