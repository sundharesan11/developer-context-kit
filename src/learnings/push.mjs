// U30 (R9, KTD29, KTD39, KTD40, KTD41): pushing a learning branch, and its undo.
//
// A learning branch written under a valid repo-push consent enters the held queue (src/held/queue.mjs) as one item for
// the target "repo:<sha256 of the root>" (enqueueLearningPush). After the consent's hold time the "repo" sender
// (registered here; the hourly learning-send job runs it) checks the item again and pushes it:
//   - the consent is still valid, the root is still an approved repoLearnings repository bound to the same project,
//     the learning ref still points at the item's commit, and the file still passes the sensitive and isolation checks;
//   - the push goes to the consent's recorded URL, named explicitly (never a remote name, so no remote.<name>.pushurl
//     applies), with per-command overrides that map that URL to itself for insteadOf and pushInsteadOf, so no rewrite
//     in the repository's config changes it; only SSH is allowed (protocol.allow=never, protocol.ssh.allow=always);
//   - the repository's configured push URL for origin must equal the recorded one, or the item stays held;
//   - it uses the scope's SSH command (the hub binding's), never forces, and runs no hook.
// An HTTPS remote pushes nothing: the result carries the exact command for the owner. A rejected push is dropped
// (devtwin never forces); a push that fails otherwise (offline) stays held and is tried again the next hour.
//
// Undo (KTD40) of a learning-branch entry ("repo-learning"):
//   - never pushed (held, local, dropped or cancelled): a held item is cancelled, and a revert commit goes on the
//     learning ref by fast-forward. Nothing is queued, so the branch stays local and adds nothing.
//   - pushed: the same revert commit, and its push is queued under the consent. Undo refuses, and names the manual
//     revert, once the commit is reachable from the learnings base or the remote branch is gone or moved.
import { createHash } from "node:crypto";
import { DevtwinError } from "../errors.mjs";
import { git } from "../identity/git.mjs";
import { repoLearningsAllowed } from "../config/pilot.mjs";
import { deterministicRequestId } from "../storage/plan.mjs";
import { DEFAULT_SSH_COMMAND } from "../hubs/git-write.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { readConsent, requireConsent } from "../consent/store.mjs";
import { readAudit, outboundStates, undoneMap } from "../audit/log.mjs";
import { registerUndoKind } from "../audit/undo.mjs";
import { enqueueHeld, heldForAudit, readHeldItem, removeHeld, withHeldLock } from "../held/queue.mjs";
import { registerSender, markState } from "../held/send.mjs";
import { learningsFor } from "../projects/commands.mjs";
import { repoGit, refValue, refFor, branchFor, isAncestor, transportOf, pushCommand, configuredPushUrl, scopeIdentity, learningRoot, learningsPlace, revertLearning } from "./repo-write.mjs";

export const PUSH_TIMEOUT_MS = 60_000;
export const repoTarget = (root) => "repo:" + createHash("sha256").update(root).digest("hex");
const reasonOf = (error) => error.code === "DEVTWIN_ISOLATION" ? "isolation" : error.code === "DEVTWIN_SENSITIVE_CONTENT" ? "sensitive" : "invalid";
// The per-command config every network call carries: SSH only, and the recorded URL mapped to itself so no insteadOf
// or pushInsteadOf rewrite from the repository's config applies (the longest match wins, and this one is exact).
const pinned = (url) => ["-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "url." + url + ".insteadOf=" + url, "-c", "url." + url + ".pushInsteadOf=" + url,
  "-c", "push.gpgSign=false", "-c", "submodule.recurse=false"];
const remoteGit = (root, url, args, ssh) => {
  try { return git(root, [...pinned(url), ...args], { timeoutMs: PUSH_TIMEOUT_MS, sshCommand: ssh ?? DEFAULT_SSH_COMMAND }); }
  catch (error) { if (error.code === "DEVTWIN_GIT_QUERY_FAILED" || error.code === "DEVTWIN_LIMIT") return { ok: false, status: null, stdout: "", stderr: "" }; throw error; }
};
// The remote branch's commit, null when it is not there, or undefined when the remote cannot be read.
export function remoteBranch(root, url, branch, ssh) {
  const r = remoteGit(root, url, ["ls-remote", "--", url, "refs/heads/" + branch], ssh);
  if (!r.ok) return undefined;
  const line = r.stdout.split("\n").find((l) => l.endsWith("\trefs/heads/" + branch));
  return line ? line.split("\t")[0] : null;
}
const REJECTED = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to update ref|stale info/;
function pushBranch(root, url, commit, branch, ssh) {
  const r = remoteGit(root, url, ["push", "--porcelain", "--no-verify", "--recurse-submodules=no", "--", url, commit + ":refs/heads/" + branch], ssh);
  return r.ok ? { ok: true } : { ok: false, rejected: REJECTED.test(r.stdout + "\n" + r.stderr) };
}

