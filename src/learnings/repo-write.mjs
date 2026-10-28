// U30 (R9, KTD29): the learning branch. A lesson accepted with the repo target becomes one commit on a new branch
// refs/heads/devtwin/learning-<id> in the project's repository. The commit adds exactly one file,
// <learnings dir>/<slug>.md, on top of the project's learnings base (src/projects/commands.mjs; default the remote
// default branch that refs/remotes/origin/HEAD names). Writing the branch is automatic (src/policy/tiers.mjs); pushing
// it is the consented step (src/learnings/push.mjs).
//
// Only Git plumbing runs, through git() (src/identity/git.mjs: hooks, fsmonitor, global and system config and replace
// refs off):
// hash-object --stdin --no-filters, ls-tree, mktree, commit-tree and update-ref, plus reads (rev-parse, cat-file,
// config --get, merge-base). None of them reads or writes the working tree or the index, runs a filter or moves HEAD,
// so a filter driver in the repository's own config never runs. The one ref devtwin creates is its own learning ref,
// and update-ref creates it only when it does not exist yet. The only later move is an undo, which adds a revert
// commit to that same ref by fast-forward (revertLearning). Before the ref is made, the new commit is checked: one
// parent, the base, and a diff to it that adds the one file and changes nothing else (addsOnly).
//
// Every check runs before anything is written: the repository is an approved repoLearnings root bound to the project,
// the scope has a recorded Git identity (its hub binding's handle and email, passed as per-command -c user.name and
// -c user.email), the repository does not require signed commits, the learnings base resolves, the branch and the file
// do not exist yet, and the file text passes the sensitive and isolation checks.
import { DevtwinError } from "../errors.mjs";
import { git, stripCredentials } from "../identity/git.mjs";
import { repoLearningsAllowed } from "../config/pilot.mjs";
import { readHubBinding } from "../config/store.mjs";
import { digest } from "../storage/canonical.mjs";
import { isolationTerms, assertOutboundClean } from "../records/isolation.mjs";
import { learningsBase } from "../import/solutions.mjs";
import { lessonBody } from "../lessons/propose.mjs";
import { readLearningsSettings, projectRoots, DEFAULT_LEARNINGS_DIR } from "../projects/commands.mjs";

export const LEARNING_ID = /^lrn_[a-f0-9]{24}$/;
export const learningIdFor = (requestId) => "lrn_" + digest({ kind: "repo-learning", requestId }).slice(7, 31);
export const branchFor = (learningId) => "devtwin/learning-" + learningId.slice(4);
export const refFor = (learningId) => "refs/heads/" + branchFor(learningId);
export const learningIdOfBranch = (branch) => {
  const match = /^(?:refs\/heads\/)?devtwin\/learning-([a-f0-9]{24})$/.exec(branch ?? "");
  if (!match) throw new DevtwinError("INVALID_INPUT", "A learning branch is named devtwin/learning-<id>", { field: "branch" });
  return "lrn_" + match[1];
};
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const gate = (message, reason, extra = {}) => new DevtwinError("GATE_REQUIRED", message, { reason, ...extra });

