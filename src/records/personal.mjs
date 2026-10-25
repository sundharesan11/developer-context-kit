import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rename, readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { loadScope } from "../config/store.mjs";
import { readPrivateJson, readPrivateText, writeNewFile, ensurePrivatePath, fsyncDir } from "../storage/fsx.mjs";
import { withPilotLock, scopeLockPath } from "../storage/lock.mjs";
import { canonicalJson, digest, sha256 } from "../storage/canonical.mjs";
import { REQUEST_ID } from "../storage/plan.mjs";
import { personalRecordIdFor, orgRecordIdFor, assertScopeId, RECORD_ID } from "../identity/ids.mjs";
import { buildHomeRecord, validateRecord, validateDraft, assertHomeReach, recordHash, HOME_KINDS } from "./schema.mjs";
import { assertSupersedesShape, resolveSupersession } from "./store.mjs";
import { isolationTerms, assertOutboundClean } from "./isolation.mjs";
// KTD21: personal and org records have their own homes, with no registry or project binding.
// Personal: dataRoot/personal/records/<id>. Org: dataRoot/scopes/<scope>/org/records/<id>. Both use the project store's bundle checks.
function homeFor(roots, reach, scope) {
  if (reach === "org") {
    assertScopeId(scope);
    return { reach, scope, segments: ["scopes", scope, "org"], idFor: (requestId) => orgRecordIdFor({ scope, requestId }), lock: scopeLockPath(roots, scope) };
  }
  // An underscore keeps this lock name apart from every scope lock name.
  return { reach, scope: null, segments: ["personal"], idFor: (requestId) => personalRecordIdFor({ requestId }), lock: join(roots.stateRoot, "locks", "personal_records.lock") };
}
const baseDir = (roots, home) => join(roots.dataRoot, ...home.segments);
const recDir = (roots, home, id) => join(baseDir(roots, home), "records", id);
const mismatch = () => new DevtwinError("INTEGRITY", "Bundle mismatch");
async function readHomeBundle(roots, home, id) {
  try {
    if (!RECORD_ID.test(id)) throw mismatch();
    const dir = recDir(roots, home, id);
    const record = validateRecord(await readPrivateJson(join(dir, "record.json")));
    const body = await readPrivateText(join(dir, "body.md"), 32768);
    if (record.schemaVersion !== 2 || record.id !== id || home.idFor(record.requestId) !== id || record.reach !== home.reach || !HOME_KINDS[home.reach].includes(record.kind) || record.scope !== home.scope || record.project !== null || record.operationId !== null || sha256(body) !== record.bodyHash || Buffer.byteLength(body) !== record.bodyBytes) throw mismatch();
    assertSupersedesShape(record);
    return { record, body };
  } catch (error) { if (error.code === "ENOENT") throw new DevtwinError("INTEGRITY", "Bundle missing"); throw error; }
}
async function readHomeSnapshot(roots, home) {
  let ids;
  try { ids = (await readdir(join(baseDir(roots, home), "records"))).sort(); } catch (error) { if (error.code === "ENOENT") ids = []; else throw error; }
  const candidates = [], corrupt = [];
  for (const id of ids) {
    try {
      const { record, body } = await readHomeBundle(roots, home, id);
      candidates.push({ ...record, body, recordHash: recordHash(record), effective: record.status, supersededBy: [] });
    } catch { corrupt.push({ id, code: "DEVTWIN_INTEGRITY" }); }
  }
  return resolveSupersession(candidates, corrupt);
}
// Checks that run before any lock or write: input shape, draft, home reach, the sensitive check and the all-scope isolation check.
async function checkInput(roots, home, input, keys, supersedes = []) {
  if (!input || Object.keys(input).some((key) => !keys.includes(key))) throw new DevtwinError("INVALID_INPUT", "Unexpected record field");
  if (!REQUEST_ID.test(input.requestId ?? "")) throw new DevtwinError("INVALID_ID", "Invalid request ID");
  validateDraft(input.draft, { recordedBy: input.recordedBy, supersedes });
  assertHomeReach(home.reach, input.draft);
  assertOutboundClean(input.draft.title + "\n" + input.draft.body, await isolationTerms(roots), { except: home.scope ?? undefined });
}
async function commitHome(roots, home, { requestId, recordedBy, draft }, { now = () => new Date(), supersedes = [] } = {}) {
  const id = home.idFor(requestId), base = baseDir(roots, home);
  const stage = join(base, "staging", id), dest = recDir(roots, home, id);
  assertWritable(roots, [stage, dest]);
  const requestHash = digest({ reach: home.reach, scope: home.scope, requestId, recordedBy, draft, supersedes });
  if (existsSync(dest)) {
    const { record } = await readHomeBundle(roots, home, id);
    if (record.requestHash !== requestHash) throw new DevtwinError("CONFLICT", "Request ID reused");
    return { recordId: id, recordHash: recordHash(record), created: false };
  }
  if (existsSync(stage)) throw new DevtwinError("RECOVERY_REQUIRED", "Orphan staging retained", { staging: [id] });
  const record = buildHomeRecord({ reach: home.reach, scope: home.scope, requestId, requestHash, recordedBy, draft, supersedes }, { now });
  ensurePrivatePath(roots.dataRoot, [...home.segments, "staging"]);
  ensurePrivatePath(roots.dataRoot, [...home.segments, "records"]);
  await mkdir(stage, { mode: 0o700 });
  await writeNewFile(join(stage, "body.md"), draft.body);
  await writeNewFile(join(stage, "record.json"), canonicalJson(record) + "\n");
  fsyncDir(stage);
  assertWritable(roots, [stage, dest]);
  await rename(stage, dest);
  fsyncDir(join(base, "records"));
  return { recordId: id, recordHash: recordHash(record), created: true, bodyHash: record.bodyHash };
}
async function addHome(roots, home, input, keys, options) {
  await checkInput(roots, home, input, keys);
  const path = recDir(roots, home, home.idFor(input.requestId));
  return withPilotLock(roots, home.lock, { kind: home.reach + "-record-add" }, () => commitHome(roots, home, input, options), { destinations: [path] });
}
// Supersession names each target with its expected record hash, as in the project store.
async function supersedeHome(roots, home, input, keys, options) {
  const targets = input?.targets;
  if (!Array.isArray(targets) || targets.length === 0 || targets.length !== input.expectHashes?.length || new Set(targets).size !== targets.length) throw new DevtwinError("INVALID_INPUT", "Targets and hashes required");
  await checkInput(roots, home, input, [...keys, "targets", "expectHashes"], targets);
  const path = recDir(roots, home, home.idFor(input.requestId));
  return withPilotLock(roots, home.lock, { kind: home.reach + "-record-supersede" }, async () => {
    const snap = await readHomeSnapshot(roots, home);
    for (let i = 0; i < targets.length; i++) {
      const target = snap.records.find((r) => r.id === targets[i]);
      if (!target || target.effective === "superseded" || target.recordHash !== input.expectHashes[i]) throw new DevtwinError("STALE_VERSION", "Target changed");
    }
    return commitHome(roots, home, input, { ...options, supersedes: targets });
  }, { destinations: [path] });
}
const PERSONAL_KEYS = ["requestId", "recordedBy", "draft"], ORG_KEYS = ["scope", ...PERSONAL_KEYS];
export const readPersonalSnapshot = (roots) => readHomeSnapshot(roots, homeFor(roots, "personal"));
export const addPersonalRecord = (roots, input, options = {}) => addHome(roots, homeFor(roots, "personal"), input, PERSONAL_KEYS, options);
export const supersedePersonalRecord = (roots, input, options = {}) => supersedeHome(roots, homeFor(roots, "personal"), input, PERSONAL_KEYS, options);
export async function readOrgSnapshot(roots, scope) { await loadScope(roots, scope); return readHomeSnapshot(roots, homeFor(roots, "org", scope)); }
export async function addOrgRecord(roots, input, options = {}) { await loadScope(roots, input?.scope); return addHome(roots, homeFor(roots, "org", input.scope), input, ORG_KEYS, options); }
export async function supersedeOrgRecord(roots, input, options = {}) { await loadScope(roots, input?.scope); return supersedeHome(roots, homeFor(roots, "org", input.scope), input, ORG_KEYS, options); }
