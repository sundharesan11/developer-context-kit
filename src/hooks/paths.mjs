import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeRelPath } from "../lessons/match.mjs";
// U7: the file paths an agent tool call names, made repo-relative to one worktree root. Nothing here reads a file's
// content or runs Git. A path outside the root, or one that cannot be made relative, is dropped.
const MAX_PATHS = 64, MAX_TOKENS = 256, MAX_COMMAND_BYTES = 65536;
const CLAUDE_FILE_TOOLS = new Set(["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CLAUDE_DIR_TOOLS = new Set(["Glob", "Grep"]);
const SHELL_TOOLS = new Set(["Bash", "shell", "local_shell", "exec_command"]);
const PATCH_LINE = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$/;
const str = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 ? value : null;
// Codex sends the command as text; an argv array is joined so both shapes parse the same way.
function commandText(input) {
  const command = Array.isArray(input?.command) ? input.command.filter((part) => typeof part === "string").join(" ") : input?.command;
  return typeof command === "string" && Buffer.byteLength(command) <= MAX_COMMAND_BYTES ? command : "";
}
// The paths named in apply_patch text: one per "*** Update File:", "*** Add File:", "*** Delete File:" or "*** Move to:" line.
export function patchPaths(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const match = PATCH_LINE.exec(line.replace(/\r$/, ""));
    if (match) out.push(match[1]);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}
// Shell words with single and double quotes removed. Operators split words. This is not a full shell parser.
function shellWords(text) {
  const words = [];
  let word = "", quote = null;
  for (const ch of text) {
    if (quote) { if (ch === quote) quote = null; else word += ch; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s|[;|&<>()]/.test(ch)) { if (word) words.push(word); word = ""; if (words.length >= MAX_TOKENS) break; continue; }
    word += ch;
  }
  if (word && words.length < MAX_TOKENS) words.push(word);
  return words;
}
// Best effort: words that look like file paths. Flags, URLs, variables and globs are skipped; "--file=x" gives "x".
export function shellPaths(text) {
  const out = [];
  for (let word of shellWords(text)) {
    if (word.startsWith("-")) { const eq = word.indexOf("="); if (eq < 0) continue; word = word.slice(eq + 1); }
    if (!word || /^[a-z][a-z0-9+.-]*:\/\//i.test(word) || /[$`*?{}[\]~]/.test(word) || word.includes("=")) continue;
    word = word.replace(/[,:]+$/, "");
    if (word.includes("/") || /^[^./][^/]*\.[A-Za-z0-9]{1,8}$/.test(word)) out.push(word);
    if (out.length >= MAX_PATHS) break;
  }
  return out;
}
// The raw paths a tool payload names, per agent. Claude Code puts paths in tool_input; Codex puts patch or command text there.
export function payloadPaths(agent, payload) {
  const tool = payload?.tool_name, input = payload?.tool_input ?? {};
  if (agent === "claude") {
    if (CLAUDE_FILE_TOOLS.has(tool)) return [str(input.file_path) ?? str(input.notebook_path)].filter(Boolean);
    if (CLAUDE_DIR_TOOLS.has(tool)) return [str(input.path)].filter(Boolean);
    if (tool === "Bash") return shellPaths(commandText(input));
    return [];
  }
  if (tool === "apply_patch") return patchPaths(commandText(input) || input.patch || input.input);
  if (SHELL_TOOLS.has(tool)) return shellPaths(commandText(input));
  return [];
}
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
export function repoPaths(agent, payload, { cwd, root }) {
  const out = new Set();
  for (const path of payloadPaths(agent, payload)) { const rel = toRepoRelative(path, { cwd, root }); if (rel) out.add(rel); }
  return [...out];
}
