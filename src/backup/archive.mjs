// U24 (KTD33, R13): the encrypted backup. One archive file holds the files of configRoot, dataRoot and stateRoot, less
// the caches a rebuild or a new session makes again (EXCLUDED) and the hub clones. Links and other non-regular files
// are not archived; the manifest lists them as skipped.
//   archive   MAGIC (8 bytes) | VERSION (1) | IV (12) | AES-256-GCM ciphertext | tag (16); the first 9 bytes are the AAD
//   plaintext manifest length (4, big-endian) | manifest JSON | the bytes of each manifest file, in manifest order
//   manifest  { schemaVersion: 1, createdAt, files: [{ root, path, mode, size, sha256 }], skipped: [{ root, path, type }] }
// root is config, data or state; path is relative to that root, with "/" between segments. The key is 32 random bytes in
// the Keychain (src/backup/keychain.mjs), made on the first create. Create reads the store while it holds, in a fixed
// order, the registry lock, each scope lock, the shared knowledge locks and the backup-key lock; a held lock stops it
// with BUSY before it writes. The key is read or made under those locks, so two first creates cannot make two keys,
// and read again from the Keychain just before sealing. Retention keeps the newest archive of each UTC day for the
// newest KEEP days that have archives; a create removes only older archives of its own day and archives older than
// those days. Restore decrypts in memory, checks the tag, every path, size and hash, and only then writes, into a new
// 0700 folder inside an approved backupTargets folder. It never writes the live store.
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { approvedFolder, assertWritable, samePath } from "../config/pilot.mjs";
import { atomicReplace, fsyncDir, info, isWithin } from "../storage/fsx.mjs";
import { registryLockPath, scopeLockPath, withPilotLocks } from "../storage/lock.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { configuredScopes } from "../records/isolation.mjs";
import { KEY_BYTES } from "./keychain.mjs";

const MAGIC = Buffer.from("DTBACKUP"), VERSION = 1, HEAD = MAGIC.length + 1, IV_BYTES = 12, TAG_BYTES = 16;
export const KEEP = 14;
export const ARCHIVE_NAME = /^devtwin-backup-(\d{8}T\d{6}Z)-[0-9a-f]{8}\.dtb$/;
export const LIMITS = Object.freeze({ fileBytes: 256 << 20, totalBytes: 512 << 20, files: 100000, manifestBytes: 64 << 20 });
export const ROOTS = Object.freeze([["config", "configRoot"], ["data", "dataRoot"], ["state", "stateRoot"]]);
// stateRoot caches that are rebuilt or remade: the lesson index, session summaries, the hook's session files and budget
// log, and the locks themselves.
const EXCLUDED_DIRS = ["locks", "lessons", "summaries", "hooks/sessions"];
const EXCLUDED_FILE = /^hooks\/budget\.jsonl(?:\.\d+)?$/;
export const EXCLUDED = Object.freeze(["state/locks", "state/lessons", "state/summaries", "state/hooks/sessions", "state/hooks/budget.jsonl*", "hub clones"]);
// The shared locks a knowledge write takes, after the registry lock and the scope locks, then the lock under which a
// create reads or makes the backup key (taken last: nothing else takes it).
const SHARED_LOCKS = ["pref_proposals", "lesson_proposals", "hub-sync", "audit", "consents", "personal_records", "backup-key"];
export const exportReceiptPath = (roots) => join(roots.stateRoot, "backup", "key-export.json");
const invalid = (message, details = {}) => { throw new DevtwinError("INTEGRITY", message, details); };
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

// The locks create holds while it reads, in their fixed order.
export async function backupLocks(roots) {
  const scopes = (await configuredScopes(roots)).sort();
  return [registryLockPath(roots), ...scopes.map((scope) => scopeLockPath(roots, scope)), ...SHARED_LOCKS.map((name) => join(roots.stateRoot, "locks", name + ".lock"))];
}
// A relative archive path: segments with no ".", "..", backslash or control character.
export function safeRelative(path) {
  if (typeof path !== "string" || !path.length || path.length > 4096 || isAbsolute(path) || /[\\\p{Cc}]/u.test(path)) return false;
  return path.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}
