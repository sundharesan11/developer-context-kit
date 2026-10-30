// The file paths a tool call's text names: shell words and apply_patch headers (U7). The adapters
// (src/agents/adapters) read their payloads with these. Nothing here reads a file or runs Git.
const MAX_PATHS = 64, MAX_TOKENS = 256, MAX_COMMAND_BYTES = 65536;
const PATCH_LINE = /^\*\*\* (?:Update File|Add File|Delete File|Move to): (.+?)\s*$/;
// Codex sends the command as text; an argv array is joined so both shapes parse the same way.
export function commandText(input) {
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