// One Git call in the repository. A failed required step stops with GIT_QUERY_FAILED naming the step.
export const repoGit = (root, args, options) => git(root, args, options);
function required(result, step) {
  if (!result.ok) throw new DevtwinError("GIT_QUERY_FAILED", "Git step failed", { command: step, status: result.status });
  return result.stdout;
}
const oid = (text, step) => {
  const value = text.trim();
  if (!OID.test(value)) throw new DevtwinError("GIT_QUERY_FAILED", "Git step failed", { command: step });
  return value;
};
export const refValue = (root, ref) => { const r = repoGit(root, ["rev-parse", "-q", "--verify", ref + "^{commit}"]); return r.ok ? oid(r.stdout, "rev-parse") : null; };
export const isAncestor = (root, commit, of) => repoGit(root, ["merge-base", "--is-ancestor", commit, of]).status === 0;
// The parents a commit object records, read from the object itself (cat-file), so no graft changes them. null when it
// is not a commit.
export function commitParents(root, commit) {
  if (!OID.test(commit ?? "")) return null;
  const r = repoGit(root, ["cat-file", "commit", commit]);
  if (!r.ok) return null;
  return r.stdout.split("\n\n", 1)[0].split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
}
// The changes from one commit's tree to another's: [{ from, to, status, path }] with file modes, no rename detection.
// null when Git fails.
export function changesBetween(root, from, to) {
  const r = repoGit(root, ["diff-tree", "--no-renames", "--ignore-submodules=none", "-r", "--raw", "-z", from, to]);
  if (!r.ok) return null;
  const parts = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const [from, to, , , status] = parts[i].replace(/^:/, "").split(" ");
    out.push({ from, to, status, path: parts[i + 1] });
  }
  return out;
}
// True when the commit has exactly one parent, that parent, and its only change is one new regular file at rel.
export function addsOnly(root, commit, parent, rel) {
  const parents = commitParents(root, commit);
  if (parents?.length !== 1 || parents[0] !== parent) return false;
  const changes = changesBetween(root, parent, commit);
  return changes?.length === 1 && changes[0].status === "A" && changes[0].to === "100644" && changes[0].path === rel;
}