// Queues a learning branch's push under a valid consent, or says why not. item: { kind: "repo-learning" |
// "repo-revert", root, scope, project, learningId, branch, commit, rel, content, parent, title }.
export async function enqueueLearningPush(roots, consent, item, { audit, requestId, now, ctx }) {
  const url = consent.remoteUrl ?? null, transport = transportOf(url);
  if (transport === "https") return { queued: false, reason: "https", command: pushCommand(item.root, url, item.commit, item.branch), message: "devtwin does not push over HTTPS. Push the branch yourself with the command." };
  if (transport !== "ssh") return { queued: false, reason: transport === "none" ? "no-remote" : "transport" };
  const { kind, title, ...payload } = item;
  const held = await enqueueHeld(roots, { target: repoTarget(item.root), kind, title, audit, requestId,
    consent: { kind: consent.kind, holdHours: consent.holdHours, ruleDigest: consent.ruleDigest }, payload: { ...payload, remoteUrl: url } }, { now, ctx });
  return { queued: true, heldId: held.item.id, sendAfter: held.item.sendAfter, ...(held.notification ? { notification: held.notification } : {}) };
}

// The checks before a push: { drop, command? }, { keep } or { ok: { url, ssh } }.
async function pushCheck(roots, item, consent, terms) {
  const p = item.payload;
  if (!repoLearningsAllowed(roots.pilot, p.root)) return { keep: "not-approved" };
  const learnings = await learningsFor(roots, p.root);
  if (!learnings || learnings.scope !== p.scope || learnings.project !== p.project) return { drop: "rebound" };
  if (refValue(p.root, refFor(p.learningId)) !== p.commit) return { drop: "stale" };
  if (item.kind === "repo-learning") {
    const blob = repoGit(p.root, ["cat-file", "blob", p.commit + ":" + p.rel]);
    if (!blob.ok || blob.stdout !== p.content) return { drop: "stale" };
    try { assertOutboundClean(p.content, terms, { except: p.scope }); } catch (error) { return { drop: reasonOf(error) }; }
  }
  const url = consent.remoteUrl ?? null, transport = transportOf(url);
  if (transport === "https") return { drop: "https", command: pushCommand(p.root, url, p.commit, p.branch) };
  if (transport !== "ssh") return { drop: transport === "none" ? "no-remote" : "transport" };
  if (configuredPushUrl(p.root) !== url) return { keep: "push-url-differs" };
  let ssh;
  try { ssh = (await scopeIdentity(roots, p.scope)).sshCommand; } catch { return { keep: "no-identity" }; }
  // A revert goes only onto the branch devtwin pushed, as it was.
  if (item.kind === "repo-revert") {
    const remote = remoteBranch(p.root, url, p.branch, ssh);
    if (remote === undefined) return { keep: "push-failed" };
    if (remote === null) return { drop: "remote-gone" };
    if (remote !== p.parent) return { drop: "remote-moved" };
  }
  return { ok: { url, ssh } };
}
// The "repo" sender, for "repo:<hash>" targets.
async function sendRepo(roots, target, due, { now, route }) {
  const out = { sent: [], dropped: [], kept: [] };
  const terms = await isolationTerms(roots);
  for (const item of due) {
    const p = item.payload;
    if (typeof p.root !== "string" || repoTarget(p.root) !== target) { out.kept.push({ id: item.id, target, reason: "invalid" }); continue; }
    const consent = await readConsent(roots, "repo-push", p.root);
    if (!consent?.valid) { out.kept.push({ id: item.id, target, reason: "needs-consent" }); continue; }
    const outcome = await withHeldLock(roots, "held-send", async () => {
      if (!await readHeldItem(roots, target, item.id)) return { gone: true };
      const check = await pushCheck(roots, item, consent, terms);
      if (check.keep) return { keep: check.keep };
      if (check.drop) { removeHeld(roots, target, item.id); return { state: "dropped", reason: check.drop, ...(check.command ? { command: check.command } : {}) }; }
      const pushed = pushBranch(p.root, check.ok.url, p.commit, p.branch, check.ok.ssh);
      if (pushed.ok) { removeHeld(roots, target, item.id); return { state: "sent" }; }
      if (pushed.rejected) { removeHeld(roots, target, item.id); return { state: "dropped", reason: "rejected" }; }
      return { keep: "push-failed" };
    });
    if (outcome.gone) continue;
    if (outcome.keep) { out.kept.push({ id: item.id, target, reason: outcome.keep }); continue; }
    const audit = await markState(roots, item, outcome.state, { now, route, extra: [p.learningId] });
    const view = { id: item.id, target, kind: item.kind, branch: p.branch, commit: p.commit, audit: item.audit, state: audit.target };
    if (outcome.state === "dropped") out.dropped.push({ ...view, reason: outcome.reason, ...(outcome.command ? { command: outcome.command } : {}) });
    else out.sent.push(view);
  }
  return out;
}
registerSender("repo", sendRepo);