const excluded = (roots, root, rel, abs) => (root === "state" && (EXCLUDED_DIRS.some((dir) => rel === dir || rel.startsWith(dir + "/")) || EXCLUDED_FILE.test(rel))) || (Boolean(roots.pilot?.writeClasses?.hubRoot?.length) && approvedFolder(roots.pilot, "hubRoot", abs) !== null);
// Reads one regular file without following a link; null when it is no longer a regular file.
function readFile(path) {
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (["ELOOP", "ENOENT", "ENXIO"].includes(error.code)) return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return null;
    if (before.size > LIMITS.fileBytes) throw new DevtwinError("LIMIT", "A store file is too large to back up", { limit: LIMITS.fileBytes });
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    const after = fstatSync(fd);
    if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new DevtwinError("INTEGRITY", "A store file changed during the backup");
    return { bytes, mode: before.mode & 0o7777 };
  } finally { closeSync(fd); }
}
// Every file to archive, sorted by root and path, and every entry left out because it is a link or not a file.
export function collect(roots) {
  const files = [], skipped = [];
  let total = 0;
  const walk = (root, base, rel) => {
    const dir = rel ? join(base, rel) : base;
    for (const name of readdirSync(dir).sort()) {
      const childRel = rel ? rel + "/" + name : name, abs = join(dir, name);
      if (excluded(roots, root, childRel, abs)) continue;
      if (!safeRelative(childRel)) { skipped.push({ root, path: childRel.replace(/[\p{Cc}]/gu, "?"), type: "name" }); continue; }
      let node;
      try { node = lstatSync(abs); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (node.isSymbolicLink()) { skipped.push({ root, path: childRel, type: "link" }); continue; }
      if (node.isDirectory()) { walk(root, base, childRel); continue; }
      const read = node.isFile() ? readFile(abs) : null;
      if (!read) { skipped.push({ root, path: childRel, type: "other" }); continue; }
      total += read.bytes.length;
      if (files.length >= LIMITS.files || total > LIMITS.totalBytes) throw new DevtwinError("LIMIT", "The store is too large to back up", { files: LIMITS.files, bytes: LIMITS.totalBytes });
      files.push({ root, path: childRel, mode: read.mode, size: read.bytes.length, sha256: sha(read.bytes), bytes: read.bytes });
    }
  };
  for (const [root, key] of ROOTS) {
    const base = roots[key], node = info(base);
    if (!node) continue;
    if (!node.isDirectory() || node.isSymbolicLink()) throw new DevtwinError("PATH_UNSAFE", "Store root is not a folder", { root });
    walk(root, base, "");
  }
  return { files, skipped };
}

export function seal(key, manifest, files) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new DevtwinError("INVALID_INPUT", "Backup key must be 32 bytes", { field: "keychain" });
  const json = Buffer.from(JSON.stringify(manifest)), length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  const head = Buffer.concat([MAGIC, Buffer.from([VERSION])]), iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(Buffer.concat([length, json, ...files])), cipher.final()]);
  return Buffer.concat([head, iv, body, cipher.getAuthTag()]);
}
function checkManifest(manifest, rest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== 1 || typeof manifest.createdAt !== "string" || !Array.isArray(manifest.files) || !Array.isArray(manifest.skipped) || manifest.files.length > LIMITS.files) invalid("Backup manifest is invalid");
  const seen = new Set();
  let total = 0;
  for (const entry of manifest.files) {
    if (!entry || typeof entry !== "object" || !ROOTS.some(([root]) => root === entry.root) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o7777
      || !Number.isInteger(entry.size) || entry.size < 0 || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) invalid("Backup manifest entry is invalid");
    if (!safeRelative(entry.path)) invalid("Backup manifest path is unsafe", { path: String(entry.path).slice(0, 200) });
    const key = entry.root + "/" + entry.path;
    if (seen.has(key)) invalid("Backup manifest names a file twice", { path: entry.path });
    seen.add(key);
    total += entry.size;
  }
  // A file must not also be a folder of another file.
  for (const key of seen) for (let at = key.indexOf("/", key.indexOf("/") + 1); at > 0; at = key.indexOf("/", at + 1)) if (seen.has(key.slice(0, at))) invalid("Backup manifest path is unsafe", { path: key });
  if (total !== rest) invalid("Backup sizes do not match the manifest");
}
// Decrypts and checks a whole archive in memory. Nothing is written.
export function unseal(key, archive) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new DevtwinError("INVALID_INPUT", "Backup key must be 32 bytes", { field: "keychain" });
  if (archive.length < HEAD + IV_BYTES + TAG_BYTES || !archive.subarray(0, MAGIC.length).equals(MAGIC)) invalid("Not a devtwin backup archive");
  if (archive[MAGIC.length] !== VERSION) invalid("Unknown backup archive version", { version: archive[MAGIC.length] });
  const decipher = createDecipheriv("aes-256-gcm", key, archive.subarray(HEAD, HEAD + IV_BYTES));
  decipher.setAAD(archive.subarray(0, HEAD));
  decipher.setAuthTag(archive.subarray(archive.length - TAG_BYTES));
  let plain;
  try { plain = Buffer.concat([decipher.update(archive.subarray(HEAD + IV_BYTES, archive.length - TAG_BYTES)), decipher.final()]); }
  catch { invalid("Backup archive failed authentication: it was changed, or the key is not the one that made it"); }
  if (plain.length < 4) invalid("Backup manifest is invalid");
  const length = plain.readUInt32BE(0);
  if (length > LIMITS.manifestBytes || 4 + length > plain.length) invalid("Backup manifest is invalid");
  let manifest;
  try { manifest = JSON.parse(plain.subarray(4, 4 + length).toString("utf8")); } catch { invalid("Backup manifest is invalid"); }
  checkManifest(manifest, plain.length - 4 - length);
  let offset = 4 + length;
  const files = manifest.files.map((entry) => {
    const bytes = plain.subarray(offset, offset + entry.size);
    offset += entry.size;
    if (sha(bytes) !== entry.sha256) invalid("Backup file hash does not match", { path: entry.path });
    return { ...entry, bytes };
  });
  return { manifest, files };
}

