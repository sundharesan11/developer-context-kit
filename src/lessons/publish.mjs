// U11 (R13, R18, KTD3, KTD9): lesson accept and lesson copy. Both preview, then apply with the plan fingerprint.
// Every copy shows the owner dialog with the exact lesson text before the first write; a dismissed or denied dialog
// writes nothing. The hub copy is the organization's copy of a lesson: accept writes no second copy to the org home
// under dataRoot/scopes/<scope>/org.
//
// U36 (KTD38): lesson accept asks the tier table (src/policy/tiers.mjs) and shows no dialog.
// U30 (R8): --target is a non-empty set of targets, comma-separated (project,repo). Each member is asked on its own,
// and a member the tier table refuses fails the whole accept before anything is written. "hub+general" is the older
// spelling of general,hub.
// Targets:   project      automatic: a project lesson record in the proposal's project; local
//            general      waits: a personal-store record reaches every organization, so U25 parks this member in the
//                         activity review's waiting list (src/audit/review.mjs) and the other members are written now.
//                         The review writes the personal record after the owner dialog showed its full text
//            hub          consented: one file in the scope's hub, only while a hub-publish consent for the scope is
//                         valid. U41 (KTD41): the file waits in the held queue for the consent's hold time
//                         (src/held/queue.mjs); a sender then publishes it (src/held/send.mjs, publishLesson below)
//            repo         automatic: a learning branch in the project's repository (src/learnings/repo-write.mjs).
//                         Under a valid repo-push consent its push waits in the held queue (src/learnings/push.mjs);
//                         without one the branch stays local and activity lists it as "needs consent"
// recordedBy names the caller (src/policy/actor.mjs).
//
// U37 (KTD40, KTD43): the project target is an automatic knowledge write. The lesson text passes the plain-rule checks
// (checkLesson), and an audit entry with the caller's --session goes into the log before the record is written. The
// hub target appends a hub-lesson entry (tier consented, itemIds the hub lesson ID) before it enqueues the held item.
// Undo of that entry cancels the item while it is held or waits in the outbox; once sent, undo points to
// `published delete` (src/audit/undo.mjs).
//
// U12: a replacement proposal (lesson supersede-propose) accepts to the hub target only. Its hub file names the
// predecessor as supersedes: [{ id, hash }]. The predecessor is checked against the local clone at preview and on the
// fetched remote branch before the commit and after every rebase, when the held item is sent. STALE_VERSION drops the
// local commit and the held item, queues nothing and reports the item as dropped with the reason "stale".
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { readHubBinding } from "../config/store.mjs";
import { assertScopeId, assertProjectId, personalRecordIdFor, recordIdFor, RECORD_ID, SCOPE_ID } from "../identity/ids.mjs";
import { digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval, dialogText, DIALOG_LIMITS } from "../owner/dialog.mjs";
import { tierRule } from "../policy/tiers.mjs";
import { cliRecorder } from "../policy/actor.mjs";
import { appendEntry } from "../audit/log.mjs";
import { requireConsent, readConsent } from "../consent/store.mjs";
import { enqueueHeld, hubTarget } from "../held/queue.mjs";
import { enqueueLearningPush } from "../learnings/push.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { readPersonalSnapshot } from "../records/personal.mjs";
import { addRecord, requireCommittedProject } from "../records/store.mjs";
import { renderHubLesson } from "../hubs/read.mjs";
import { publishToHub, hubGit, checkRemoteSupersession } from "../hubs/git-write.mjs";
import { rebuildIndex } from "./index.mjs";
import { checkLesson, lessonBody, lessonDraft, lessonText, requirePending, proposalHash, markAccepted, withProposalLock, SESSION_ID } from "./propose.mjs";
import { checkLocalSupersession } from "./supersede.mjs";

