// U11 (R13, R18, KTD3, KTD9): lesson accept and lesson copy. Both preview, then apply with the plan fingerprint.
// A target that leaves the machine (hub, hub+general, and every copy) shows the owner dialog with the exact lesson
// text before the first write; a dismissed or denied dialog writes nothing. The hub copy is the organization's copy of
// a lesson: accept writes no second copy to the org home under dataRoot/scopes/<scope>/org.
//
// Targets:   hub          one file in the scope's hub (publishToHub; a rejected push goes to the outbox)
//            hub+general  the hub file and a personal-store record, after the all-scope isolation check
//            project      a project lesson record in the proposal's project; local, no dialog
//            general      a personal-store record only; local, no dialog, the all-scope isolation check still runs
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { readHubBinding } from "../config/store.mjs";
import { assertScopeId, assertProjectId, personalRecordIdFor, recordIdFor, RECORD_ID, SCOPE_ID } from "../identity/ids.mjs";
import { digest } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { requireOwnerApproval, dialogText, DIALOG_LIMITS } from "../owner/dialog.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { addPersonalRecord, readPersonalSnapshot } from "../records/personal.mjs";
import { addRecord, requireCommittedProject } from "../records/store.mjs";
import { renderHubLesson } from "../hubs/read.mjs";
import { publishToHub, hubGit } from "../hubs/git-write.mjs";
import { rebuildIndex } from "./index.mjs";
import { checkLesson, lessonBody, lessonDraft, lessonText, requirePending, proposalHash, markAccepted, withProposalLock } from "./propose.mjs";

export const TARGETS = Object.freeze(["hub", "hub+general", "project", "general"]);
export const leavesMachine = (target) => target === "hub" || target === "hub+general";
const general = (target) => target === "hub+general" || target === "general";
const recordedBy = { actor: "human", runId: "run_cli00001" };
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
function hubFile(binding, { requestId, createdAt, lesson, localRecordHash }) {
  const id = hubLessonId({ hubId: binding.hubId, handle: binding.handle, requestId, createdAt });
  const meta = { schemaVersion: 1, id, author: binding.actorRef, title: lesson.title, match: lesson.match, createdAt, localRecordHash };
  return { hubId: binding.hubId, scope: binding.scope, author: binding.actorRef, lessonId: id, rel: "lessons/" + id + ".md", content: renderHubLesson(meta, lessonBody(lesson)) };
}
const matchLine = (match) => ["paths", "packages", "topics"].filter((key) => match[key].length).map((key) => key + ": " + match[key].join(", ")).join("; ");
// The owner dialog shows the exact lesson text. A lesson too long to show in full is refused, never cut.
function lessonDialog(title, header, lesson) {
  const content = { title, body: [...header, "", "Title: " + lesson.title, ...(lesson.summary ? ["Do or don't: " + lesson.summary] : []), "", lesson.text.trim() || "(no further text)", "", "Matches " + matchLine(lesson.match)].join("\n") };
  const shown = dialogText(content).body;
  if (shown.endsWith("\u2026") && [...shown].length >= DIALOG_LIMITS.bodyChars) throw new DevtwinError("LIMIT", "Lesson too long to show in the owner dialog; shorten it with lesson edit", { maxChars: DIALOG_LIMITS.bodyChars });
  return content;
}
const acceptDialog = (plan) => lessonDialog("Publish a lesson to an organization hub", [
  "Scope: " + plan.scope, "Hub: " + plan.hub.hubId, "Author: " + plan.hub.author,
  plan.target === "hub+general" ? "Also saves it to your personal store, which every organization's sessions read." : "Hub only. Your personal store does not get a copy.",
  "Everyone with access to this hub can read it. Git history keeps the text."
], plan.lesson);
const copyDialog = (plan) => lessonDialog("Copy a personal lesson to another organization's hub", [
  "Personal lesson: " + plan.recordId, "To scope: " + plan.scope, "Hub: " + plan.hub.hubId, "Author: " + plan.hub.author,
  "Everyone with access to this hub can read it. Git history keeps the text."
], plan.lesson);

