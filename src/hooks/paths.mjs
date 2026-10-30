import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeRelPath } from "../lessons/match.mjs";
import { adapter, isAgent } from "../agents/adapters/index.mjs";
export { patchPaths, shellPaths, commandText } from "./tool-text.mjs";
// U7: the file paths an agent tool call names, made repo-relative to one worktree root. Nothing here reads a file's
// content or runs Git. A path outside the root, or one that cannot be made relative, is dropped. Each agent adapter
// reads its own payload shape (src/agents/adapters); these wrappers keep the per-agent entry points.
// U13: the tool calls that edit files. Only these post a "working on" note.
export const isEditCall = (agent, payload) => isAgent(agent) && adapter(agent).hooks.parse(payload).edit;
// The raw paths a tool payload names, per agent.
export const payloadPaths = (agent, payload) => adapter(agent).hooks.parse(payload).paths;
const inside = (rel) => rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
// The repo-relative form of a path against a canonical root, or null. A relative path resolves against cwd. When the
// plain form falls outside the root, the real path of the parent folder is tried, which covers a symlinked prefix.
export function toRepoRelative(path, { cwd, root }) {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  let rel = relative(root, absolute);
  if (!inside(rel)) {
    try { rel = relative(root, join(realpathSync(dirname(absolute)), basename(absolute))); } catch { return null; }
    if (!inside(rel)) return null;
  }
  return normalizeRelPath(rel.split(sep).join("/"));
}
export const repoPaths = (agent, payload, where) => relativePaths(payloadPaths(agent, payload), where);
// Raw paths from a normalized payload, made repo-relative and deduplicated.
export function relativePaths(paths, { cwd, root }) {
  const out = new Set();
  for (const path of paths) { const rel = toRepoRelative(path, { cwd, root }); if (rel) out.add(rel); }
  return [...out];
}