export const TARGETS = Object.freeze(["project", "general", "hub", "repo"]);
export const leavesMachine = (target) => target === "hub" || target === "repo";
// The members of a --target value, in TARGETS order.
export function parseTargets(value) {
  const parts = value === "hub+general" ? ["general", "hub"] : typeof value === "string" ? value.split(",").map((part) => part.trim()) : [];
  if (!parts.length || parts.some((part) => !TARGETS.includes(part)) || new Set(parts).size !== parts.length) throw new DevtwinError("INVALID_INPUT", "Invalid lesson target", { field: "target", allowed: TARGETS });
  return TARGETS.filter((target) => parts.includes(target));
}
// The first member the tier table hands to a route other than activity review, or null. U25: a member whose tier
// sends it through activity review (general) is parked there instead (parkedMembers).
const refusedMember = (rules) => Object.entries(rules).find(([, rule]) => rule.via && rule.via !== "activity review") ?? null;
const parkedMembers = (rules) => Object.entries(rules).filter(([, rule]) => rule.via === "activity review").map(([member]) => member);
const hex = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);
// KTD3: lsn_ plus a hash of hub ID, author handle, request ID and creation time.
export const hubLessonId = ({ hubId, handle, requestId, createdAt }) => "lsn_" + hex([hubId, handle, requestId, createdAt].join("\0"));
const requestIdFor = (prefix, value) => "req_" + prefix + digest(value).slice(7, 31);

async function writableBinding(roots, scope) {
  const binding = await readHubBinding(roots, scope);
  if (!binding || binding.status !== "joined" || binding.delivery !== "on") throw new DevtwinError("HUB_NOT_JOINED", "Scope has not joined a hub", { scope });
  if (binding.readOnly) throw new DevtwinError("HUB_READ_ONLY", "Hub uses a newer format; devtwin does not write to it", { hubId: binding.hubId });
  return binding;
}
// The hub file for a lesson. localRecordHash points back to the local record or the accepted proposal draft; the
// full local record is never published.
function hubFile(binding, { requestId, createdAt, lesson, localRecordHash, supersedes = null }) {
  const id = hubLessonId({ hubId: binding.hubId, handle: binding.handle, requestId, createdAt });
  const meta = { schemaVersion: 1, id, author: binding.actorRef, title: lesson.title, match: lesson.match, createdAt, localRecordHash, ...(supersedes ? { supersedes } : {}) };
  return { hubId: binding.hubId, scope: binding.scope, author: binding.actorRef, lessonId: id, rel: "lessons/" + id + ".md", content: renderHubLesson(meta, lessonBody(lesson)), ...(supersedes ? { supersedes } : {}) };
}
const matchLine = (match) => ["paths", "packages", "topics", "commands"].filter((key) => match[key]?.length).map((key) => key + ": " + match[key].join(", ")).join("; ");
// The owner dialog shows the exact lesson text. A lesson too long to show in full is refused, never cut.
function lessonDialog(title, header, lesson) {
  const content = { title, body: [...header, "", "Title: " + lesson.title, ...(lesson.summary ? ["Do or don't: " + lesson.summary] : []), "", lesson.text.trim() || "(no further text)", "", "Matches " + matchLine(lesson.match)].join("\n") };
  const shown = dialogText(content).body;
  if (shown.endsWith("\u2026") && [...shown].length >= DIALOG_LIMITS.bodyChars) throw new DevtwinError("LIMIT", "Lesson too long to show in the owner dialog; shorten it with lesson edit", { maxChars: DIALOG_LIMITS.bodyChars });
  return content;
}
const copyDialog = (plan) => lessonDialog("Copy a personal lesson to another organization's hub", [
  "Personal lesson: " + plan.recordId, "To scope: " + plan.scope, "Hub: " + plan.hub.hubId, "Author: " + plan.hub.author,
  "Everyone with access to this hub can read it. Git history keeps the text."
], plan.lesson);

