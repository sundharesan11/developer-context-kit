// U15 (R23, KTD9, KTD12): preferences from corrections. After the developer corrects it, an agent writes a pending
// preference with `pref propose`. It stays on this machine, at dataRoot/pref-proposals/<pref_id>.json, until the owner
// accepts or declines it. Accept is an owner action with the owner dialog; it writes a preference record to the
// personal store, which reaches every organization's sessions through the managed instruction block (U16). A declined
// preference is remembered, and the same text is never proposed again. Preferences never enter a hub or a handoff.
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { readPrivateJson, writeNewFile, atomicReplace, ensurePrivatePath, fsyncDir, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { validateDraft } from "../records/schema.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { addPersonalRecord, readPersonalSnapshot } from "../records/personal.mjs";
import { requireOwnerApproval } from "../owner/dialog.mjs";
import { SESSION_ID } from "../lessons/propose.mjs";
import { plainRuleProblem } from "../audit/checks.mjs";

export const PREFS_PER_SESSION = 3;
export const PREF_ID = /^pref_[a-f0-9]{24}$/;
const TITLE_CHARS = 80, TEXT_CHARS = 300, PROPOSAL_BYTES = 16384, MAX_PROPOSALS = 1000;
const TOPIC = /^[a-z0-9][a-z0-9-]{0,47}$/;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// Preference text goes into agent instruction files. It must read as one plain rule: no Markdown structure, no
// devtwin markers, no Claude Code import line (@path) and no text that tries to override other instructions. U37: the
// checks live in src/audit/checks.mjs, shared with automatic lesson and record text.
const dir = (roots) => join(roots.dataRoot, "pref-proposals");
const pathOf = (roots, id) => join(dir(roots), id + ".json");
const lockPath = (roots) => join(roots.stateRoot, "locks", "pref_proposals.lock");
const invalid = (field, extra = {}) => { throw new DevtwinError("INVALID_INPUT", "Invalid preference", { field, ...extra }); };
// The key of a preference is its text without case or spacing differences, so a declined rule stays declined.
export const prefKey = (text) => digest({ text: text.toLowerCase().replace(/\s+/g, " ").trim() });
const requestIdFor = (value) => "req_prf" + digest(value).slice(7, 31);

export function checkInjection(text) {
  const reason = plainRuleProblem(text);
  if (reason) throw new DevtwinError("INVALID_INPUT", "Preference text is not one plain rule", { field: "text", reason });
}
// Shape, injection, draft and isolation checks. A preference reaches every organization, so it is checked against the
// names of every scope.
export async function checkPreference(roots, { title, text, topic = null }) {
  if (typeof title !== "string" || !title.trim() || [...title].length > TITLE_CHARS || UNSAFE.test(title)) invalid("title");
  if (typeof text !== "string" || !text.trim() || [...text].length > TEXT_CHARS || UNSAFE.test(text)) invalid("text");
  if (topic !== null && (typeof topic !== "string" || !TOPIC.test(topic))) invalid("topic");
  const clean = { title: title.trim(), text: text.trim(), topic };
  checkInjection(clean.title + "\n" + clean.text);
  validateDraft(prefDraft(clean), { recordedBy: { actor: "other" } });
  assertOutboundClean(clean.title + "\n" + clean.text, await isolationTerms(roots));
  return clean;
}
const prefDraft = (pref, status = "proposed") => ({ kind: "preference", class: "lesson", reach: "personal", status, title: pref.title, body: pref.text + "\n", match: { paths: [], packages: [], topics: pref.topic ? [pref.topic] : [] } });

async function readAll(roots) {
  let names;
  try { names = await readdir(dir(roots)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json") && PREF_ID.test(n.slice(0, -5))).sort()) out.push(await readProposal(roots, name.slice(0, -5)));
  return out;
}
async function readProposal(roots, id) {
  if (!PREF_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid preference ID");
  let value;
  try { value = await readPrivateJson(pathOf(roots, id), PROPOSAL_BYTES); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("NOT_FOUND", "No preference proposal with this ID", { id }); throw error; }
  if (value?.schemaVersion !== 1 || value.proposalId !== id || !["pending", "declined", "accepted"].includes(value.state)) throw new DevtwinError("INTEGRITY", "Preference proposal invalid", { id });
  return value;
}
const hashOf = (proposal) => digest(proposal);
async function requirePending(roots, id) {
  const proposal = await readProposal(roots, id);
  if (proposal.state !== "pending") throw new DevtwinError("CONFLICT", "Preference proposal is not pending", { id, state: proposal.state });
  return proposal;
}
const withLock = (roots, kind, action) => withPilotLock(roots, lockPath(roots), { kind }, action, { destinations: [dir(roots)] });
async function replace(roots, expectHash, next) {
  if (hashOf(await readProposal(roots, next.proposalId)) !== expectHash) throw new DevtwinError("STALE_VERSION", "Preference proposal changed", { id: next.proposalId });
  const path = pathOf(roots, next.proposalId);
  assertWritable(roots, [path]);
  await atomicReplace(path, canonicalJson(next) + "\n");
}

// pref propose. Without apply it runs every check and writes nothing. One session has at most three proposals and
// at most one per topic. A declined or accepted preference with the same key is refused.
export async function proposePreference(roots, { session, title, text, topic = null }, { now = () => new Date(), apply = false } = {}) {
  if (typeof session !== "string" || !SESSION_ID.test(session)) invalid("session");
  const pref = await checkPreference(roots, { title, text, topic });
  const key = prefKey(pref.text), proposalId = "pref_" + digest({ session, key }).slice(7, 31), path = pathOf(roots, proposalId);
  const check = (all) => {
    // A pending, declined or accepted proposal with the same text, from any session, is the developer's answer already.
    const earlier = all.find((p) => p.key === key && p.proposalId !== proposalId);
    if (earlier) throw new DevtwinError("CONFLICT", earlier.state === "declined" ? "The developer declined this preference" : earlier.state === "accepted" ? "This preference is already saved" : "This preference is already waiting for review", { reason: earlier.state, id: earlier.proposalId });
    const mine = all.filter((p) => p.session === session && p.proposalId !== proposalId);
    if (mine.length >= PREFS_PER_SESSION) throw new DevtwinError("LIMIT", "At most three preference proposals per session", { max: PREFS_PER_SESSION, session });
    if (topic !== null && mine.some((p) => p.preference.topic === topic)) throw new DevtwinError("LIMIT", "One preference proposal per topic per session", { topic, session });
  };
  const existing = info(path) !== null;
  if (!existing) check(await readAll(roots));
  if (!apply) return { preview: true, proposalId, session, preference: pref, existing };
  assertWritable(roots, [path]);
  return withLock(roots, "pref-propose", async () => {
    if (info(path)) return { proposalId, created: false, state: (await readProposal(roots, proposalId)).state };
    const all = await readAll(roots);
    check(all);
    if (all.length >= MAX_PROPOSALS) throw new DevtwinError("LIMIT", "Too many preference proposals", { max: MAX_PROPOSALS });
    const at = now().toISOString();
    ensurePrivatePath(roots.dataRoot, ["pref-proposals"]);
    await writeNewFile(path, canonicalJson({ schemaVersion: 1, proposalId, session, key, preference: pref, state: "pending", createdAt: at, updatedAt: at, outcome: null }) + "\n");
    fsyncDir(dir(roots));
    return { proposalId, created: true, state: "pending" };
  });
}

// U28 (R7, KTD27): a preference candidate from an imported source (a Claude memory of type user). It waits as a
// pending proposal for the owner's weekly review; nothing here accepts it. The proposal carries its source, and its
// session is "import:<source>". It passes the same checks as pref propose. A proposal with the same text, pending,
// declined or accepted, is the answer already, so nothing new is written. The per-session limit is for agent sessions
// and does not apply; the importer caps its own run.
export const PREF_SOURCES = Object.freeze(["memory"]);
export async function proposeImportedPreference(roots, { title, text, source }, { now = () => new Date() } = {}) {
  if (!PREF_SOURCES.includes(source)) invalid("source");
  const pref = await checkPreference(roots, { title, text, topic: null });
  const key = prefKey(pref.text), proposalId = "pref_" + digest({ source, key }).slice(7, 31), path = pathOf(roots, proposalId);
  assertWritable(roots, [path]);
  return withLock(roots, "pref-import", async () => {
    const all = await readAll(roots), earlier = all.find((p) => p.key === key);
    if (earlier) return { proposalId: earlier.proposalId, created: false, state: earlier.state };
    if (all.length >= MAX_PROPOSALS) throw new DevtwinError("LIMIT", "Too many preference proposals", { max: MAX_PROPOSALS });
    const at = now().toISOString();
    ensurePrivatePath(roots.dataRoot, ["pref-proposals"]);
    await writeNewFile(path, canonicalJson({ schemaVersion: 1, proposalId, session: "import:" + source, source, key, preference: pref, state: "pending", createdAt: at, updatedAt: at, outcome: null }) + "\n");
    fsyncDir(dir(roots));
    return { proposalId, created: true, state: "pending" };
  });
}

// pref proposals: pending proposals, or every proposal with all. The text came from an agent, or from an import (source).
export async function listPreferenceProposals(roots, { all = false } = {}) {
  return { proposals: (await readAll(roots)).filter((p) => all || p.state === "pending").map((p) => ({ id: p.proposalId, state: p.state, session: p.session, title: p.preference.title, text: p.preference.text, topic: p.preference.topic, createdAt: p.createdAt, outcome: p.outcome, ...(p.source ? { source: p.source } : {}) })) };
}

// The preferences the instruction block delivers: effective preference records of the personal store, oldest first,
// without retired ones.
export async function activePreferences(roots) {
  const snap = await readPersonalSnapshot(roots), retired = new Set((await readRetired(roots)).ids);
  // Setup sandbox records hold advice for one repository, so they stay out of the block that every session reads.
  return snap.records.filter((r) => r.kind === "preference" && r.effective !== "superseded" && !retired.has(r.id) && !r.requestId.startsWith("req_setup_sandbox_"))
    .sort((a, b) => a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1)
    .map((r) => ({ id: r.id, title: r.title, text: r.body.trim(), topic: r.match?.topics?.[0] ?? null, createdAt: r.createdAt, recordHash: r.recordHash }));
}
export async function listPreferences(roots) {
  return { preferences: await activePreferences(roots), pending: (await listPreferenceProposals(roots)).proposals.length };
}

const acceptDialog = (plan) => ({ title: "Save a preference for every agent session", body: [
  "Saves it to your personal store. Every organization's agent sessions read it after you run devtwin instructions apply.", "",
  "Title: " + plan.preference.title, "", plan.preference.text
].join("\n") });
export async function planAcceptPreference(roots, { id }) {
  const proposal = await requirePending(roots, id);
  const pref = await checkPreference(roots, proposal.preference);
  const requestId = requestIdFor({ proposalId: id, key: proposal.key });
  return finalizePlan({ kind: "pref-accept", proposalId: id, proposalHash: hashOf(proposal), preference: pref, requestId, dialog: true });
}
export async function applyAcceptPreference(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planAcceptPreference(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, acceptDialog(plan));
  return withLock(roots, "pref-accept", async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    const twin = (await readAll(roots)).find((p) => p.key === proposal.key && p.state === "accepted");
    if (twin) throw new DevtwinError("CONFLICT", "This preference is already saved", { reason: "accepted", id: twin.proposalId });
    if (hashOf(proposal) !== plan.proposalHash) throw new DevtwinError("STALE_VERSION", "Preference proposal changed", { id: plan.proposalId });
    const added = await addPersonalRecord(roots, { requestId: plan.requestId, recordedBy: { actor: "human", runId: "run_cli00001" }, draft: prefDraft(plan.preference, "observed") }, { now });
    const outcome = { acceptedAt: now().toISOString(), recordId: added.recordId, recordHash: added.recordHash };
    await replace(roots, plan.proposalHash, { ...proposal, state: "accepted", updatedAt: outcome.acceptedAt, outcome });
    return { accepted: true, proposalId: plan.proposalId, ...outcome, next: "Run devtwin instructions plan to deliver it to Claude Code and Codex." };
  });
}
// pref decline: the developer said no. The file stays as "declined", so the same text is refused at propose time.
export async function planDeclinePreference(roots, { id }) {
  const proposal = await requirePending(roots, id);
  return finalizePlan({ kind: "pref-decline", proposalId: id, proposalHash: hashOf(proposal), title: proposal.preference.title });
}
export async function applyDeclinePreference(roots, input, { fingerprint, now = () => new Date() } = {}) {
  const plan = await planDeclinePreference(roots, input);
  assertFingerprint(plan, fingerprint);
  return withLock(roots, "pref-decline", async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    await replace(roots, plan.proposalHash, { ...proposal, state: "declined", updatedAt: now().toISOString(), outcome: { declinedAt: now().toISOString() } });
    return { declined: true, proposalId: plan.proposalId };
  });
}

// pref retire: stops delivering an accepted preference. The record stays in the personal store; its ID goes to
// dataRoot/pref-retired.json, which the instruction block reads. Run instructions apply afterwards.
const retiredPath = (roots) => join(roots.dataRoot, "pref-retired.json");
async function readRetired(roots) {
  try {
    const value = await readPrivateJson(retiredPath(roots), 65536);
    if (value?.schemaVersion !== 1 || !Array.isArray(value.ids)) throw new DevtwinError("INTEGRITY", "Retired preferences invalid");
    return value;
  } catch (error) { if (error.code === "ENOENT") return { schemaVersion: 1, ids: [] }; throw error; }
}
export async function planRetirePreference(roots, { id }) {
  const pref = (await activePreferences(roots)).find((p) => p.id === id);
  if (!pref) throw new DevtwinError("NOT_FOUND", "No active preference with this ID", { id });
  return finalizePlan({ kind: "pref-retire", id, recordHash: pref.recordHash, title: pref.title });
}
export async function applyRetirePreference(roots, input, { fingerprint } = {}) {
  const plan = await planRetirePreference(roots, input);
  assertFingerprint(plan, fingerprint);
  return withLock(roots, "pref-retire", async () => {
    const current = await readRetired(roots), path = retiredPath(roots);
    assertWritable(roots, [path]);
    await atomicReplace(path, canonicalJson({ schemaVersion: 1, ids: [...new Set([...current.ids, plan.id])].sort() }) + "\n");
    return { retired: true, id: plan.id, next: "Run devtwin instructions plan to remove it from the instruction files." };
  });
}
