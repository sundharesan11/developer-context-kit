// R37-R39: STE-based writing rules, a defined subset derived from ASD-STE100 Simplified Technical English. This is not
// an STE-compliant checker: there is no approved-word dictionary. Pure, deterministic and dependency-free, so docs CI
// and later renderers (lessons, digests, guides, templates) call the same code. docs/WRITING.md explains each rule.
export const LIMITS = Object.freeze({ procedure: 25, prose: 30 });
export const RULES = Object.freeze(["sentence-length", "one-instruction", "banned-word", "passive-voice", "future-tense"]);
// Small and defensible: each term is filler or has a shorter, plainer form. Matched case-insensitively as whole words.
export const BANNED = Object.freeze([
  { term: "utilize", pattern: /\butili[sz](?:e|es|ed|ing|ation)\b/i, use: "use" },
  { term: "leverage", pattern: /\bleverag(?:e|es|ed|ing)\b/i, use: "use" },
  { term: "in order to", pattern: /\bin order to\b/i, use: "to" },
  { term: "simply", pattern: /\bsimply\b/i, use: "omit the word" },
  { term: "just", pattern: /\bjust\b/i, use: "omit the word, or use only or exactly" },
  { term: "easily", pattern: /\beasily\b/i, use: "omit the word" },
  { term: "obviously", pattern: /\bobviously\b/i, use: "omit the word" },
  { term: "please note", pattern: /\bplease note\b/i, use: "omit the phrase, or use a Note label" },
  { term: "etc.", pattern: /\betc\b\.?/i, use: "name each item, or use such as" },
]);
// Procedures are numbered list items. Passive voice is a form of "to be" plus a past participle, with one optional
// adverb between. Participles that are also common adjectives or nouns (read, set, left, open) are left out, and so
// are state words that describe a setting rather than an action (deprecated, supported, enabled, disabled).
const PASSIVE = /\b(?:am|is|are|was|were|be|been|being)\s+(?:[a-z]+ly\s+|not\s+|also\s+|then\s+|now\s+)?(?!(?:deprecated|supported|unsupported|enabled|disabled)\b)(?:[a-z]+ed|written|shown|given|done|made|taken|known|seen|built|kept|sent|found|chosen|held|hidden|run)\b(?!-)/i;
const FUTURE = /\b(?:will|shall|won't)\b|\b[a-z]+'ll\b/i;
const TWO_STEPS = /\band then\b|;\s*then\b/i;
// A sentence ends at . ! or ? (plus closing quotes or brackets) before whitespace or the end of the paragraph. A
// lowercase start still counts, because devtwin and inline code often begin a sentence. Common abbreviations are
// masked first so they do not end a sentence.
const BOUNDARY = /[.!?]+["'\u201D\u2019)\]]*(?=\s|$)/gu;
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|approx|incl)\./gi;
const HOLD = "\uE000", RELEASE = "\uE001";

// Hides inline code and bare URLs behind one-word placeholders, keeps link text, and drops markup. Newlines survive,
// so a sentence's line is its paragraph's first line plus the newlines before it.
function clean(text, saved) {
  const hold = (value) => HOLD + (saved.push(value) - 1) + RELEASE;
  return text
    .replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (m) => hold(m.replace(/\n/g, " ")) + "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/<(https?:\/\/[^>\s]+)>/g, (m, url) => hold(url))
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/https?:\/\/[^\s)<>]*[^\s)<>.,;:!?'"]/g, (m) => hold(m))
    .replace(/\*\*|__|\*/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1");
}
const restore = (text, saved) => text.replace(new RegExp(HOLD + "(\\d+)" + RELEASE, "g"), (m, i) => saved[Number(i)]);
const excerptOf = (text, saved) => { const s = restore(text, saved).replace(/\s+/g, " ").trim(); return s.length > 240 ? s.slice(0, 237) + "..." : s; };
const countWords = (sentence) => sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function sentences(text) {
  const masked = text.replace(ABBREVIATIONS, (m) => m.replace(/\./g, "\u00B7"));
  const out = [];
  let start = 0;
  for (const m of masked.matchAll(BOUNDARY)) {
    const end = m.index + m[0].length;
    out.push({ offset: start, text: text.slice(start, end) });
    start = end;
  }
  if (text.slice(start).trim()) out.push({ offset: start, text: text.slice(start) });
  return out.map((s) => { const lead = s.text.length - s.text.trimStart().length; return { offset: s.offset + lead, text: s.text.trim() }; })
    .filter((s) => s.text);
}
function banned(text, line, excerpt, findings) {
  for (const { term, pattern, use } of BANNED) {
    if (pattern.test(text)) findings.push({ rule: "banned-word", line, message: `"${term}": ${use}`, excerpt });
  }
}
function checkBlock(block, findings) {
  const saved = [], text = clean(block.parts.join("\n"), saved);
  if (block.procedural && TWO_STEPS.test(text)) {
    findings.push({ rule: "one-instruction", line: block.line, message: "write one instruction per step", excerpt: excerptOf(text, saved) });
  }
  for (const s of sentences(text)) {
    const line = block.line + (text.slice(0, s.offset).match(/\n/g) ?? []).length, excerpt = excerptOf(s.text, saved);
    const limit = block.procedural ? LIMITS.procedure : LIMITS.prose, count = countWords(s.text);
    if (count > limit) findings.push({ rule: "sentence-length", line, message: `${count} words; the limit is ${limit}${block.procedural ? " in a procedure" : ""}`, excerpt });
    banned(s.text, line, excerpt, findings);
    if (!block.procedural) continue;
    if (PASSIVE.test(s.text)) findings.push({ rule: "passive-voice", line, message: "use the active voice in a procedure", excerpt });
    if (FUTURE.test(s.text)) findings.push({ rule: "future-tense", line, message: "use the present tense in a procedure", excerpt });
  }
}

// Returns [{rule, line, message, excerpt}] for Markdown text, in line order. Skips YAML frontmatter, fenced code,
// HTML comments, headings, rules and link definitions. Table cells get only the banned-word check: they are short
// labels, not sentences. A numbered list item, with its continuation lines, is a procedure step.
export function checkMarkdown(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n"), findings = [];
  let i = 0, fence = null, comment = false, block = null;
  if (lines[0] === "---") { const end = lines.indexOf("---", 1); if (end > 0) i = end + 1; }
  const flush = () => { if (block) checkBlock(block, findings); block = null; };
  for (; i < lines.length; i++) {
    let line = lines[i];
    const n = i + 1;
    if (fence) { if (line.trim().startsWith(fence) && !line.trim().slice(fence.length).trim()) fence = null; continue; }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) { flush(); fence = open[1]; continue; }
    if (comment) { const end = line.indexOf("-->"); if (end < 0) continue; line = line.slice(end + 3); comment = false; }
    line = line.replace(/<!--[\s\S]*?-->/g, " ");
    if (line.includes("<!--")) { line = line.slice(0, line.indexOf("<!--")); comment = true; }
    if (!line.trim()) { flush(); continue; }
    if (block && /^\s{0,3}(?:=+|-+)\s*$/.test(line)) { block.parts.pop(); if (!block.parts.length) block = null; flush(); continue; }
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line) || /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) || /^\s{0,3}\[[^\]]+\]:\s/.test(line)) { flush(); continue; }
    if (/^\s*\|/.test(line)) {
      flush();
      if (/^[\s|:-]+$/.test(line)) continue;
      const saved = [], cells = clean(line, saved);
      banned(cells, n, excerptOf(cells, saved), findings);
      continue;
    }
    const item = /^\s*(?:(\d+)[.)]|[-*+])\s+(.*)$/.exec(line);
    if (item) { flush(); block = { line: n, procedural: item[1] !== undefined, parts: [item[2]] }; continue; }
    const body = line.replace(/^\s*(?:>\s?)+/, "").trim();
    if (!body) { flush(); continue; }
    if (block) block.parts.push(body); else block = { line: n, procedural: false, parts: [body] };
  }
  flush();
  return findings;
}
// For renderers: true when generated Markdown has no findings.
export const passesWriting = (markdown) => checkMarkdown(markdown).length === 0;

// entries: [{file, rule, excerpt, reason}]. A finding is suppressed when file, rule and excerpt all match an entry.
// An entry that suppresses nothing is stale and returned so the caller reports it.
export function applyAllowlist(findings, entries) {
  const key = (x) => x.file + "\0" + x.rule + "\0" + x.excerpt;
  const keys = new Set(entries.map(key)), used = new Set();
  const kept = findings.filter((f) => { const k = key(f); if (!keys.has(k)) return true; used.add(k); return false; });
  return { findings: kept, stale: entries.filter((e) => !used.has(key(e))) };
}
