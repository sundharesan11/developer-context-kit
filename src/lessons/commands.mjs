import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DevtwinError } from "../errors.mjs";
import { assertScopeId, RECORD_ID } from "../identity/ids.mjs";
import { isWithin } from "../storage/fsx.mjs";
import { renderInbound } from "../records/isolation.mjs";
import { buildIndex, rebuildIndex, readIndex, findLesson, findRepoRoot, readCommonDir, resolveRepo } from "./index.mjs";
import { matchLessons, normalizeRelPath, packageName, isStale } from "./match.mjs";
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const options = { scope: { type: "string" }, cwd: { type: "string" }, path: { type: "string", multiple: true }, package: { type: "string", multiple: true }, text: { type: "string" }, id: { type: "string" } };
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid lesson match input", { field }); };
// The worktree for --cwd, resolved through the index's path-to-scope map, as the hook does.
function repoFor(index, cwd) {
  let canonical;
  try { canonical = realpathSync(cwd); } catch { throw new DevtwinError("PATH_UNSAFE", "Working directory unavailable"); }
  if (canonical !== resolve(cwd)) throw new DevtwinError("PATH_UNSAFE", "Working directory must be canonical");
  const root = findRepoRoot(canonical);
  const repo = root && resolveRepo(index, { root, commonDir: readCommonDir(root) });
  if (!repo) throw new DevtwinError("PROJECT_UNBOUND", "Worktree not bound in selected scope", { reason: "not-bound-in-scope" });
  return { root, repo };
}
// An absolute --path must sit inside the --cwd worktree. Every path must stay inside the repository.
function relativePath(path, root) {
  if (isAbsolute(path)) {
    if (!root || !isWithin(resolve(path), root)) invalid("path");
    path = relative(root, resolve(path));
  }
  return normalizeRelPath(path) ?? invalid("path");
}
// Read-only: builds the index in memory from current sources, and reports whether the stored index matches.
export const lessonMatchCommand = { options, async run(values, ctx) {
  const scope = assertScopeId(values.scope);
  const index = await buildIndex(ctx.roots, scope);
  let stored;
  try { stored = await readIndex(ctx.roots, scope); } catch { stored = undefined; }
  const state = stored === null ? "missing" : stored === undefined ? "invalid" : stored.fingerprint === index.fingerprint ? "current" : "stale";
  const located = values.cwd === undefined ? null : repoFor(index, values.cwd);
  const paths = list(values.path).map((p) => relativePath(p, located?.root));
  const packages = list(values.package).map((p) => packageName(p) ?? invalid("package"));
  const matches = matchLessons(index, { paths, packages, text: values.text ?? "", project: located?.repo.project ?? null, now: ctx.now() });
  return { scope, repo: located?.repo ?? null, index: state, matches };
} };
// The full lesson as fenced, claimed, capped data (KTD11). Only an effective lesson in the scope's index is shown.
export const lessonShowCommand = { options, async run(values, ctx) {
  const scope = assertScopeId(values.scope);
  if (!RECORD_ID.test(values.id ?? "")) throw new DevtwinError("INVALID_ID", "Invalid record ID");
  const found = await findLesson(ctx.roots, scope, values.id);
  if (!found) throw new DevtwinError("NOT_FOUND", "No effective lesson with this ID", { id: values.id });
  const { entry, body } = found;
  return { id: entry.id, kind: entry.kind, reach: entry.reach, scope: entry.scope, project: entry.project, claimedBy: entry.claimedBy, revisitAfter: entry.revisitAfter, stale: isStale(entry, ctx.now()), recordHash: entry.recordHash, text: renderInbound(entry.title + "\n\n" + body, { handle: entry.claimedBy }) };
} };
// Rebuilds stateRoot/lessons/<scope>.json. The file is a cache of record data, so the write needs no plan fingerprint.
export const lessonIndexCommand = { options: { scope: { type: "string" } }, run: (values, ctx) => rebuildIndex(ctx.roots, assertScopeId(values.scope)) };