// lesson accept preview. It re-runs the draft and isolation checks; general targets are also checked against the
// lesson's own scope, because the personal store reaches every organization.
export async function planAccept(roots, { id, target, scope, project }) {
  if (!TARGETS.includes(target)) throw new DevtwinError("INVALID_INPUT", "Invalid lesson target", { field: "target", allowed: TARGETS });
  const proposal = await requirePending(roots, id);
  if (scope !== undefined && assertScopeId(scope) !== proposal.scope) throw new DevtwinError("CONFLICT", "Proposal belongs to another scope", { scope: proposal.scope });
  const lesson = await checkLesson(roots, proposal.scope, proposal.lesson);
  if (general(target)) assertOutboundClean(lessonText(lesson), await isolationTerms(roots));
  const requestId = requestIdFor("lsn", { proposalId: id, revision: proposal.revision, target });
  const plan = { kind: "lesson-accept", proposalId: id, proposalHash: proposalHash(proposal), revision: proposal.revision, scope: proposal.scope, target, requestId, lesson, dialog: leavesMachine(target) };
  if (leavesMachine(target)) {
    const binding = await writableBinding(roots, proposal.scope);
    plan.hub = hubFile(binding, { requestId, createdAt: proposal.createdAt, lesson, localRecordHash: digest(lessonDraft(lesson)) });
    plan.createdAt = proposal.createdAt;
  }
  if (general(target)) plan.personalRecordId = personalRecordIdFor({ requestId });
  if (target === "project") {
    const name = project ?? proposal.project;
    if (name === null || name === undefined) throw new DevtwinError("INVALID_INPUT", "Project target needs --project", { field: "project" });
    if (project !== undefined && proposal.project !== null && project !== proposal.project) throw new DevtwinError("CONFLICT", "Proposal belongs to another project", { project: proposal.project });
    assertProjectId(name, proposal.scope);
    await requireCommittedProject(roots, proposal.scope, name);
    plan.project = name;
    plan.projectRecordId = recordIdFor({ scope: proposal.scope, project: name, requestId });
  }
  const final = finalizePlan(plan);
  if (final.dialog) acceptDialog(final);
  return final;
}
// Publishes one lesson file. The precondition runs before the commit and after each rebase: the file must not be there.
async function publishLesson(roots, binding, hub, { now, createdAt }) {
  // The check reads the fetched remote branch, not the clone's work tree, which holds the new file after a rebase.
  const preconditions = async () => { if (hubGit(binding, ["cat-file", "-e", "refs/remotes/origin/" + binding.branch + ":" + hub.rel]).ok) throw new DevtwinError("CONFLICT", "Hub already has this lesson", { lessonId: hub.lessonId }); };
  const result = await publishToHub(roots, binding, { writes: [{ rel: hub.rel, content: hub.content }], message: "Add lesson " + hub.lessonId, preconditions, now, kind: "lesson", createdAt });
  return { lessonId: hub.lessonId, hubId: hub.hubId, pushed: result.pushed, ...(result.pushed ? { commit: result.commit, attempts: result.attempts } : { reason: result.reason, queued: result.queued }) };
}
async function configuredScopes(roots) {
  try { return (await readdir(join(roots.configRoot, "scopes"))).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((s) => SCOPE_ID.test(s)).sort(); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
// KTD22: lesson commands rebuild the index. A personal record is in every scope's index, so all of them rebuild.
async function rebuild(roots, scopes) {
  const out = [];
  for (const scope of scopes) {
    try { const index = await rebuildIndex(roots, scope); out.push({ scope, written: index.written, counts: index.counts }); }
    catch (error) { out.push({ scope, problem: error.code ?? "DEVTWIN_INTERNAL" }); }
  }
  return out;
}

export async function applyAccept(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planAccept(roots, input);
  assertFingerprint(plan, fingerprint);
  if (plan.dialog) await requireOwnerApproval(ctx, acceptDialog(plan));
  const outcome = await withProposalLock(roots, "lesson-accept", async () => {
    const proposal = await requirePending(roots, plan.proposalId);
    if (proposalHash(proposal) !== plan.proposalHash) throw new DevtwinError("STALE_VERSION", "Lesson proposal changed", { id: plan.proposalId });
    const result = { target: plan.target, acceptedAt: now().toISOString() };
    const binding = plan.hub ? await writableBinding(roots, plan.scope) : null;
    if (binding && (binding.hubId !== plan.hub.hubId || binding.actorRef !== plan.hub.author)) throw new DevtwinError("STALE_VERSION", "Hub binding changed");
    // Local writes come first. They are idempotent by request ID, so if the publish then fails, the same accept can run
    // again; the hub precondition keeps a second publish out.
    if (plan.personalRecordId) {
      const added = await addPersonalRecord(roots, { requestId: plan.requestId, recordedBy, draft: lessonDraft(plan.lesson, { reach: "personal", status: "observed" }) }, { now });
      result.personal = { recordId: added.recordId, recordHash: added.recordHash };
    }
    if (plan.projectRecordId) {
      const added = await addRecord(roots, { scope: plan.scope, project: plan.project, requestId: plan.requestId, recordedBy, draft: { ...lessonDraft(plan.lesson, { reach: "project", status: "observed" }), applicability: { level: "project" } } }, { now });
      result.project = { project: plan.project, recordId: added.recordId, recordHash: added.recordHash };
    }
    if (binding) result.hub = await publishLesson(roots, binding, plan.hub, { now, createdAt: plan.createdAt });
    await markAccepted(roots, proposal, plan.proposalHash, result, { now });
    return result;
  });
  const index = await rebuild(roots, plan.personalRecordId ? await configuredScopes(roots) : [plan.scope]);
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
  const index = await rebuild(roots, [plan.scope]);
  return { copied: true, recordId: plan.recordId, scope: plan.scope, hub, index };
}
