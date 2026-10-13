import { readdir } from "node:fs/promises";
import { DevctxError } from "../errors.mjs";
import { locateWorktree, gitQuery } from "../identity/git.mjs";
import { readApprovedSource, SOURCE_LIMITS, assertSourceRel } from "../storage/source-read.mjs";
export const AUTO_SOURCES = ["README.md", "README", "AGENTS.md", "CLAUDE.md", "package.json", ".nvmrc", ".node-version", "go.mod", "pyproject.toml", "Cargo.toml", "Makefile"];
export async function scanRepository({ repo, approvedDocs = [] }) {
  const location = await locateWorktree(repo);
  if (!location.git || location.root !== repo) throw new DevctxError("INVALID_INPUT", "Repository root required", { root: location.root ?? null });
  if (!Array.isArray(approvedDocs) || AUTO_SOURCES.length + approvedDocs.length > SOURCE_LIMITS.maxFiles) throw new DevctxError("LIMIT", "Too many approved sources");
  const names = [...new Set([...AUTO_SOURCES, ...approvedDocs.map(assertSourceRel)])];
  const sources = [];
  for (const rel of names) sources.push(await readApprovedSource(location.root, rel));
  const tracked = gitQuery(repo, ["ls-files", "-z"]).stdout;
  const trackedCount = tracked ? tracked.split("\0").filter(Boolean).length : 0;
  const topLevel = (await readdir(repo)).filter((name) => name !== ".git").sort().slice(0, 50);
  return { location, sources, trackedCount, topLevel };
}
