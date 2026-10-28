// U28 (R6, KTD26): reading docs/solutions of a bound repository. The files come from the tree of the project's learnings
// base commit through Git plumbing (src/identity/git.mjs: hooks, fsmonitor and global config off; cat-file applies no
// filters), never from the working copy, so a checked-out feature branch or an unreviewed pull request does not feed the
// import. The learnings base is the binding's learningsBase ref when one is set, or else the remote default branch that
// refs/remotes/origin/HEAD names. With neither, solutions are skipped and reported.
import { git } from "../identity/git.mjs";
import { assertSourceRel, isDeniedRel, SOURCE_LIMITS } from "../storage/source-read.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { parseFrontMatter } from "./memory.mjs";

export const SOLUTIONS_DIR = "docs/solutions";
export const SOLUTION_FILES = 200;
const REF = /^refs\/(?:remotes|heads)\/[A-Za-z0-9._\/-]{1,200}$/;
const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

// { ref, commit } of the learnings base, or null.
export function learningsBase(root, binding = {}) {
  let ref = typeof binding.learningsBase === "string" ? binding.learningsBase : null;
  if (!ref) {
    const head = git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
    if (!head.ok) return null;
    ref = head.stdout.trim();
  }
  if (!REF.test(ref) || ref.split("/").includes("..")) return null;
  const commit = git(root, ["rev-parse", "-q", "--verify", ref + "^{commit}"]);
  const id = commit.ok ? commit.stdout.trim() : "";
  return COMMIT.test(id) ? { ref, commit: id } : null;
}
// The Markdown files under docs/solutions in that commit's tree. skipped names files left out, never their text.
export function readSolutions(root, commit) {
  const items = [], skipped = [];
  const listed = git(root, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", SOLUTIONS_DIR]);
  if (!listed.ok) return { items, skipped: [{ file: SOLUTIONS_DIR, reason: "unreadable" }] };
  const rows = listed.stdout.split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t"), [mode, type, blob] = row.slice(0, tab).split(" ");
    return { mode, type, blob, path: row.slice(tab + 1) };
  }).filter((row) => row.path.endsWith(".md")).sort((a, b) => a.path < b.path ? -1 : 1);
  for (const [i, row] of rows.entries()) {
    const file = row.path;
    try { assertSourceRel(file); } catch { skipped.push({ file: "(unsafe name)", reason: "unsafe-name" }); continue; }
    if (isDeniedRel(file)) { skipped.push({ file, reason: "denied" }); continue; }
    if (row.type !== "blob" || !["100644", "100755"].includes(row.mode)) { skipped.push({ file, reason: row.mode === "120000" ? "symlink" : "not-regular" }); continue; }
    if (i >= SOLUTION_FILES) { skipped.push({ file, reason: "cap" }); continue; }
    const size = git(root, ["cat-file", "-s", row.blob]);
    if (!size.ok || Number(size.stdout.trim()) > SOURCE_LIMITS.maxBytes) { skipped.push({ file, reason: "too-large" }); continue; }
    const blob = git(root, ["cat-file", "blob", row.blob]);
    if (!blob.ok) { skipped.push({ file, reason: "unreadable" }); continue; }
    if (blob.stdout.includes("\0")) { skipped.push({ file, reason: "binary" }); continue; }
    items.push(solutionItem(file, blob.stdout));
  }
  return { items, skipped };
}
// One solution file: its title (front matter title, else the first heading, else the file name) and its body. The
// dedupe hash is the file's text, so a new commit that leaves the file alone changes nothing.
export function solutionItem(file, text) {
  const { front, body } = parseFrontMatter(text);
  const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/m.exec(body)?.[1];
  const base = file.split("/").pop().replace(/\.md$/, "").replace(/[-_]+/g, " ");
  const title = (typeof front.title === "string" && front.title.trim()) || heading || base;
  return { file, title, body: body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd() + "\n", hash: sha256(text) };
}
