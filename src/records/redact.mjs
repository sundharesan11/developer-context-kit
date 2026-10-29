import { DevtwinError } from "../errors.mjs";
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ["authorization", /authorization\s*:\s*\S+/gi],
  ["bearer-token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi],
  // A GitHub Actions `id-token: write` (or read, none) permission names no credential, so it is not one.
  ["credential-assignment", /\b(?!(?<=\bid-)token\s*:\s*(?:read|write|none)\b)[a-z_]*(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*(?:["']\s*)?[:=]\s*\S{6,}/gi],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g],
  ["aws-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g],
  ["llm-api-key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g],
  ["stripe-key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["url-userinfo", /\b[a-z]+:\/\/[^\s/@:]+:[^\s/@]+@/gi]
];
export function scanSensitive(text) {
  const found = [];
  for (const [type, pattern] of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of String(text).matchAll(pattern)) found.push({ type, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index || a.type.localeCompare(b.type));
}
export function assertNoSensitive(text) {
  const found = scanSensitive(text);
  if (found.length) throw new DevtwinError("SENSITIVE_CONTENT", "Sensitive content refused", { types: [...new Set(found.map((x) => x.type))] });
}
export function findForbiddenFields(value, prefix = "") {
  const result = [];
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (/^(password|token|secret|api[_-]?key|private[_-]?key|access[_-]?key|credential)$/i.test(key) || /[_-](?:token|secret|password)$/i.test(key) || /[a-z](?:Token|Secret|Password)$/.test(key)) result.push(path);
    result.push(...findForbiddenFields(child, path));
  }
  return result;
}
// U29 (KTD36): a location says where a value lives, never the value. These shapes are values, not places: a URL that
// carries user info or a query, an `=` assignment, or a long run that looks random. A random run switches between
// upper case, lower case and digits far more often than a readable name, is hex with digits and letters, or breaks
// into three or more digit groups. Readable CamelCase names stay under the switch threshold.
const VALUE_LIKE = [
  ["url-userinfo", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]*@/gi],
  ["url-query", /\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*\?/gi],
  ["assignment", /=/g]
];
const RUN = /[A-Za-z0-9+]{24,}/g;
const charClass = (ch) => /[A-Z]/.test(ch) ? 0 : /[a-z]/.test(ch) ? 1 : 2;
function looksRandom(run) {
  if (/^[0-9a-f]+$/i.test(run) && /[0-9]/.test(run) && /[a-f]/i.test(run)) return true;
  let switches = 0;
  for (let i = 1; i < run.length; i++) if (charClass(run[i]) !== charClass(run[i - 1])) switches++;
  return switches / (run.length - 1) >= 0.3 || (run.match(/[0-9]+/g) ?? []).length >= 3;
}
export function scanValueLike(text) {
  const found = [];
  for (const [type, pattern] of VALUE_LIKE) {
    pattern.lastIndex = 0;
    for (const match of String(text).matchAll(pattern)) found.push({ type, index: match.index });
  }
  RUN.lastIndex = 0;
  for (const match of String(text).matchAll(RUN)) if (looksRandom(match[0])) found.push({ type: "high-entropy", index: match.index });
  return found.sort((a, b) => a.index - b.index || a.type.localeCompare(b.type));
}
// Both scans. The error names the types only, never the text.
export function assertNoValueLike(text) {
  const found = [...scanSensitive(text), ...scanValueLike(text)];
  if (found.length) throw new DevtwinError("SENSITIVE_CONTENT", "Value-like content refused", { types: [...new Set(found.map((x) => x.type))].sort() });
}
