// U37 (KTD43): the plain-rule text checks shared by preferences (src/prefs/store.mjs) and by automatic lesson and
// record text. Text an agent writes reaches later sessions, so it must not carry Markdown structure that could pose as
// instructions, devtwin's own markers, a Claude Code import line (@path) or text that tries to override other
// instructions. A preference is one plain rule, so every check covers all of its text.
//
// Lesson and record bodies are longer notes that legitimately use headings, lists, code fences and package names such
// as @types/node. So for them the structure and import checks cover only the one-line fields (title and summary); the
// body gets the marker, override and system-prompt checks. The sensitive and scope-name checks run separately
// (src/records/redact.mjs, src/records/isolation.mjs).
import { DevtwinError } from "../errors.mjs";

export const PLAIN_RULE_CHECKS = Object.freeze([
  ["markdown-structure", /^\s*(?:#|>|```|~~~|-{3,}|\*{3,})/m],
  ["marker", /<!--|-->|devtwin:(?:begin|end)/i],
  ["import", /(?:^|\s)@[~./A-Za-z0-9_-]/],
  ["override", /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+)?(?:the\s+|your\s+)?(?:previous|prior|above|earlier|other|system|developer)\b/i],
  ["system-prompt", /\bsystem\s+prompt\b/i]
].map((check) => Object.freeze(check)));
const BODY_CHECKS = new Set(["marker", "override", "system-prompt"]);

// The first check the text fails, or null. only limits the checks by reason.
export function plainRuleProblem(text, { only = null } = {}) {
  for (const [reason, pattern] of PLAIN_RULE_CHECKS) if ((!only || only.has(reason)) && pattern.test(String(text ?? ""))) return reason;
  return null;
}
// Automatic lesson or record text: every check on each one-line field, the body checks on the body.
export function checkAutomaticText({ lines = [], body = "" }, { field = "text" } = {}) {
  for (const line of lines) {
    const reason = plainRuleProblem(line);
    if (reason) throw new DevtwinError("INVALID_INPUT", "Automatic text is not plain enough to store", { field, reason });
  }
  const reason = plainRuleProblem(body, { only: BODY_CHECKS });
  if (reason) throw new DevtwinError("INVALID_INPUT", "Automatic text is not plain enough to store", { field: "body", reason });
}
