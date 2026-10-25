import { lstatSync, mkdirSync, readdirSync, linkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { isWithin, checkNode, writeNewFile, readPrivateBytes, fsyncDir } from "../storage/fsx.mjs";
import { digest } from "../storage/canonical.mjs";
import { ACQUISITION_LIMITS as L, ASSESSMENT, validateManifest, validateSelection, manifestFingerprint, gitBlobSha } from "./selection.mjs";
import { downloadAcquisition } from "./github-package.mjs";

const RUN = /^stage_[0-9a-f]{32}$/;
const fail = (code, field = "stage") => { throw new DevtwinError(code, "Skill source staging refused", {field}); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
function sanitized(error, operation) {
  if (error instanceof DevtwinError && error.code === "DEVTWIN_RATE_LIMITED") {
    const details = {};
    if (Number.isInteger(error.details.retryAfterSeconds) && error.details.retryAfterSeconds >= 0 && error.details.retryAfterSeconds <= 86400) details.retryAfterSeconds = error.details.retryAfterSeconds;
    if (typeof error.details.resetAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(error.details.resetAt) && Number.isFinite(Date.parse(error.details.resetAt))) details.resetAt = error.details.resetAt;
    return new DevtwinError("RATE_LIMITED", "GitHub rate limit reached", details);
  }
  if (error instanceof DevtwinError) return new DevtwinError(error.code, "Skill source staging refused", {field: ["pilotDigest", "pilot", "destination"].includes(error.details.field) ? error.details.field : "stage"});
  return new DevtwinError("STORAGE_ERROR", "Skill source storage operation failed", {operation});
}
function io(operation, fn) {
  try { const result = fn(); return result?.then ? result.catch((e) => { throw sanitized(e, operation); }) : result; }
  catch (e) { throw sanitized(e, operation); }
}
function node(path) {
  return io("inspect", () => { try { return lstatSync(path); } catch (e) { if (e.code === "ENOENT") return null; throw e; } });
}
function directory(st, strict = false) {
  if (!st || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (strict ? (st.mode & 0o7777) !== 0o700 : (st.mode & 0o022))) fail("PATH_UNSAFE");
}
function boundary(roots) {
  const pins = new Map();
  function pin(path, st, strict) {
    directory(st, strict);
    const previous = pins.get(path);
    if (previous && !same(previous.st, st)) fail("PATH_UNSAFE");
    pins.set(path, {st, strict});
  }
  function check(destination = roots?.dataRoot) {
    io("inspect", () => assertWritable(roots, [destination]));
    if (!isWithin(destination, roots.dataRoot)) fail("GATE_REQUIRED", "destination");
    const anchor = roots.pilot.pilotRoot;
    const above = []; let at = dirname(anchor);
    while (true) { above.push(at); if (dirname(at) === at) break; at = dirname(at); }
    for (const path of above) {
      const st = node(path);
      if (!st || !st.isDirectory() || st.isSymbolicLink() || ![0, process.getuid()].includes(st.uid) || ((st.mode & 0o022) && !(st.mode & 0o1000))) fail("PATH_UNSAFE");
    }
    pin(anchor, node(anchor), false);
    const parts = relative(anchor, roots.dataRoot).split(sep);
    at = anchor;
    for (const part of parts.slice(0, -1)) { at = join(at, part); pin(at, node(at), false); }
    const data = node(roots.dataRoot);
    if (data) pin(roots.dataRoot, data, true);
    for (const [path, prior] of pins) {
      const current = node(path); directory(current, prior.strict);
      if (!same(prior.st, current)) fail("PATH_UNSAFE");
    }
  }
  function existing(path) { check(path); const st = node(path); pin(path, st, true); return st; }
  function create(path, exclusive = false) {
    check(path);
    let st = node(path);
    if (st && exclusive) fail("CONFLICT");
    if (!st) {
      io("mkdir", () => {
        try { mkdirSync(path, {mode: 0o700}); }
        catch (e) { if (e.code === "EEXIST") { if (exclusive) fail("CONFLICT"); } else throw e; }
      });
      st = node(path);
    }
    pin(path, st, true);
  }
  check();
  return {check, existing, create, pins};
}
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const checksum = (bytes) => "sha256:" + createHash("sha256").update(bytes).digest("hex");
function result(receipt) {
  return {status: "staged", runId: receipt.runId, fingerprint: receipt.fingerprint, manifest: receipt.manifest, files: receipt.files, assessment: {...ASSESSMENT}};
}

export async function stageAcquisition(roots, source, input, {request = fetch, now = () => new Date(), runIdBytes = () => randomBytes(16), faults = {}} = {}) {
  let published = false, runId;
  try {
    validateSelection(source, input.pin, input.files);
    const id = runIdBytes();
    if (!Buffer.isBuffer(id) || id.length !== 16) fail("INVALID_INPUT");
    runId = "stage_" + id.toString("hex");
    const fence = boundary(roots);
    const acquired = await downloadAcquisition(source, input, {request});
    fence.check();
    const staging = join(roots.dataRoot, "skill-sources", "staging"), run = join(staging, runId), filesRoot = join(run, "files");
    for (const path of [roots.dataRoot, join(roots.dataRoot, "skill-sources"), staging]) fence.create(path);
    fence.create(run, true);
    await faults.afterRunCreated?.();
    fence.create(filesRoot, true);
    const directories = new Set([filesRoot]);
    const files = [];
    for (let index = 0; index < acquired.blobs.length; index++) {
      const blob = acquired.blobs[index], metadata = acquired.preview.manifest.files[index];
      let parent = filesRoot;
      for (const part of blob.path.split("/").slice(0, -1)) {
        parent = join(parent, part);
        if (!directories.has(parent)) { fence.create(parent, true); directories.add(parent); }
      }
      const path = join(filesRoot, blob.path);
      fence.check(path);
      await io("write", () => writeNewFile(path, blob.bytes));
      await faults.afterFileWritten?.({index});
      fence.check(path);
      const written = await io("read", () => readPrivateBytes(path, L.fileBytes));
      if (gitBlobSha(written) !== metadata.blob || checksum(written) !== blob.sha256) fail("INTEGRITY");
      files.push({...metadata, sha256: blob.sha256});
    }
    for (const path of [...directories].sort((a, b) => b.length - a.length)) { fence.check(path); io("fsync", () => fsyncDir(path)); }
    const createdAt = now().toISOString();
    const body = {schemaVersion: 1, kind: "skill-source-stage", runId, createdAt, pilotDigest: roots.pilot.digest, manifest: acquired.preview.manifest, fingerprint: acquired.preview.fingerprint, files, assessment: {...ASSESSMENT}};
    const receipt = {...body, receiptHash: digest(body)};
    const content = Buffer.from(JSON.stringify(receipt) + "\n");
    if (content.length > L.receiptBytes) fail("LIMIT");
    await faults.beforeReceipt?.();
    const pending = join(run, ".receipt-pending"), final = join(run, "receipt.json");
    fence.check(pending);
    await io("write", () => writeNewFile(pending, content));
    const pendingIdentity = node(pending);
    io("inspect", () => checkNode(pendingIdentity, pending));
    fence.check(final);
    io("link", () => { try { linkSync(pending, final); } catch (e) { if (e.code === "EEXIST") fail("CONFLICT"); throw e; } });
    published = true;
    await faults.afterReceiptLinked?.();
    fence.check(run); io("fsync", () => fsyncDir(run));
    fence.check(pending);
    const current = node(pending), finalIdentity = node(final);
    if (!current || !same(current, pendingIdentity) || !finalIdentity || !same(current, finalIdentity) || current.nlink !== 2) fail("PATH_UNSAFE");
    // Node has no inode-conditional unlink; same-user replacement remains a residual race.
    io("unlink-pending", () => unlinkSync(pending));
    await faults.afterReceipt?.();
    fence.check(run); io("fsync", () => fsyncDir(run));
    fence.check(staging); io("fsync", () => fsyncDir(staging));
    const inspected = await inspectAcquisition(roots, runId);
    fence.check(run);
    return inspected;
  } catch (error) {
    if (published) throw new DevtwinError("STAGE_UNCONFIRMED", "Stage publication needs inspection", {runId, next: "inspect"});
    throw sanitized(error, "write");
  }
}

export async function inspectAcquisition(roots, runId) {
  try {
    if (typeof runId !== "string" || !RUN.test(runId)) fail("INVALID_INPUT");
    const fence = boundary(roots);
    const staging = join(roots.dataRoot, "skill-sources", "staging"), run = join(staging, runId);
    for (const path of [roots.dataRoot, join(roots.dataRoot, "skill-sources"), staging, run]) {
      if (!node(path)) fail("STAGE_NOT_FOUND");
      fence.existing(path);
    }
    const entries = new Map(); let count = 0;
    function walk(path, rel = "", depth = 0) {
      if (depth > L.depth + 1) fail("INTEGRITY");
      fence.check(path);
      for (const name of io("inspect", () => readdirSync(path))) {
        if (++count > L.files * L.depth + 3) fail("INTEGRITY");
        const child = join(path, name), childRel = rel ? rel + "/" + name : name, st = node(child);
        if (!st || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o7777) !== (st.isDirectory() ? 0o700 : 0o600)) fail("PATH_UNSAFE");
        entries.set(childRel, st);
        if (st.isDirectory()) { fence.existing(child); walk(child, childRel, depth + 1); }
        else if (!st.isFile() || (st.nlink !== 1 && !["receipt.json", ".receipt-pending"].includes(childRel))) fail("PATH_UNSAFE");
      }
    }
    walk(run);
    const final = entries.get("receipt.json"), pending = entries.get(".receipt-pending");
    if (final && !final.isFile() || pending && !pending.isFile()) fail("PATH_UNSAFE");
    if (!final) {
      if (pending && pending.nlink !== 1) fail("PATH_UNSAFE");
      fail("STAGE_INCOMPLETE");
    }
    if (final.nlink === 2 && pending && same(final, pending) && pending.nlink === 2) fail("STAGE_INCOMPLETE");
    if (final.nlink !== 1 || (pending && pending.nlink !== 1)) fail("PATH_UNSAFE");
    if (pending) fail("INTEGRITY");
    if (final.size > L.receiptBytes) fail("INTEGRITY");
    const receiptBytes = await io("read", () => readPrivateBytes(join(run, "receipt.json"), L.receiptBytes));
    let receipt;
    try { receipt = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(receiptBytes)); } catch { fail("INTEGRITY"); }
    if (!exact(receipt, ["schemaVersion", "kind", "runId", "createdAt", "pilotDigest", "manifest", "fingerprint", "files", "assessment", "receiptHash"]) || receipt.schemaVersion !== 1 || receipt.kind !== "skill-source-stage" || receipt.runId !== runId || typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt)) || new Date(receipt.createdAt).toISOString() !== receipt.createdAt || digest(receipt.assessment) !== digest(ASSESSMENT)) fail("INTEGRITY");
    const {receiptHash, ...body} = receipt;
    if (receiptHash !== digest(body)) fail("INTEGRITY");
    if (receipt.pilotDigest !== roots.pilot.digest) fail("GATE_REQUIRED", "pilotDigest");
    let manifest;
    try { manifest = validateManifest(receipt.manifest); } catch { fail("INTEGRITY"); }
    if (manifestFingerprint(manifest) !== receipt.fingerprint || !Array.isArray(receipt.files) || receipt.files.length !== manifest.files.length) fail("INTEGRITY");
    const expected = new Set(["files", "receipt.json"]);
    for (let i = 0; i < manifest.files.length; i++) {
      const metadata = manifest.files[i], file = receipt.files[i];
      if (!exact(file, ["path", "blob", "mode", "size", "sha256"]) || !/^sha256:[0-9a-f]{64}$/.test(file.sha256) || Object.keys(metadata).some((key) => file[key] !== metadata[key])) fail("INTEGRITY");
      const parts = file.path.split("/");
      for (let j = 1; j <= parts.length; j++) {
        const rel = "files/" + parts.slice(0, j).join("/"); expected.add(rel);
        const st = entries.get(rel);
        if (!st || (j === parts.length ? !st.isFile() : !st.isDirectory())) fail("INTEGRITY");
      }
      const path = join(run, "files", file.path);
      fence.check(path);
      const bytes = await io("read", () => readPrivateBytes(path, L.fileBytes));
      if (bytes.length !== file.size || gitBlobSha(bytes) !== file.blob || checksum(bytes) !== file.sha256) fail("INTEGRITY");
      if (!same(entries.get("files/" + file.path), node(path))) fail("INTEGRITY");
    }
    if (!entries.get("files")?.isDirectory() || entries.size !== expected.size || [...entries.keys()].some((rel) => !expected.has(rel))) fail("INTEGRITY");
    fence.check(run);
    if (!same(final, node(join(run, "receipt.json"))) || !(await io("read", () => readPrivateBytes(join(run, "receipt.json"), L.receiptBytes))).equals(receiptBytes)) fail("INTEGRITY");
    return result(receipt);
  } catch (error) { throw sanitized(error, "inspect"); }
}
