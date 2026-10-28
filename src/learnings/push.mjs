// U30 (R9, KTD29, KTD39, KTD40, KTD41): pushing a learning branch, and its undo.
//
// A learning branch written under a valid repo-push consent enters the held queue (src/held/queue.mjs) as one item for
// the target "repo:<sha256 of the root>" (enqueueLearningPush). After the consent's hold time the "repo" sender
// (registered here; the hourly learning-send job runs it) checks the item again, under the held lock, and pushes it:
//   - the consent is read again for the item and must be the grant it was queued under (consentGap in
//     src/held/send.mjs); the root is still an approved repoLearnings repository bound to the same project, the
//     learning ref still points at the item's commit, and the file still passes the sensitive and isolation checks;
//   - the repository's configured push URL for origin must equal the consent's recorded URL, or the item stays held
//     ("push-url-differs");
//   - every Git command from here runs in a throwaway bare repository made for this push (withPushRepo): clean config,
//     no refs, no hooks, and the source repository's objects through objects/info/alternates. So no pushurl,
//     insteadOf, pushInsteadOf, receivepack, uploadpack or push option from the repository's config applies, and no
//     replace ref or graft changes a commit (git() also turns replace refs off). Only SSH is allowed
//     (protocol.allow=never, protocol.ssh.allow=always), with the scope's SSH command (the hub binding's);
//   - the commit has one parent and adds exactly the lesson file and nothing else (addsOnly in repo-write.mjs); a revert
//     has the learning commit as its one parent and removes exactly that file;
//   - the learnings base is checked on the remote: the base ref maps to a remote branch (refs/remotes/<remote>/<name>
//     to refs/heads/<name>), and the learning commit's parent is that branch's tip on the consent's URL, or an ancestor
//     of it that is in the local objects. Otherwise the item stays held ("base-not-on-remote"), so a local
//     remote-tracking ref that a process moved cannot carry other commits out;
//   - the push names the consent's URL and the commit by object ID, <oid>:refs/heads/devtwin/learning-<id>, and never
//     forces.
// An HTTPS remote pushes nothing: the result carries the exact command for the owner. A rejected push is dropped
// (devtwin never forces); a push that fails otherwise (offline) stays held and is tried again the next hour. A kept item
// records its reason, which the activity digest shows.
//
// Undo (KTD40) of a learning-branch entry ("repo-learning"):
//   - never pushed (held, local, dropped or cancelled): a held item is cancelled, and a revert commit goes on the
//     learning ref by fast-forward. Nothing is queued, so the branch stays local and adds nothing.
//   - pushed: the same revert commit, and its push is queued under the consent. Undo refuses, and names the manual
//     revert, once the commit is reachable from the learnings base or the remote branch is gone or moved.
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { git } from "../identity/git.mjs";
import { assertWritable, repoLearningsAllowed } from "../config/pilot.mjs";
import { ensurePrivatePath } from "../storage/fsx.mjs";
import { deterministicRequestId } from "../storage/plan.mjs";
import { DEFAULT_SSH_COMMAND } from "../hubs/git-write.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { readConsent, requireConsent } from "../consent/store.mjs";
import { readAudit, outboundStates, undoneMap } from "../audit/log.mjs";
import { registerUndoKind } from "../audit/undo.mjs";
import { enqueueHeld, heldForAudit, readHeldItem, removeHeld, rearmHeld, withHeldLock } from "../held/queue.mjs";
import { registerSender, markState, consentGap, keepHeld } from "../held/send.mjs";
import { learningsFor } from "../projects/commands.mjs";
import { repoGit, refValue, refFor, branchFor, isAncestor, commitParents, changesBetween, addsOnly, transportOf, pushCommand, configuredPushUrl, scopeIdentity, learningRoot, learningsPlace, revertLearning } from "./repo-write.mjs";

export const PUSH_TIMEOUT_MS = 60_000;
export const repoTarget = (root) => "repo:" + createHash("sha256").update(root).digest("hex");
const reasonOf = (error) => error.code === "DEVTWIN_ISOLATION" ? "isolation" : error.code === "DEVTWIN_SENSITIVE_CONTENT" ? "sensitive" : "invalid";
const failed = (command) => new DevtwinError("GIT_QUERY_FAILED", "Git step failed", { command });

