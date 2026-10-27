import { termPattern } from "../stack/match.mjs";
import { startsWithWords } from "../hooks/shell-words.mjs";
// U6: pure lesson matching over an index from src/lessons/index.mjs. No file, Git or network access, so the hook
// fast path (KTD6) can call it directly. Globs are matched segment by segment without building a regular expression.
export const INDEX_LINE_BYTES = 240;
// U32 (KTD31): a command match sits between package and topic.
const STRENGTH = { path: 4, package: 3, command: 2, topic: 1 };
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const MAX_PATH_BYTES = 4096, MAX_TEXT_BYTES = 16384;
// A repo-relative path with "." and empty segments removed. An absolute path, a NUL or any ".." segment gives null.
export function normalizeRelPath(path) {
  if (typeof path !== "string" || !path || path.includes("\0") || path.startsWith("/") || Buffer.byteLength(path) > MAX_PATH_BYTES) return null;
  const segments = path.split("/").filter((s) => s && s !== ".");
  return segments.length && !segments.includes("..") ? segments.join("/") : null;
}
// The package an import names: "pg/lib/client" is "pg" and "@scope/name/sub" is "@scope/name". Builtins and paths give null.
export function packageName(specifier) {
  if (typeof specifier !== "string") return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? (parts.length > 1 ? parts[0] + "/" + parts[1] : "") : parts[0];
  return name.length <= 214 && PACKAGE.test(name) ? name : null;
}
// One segment: "*" is any run of characters and "?" is one character. A wildcard never matches a leading dot, so
// "*" misses ".env" and a dotfile matches only a pattern that starts with a literal dot. Two pointers, no backtracking blowup.
function segmentMatch(pattern, text) {
  if (text.startsWith(".") && !pattern.startsWith(".")) return false;
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) { p++; t++; }
    else if (p < pattern.length && pattern[p] === "*") { star = p++; mark = t; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
// A glob as segments, or null when it could escape the repository. A "**" segment matches zero or more segments.
export function compileGlob(pattern) {
  const normal = normalizeRelPath(pattern);
  return normal ? normal.split("/") : null;
}
// Dynamic programming over (pattern segment, path segment): linear in their product. "**" skips no dot segment.
// Leading segments without a wildcard must equal the path's own, which rejects most pairs before the table is built.
function segmentsMatch(pattern, path) {
  for (let k = 0; k < pattern.length && !pattern[k].includes("*") && !pattern[k].includes("?"); k++) if (path[k] !== pattern[k]) return false;
  let next = new Array(path.length + 1).fill(false);
  next[path.length] = true;
  for (let i = pattern.length - 1; i >= 0; i--) {
    const row = new Array(path.length + 1).fill(false);
    for (let j = path.length; j >= 0; j--) {
      if (pattern[i] === "**") row[j] = next[j] || (j < path.length && !path[j].startsWith(".") && row[j + 1]);
      else row[j] = j < path.length && next[j + 1] && segmentMatch(pattern[i], path[j]);
    }
    next = row;
  }
  return next[0];
}
export function globMatch(pattern, path) {
  const glob = compileGlob(pattern), normal = normalizeRelPath(path);
  return Boolean(glob && normal) && segmentsMatch(glob, normal.split("/"));
}
// A whole-word term check. The plain substring test runs first, so most terms never build a pattern.
function wordTest(term) {
  const lower = term.toLowerCase();
  let pattern;
  return (text, lowerText) => lowerText.includes(lower) && (pattern ??= termPattern(term)).test(text);
}
// Compiles every glob and term once. matchLessons accepts a raw or a prepared index.
export function prepareIndex(index) {
  if (index.prepared) return index;
  const entries = (index.entries ?? []).map((entry) => ({
    entry,
    globs: (entry.match?.paths ?? []).map(compileGlob).filter(Boolean),
    packages: new Set(entry.match?.packages ?? []),
    packageWords: (entry.match?.packages ?? []).map(wordTest),
    topicWords: (entry.match?.topics ?? []).map(wordTest),
    commands: (entry.match?.commands ?? []).map((prefix) => prefix.split(" "))
  }));
  return { prepared: true, scope: index.scope, entries };
}
const clean = (text) => String(text ?? "").replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
function capBytes(text, limit) {
  if (Buffer.byteLength(text) <= limit) return text;
  let out = "", bytes = 0;
  for (const ch of text) { const n = Buffer.byteLength(ch); if (bytes + n > limit - 3) break; out += ch; bytes += n; }
  return out.trimEnd() + "\u2026";
}
export const isStale = (entry, now) => {
  if (!entry.revisitAfter) return false;
  const due = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(entry.revisitAfter) ? entry.revisitAfter + "T00:00:00.000Z" : entry.revisitAfter);
  return Number.isFinite(due) && due <= now.getTime();
};
// About 60 tokens: "[contested: ][stale, revisit: ]title: do or do not (claimed by handle) [id]". Title and summary
// are cut to fit. "contested: " marks one of two replacements of the same lesson that raced to the hub (U12).
export function indexLine(entry, { stale = false, contested = entry.contested === true } = {}) {
  const prefix = (contested ? "contested: " : "") + (stale ? "stale, revisit: " : "");
  const suffix = " (claimed by " + capBytes(clean(entry.claimedBy), 64) + ") [" + entry.id + "]";
  const title = clean(entry.title), summary = clean(entry.summary);
  const text = summary && summary !== title ? title + ": " + summary : title;
  return prefix + capBytes(text, INDEX_LINE_BYTES - Buffer.byteLength(prefix + suffix)) + suffix;
}
// Input {paths, packages, text, commands, project, now}. paths are repo-relative; packages are import specifiers; text is
// a prompt; commands are word lists from src/hooks/shell-words.mjs, matched against each lesson's command prefixes. A project-reach lesson from another project is skipped when project is set. Stronger matches come first
// (path, then package, then command, then topic), then the newest. The index holds effective lessons only, so nothing superseded returns.
export function matchLessons(index, { paths = [], packages = [], text = "", commands = [], project = null, now = new Date() } = {}) {
  const prepared = prepareIndex(index);
  const pathSegments = paths.map(normalizeRelPath).filter(Boolean).map((p) => p.split("/"));
  const names = new Set(packages.map(packageName).filter(Boolean));
  const prompt = capBytes(String(text ?? ""), MAX_TEXT_BYTES), lowerPrompt = prompt.toLowerCase();
  const out = [];
  for (const { entry, globs, packages: own, packageWords, topicWords, commands: prefixes } of prepared.entries) {
    if (project && entry.reach === "project" && entry.project !== project) continue;
    const matchedBy = [];
    if (globs.some((glob) => pathSegments.some((path) => segmentsMatch(glob, path)))) matchedBy.push("path");
    if (names.size && [...names].some((name) => own.has(name)) || (prompt && packageWords.some((test) => test(prompt, lowerPrompt)))) matchedBy.push("package");
    if (commands.length && prefixes.some((prefix) => commands.some((words) => startsWithWords(words, prefix)))) matchedBy.push("command");
    if (prompt && topicWords.some((test) => test(prompt, lowerPrompt))) matchedBy.push("topic");
    if (!matchedBy.length) continue;
    const stale = isStale(entry, now);
    out.push({ id: entry.id, reach: entry.reach, scope: entry.scope, project: entry.project, matchedBy, stale, ...(entry.contested === true ? { contested: true } : {}), strength: STRENGTH[matchedBy[0]], createdAt: entry.createdAt, line: indexLine(entry, { stale }) });
  }
  out.sort((a, b) => b.strength - a.strength || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) || (a.id < b.id ? -1 : 1));
  return out.map(({ strength, createdAt, ...rest }) => rest);
}
