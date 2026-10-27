// U11 (R12, R13, KTD23): private lesson proposals. An agent writes at most three pending proposals per session with
// `lesson propose`. They stay on this machine, at dataRoot/lesson-proposals/<prop_id>.json, until the owner accepts,
// edits or rejects each one. Nothing here uses the network or a hub. The same draft, sensitive-content and isolation
// checks run at propose time and again at edit and accept time, so a bad draft is refused early.
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { DevtwinError } from "../errors.mjs";
import { assertWritable } from "../config/pilot.mjs";
import { loadScope } from "../config/store.mjs";
import { assertScopeId, assertProjectId } from "../identity/ids.mjs";
import { readPrivateJson, writeNewFile, atomicReplace, ensurePrivatePath, fsyncDir, info } from "../storage/fsx.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { canonicalJson, digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { validateDraft } from "../records/schema.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { checkAutomaticText } from "../audit/checks.mjs";

export const PROPOSALS_PER_SESSION = 3;
export const PROPOSAL_ID = /^prop_[a-f0-9]{24}$/;
// The session ID from the hook's session-start line, or one ID the agent keeps for the whole session.
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SUMMARY_CHARS = 200, PROPOSAL_BYTES = 131072, MAX_PROPOSALS = 1000;
const LINE_UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
// Body text keeps line breaks and tabs. Other control, format and bidi characters are refused, so the owner dialog
// shows the same text that leaves the machine.
const TEXT_UNSAFE = /[\p{Cf}\u2028\u2029]|(?![\n\t])\p{Cc}/u;
export const proposalsDir = (roots) => join(roots.dataRoot, "lesson-proposals");
const proposalPath = (roots, id) => join(proposalsDir(roots), id + ".json");
// An underscore keeps this lock name apart from every scope lock name.
const proposalLockPath = (roots) => join(roots.stateRoot, "locks", "lesson_proposals.lock");
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid lesson proposal", { field }); };

// The lesson body: the one-line "do or do not" first, then the longer text. The match index uses the first line as
// the summary of the lesson (src/lessons/index.mjs).
export const lessonBody = ({ summary, text }) => summary ? summary + "\n" + (text ? "\n" + text : "") : text;
// The draft that validateDraft checks. Personal reach has no project, so the same check covers every target.
export const lessonDraft = (lesson, { reach = "personal", status = "proposed" } = {}) => ({ kind: "lesson", class: "lesson", reach, status, title: lesson.title, body: lessonBody(lesson), match: lesson.match });
// All text a lesson carries outside the machine: title, summary, body and match terms.
export const lessonText = (lesson) => [lesson.title, lessonBody(lesson), ...lesson.match.paths, ...lesson.match.packages, ...lesson.match.topics].join("\n");