// Where a learning-branch entry stands: "held" (in the held queue), an outbound state (sent, dropped, cancelled), or
// "local" (written, never queued).
export async function learningState(roots, entry, entries) {
  const state = outboundStates(entries).get(entry.id);
  if (state) return state;
  return (await heldForAudit(roots, entry.id)) ? "held" : "local";
}
const ids = (entry) => ({ learningId: entry.itemIds.find((x) => x.startsWith("lrn_")), commit: entry.itemIds.find((x) => x.startsWith("cmt_"))?.slice(4) });

// KTD39: branches written without a consent wait for it. The activity digest lists them; `learning send --branch`
// queues one once the consent exists.
export async function waitingBranches(roots) {
  const { entries } = await readAudit(roots), done = undoneMap(roots, entries), out = [];
  for (const entry of entries) {
    if (entry.kind !== "repo-learning" || done.has(entry.id) || await learningState(roots, entry, entries) !== "local") continue;
    const branch = branchFor(ids(entry).learningId);
    let consent = null;
    try { consent = await readConsent(roots, "repo-push", await learningRoot(roots, entry.scope, entry.project)); } catch { consent = null; }
    out.push({ kind: "learning-branch", audit: entry.id, at: entry.at, scope: entry.scope, project: entry.project, branch, reason: consent?.valid ? "not-queued" : "needs-consent",
      next: consent?.valid ? "devtwin learning send --branch " + branch : "Grant consent grant --kind repo-push for the repository, then run learning send --branch " + branch });
  }
  return out;
}

// learning send --branch: queues a branch written before the consent existed (KTD39). Consented.
export async function planSend(roots, { branch }) {
  const { learningIdOfBranch } = await import("./repo-write.mjs");
  const learningId = learningIdOfBranch(branch);
  const { entries } = await readAudit(roots);
  const entry = entries.find((e) => e.kind === "repo-learning" && e.itemIds.includes(learningId));
  if (!entry) throw new DevtwinError("NOT_FOUND", "No learning branch with this name in the activity log", { branch });
  if (undoneMap(roots, entries).has(entry.id)) throw new DevtwinError("CONFLICT", "This learning branch was undone", { branch, audit: entry.id });
  const state = await learningState(roots, entry, entries);
  if (state !== "local") throw new DevtwinError("CONFLICT", "This learning branch is not waiting to be sent", { branch, state });
  const root = await learningRoot(roots, entry.scope, entry.project), { commit } = ids(entry);
  if (refValue(root, refFor(learningId)) !== commit) throw new DevtwinError("STALE_VERSION", "The learning branch changed since devtwin wrote it", { branch });
  const consent = await requireConsent(roots, "repo-push", root);
  const place = await learningsPlace(roots, root, entry.scope, entry.project);
  const changed = repoGit(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit + "^1", commit]);
  const rel = changed.ok ? changed.stdout.split("\0").filter(Boolean) : [];
  if (rel.length !== 1) throw new DevtwinError("STALE_VERSION", "The learning branch does not add exactly one file", { branch });
  const content = repoGit(root, ["cat-file", "blob", commit + ":" + rel[0]]).stdout;
  const { finalizePlan } = await import("../storage/plan.mjs");
  return finalizePlan({ kind: "learning-send", tier: "consented", consent: { kind: consent.kind, target: root, ruleDigest: consent.ruleDigest }, audit: entry.id, requestId: entry.requestId,
    item: { kind: "repo-learning", root, scope: entry.scope, project: entry.project, learningId, branch: branchFor(learningId), commit, rel: rel[0], content, title: "Learning branch " + branchFor(learningId) }, learningsDir: place.dir });
}
export async function applySend(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const { assertFingerprint } = await import("../storage/plan.mjs");
  const plan = await planSend(roots, input);
  assertFingerprint(plan, fingerprint);
  const consent = await requireConsent(roots, "repo-push", plan.item.root);
  return { branch: plan.item.branch, audit: plan.audit, push: await enqueueLearningPush(roots, consent, plan.item, { audit: plan.audit, requestId: plan.requestId, now, ctx }) };
}

