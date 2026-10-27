import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { git as runGitDefault } from "../identity/git.mjs";
import { readCommonDir } from "../lessons/index.mjs";
import { readPrivateJson, ensurePrivatePath, atomicReplace, info } from "../storage/fsx.mjs";
import { plainRuleProblem } from "../audit/checks.mjs";
import { scanSensitive } from "../records/redact.mjs";
// U33 (R12, KTD32): the stop stub. On a Stop or PreCompact event in a bound project the hook records where this
// worktree stood: stateRoot/handoffs/<scope>/<project>/<worktree-hash>.json, by atomic replace (file 0600, folders
// 0700, never through a symlink). It is derived, so it is not audited. Shape:
//   { schemaVersion: 1, at, scope, project, worktree, branch, head, changed, paths, session }
// branch is null on a detached HEAD, head is the short commit (null before the first commit), changed is the full
// count and paths holds at most STUB_PATHS repo-relative paths. session is the hook's session key.
// It runs one `git status` with hooks and fsmonitor off, no global or system config and a 2-second limit. A repository
// whose own config defines a filter or an include writes no stub, so status never runs a filter command. On a timeout or
// any other error nothing is written. Stop fires at the end of every turn, so this stays one Git call.
export const STUB_PATHS = 10, STUB_GIT_TIMEOUT_MS = 2000;
const STUB_BYTES = 32768, PATH_CHARS = 1024, SHOWN_PATH_CHARS = 80, LINE_CHARS = 200;
const SESSION_KEY = /^[a-f0-9]{64}$/, HASH = /^[a-f0-9]{16}$/, ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
// Two worktrees of one project keep separate stubs: the name is a short hash of the worktree's real path.
export const worktreeHash = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16);
export const stubPath = (stateRoot, scope, project, root) => join(stateRoot, "handoffs", scope, project, worktreeHash(root) + ".json");
export const STATUS_ARGS = Object.freeze(["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal", "--ignore-submodules=all", "--no-renames"]);

// The worktree's own Git folder: the .git directory, or the folder a linked worktree's .git file names.
function gitDirOf(root) {
  const dotGit = join(root, ".git"), node = info(dotGit);
  if (node?.isDirectory() && !node.isSymbolicLink()) return realpathSync(dotGit);
  if (!node?.isFile() || node.size > 4096) return null;
  const match = /^gitdir: (.+?)\r?\n?$/.exec(readFileSync(dotGit, "utf8"));
  return match ? realpathSync(resolve(root, match[1])) : null;
}
// True when the repository's config could make status run a command: a filter driver, or an include that may define one.
function hasFilters(root) {
  const common = readCommonDir(root), own = gitDirOf(root);
  if (!common || !own) return true;
  for (const path of [join(common, "config"), join(own, "config.worktree")]) {
    const node = info(path);
    if (!node) continue;
    if (!node.isFile() || node.size > 1 << 20) return true;
    if (/^\s*\[\s*(?:filter|include|includeif)\b/im.test(readFileSync(path, "utf8"))) return true;
  }
  return false;
}
// Branch, short HEAD, the changed-file count and the first STUB_PATHS paths, from porcelain v2 with -z.
export function parseStatus(stdout) {
  const fields = stdout.split("\0");
  let branch = null, head = null, changed = 0;
  const paths = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    if (field.startsWith("# branch.oid ")) { const oid = field.slice(13); head = /^[a-f0-9]{7,64}$/.test(oid) ? oid.slice(0, 7) : null; continue; }
    if (field.startsWith("# branch.head ")) { const name = field.slice(14); branch = name === "(detached)" ? null : name; continue; }
    if (field.startsWith("#")) continue;
    // Changed (1), renamed or copied (2, whose original path follows as its own field), unmerged (u), untracked (?).
    const skip = { "1": 8, "2": 9, u: 10, "?": 1 }[field[0]];
    if (skip === undefined || field[1] !== " ") continue;
    const path = field.split(" ").slice(skip).join(" ");
    if (field[0] === "2") i++;
    if (!path) continue;
    changed++;
    if (paths.length < STUB_PATHS) paths.push(path.slice(0, PATH_CHARS));
  }
  return { branch, head, changed, paths };
}
// Writes the stub for a bound worktree, or nothing. Returns the stub, or null. Errors are thrown for the caller's log.
export async function writeStub(stateRoot, { scope, project, root }, { key, now, runGit = runGitDefault }) {
  if (hasFilters(root)) return null;
  const result = runGit(root, [...STATUS_ARGS], { timeoutMs: STUB_GIT_TIMEOUT_MS });
  if (!result?.ok) return null;
  const stub = { schemaVersion: 1, at: now.toISOString(), scope, project, worktree: worktreeHash(root), ...parseStatus(result.stdout), session: key };
  ensurePrivatePath(stateRoot, ["handoffs", scope, project]);
  await atomicReplace(stubPath(stateRoot, scope, project, root), JSON.stringify(stub) + "\n");
  return stub;
}
const validStub = (s, { scope, project, root }) => s?.schemaVersion === 1 && typeof s.at === "string" && ISO.test(s.at) && s.scope === scope && s.project === project
  && HASH.test(s.worktree ?? "") && s.worktree === worktreeHash(root) && (s.branch === null || (typeof s.branch === "string" && s.branch.length <= 256))
  && (s.head === null || /^[a-f0-9]{7}$/.test(s.head ?? "")) && Number.isInteger(s.changed) && s.changed >= 0
  && Array.isArray(s.paths) && s.paths.length <= STUB_PATHS && s.paths.every((p) => typeof p === "string" && p.length <= PATH_CHARS) && SESSION_KEY.test(s.session ?? "");
// The hook's read: the stub for this worktree, or null when there is none. A damaged stub fails with INTEGRITY.
export async function readStub(stateRoot, found) {
  let value;
  try { value = await readPrivateJson(stubPath(stateRoot, found.scope, found.project, found.root), STUB_BYTES); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!validStub(value, found)) throw new DevtwinError("INTEGRITY", "Stop stub invalid");
  return value;
}
// A path or branch as shown: no backticks inside its quotes, capped, and left out when it fails the summary text checks.
const quoted = (text) => {
  const plain = String(text).replace(/[`\r\n\t]/g, "?");
  const capped = [...plain].length <= SHOWN_PATH_CHARS ? plain : [...plain].slice(0, SHOWN_PATH_CHARS - 1).join("") + "…";
  return plainRuleProblem(capped) || scanSensitive(capped).length ? null : "`" + capped + "`";
};
const minute = (iso) => iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
// The one summary line for an unanswered stub. Paths are added while the line stays within LINE_CHARS.
export function stubLine(stub) {
  const where = stub.branch !== null ? " on branch " + (quoted(stub.branch) ?? "(name withheld)") : stub.head ? " at " + stub.head + " (detached)" : "";
  const head = "Last session stopped " + minute(stub.at) + where + " with " + (stub.changed === 1 ? "1 changed file" : stub.changed + " changed files");
  const tail = ". No handoff was written.";
  const shown = [];
  for (const path of stub.paths) {
    const q = quoted(path);
    if (!q) continue;
    const next = [...shown, q], more = stub.changed - next.length;
    if ([...(head + ": " + next.join(", ") + (more > 0 ? " and " + more + " more" : "") + tail)].length > LINE_CHARS) break;
    shown.push(q);
  }
  const more = stub.changed - shown.length;
  return head + (shown.length ? ": " + shown.join(", ") + (more > 0 ? " and " + more + " more" : "") : "") + tail;
}