// A throwaway bare repository for one push, at stateRoot/tmp/learning-push-<random> (0700), removed afterwards, also on
// failure. It has Git's default config only, no refs and no hooks; objects/info/alternates points at the source
// repository's object folder (its real path, from rev-parse --git-common-dir). -> action(dir)
export async function withPushRepo(roots, root, action) {
  const common = repoGit(root, ["rev-parse", "--git-common-dir"]), format = repoGit(root, ["rev-parse", "--show-object-format"]);
  if (!common.ok || !format.ok || !/^sha(?:1|256)$/.test(format.stdout.trim())) throw failed("rev-parse");
  const raw = common.stdout.trim(), objects = join(isAbsolute(raw) ? raw : resolve(root, raw), "objects");
  let real = null;
  try { real = realpathSync(objects); } catch { real = null; }
  if (real !== objects || !lstatSync(objects).isDirectory() || /[\n\r]/.test(objects)) throw new DevtwinError("PATH_UNSAFE", "The repository's object folder is not a plain folder", { field: "objects" });
  const parent = ensurePrivatePath(roots.stateRoot, ["tmp"]);
  assertWritable(roots, [parent]);
  const dir = mkdtempSync(join(parent, "learning-push-"));
  try {
    if (!git(dir, ["init", "-q", "--bare", "--template=", "--object-format=" + format.stdout.trim(), dir]).ok) throw failed("init");
    writeFileSync(join(dir, "objects", "info", "alternates"), objects + "\n", { flag: "wx", mode: 0o600 });
    return await action(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
// One Git call in the push repository. SSH only; commit-graph files (which the alternates could supply) are not read.
const NET = ["-c", "protocol.allow=never", "-c", "protocol.ssh.allow=always", "-c", "core.commitGraph=false"];
const cleanGit = (dir, args, ssh) => {
  try { return git(dir, [...NET, ...args], { timeoutMs: PUSH_TIMEOUT_MS, sshCommand: ssh ?? DEFAULT_SSH_COMMAND }); }
  catch (error) { if (error.code === "DEVTWIN_GIT_QUERY_FAILED" || error.code === "DEVTWIN_LIMIT") return { ok: false, status: null, stdout: "", stderr: "" }; throw error; }
};
// A remote ref's commit, null when it is not there, or undefined when the remote cannot be read. dir: a push repository.
export function remoteRef(dir, url, ref, ssh) {
  const r = cleanGit(dir, ["ls-remote", "--", url, ref], ssh);
  if (!r.ok) return undefined;
  const line = r.stdout.split("\n").find((l) => l.split("\t")[1] === ref);
  return line ? line.split("\t")[0] : null;
}
const REJECTED = /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to update ref|stale info/;
function pushBranch(dir, url, commit, branch, ssh) {
  const r = cleanGit(dir, ["push", "--porcelain", "--no-verify", "--recurse-submodules=no", "--", url, commit + ":refs/heads/" + branch], ssh);
  return r.ok ? { ok: true } : { ok: false, rejected: REJECTED.test(r.stdout + "\n" + r.stderr) };
}
// The remote branch a learnings base names: refs/remotes/<remote>/<name> -> refs/heads/<name>, or null.
export function remoteBaseRef(ref) {
  const match = /^refs\/remotes\/[^/]+\/(.+)$/.exec(ref ?? "");
  return match && match[1] !== "HEAD" ? "refs/heads/" + match[1] : null;
}

// Queues a learning branch's push under a valid consent, or says why not. item: { kind: "repo-learning" |
// "repo-revert", root, scope, project, learningId, branch, commit, rel, content, parent, title }.
export async function enqueueLearningPush(roots, consent, item, { audit, requestId, now, ctx }) {
  const url = consent.remoteUrl ?? null, transport = transportOf(url);
  if (transport === "https") return { queued: false, reason: "https", command: pushCommand(item.root, url, item.commit, item.branch), message: "devtwin does not push over HTTPS. Push the branch yourself with the command." };
  if (transport !== "ssh") return { queued: false, reason: transport === "none" ? "no-remote" : "transport" };
  const { kind, title, ...payload } = item;
  const held = await enqueueHeld(roots, { target: repoTarget(item.root), kind, title, audit, requestId,
    consent: { kind: consent.kind, holdHours: consent.holdHours, ruleDigest: consent.ruleDigest, grantedAt: consent.grantedAt }, payload: { ...payload, remoteUrl: url } }, { now, ctx });
  return { queued: true, heldId: held.item.id, sendAfter: held.item.sendAfter, ...(held.notification ? { notification: held.notification } : {}) };
}

// The checks before a push that need no network: { drop, command? }, { keep } or { ok: { url, ssh } }.
async function localCheck(roots, item, consent, terms) {
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
  return { ok: { url, ssh } };
}
// A revert's one change: it removes the one file its parent, a learning commit, added.
function revertsOnly(dir, revert, learning) {
  const parents = commitParents(dir, learning);
  if (parents?.length !== 1) return false;
  const added = changesBetween(dir, parents[0], learning), removed = changesBetween(dir, learning, revert);
  return added?.length === 1 && added[0].status === "A" && removed?.length === 1 && removed[0].status === "D" && removed[0].path === added[0].path;
}
// The checks in the push repository: the commit's shape, then the remote. -> { drop }, { keep } or { ok: true }
async function remoteCheck(roots, dir, item, { url, ssh }) {
  const p = item.payload, parents = commitParents(dir, p.commit);
  if (parents?.length !== 1) return { drop: "invalid" };
  if (item.kind === "repo-revert") {
    // A revert goes only onto the branch devtwin pushed, as it was.
    if (parents[0] !== p.parent || !revertsOnly(dir, p.commit, p.parent)) return { drop: "invalid" };
    const remote = remoteRef(dir, url, "refs/heads/" + p.branch, ssh);
    if (remote === undefined) return { keep: "push-failed" };
    if (remote === null) return { drop: "remote-gone" };
    if (remote !== p.parent) return { drop: "remote-moved" };
    return { ok: true };
  }
  if (!addsOnly(dir, p.commit, parents[0], p.rel)) return { drop: "invalid" };
  const place = await learningsPlace(roots, p.root, p.scope, p.project), branch = remoteBaseRef(place.base?.ref);
  if (!branch) return { keep: "base-not-on-remote" };
  const tip = remoteRef(dir, url, branch, ssh);
  if (tip === undefined) return { keep: "push-failed" };
  const known = (oid) => cleanGit(dir, ["cat-file", "-e", oid + "^{commit}"]).ok;
  if (tip === null || (tip !== parents[0] && !(known(tip) && cleanGit(dir, ["merge-base", "--is-ancestor", parents[0], tip]).status === 0))) return { keep: "base-not-on-remote" };
  return { ok: true };
}
// The "repo" sender, for "repo:<hash>" targets. Each item is checked and pushed under the held lock, with the consent
// read again there.
async function sendRepo(roots, target, due, { now, route }) {
  const out = { sent: [], dropped: [], kept: [] };
  const terms = await isolationTerms(roots);
  for (const item of due) {
    if (typeof item.payload.root !== "string" || repoTarget(item.payload.root) !== target) { out.kept.push({ id: item.id, target, reason: "invalid" }); continue; }
    const outcome = await withHeldLock(roots, "held-send", async () => {
      const current = await readHeldItem(roots, target, item.id);
      if (!current) return { gone: true };
      const p = current.payload, consent = await readConsent(roots, "repo-push", p.root);
      const gap = consentGap(current, consent);
      if (gap) return keepHeld(roots, current, gap, now);
      const local = await localCheck(roots, current, consent, terms);
      let check = local;
      if (local.ok) {
        try {
          check = await withPushRepo(roots, p.root, async (dir) => {
            const remote = await remoteCheck(roots, dir, current, local.ok);
            if (!remote.ok) return remote;
            const pushed = pushBranch(dir, local.ok.url, p.commit, p.branch, local.ok.ssh);
            return pushed.ok ? { sent: true } : pushed.rejected ? { drop: "rejected" } : { keep: "push-failed" };
          });
        } catch (error) {
          if (!(error instanceof DevtwinError)) throw error;
          check = { keep: error.code === "DEVTWIN_PATH_UNSAFE" ? "unsafe-repository" : "push-failed" };
        }
      }
      if (check.keep) return keepHeld(roots, current, check.keep, now);
      removeHeld(roots, target, item.id);
      if (check.drop) return { state: "dropped", reason: check.drop, ...(check.command ? { command: check.command } : {}) };
      return { state: "sent" };
    });
    if (outcome.gone) continue;
    if (outcome.keep) { out.kept.push({ id: item.id, target, reason: outcome.keep }); continue; }
    const p = item.payload;
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

// learning send --branch: queues a branch written before the consent existed (KTD39), or queues again a held one that
// was kept as "consent-changed" (queued under an earlier grant): it goes under the current grant with a new hold.
// Consented.
export async function planSend(roots, { branch }) {
  const { learningIdOfBranch } = await import("./repo-write.mjs");
  const learningId = learningIdOfBranch(branch);
  const { entries } = await readAudit(roots);
  const entry = entries.find((e) => e.kind === "repo-learning" && e.itemIds.includes(learningId));
  if (!entry) throw new DevtwinError("NOT_FOUND", "No learning branch with this name in the activity log", { branch });
  if (undoneMap(roots, entries).has(entry.id)) throw new DevtwinError("CONFLICT", "This learning branch was undone", { branch, audit: entry.id });
  const state = await learningState(roots, entry, entries);
  const root = await learningRoot(roots, entry.scope, entry.project), { commit } = ids(entry);
  const consent = state === "local" || state === "held" ? await requireConsent(roots, "repo-push", root) : null;
  const held = state === "held" ? await heldForAudit(roots, entry.id) : null;
  if (state !== "local" && !(held && consentGap(held, consent) === "consent-changed")) throw new DevtwinError("CONFLICT", "This learning branch is not waiting to be sent", { branch, state });
  if (refValue(root, refFor(learningId)) !== commit) throw new DevtwinError("STALE_VERSION", "The learning branch changed since devtwin wrote it", { branch });
  const place = await learningsPlace(roots, root, entry.scope, entry.project);
  const parents = commitParents(root, commit), changed = parents?.length === 1 ? changesBetween(root, parents[0], commit) : null;
  if (changed?.length !== 1 || !addsOnly(root, commit, parents[0], changed[0].path)) throw new DevtwinError("STALE_VERSION", "The learning branch does not add exactly one file", { branch });
  const rel = changed[0].path, content = repoGit(root, ["cat-file", "blob", commit + ":" + rel]).stdout;
  const { finalizePlan } = await import("../storage/plan.mjs");
  return finalizePlan({ kind: "learning-send", tier: "consented", consent: { kind: consent.kind, target: root, ruleDigest: consent.ruleDigest, grantedAt: consent.grantedAt }, audit: entry.id, requestId: entry.requestId,
    item: { kind: "repo-learning", root, scope: entry.scope, project: entry.project, learningId, branch: branchFor(learningId), commit, rel, content, title: "Learning branch " + branchFor(learningId) }, learningsDir: place.dir,
    ...(held ? { requeue: held.id } : {}) });
}
export async function applySend(roots, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const { assertFingerprint } = await import("../storage/plan.mjs");
  const plan = await planSend(roots, input);
  assertFingerprint(plan, fingerprint);
  const consent = await requireConsent(roots, "repo-push", plan.item.root);
  if (!plan.requeue) return { branch: plan.item.branch, audit: plan.audit, push: await enqueueLearningPush(roots, consent, plan.item, { audit: plan.audit, requestId: plan.requestId, now, ctx }) };
  // The held item goes under the current grant. Nothing else about it changes: same commit, same file.
  const target = repoTarget(plan.item.root);
  const rearmed = await withHeldLock(roots, "learning-send", async () => {
    const item = await readHeldItem(roots, target, plan.requeue);
    if (!item || item.payload.commit !== plan.item.commit || consentGap(item, consent) !== "consent-changed") throw new DevtwinError("STALE_VERSION", "The held item changed", { id: plan.requeue });
    return rearmHeld(roots, item, consent, { now, ctx });
  });
  return { branch: plan.item.branch, audit: plan.audit, push: { queued: true, requeued: true, heldId: rearmed.item.id, sendAfter: rearmed.item.sendAfter, notification: rearmed.notification } };
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
    const remote = await withPushRepo(roots, root, async (dir) => remoteRef(dir, consent.remoteUrl, "refs/heads/" + branch, identity.sshCommand));
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