// Shape checks, then the draft check (which includes the sensitive-content tripwire), then the isolation check
// against every scope but the lesson's own. The general targets check against the lesson's own scope too, at accept.
export async function checkLesson(roots, scope, lesson) {
  if (!lesson || typeof lesson !== "object") invalid("lesson");
  const { title, summary, text, match } = lesson;
  if (typeof title !== "string" || !title.trim()) invalid("title");
  if (summary !== null && (typeof summary !== "string" || !summary.trim() || [...summary].length > SUMMARY_CHARS || LINE_UNSAFE.test(summary))) invalid("summary");
  if (typeof text !== "string" || (!text.trim() && !summary) || TEXT_UNSAFE.test(text)) invalid("body");
  const clean = { title, summary, text, match: { paths: match?.paths ?? [], packages: match?.packages ?? [], topics: match?.topics ?? [] } };
  if (!["paths", "packages", "topics"].some((key) => clean.match[key].length)) invalid("match");
  // U37 (KTD43): the plain-rule checks; the body may use Markdown structure (src/audit/checks.mjs).
  checkAutomaticText({ lines: [title, ...(summary ? [summary] : [])], body: text });
  validateDraft(lessonDraft(clean), { recordedBy: { actor: "other" } });
  assertOutboundClean(lessonText(clean), await isolationTerms(roots), { except: scope });
  return clean;
}
async function readAll(roots) {
  let names;
  try { names = await readdir(proposalsDir(roots)); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const out = [];
  for (const name of names.filter((n) => n.endsWith(".json") && PROPOSAL_ID.test(n.slice(0, -5))).sort()) out.push(await readProposal(roots, name.slice(0, -5)));
  return out;
}
export async function readProposal(roots, id) {
  if (!PROPOSAL_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid proposal ID");
  let value;
  try { value = await readPrivateJson(proposalPath(roots, id), PROPOSAL_BYTES); }
  catch (error) { if (error.code === "ENOENT") throw new DevtwinError("NOT_FOUND", "No lesson proposal with this ID", { id }); throw error; }
  if (value?.schemaVersion !== 1 || value.proposalId !== id || !["pending", "rejected", "accepted"].includes(value.state)) throw new DevtwinError("INTEGRITY", "Lesson proposal invalid", { id });
  return value;
}
export const proposalHash = (proposal) => digest(proposal);
export async function requirePending(roots, id) {
  const proposal = await readProposal(roots, id);
  if (proposal.state !== "pending") throw new DevtwinError("CONFLICT", "Lesson proposal is not pending", { id, state: proposal.state });
  return proposal;
}
// Replaces one proposal file. The caller holds the proposal lock and passes the hash it read, so a change made in
// between fails with STALE_VERSION.
async function replaceProposal(roots, expectHash, next) {
  const current = await readProposal(roots, next.proposalId);
  if (proposalHash(current) !== expectHash) throw new DevtwinError("STALE_VERSION", "Lesson proposal changed", { id: next.proposalId });
  const path = proposalPath(roots, next.proposalId);
  assertWritable(roots, [path]);
  await atomicReplace(path, canonicalJson(next) + "\n");
  return next;
}
export const withProposalLock = (roots, kind, action) => withPilotLock(roots, proposalLockPath(roots), { kind }, action, { destinations: [proposalsDir(roots)] });

// lesson propose. Without apply it checks everything and writes nothing. The ID comes from the content, so the
// same draft in the same session is one proposal.
// U12: supersedes, when given, is { id, hash, title, author, hubId } for the hub lesson this proposal replaces
// (src/lessons/supersede.mjs). A replacement counts toward the same three-per-session cap.
export async function proposeLesson(roots, { session, scope, project = null, lesson, supersedes = null }, { now = () => new Date(), apply = false } = {}) {
  if (typeof session !== "string" || !SESSION_ID.test(session)) invalid("session");
  assertScopeId(scope);
  await loadScope(roots, scope);
  if (project !== null) assertProjectId(project, scope);
  const clean = await checkLesson(roots, scope, lesson);
  const replaces = supersedes ? { supersedes } : {};
  const proposalId = "prop_" + digest({ session, scope, project, lesson: clean, ...replaces }).slice(7, 31), path = proposalPath(roots, proposalId);
  const count = async () => (await readAll(roots)).filter((p) => p.session === session && p.proposalId !== proposalId).length;
  const existing = info(path) !== null;
  if (!existing && await count() >= PROPOSALS_PER_SESSION) throw new DevtwinError("LIMIT", "At most three lesson proposals per session", { max: PROPOSALS_PER_SESSION, session });
  if (!apply) return { preview: true, proposalId, session, scope, project, lesson: clean, ...replaces, path, existing };
  assertWritable(roots, [path]);
  return withProposalLock(roots, "lesson-propose", async () => {
    if (info(path)) return { proposalId, path, created: false, state: (await readProposal(roots, proposalId)).state };
    const all = await readAll(roots);
    if (all.filter((p) => p.session === session).length >= PROPOSALS_PER_SESSION) throw new DevtwinError("LIMIT", "At most three lesson proposals per session", { max: PROPOSALS_PER_SESSION, session });
    if (all.length >= MAX_PROPOSALS) throw new DevtwinError("LIMIT", "Too many lesson proposals", { max: MAX_PROPOSALS });
    const at = now().toISOString();
    const value = { schemaVersion: 1, proposalId, session, scope, project, lesson: clean, ...replaces, state: "pending", review: "unreviewed", revision: 0, createdAt: at, updatedAt: at, outcome: null };
    assertWritable(roots, [path]);
    ensurePrivatePath(roots.dataRoot, ["lesson-proposals"]);
    await writeNewFile(path, canonicalJson(value) + "\n");
    fsyncDir(proposalsDir(roots));
    return { proposalId, path, created: true, state: "pending", ...replaces };
  });
}

// lesson proposals: the pending proposals, or every proposal with all. The lesson text came from an agent; the owner
// reviews it before any accept.
export async function listProposals(roots, { scope, all = false } = {}) {
  if (scope !== undefined) assertScopeId(scope);
  const proposals = (await readAll(roots)).filter((p) => (all || p.state === "pending") && (scope === undefined || p.scope === scope));
  return { proposals: proposals.map((p) => ({ id: p.proposalId, state: p.state, scope: p.scope, project: p.project, session: p.session, revision: p.revision, createdAt: p.createdAt, updatedAt: p.updatedAt, title: p.lesson.title, summary: p.lesson.summary, body: p.lesson.text, match: p.lesson.match, outcome: p.outcome,
    ...(p.supersedes ? { supersedes: p.supersedes } : {}), ...(p.lastAttempt ? { lastAttempt: p.lastAttempt } : {}) })) };
}

// lesson reject: preview, then apply with the plan fingerprint. The file stays as "rejected", so it still counts
// toward the session's cap.
export async function planReject(roots, { id }) {
  const proposal = await requirePending(roots, id);
  return finalizePlan({ kind: "lesson-reject", proposalId: id, proposalHash: proposalHash(proposal), scope: proposal.scope, title: proposal.lesson.title });
}
export async function applyReject(roots, input, { fingerprint, now = () => new Date() } = {}) {
  const plan = await planReject(roots, input);
  assertFingerprint(plan, fingerprint);
  return withProposalLock(roots, "lesson-reject", async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    await replaceProposal(roots, plan.proposalHash, { ...proposal, state: "rejected", review: "rejected", updatedAt: now().toISOString(), outcome: { rejectedAt: now().toISOString() } });
    return { rejected: true, proposalId: plan.proposalId };
  });
}

// lesson edit: the owner changes the text or the match rules of a pending proposal. Fields not given stay. The preview
// shows the whole new lesson; apply writes it as a new revision with the same ID.
export async function planEdit(roots, { id, title, summary, text, match }) {
  const proposal = await requirePending(roots, id);
  const current = proposal.lesson;
  const next = { title: title ?? current.title, summary: summary === undefined ? current.summary : summary || null, text: text ?? current.text, match: match ?? current.match };
  const lesson = await checkLesson(roots, proposal.scope, next);
  if (canonicalJson(lesson) === canonicalJson(current)) throw new DevtwinError("INVALID_INPUT", "Edit changes nothing", { field: "edit" });
  return finalizePlan({ kind: "lesson-edit", proposalId: id, proposalHash: proposalHash(proposal), scope: proposal.scope, revision: proposal.revision + 1, before: current, lesson });
}
export async function applyEdit(roots, input, { fingerprint, now = () => new Date() } = {}) {
  const plan = await planEdit(roots, input);
  assertFingerprint(plan, fingerprint);
  return withProposalLock(roots, "lesson-edit", async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    await replaceProposal(roots, plan.proposalHash, { ...proposal, lesson: plan.lesson, revision: plan.revision, updatedAt: now().toISOString() });
    return { edited: true, proposalId: plan.proposalId, revision: plan.revision, lesson: plan.lesson };
  });
}

// Accept marks the proposal after its writes. Called from src/lessons/publish.mjs only, which holds the proposal lock.
export const markAccepted = (roots, proposal, expectHash, outcome, { now = () => new Date() } = {}) =>
  replaceProposal(roots, expectHash, { ...proposal, state: "accepted", review: "accepted", updatedAt: now().toISOString(), outcome });
// U12: a replacement whose publish failed with STALE_VERSION stays pending and records why. Called from
// src/lessons/publish.mjs only, which holds the proposal lock.
export const markAttempt = (roots, proposal, expectHash, attempt, { now = () => new Date() } = {}) =>
  replaceProposal(roots, expectHash, { ...proposal, lastAttempt: { ...attempt, at: now().toISOString() }, updatedAt: now().toISOString() });