// lesson accept preview. It re-runs the draft and isolation checks; general targets are also checked against the
// lesson's own scope, because the personal store reaches every organization.
export async function planAccept(roots, { id, target: value, scope, project, session = null }) {
  const members = parseTargets(value), target = members.join(","), has = (member) => members.includes(member);
  if (session !== null && (typeof session !== "string" || !SESSION_ID.test(session))) throw new DevtwinError("INVALID_INPUT", "Invalid session ID", { field: "session" });
  const proposal = await requirePending(roots, id);
  if (scope !== undefined && assertScopeId(scope) !== proposal.scope) throw new DevtwinError("CONFLICT", "Proposal belongs to another scope", { scope: proposal.scope });
  const lesson = await checkLesson(roots, proposal.scope, proposal.lesson);
  if (proposal.supersedes && target !== "hub") throw new DevtwinError("INVALID_INPUT", "A replacement lesson goes to the hub only", { field: "target", allowed: ["hub"] });
  const rules = Object.fromEntries(members.map((member) => [member, tierRule({ route: "lesson accept", target: member })]));
  const refused = refusedMember(rules);
  if (refused) throw new DevtwinError("GATE_REQUIRED", "This lesson target is done by " + refused[1].via, { target, member: refused[0], tier: refused[1].tier, via: refused[1].via });
  const parked = parkedMembers(rules);
  if (has("general")) assertOutboundClean(lessonText(lesson), await isolationTerms(roots));
  // One request ID per member, so each write keeps its own audit entry and record ID. A one-member accept keeps the
  // request ID it always had.
  const requestOf = (member) => requestIdFor("lsn", { proposalId: id, revision: proposal.revision, target: member });
  const requestId = requestIdFor("lsn", { proposalId: id, revision: proposal.revision, target });
  const tier = members.some((member) => rules[member].tier === "consented") ? "consented" : "automatic";
  // tier is the tier of what this accept writes now; a parked member waits for the review.
  const plan = { kind: "lesson-accept", proposalId: id, proposalHash: proposalHash(proposal), revision: proposal.revision, scope: proposal.scope, target, targets: members, tier,
    ...(members.length > 1 ? { tiers: Object.fromEntries(members.map((member) => [member, rules[member].tier])) } : {}), ...(rules.hub?.consent ? { consent: rules.hub.consent } : {}), requestId, lesson, ...(parked.length ? { parked, waitsFor: "activity review" } : {}) };
  if (has("hub")) {
    const requestId = requestOf("hub");
    const binding = await writableBinding(roots, proposal.scope);
    let supersedes = null;
    if (proposal.supersedes) {
      await checkLocalSupersession(binding, proposal.supersedes);
      supersedes = [{ id: proposal.supersedes.id, hash: proposal.supersedes.hash }];
      plan.supersedes = supersedes;
      plan.replaces = { id: proposal.supersedes.id, title: proposal.supersedes.title, author: proposal.supersedes.author };
    }
    plan.hub = hubFile(binding, { requestId, createdAt: proposal.createdAt, lesson, localRecordHash: digest(lessonDraft(lesson)), supersedes });
    plan.hubRequestId = requestId;
    plan.createdAt = proposal.createdAt;
    plan.session = session;
  }
  // The record the review writes for the general member, if the owner accepts it.
  if (has("general")) plan.general = { requestId: requestOf("general"), personalRecordId: personalRecordIdFor({ requestId: requestOf("general") }) };
  if (has("project") || has("repo")) {
    const name = project ?? proposal.project;
    if (name === null || name === undefined) throw new DevtwinError("INVALID_INPUT", "Project target needs --project", { field: "project" });
    if (project !== undefined && proposal.project !== null && project !== proposal.project) throw new DevtwinError("CONFLICT", "Proposal belongs to another project", { project: proposal.project });
    assertProjectId(name, proposal.scope);
    await requireCommittedProject(roots, proposal.scope, name);
    plan.project = name;
    plan.session = session;
  }
  if (has("project")) plan.projectRecordId = recordIdFor({ scope: proposal.scope, project: plan.project, requestId: requestOf("project") });
  if (has("repo")) {
    // Every check of the learning branch runs here, so a refusal stops the accept before any write.
    const { prepareLearning, learningIdFor } = await import("../learnings/repo-write.mjs");
    const sourceId = plan.projectRecordId ?? learningIdFor(requestOf("repo"));
    plan.repo = await prepareLearning(roots, { scope: proposal.scope, project: plan.project, lesson, requestId: requestOf("repo"), sourceId, createdAt: proposal.createdAt });
  }
  return finalizePlan(plan);
}
// Publishes one lesson file. The precondition runs before the commit and after each rebase: the file must not be there,
// and for a replacement the predecessor must be there unchanged with no other replacement (U12).
// U41: the held-queue sender calls it with locked: true under the hub-sync lock.
export async function publishLesson(roots, binding, hub, { now, createdAt, locked = false }) {
  // The check reads the fetched remote branch, not the clone's work tree, which holds the new file after a rebase.
  const preconditions = async () => {
    if (hubGit(binding, ["cat-file", "-e", "refs/remotes/origin/" + binding.branch + ":" + hub.rel]).ok) throw new DevtwinError("CONFLICT", "Hub already has this lesson", { lessonId: hub.lessonId });
    if (hub.supersedes) checkRemoteSupersession(binding, { lessonId: hub.lessonId, supersedes: hub.supersedes });
  };
  const result = await publishToHub(roots, binding, { writes: [{ rel: hub.rel, content: hub.content }], message: "Add lesson " + hub.lessonId, preconditions, now, kind: "lesson", createdAt, locked });
  return { lessonId: hub.lessonId, hubId: hub.hubId, pushed: result.pushed, ...(result.pushed ? { commit: result.commit, attempts: result.attempts } : { reason: result.reason, queued: result.queued }) };
}
async function configuredScopes(roots) {
  try { return (await readdir(join(roots.configRoot, "scopes"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((s) => SCOPE_ID.test(s)).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
// KTD22: lesson commands rebuild the index. A personal record is in every scope's index, so all of them rebuild.
// U37: undo rebuilds the same way (src/audit/undo.mjs).
export const indexScopesFor = async (roots, home, scope) => home === "personal" ? configuredScopes(roots) : [scope];
export async function rebuildIndexes(roots, scopes) {
  const out = [];
  for (const scope of scopes) {
    try { const index = await rebuildIndex(roots, scope); out.push({ scope, written: index.written, counts: index.counts }); }
    catch (error) { out.push({ scope, problem: error.code ?? "DEVTWIN_INTERNAL" }); }
  }
  return out;
}

// The request ID of one member's write (the same one planAccept used for its record ID).
const requestOf = (plan, member) => requestIdFor("lsn", { proposalId: plan.proposalId, revision: plan.revision, target: member });
const members = (plan) => plan.targets ?? [plan.target];
// U30: the learning branch's audit entry comes before its ref (KTD40). The objects are written first, so the entry can
// name the commit; until the ref exists they are unreachable and change nothing. A retry after a stop between the
// entry and the ref uses the commit the entry names.
async function writeLearning(roots, prepared, { recordedBy, session, now }) {
  const view = { root: prepared.root, branch: prepared.branch, learningId: prepared.learningId, rel: prepared.rel, base: prepared.base.ref, baseCommit: prepared.base.commit };
  if (prepared.resumed) return { ...view, commit: prepared.resumed.commit, audit: prepared.resumed.audit, resumed: true };
  const { buildLearningCommit, sameLearningCommit, createLearningRef } = await import("../learnings/repo-write.mjs");
  const commit = buildLearningCommit(prepared);
  const entry = await appendEntry(roots, { kind: "repo-learning", tier: "automatic", route: "lesson accept", target: "repo", scope: prepared.scope, project: prepared.project,
    itemIds: [prepared.learningId, "cmt_" + commit], actor: recordedBy.actor, session, requestId: prepared.requestId }, { now });
  const named = entry.itemIds.find((x) => x.startsWith("cmt_")).slice(4);
  if (named !== commit && !sameLearningCommit(prepared, named)) throw new DevtwinError("STALE_VERSION", "An earlier write of this learning branch differs", { branch: prepared.branch });
  createLearningRef(prepared, named);
  return { ...view, commit: named, audit: entry.id };
}

export async function applyAccept(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planAccept(roots, input);
  assertFingerprint(plan, fingerprint);
  // A consented target needs its standing consent; no owner dialog runs for any accept target.
  const consent = plan.consent ? await requireConsent(roots, plan.consent, plan.scope) : null;
  // U30: the repo target writes its branch either way; the consent decides only whether the push is queued.
  const repoConsent = plan.repo ? await readConsent(roots, "repo-push", plan.repo.root) : null;
  const recordedBy = cliRecorder(ctx.env ?? process.env);
  // U25: a parked member goes into the review's waiting list under the review lock, taken before the proposal lock.
  const { withReviewLock, parkItem } = plan.general ? await import("../audit/review.mjs") : {};
  const locked = (action) => plan.general ? withReviewLock(roots, "lesson-accept", () => withProposalLock(roots, "lesson-accept", action)) : withProposalLock(roots, "lesson-accept", action);
  const outcome = await locked(async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    if (proposalHash(proposal) !== plan.proposalHash) throw new DevtwinError("STALE_VERSION", "Lesson proposal changed", { id: plan.proposalId });
    const result = { target: plan.target, tier: plan.tier, recordedBy: recordedBy.actor, acceptedAt: now().toISOString() };
    const binding = plan.hub ? await writableBinding(roots, plan.scope) : null;
    if (binding && (binding.hubId !== plan.hub.hubId || binding.actorRef !== plan.hub.author)) throw new DevtwinError("STALE_VERSION", "Hub binding changed");
    // Local writes come first. They are idempotent by request ID, so if the publish then fails, the same accept can run
    // again; the hub precondition keeps a second publish out. The learning branch is first of all: its ref is the
    // write most likely to fail, and a retry finds the branch it wrote through its audit entry (resumed).
    if (plan.repo) result.repo = await writeLearning(roots, plan.repo, { recordedBy, session: plan.session ?? null, now });
    if (plan.general) {
      const parked = await parkItem(roots, { type: "general-lesson", source: recordedBy.actor === "human" ? "owner" : "agent", title: plan.lesson.title, requestId: plan.general.requestId,
        payload: { proposalId: plan.proposalId, scope: plan.scope, lesson: plan.lesson, from: { actor: recordedBy.actor, session: input.session ?? null } } }, { now, locked: true });
      result.general = { waiting: true, id: parked.id, via: "activity review", personalRecordId: plan.general.personalRecordId };
    }
    if (plan.projectRecordId) {
      const entry = await appendEntry(roots, { kind: "record", tier: "automatic", route: "lesson accept", target: "project", home: "project", scope: plan.scope, project: plan.project, recordIds: [plan.projectRecordId], actor: recordedBy.actor, session: plan.session, requestId: requestOf(plan, "project") }, { now });
      result.audit = entry.id;
      const added = await addRecord(roots, { scope: plan.scope, project: plan.project, requestId: requestOf(plan, "project"), recordedBy, draft: { ...lessonDraft(plan.lesson, { reach: "project", status: "observed" }), applicability: { level: "project" } } }, { now });
      result.project = { project: plan.project, recordId: added.recordId, recordHash: added.recordHash };
    }
    if (binding) {
      // KTD41: the lesson waits in the held queue; the audit entry goes first, so its state starts as held.
      const entry = await appendEntry(roots, { kind: "hub-lesson", tier: "consented", route: "lesson accept", target: "hub", scope: plan.scope, itemIds: [plan.hub.lessonId], actor: recordedBy.actor, session: plan.session ?? null, requestId: plan.hubRequestId }, { now });
      result.audit = entry.id;
      const held = await enqueueHeld(roots, { target: hubTarget(plan.scope), kind: "hub-lesson", title: plan.lesson.title, audit: entry.id, requestId: plan.hubRequestId,
        consent: { kind: consent.kind, holdHours: consent.holdHours, ruleDigest: consent.ruleDigest, grantedAt: consent.grantedAt }, payload: { ...plan.hub, createdAt: plan.createdAt, message: "Add lesson " + plan.hub.lessonId } }, { now, ctx });
      result.hub = { lessonId: plan.hub.lessonId, hubId: plan.hub.hubId, held: true, heldId: held.item.id, sendAfter: held.item.sendAfter, ...(held.notification ? { notification: held.notification } : {}) };
    }
    if (plan.repo) {
      result.repo.push = repoConsent?.valid
        ? await enqueueLearningPush(roots, repoConsent, { kind: "repo-learning", root: plan.repo.root, scope: plan.scope, project: plan.project, learningId: plan.repo.learningId, branch: plan.repo.branch,
          commit: result.repo.commit, rel: plan.repo.rel, content: plan.repo.content, title: plan.lesson.title }, { audit: result.repo.audit, requestId: plan.repo.requestId, now, ctx })
        : { queued: false, reason: "needs-consent", message: "The branch stays local. Ask your developer to run consent grant --kind repo-push --repo " + plan.repo.root + ", then learning send --branch " + plan.repo.branch, ...(repoConsent ? { voidReason: repoConsent.voidReason } : {}) };
      if (members(plan).length === 1) result.audit = result.repo.audit;
    }
    await markAccepted(roots, proposal, plan.proposalHash, result, { now });
    return result;
  });
  const index = await rebuildIndexes(roots, [plan.scope]);
  return { accepted: true, proposalId: plan.proposalId, ...outcome, index };
}

// lesson copy (R18): a personal lesson into another organization's hub. The isolation check covers every scope but
// the target, so text that names any other organization stays home.
export async function planCopy(roots, { id, toScope }) {
  if (!RECORD_ID.test(id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid record ID");
  const scope = assertScopeId(toScope);
  const record = (await readPersonalSnapshot(roots)).records.find((r) => r.id === id);
  if (!record || record.kind !== "lesson" || !["observed", "confirmed"].includes(record.effective)) throw new DevtwinError("NOT_FOUND", "No effective personal lesson with this ID", { id });
  // The same checks as a proposal for this scope: draft, characters, match rules and every scope but the target.
  const lesson = await checkLesson(roots, scope, { title: record.title, summary: null, text: record.body, match: record.match });
  const binding = await writableBinding(roots, scope);
  const requestId = requestIdFor("cpy", { recordId: id, recordHash: record.recordHash, scope });
  const hub = hubFile(binding, { requestId, createdAt: record.createdAt, lesson, localRecordHash: record.recordHash });
  const plan = finalizePlan({ kind: "lesson-copy", recordId: id, recordHash: record.recordHash, scope, requestId, createdAt: record.createdAt, lesson, hub, dialog: true });
  copyDialog(plan);
  return plan;
}
export async function applyCopy(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planCopy(roots, input);
  assertFingerprint(plan, fingerprint);
  await requireOwnerApproval(ctx, copyDialog(plan));
  const binding = await writableBinding(roots, plan.scope);
  if (binding.hubId !== plan.hub.hubId || binding.actorRef !== plan.hub.author) throw new DevtwinError("STALE_VERSION", "Hub binding changed");
  const hub = await publishLesson(roots, binding, plan.hub, { now, createdAt: plan.createdAt });
  const index = await rebuildIndexes(roots, [plan.scope]);
  return { copied: true, recordId: plan.recordId, scope: plan.scope, hub, index };
}