// The push URL of the repository's origin, as Git resolves it from the repository's own config (pushurl and any
// insteadOf rewrite applied), with credentials in an HTTPS URL removed. null when there is no origin.
export function configuredPushUrl(root) {
  const r = repoGit(root, ["remote", "get-url", "--push", "origin"]);
  const url = r.ok ? r.stdout.trim() : "";
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return stripCredentials(url);
  // An SSH user name is not a secret; a password in an ssh:// URL is removed.
  if (/^ssh:\/\/[^/@]*:[^/@]*@/i.test(url)) return url.replace(/^(ssh:\/\/[^/:@]*):[^/@]*@/i, "$1@");
  return url;
}
// How a recorded URL is pushed: "ssh" (ssh:// or the scp-like user@host:path), "https" (never pushed; the owner gets
// the command), "none" (no URL) or "other" (a local path, git://, file:// and the rest: refused).
export function transportOf(url) {
  if (url === null || url === undefined) return "none";
  if (/[\s?#]/.test(url)) return "other";
  if (/^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*(?::[0-9]{1,5})?\/[^-]\S*$/i.test(url)) return "ssh";
  if (/^https?:\/\//i.test(url)) return "https";
  if (!url.includes("://") && /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*:[^-\s]\S*$/.test(url)) return "ssh";
  return "other";
}
const shq = (text) => "'" + String(text).replace(/'/g, "'\\''") + "'";
// The command the owner runs for a remote devtwin does not push to.
export const pushCommand = (root, url, commit, branch) => "git -C " + shq(root) + " push " + shq(url ?? "<remote>") + " " + commit + ":refs/heads/" + branch;

// The scope's recorded Git identity and SSH command: the handle and email its hub binding records (hub join).
export async function scopeIdentity(roots, scope) {
  const binding = await readHubBinding(roots, scope);
  if (!binding?.handle || !binding?.email) throw gate("No recorded Git identity for this scope. Join its hub first: hub join records the handle and email a learning branch commits as", "no-identity", { field: "identity", scope, remedy: "hub join" });
  return { name: binding.handle, email: binding.email, sshCommand: binding.sshCommand ?? null };
}
// The repository root a project's learning branches go to: its first bound root that repoLearnings approves.
export async function learningRoot(roots, scope, project) {
  const root = (await projectRoots(roots, scope, project)).find((path) => repoLearningsAllowed(roots.pilot, path));
  if (!root) throw gate("This project's repository is not approved for learning branches. Approve it with live write-classes --repo-learnings <root>", "not-approved", { field: "writeClasses.repoLearnings", scope, project, remedy: "live write-classes --repo-learnings" });
  return root;
}
// The learnings folder and base commit of a project's repository.
export async function learningsPlace(roots, root, scope, project) {
  const settings = await readLearningsSettings(roots, scope, project);
  const base = learningsBase(root, { learningsBase: settings.learningsBase });
  return { dir: settings.learningsDir ?? DEFAULT_LEARNINGS_DIR, base, configuredBase: settings.learningsBase };
}
function assertUnsigned(root) {
  const r = repoGit(root, ["config", "--bool", "--get", "commit.gpgsign"]);
  if (r.ok && r.stdout.trim() === "true") throw gate("This repository requires signed commits (commit.gpgSign), and devtwin does not sign learning branches. Leave out the repo target for this repository", "signing-required", { field: "commit.gpgsign" });
}

export function slugOf(title) {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 60).replace(/-+$/, "");
  return slug || "lesson";
}
// The fixed file template: front matter (title, date, category, tags, source) and the lesson text.
export function renderLearning({ title, date, tags, sourceId, body }) {
  return ["---", "title: " + JSON.stringify(title), "date: " + date, "category: lesson", "tags: " + JSON.stringify(tags), "source: devtwin " + sourceId, "---", "", "# " + title, "", body.trimEnd(), ""].join("\n");
}
const commitMessage = (title, sourceId) => "Add devtwin lesson: " + title.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60) + "\n\nSource: devtwin " + sourceId + "\n";

// Every check, and the exact file, before anything is written. resumed: a retry of an accept whose branch was written
// before it stopped (the audit entry names the branch's commit) -> { commit, audit }.
export async function prepareLearning(roots, { scope, project, lesson, requestId, sourceId, createdAt }) {
  const root = await learningRoot(roots, scope, project);
  const identity = await scopeIdentity(roots, scope);
  const learningId = learningIdFor(requestId), branch = branchFor(learningId), ref = refFor(learningId);
  const place = await learningsPlace(roots, root, scope, project);
  if (!place.base) throw gate("No learnings base: the repository has no refs/remotes/origin/HEAD and the project names no base. Set one with project set --learnings-base", "no-learnings-base", { field: "learnings-base", remedy: "project set --learnings-base" });
  assertUnsigned(root);
  const rel = place.dir + "/" + slugOf(lesson.title) + ".md";
  const tags = [...new Set([...lesson.match.topics, ...lesson.match.packages])];
  const content = renderLearning({ title: lesson.title, date: createdAt.slice(0, 10), tags, sourceId, body: lessonBody(lesson) });
  // The repository belongs to the scope, so only the other scopes' names are refused.
  assertOutboundClean(content, await isolationTerms(roots), { except: scope });
  const prepared = { root, scope, project, learningId, branch, ref, rel, title: lesson.title, sourceId, requestId, base: place.base, identity: { name: identity.name, email: identity.email }, content, message: commitMessage(lesson.title, sourceId) };
  const existing = refValue(root, ref);
  if (existing) {
    const { readAudit } = await import("../audit/log.mjs");
    const entry = (await readAudit(roots)).entries.find((e) => e.kind === "repo-learning" && e.requestId === requestId && e.itemIds.includes("cmt_" + existing));
    if (!entry) throw new DevtwinError("CONFLICT", "A branch with this learning's name already exists", { branch });
    return { ...prepared, resumed: { commit: existing, audit: entry.id } };
  }
  if (repoGit(root, ["cat-file", "-e", place.base.commit + ":" + rel]).ok) throw new DevtwinError("CONFLICT", "The learnings base already has a file with this name", { rel });
  return prepared;
}

// Tree entries of one tree object, from ls-tree -z: { mode, type, oid, name }.
function treeEntries(root, tree) {
  if (!tree) return [];
  return required(repoGit(root, ["ls-tree", "-z", tree]), "ls-tree").split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t"), [mode, type, id] = row.slice(0, tab).split(" ");
    return { mode, type, oid: id, name: row.slice(tab + 1) };
  });
}
const mktree = (root, entries) => oid(required(repoGit(root, ["mktree", "-z"], { input: entries.map((e) => e.mode + " " + e.type + " " + e.oid + "\t" + e.name + "\0").join("") }), "mktree"), "mktree");
// The base tree with one more file at rel, built level by level with mktree.
function treeWith(root, baseCommit, rel, blob) {
  const parts = rel.split("/"), name = parts.pop(), levels = [oid(required(repoGit(root, ["rev-parse", baseCommit + "^{tree}"]), "rev-parse"), "rev-parse")];
  for (const part of parts) {
    const entry = treeEntries(root, levels.at(-1)).find((e) => e.name === part);
    if (entry && entry.type !== "tree") throw new DevtwinError("CONFLICT", "The learnings folder is a file in the learnings base", { rel });
    levels.push(entry?.oid ?? null);
  }
  const put = (entries, item) => [...entries.filter((e) => e.name !== item.name), item];
  let child = mktree(root, put(treeEntries(root, levels.at(-1)), { mode: "100644", type: "blob", oid: blob, name }));
  for (let i = parts.length - 1; i >= 0; i--) child = mktree(root, put(treeEntries(root, levels[i]), { mode: "040000", type: "tree", oid: child, name: parts[i] }));
  return child;
}
const identityArgs = (identity) => ["-c", "user.name=" + identity.name, "-c", "user.email=" + identity.email];
// Writes the blob, trees and commit (objects only; no ref yet) and returns the commit.
export function buildLearningCommit(prepared) {
  const { root } = prepared;
  const blob = oid(required(repoGit(root, ["hash-object", "-w", "--no-filters", "--stdin"], { input: prepared.content }), "hash-object"), "hash-object");
  const tree = treeWith(root, prepared.base.commit, prepared.rel, blob);
  const commit = oid(required(repoGit(root, [...identityArgs(prepared.identity), "commit-tree", "--no-gpg-sign", tree, "-p", prepared.base.commit, "-m", prepared.message]), "commit-tree"), "commit-tree");
  if (!addsOnly(root, commit, prepared.base.commit, prepared.rel)) throw new DevtwinError("INTEGRITY", "The learning commit does not add exactly one file to the learnings base", { rel: prepared.rel });
  return commit;
}
// A commit an earlier, stopped accept made: the same tree on the same base.
export function sameLearningCommit(prepared, commit) {
  const { root } = prepared;
  if (!OID.test(commit) || !repoGit(root, ["cat-file", "-e", commit + "^{commit}"]).ok) return false;
  const parent = repoGit(root, ["rev-parse", "-q", "--verify", commit + "^1"]);
  if (!parent.ok || parent.stdout.trim() !== prepared.base.commit) return false;
  const blob = repoGit(root, ["rev-parse", "-q", "--verify", commit + ":" + prepared.rel]);
  return blob.ok && addsOnly(root, commit, prepared.base.commit, prepared.rel) && repoGit(root, ["cat-file", "blob", commit + ":" + prepared.rel]).stdout === prepared.content;
}
// Creates the learning ref. update-ref with an all-zero old value fails when the ref exists, so it never moves one.
export function createLearningRef(prepared, commit) {
  const { root, ref } = prepared;
  if (refValue(root, ref) === commit) return;
  required(repoGit(root, ["update-ref", "-m", "devtwin learning", ref, commit, "0".repeat(commit.length)]), "update-ref");
}
// The undo of a learning branch: a revert commit (the parent's tree) on top of the learning commit, moved onto the
// learning ref by fast-forward from that exact commit. -> the revert commit
export function revertLearning(root, identity, { ref, commit, title }) {
  const parent = oid(required(repoGit(root, ["rev-parse", "--verify", commit + "^1"]), "rev-parse"), "rev-parse");
  const tree = oid(required(repoGit(root, ["rev-parse", parent + "^{tree}"]), "rev-parse"), "rev-parse");
  const revert = oid(required(repoGit(root, [...identityArgs(identity), "commit-tree", "--no-gpg-sign", tree, "-p", commit, "-m", "Revert devtwin lesson: " + title.slice(0, 60) + "\n\nThis reverts commit " + commit + ".\n"]), "commit-tree"), "commit-tree");
  required(repoGit(root, ["update-ref", "-m", "devtwin learning undo", ref, revert, commit]), "update-ref");
  return revert;
}