// The key, made and stored on first use. A new key must read back the same before it is used.
export async function backupKey(keychain, { create = true } = {}) {
  const existing = await keychain.read();
  if (existing) {
    if (!Buffer.isBuffer(existing) || existing.length !== KEY_BYTES) throw new DevtwinError("INTEGRITY", "Keychain backup key is not 32 bytes", { field: "keychain" });
    return { key: existing, created: false };
  }
  if (!create) throw new DevtwinError("NOT_FOUND", "No backup key in the Keychain", { field: "keychain" });
  const key = randomBytes(KEY_BYTES);
  await keychain.write(key);
  const back = await keychain.read();
  if (!Buffer.isBuffer(back) || !back.equals(key)) throw new DevtwinError("STORAGE_ERROR", "Keychain did not keep the new backup key", { field: "keychain" });
  return { key, created: true };
}
// The approved backup folder: --to must name one; without it, the first approved one.
export function backupFolder(roots, requested) {
  const approved = roots.pilot?.writeClasses?.backupTargets ?? [];
  if (!approved.length) throw new DevtwinError("GATE_REQUIRED", "No backup folder approved", { field: "writeClasses.backupTargets", remedy: "live write-classes --backup-target <folder>" });
  if (requested === undefined) return approved[0];
  if (typeof requested !== "string" || !approved.includes(requested)) throw new DevtwinError("GATE_REQUIRED", "Backup folder not approved", { field: "to" });
  return requested;
}
export function listArchives(folder) {
  let names;
  try { names = readdirSync(folder); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter((name) => ARCHIVE_NAME.test(name) && info(join(folder, name))?.isFile() === true).sort();
}
export const archiveTime = (name) => { const m = ARCHIVE_NAME.exec(name)?.[1]; return m ? m.slice(0, 4) + "-" + m.slice(4, 6) + "-" + m.slice(6, 11) + ":" + m.slice(11, 13) + ":" + m.slice(13) : null; };

// The archives retention removes after a create wrote `made`: every archive of a UTC day outside the newest KEEP days
// that have archives, and the archives of made's own day that sort before it. made itself always stays. An earlier day
// inside those days is left as it is.
export function expiredArchives(names, made) {
  const day = (name) => ARCHIVE_NAME.exec(name)[1].slice(0, 8);
  const days = [...new Set(names.map(day))].sort().reverse().slice(0, KEEP), today = day(made);
  return names.filter((name) => name !== made && (!days.includes(day(name)) || (day(name) === today && name < made)));
}
export function planBackupCreate(roots, { to } = {}) {
  const target = backupFolder(roots, to);
  assertWritable(roots, [target], { writeClass: "backupTargets" });
  return finalizePlan({ kind: "backup-create", target, roots: ROOTS.map(([root]) => root), excluded: EXCLUDED, keep: KEEP, archives: listArchives(target).length });
}
// Writes one archive into the folder and keeps the newest KEEP. Used by backup create --apply and the daily job.
export async function writeBackup(roots, { to, now = () => new Date(), keychain }) {
  const target = backupFolder(roots, to);
  assertWritable(roots, [target], { writeClass: "backupTargets" });
  const { files, skipped, key, created } = await withPilotLocks(roots, await backupLocks(roots), { kind: "backup-create" }, async () => ({ ...collect(roots), ...await backupKey(keychain) }));
  const at = now().toISOString();
  const manifest = { schemaVersion: 1, createdAt: at, files: files.map(({ bytes, ...entry }) => entry), skipped };
  // The key in the Keychain must still be the one this create holds, or the archive could not be opened later.
  const current = await keychain.read();
  if (!Buffer.isBuffer(current) || !current.equals(key)) throw new DevtwinError("CONFLICT", "The Keychain backup key changed during the backup; run backup create again", { field: "keychain" });
  const archive = seal(key, manifest, files.map((file) => file.bytes));
  const name = "devtwin-backup-" + at.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z") + "-" + randomBytes(4).toString("hex") + ".dtb", path = join(target, name);
  assertWritable(roots, [target, path], { writeClass: "backupTargets" });
  if (!info(target)) mkdirSync(target, { mode: 0o700 });
  const folder = info(target);
  if (!folder.isDirectory() || folder.isSymbolicLink() || folder.uid !== process.getuid()) throw new DevtwinError("PATH_UNSAFE", "Backup folder is not a folder you own", { field: "to" });
  await atomicReplace(path, archive);
  const removed = [];
  for (const old of expiredArchives(listArchives(target), name)) {
    assertWritable(roots, [join(target, old)], { writeClass: "backupTargets" });
    unlinkSync(join(target, old));
    removed.push(old);
  }
  if (removed.length) fsyncDir(target);
  return { created: true, archive: path, createdAt: at, files: files.length, bytes: archive.length, skipped: skipped.length, removed, keyCreated: created };
}
export async function applyBackupCreate(roots, { to, fingerprint }, { now, keychain }) {
  assertFingerprint(planBackupCreate(roots, { to }), fingerprint);
  return writeBackup(roots, { to, now, keychain });
}

function readArchive(from) {
  if (typeof from !== "string" || !isAbsolute(from) || resolve(from) !== from) throw new DevtwinError("INVALID_INPUT", "Backup archive path must be absolute", { field: "from" });
  const read = readFile(from);
  if (!read) throw new DevtwinError("NOT_FOUND", "Backup archive is not a file", { field: "from" });
  return read.bytes;
}
// The restore folder: a new path inside an approved backupTargets folder, whose parent folder exists.
function restoreTarget(roots, to) {
  if (typeof to !== "string" || !isAbsolute(to) || resolve(to) !== to) throw new DevtwinError("INVALID_INPUT", "Restore folder must be an absolute path", { field: "to" });
  const folder = approvedFolder(roots.pilot, "backupTargets", to);
  if (!folder || samePath(folder, to)) throw new DevtwinError("GATE_REQUIRED", "Restore folder must be a new folder inside an approved backup folder", { field: "to", remedy: "live write-classes --backup-target <folder>" });
  assertWritable(roots, [to], { writeClass: "backupTargets" });
  if (info(to)) throw new DevtwinError("CONFLICT", "Restore folder already exists; name a new folder", { field: "to" });
  const parent = info(dirname(to));
  if (!parent?.isDirectory() || parent.isSymbolicLink()) throw new DevtwinError("NOT_FOUND", "The folder that holds the restore folder must exist", { field: "to" });
  return to;
}
function opened(roots, { from, to }, key) {
  const target = restoreTarget(roots, to);
  const archive = readArchive(from), { manifest, files } = unseal(key, archive);
  // Each path stays inside its root folder in the target, whatever the archive says.
  for (const file of files) {
    const base = join(target, file.root), dest = resolve(base, file.path);
    if (!isWithin(dest, base) || dest === base) invalid("Backup manifest path is unsafe", { path: file.path });
  }
  return { target, archive, manifest, files };
}
const restorePlan = (from, { target, archive, manifest, files }) => finalizePlan({ kind: "backup-restore", from, archiveSha256: sha(archive), to: target, createdAt: manifest.createdAt,
  files: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0), skipped: manifest.skipped.length });
