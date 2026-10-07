import { DevctxError } from "../errors.mjs";
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["authorization", /authorization\s*:\s*\S+/gi],
  ["credential-assignment", /\b[a-z_]*(?:token|secret|password|api_key|private_key|access_key|credential)\s*["']?\s*[:=]\s*\S{6,}/gi],
  ["jwt", /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ["aws-key", /\bAKIA[A-Z0-9]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{8,}\b/g],
  ["url-userinfo", /[a-z]+:\/\/[^\s/@:]+:[^\s/@]+@/gi]
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
  if (found.length) throw new DevctxError("SENSITIVE_CONTENT", "Sensitive content refused", { types: [...new Set(found.map((x) => x.type))] });
}
export function findForbiddenFields(value, prefix = "") {
  const result = [];
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    const path = prefix ? prefix + "." + key : key;
    if (/^(password|token|secret|api[_-]?key|private[_-]?key|access[_-]?key|credential)$/i.test(key)) result.push(path);
    result.push(...findForbiddenFields(child, path));
  }
  return result;
}