// Undo of a learning branch. The checks run at preview and again under the held lock at apply; a refusal names the
// manual revert.
const manual = (message, reason, extra) => new DevtwinError("GATE_REQUIRED", message, { field: "id", reason, ...extra });
async function undoState(roots, entry) {
  const { learningId, commit } = ids(entry);
  const root = await learningRoot(roots, entry.scope, entry.project), branch = branchFor(learningId), ref = refFor(learningId);
  const tip = refValue(root, ref);
  if (!tip) throw manual("The learning branch " + branch + " is gone, so devtwin cannot undo it. Revert the lesson by hand if it was merged", "branch-missing", { branch });
  if (tip !== commit) throw manual("The learning branch " + branch + " moved since devtwin wrote it. Revert the lesson by hand", "branch-moved", { branch });
  const place = await learningsPlace(roots, root, entry.scope, entry.project);
  if (place.base && isAncestor(root, commit, place.base.commit)) throw manual("The lesson is already in " + place.base.ref + ". Revert it there by hand: git revert " + commit, "merged", { branch, commit, base: place.base.ref });
  const { entries } = await readAudit(roots);
  const state = await learningState(roots, entry, entries), pushed = state === "sent";
  const identity = await scopeIdentity(roots, entry.scope);
  let consent = null;
  if (pushed) {
    consent = await requireConsent(roots, "repo-push", root);
    const remote = remoteBranch(root, consent.remoteUrl, branch, identity.sshCommand);
    if (remote === undefined) throw new DevtwinError("GIT_QUERY_FAILED", "Could not read the remote branch; try again when the remote is reachable", { command: "ls-remote", branch });
    if (remote === null) throw manual("The remote branch " + branch + " is gone. If the lesson was merged, revert it by hand: git revert " + commit, "remote-gone", { branch, commit });
    if (remote !== commit) throw manual("The remote branch " + branch + " moved. Revert the lesson by hand: git revert " + commit, "remote-moved", { branch, commit });
  }
  return { root, learningId, branch, ref, commit, state, pushed, consent, identity, held: state === "held" ? await heldForAudit(roots, entry.id) : null };
}
const repoLearningUndo = {
  async preview(roots, entry) {
    const s = await undoState(roots, entry);
    return { heads: [], revert: { branch: s.branch, commit: s.commit, push: s.pushed, ...(s.held ? { held: s.held.id } : {}) } };
  },
  recordIds: async () => [],
  async apply(roots, entry, { now, audit, ctx = {} }) {
    const done = await withHeldLock(roots, "undo", async () => {
      const s = await undoState(roots, entry);
      if (s.held && !removeHeld(roots, s.held.target, s.held.id)) throw new DevtwinError("STALE_VERSION", "The held item already left the queue", { id: entry.id });
      const revert = revertLearning(s.root, s.identity, { ref: s.ref, commit: s.commit, title: s.branch });
      return { ...s, revert };
    });
    const result = { branch: done.branch, revert: done.revert, ...(done.held ? { cancelled: { held: done.held.id } } : {}) };
    if (!done.pushed) return { ...result, push: { queued: false, reason: "never-pushed" } };
    const push = await enqueueLearningPush(roots, done.consent, { kind: "repo-revert", root: done.root, scope: entry.scope, project: entry.project, learningId: done.learningId, branch: done.branch,
      commit: done.revert, parent: done.commit, rel: null, content: null, title: "Revert of " + done.branch }, { audit, requestId: deterministicRequestId("learning-revert", { entry: entry.id }), now, ctx });
    return { ...result, push };
  }
};
registerUndoKind("repo-learning", repoLearningUndo);
