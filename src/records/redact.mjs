import { DevctxError } from "../errors.mjs";
const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g],
  ["authorization", /authorization\s*:\s*\S+/gi],
  ["bearer-token", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi],
  ["credential-assignment", /\b[a-z_]*(?:token|secret|password|api[_-]?key|private[_-]?key|access[_-]?key|credential)\s*(?:["']\s*)?[:=]\s*\S{6,}/gi],
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
  if (found.length) throw new DevctxError("SENSITIVE_CONTENT", "Sensitive content refused", { types: [...new Set(found.map((x) => x.type))] });
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