export async function planBackupRestore(roots, { from, to }, { keychain }) {
  const { key } = await backupKey(keychain, { create: false });
  return restorePlan(from, opened(roots, { from, to }, key));
}
function writeRestored(path, bytes, mode) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, mode & 0o777);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
// Restores into the new folder after every check passes, then reads each file back and checks its hash and mode.
export async function applyBackupRestore(roots, { from, to, fingerprint }, { keychain }) {
  const { key } = await backupKey(keychain, { create: false });
  const state = opened(roots, { from, to }, key);
  assertFingerprint(restorePlan(from, state), fingerprint);
  const { target, files } = state, staging = target + ".restoring-" + randomBytes(4).toString("hex");
  assertWritable(roots, [staging], { writeClass: "backupTargets" });
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const [root] of ROOTS) mkdirSync(join(staging, root), { mode: 0o700 });
    for (const file of files) {
      const dest = join(staging, file.root, file.path);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      writeRestored(dest, file.bytes, file.mode);
    }
    let verified = 0;
    for (const file of files) {
      const back = readFile(join(staging, file.root, file.path));
      if (!back || sha(back.bytes) !== file.sha256 || back.mode !== (file.mode & 0o777)) invalid("A restored file does not match the archive", { path: file.path });
      verified += 1;
    }
    if (info(target)) throw new DevtwinError("CONFLICT", "Restore folder already exists; name a new folder", { field: "to" });
    renameSync(staging, target);
    fsyncDir(dirname(target));
    return { restored: true, to: target, files: files.length, verified, layout: { config: join(target, "config"), data: join(target, "data"), state: join(target, "state") } };
  } catch (error) {
    // The staging folder is left for review; it is never the target and never the live store.
    throw Object.assign(error, { details: { ...(error.details ?? {}), staging } });
  }
}
