// U17 (R25, R26): output templates. The kit ships starter templates for an RCA, a report and a decision note, in
// Markdown and HTML, under templates/outputs/. `template from` saves the structure of an output the developer liked as
// a personal template, which then replaces the starter of the same kind and format. Only the structure is saved: the
// heading levels and texts, in order, with the first top-level heading replaced by "<title>". The whole source file
// passes the credential check, and the headings pass the check against the names of every scope, because the
// personal store reaches every organization. Personal templates live at dataRoot/templates/outputs/<kind>.<format>.json.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { assertInPilot, assertWritable } from "../config/pilot.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { readPrivateJson, atomicReplace, ensurePrivatePath } from "../storage/fsx.mjs";
import { canonicalJson, sha256 } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { scanSensitive } from "../records/redact.mjs";
import { isolationTerms, findScopeMentions } from "../records/isolation.mjs";

const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FORMATS = ["md", "html"];
export const KIND = /^[a-z][a-z0-9-]{1,31}$/;
const MAX_HEADINGS = 60, HEADING_CHARS = 120, SOURCE_BYTES = 262144;
const UNSAFE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const starterDir = (ctx) => join(ctx.kitRoot ?? KIT, "templates", "outputs");
const personalDir = (roots) => join(roots.dataRoot, "templates", "outputs");
const personalPath = (roots, kind, format) => join(personalDir(roots), kind + "." + format + ".json");
const invalid = (field, extra = {}) => { throw new DevtwinError("INVALID_INPUT", "Invalid output template input", { field, ...extra }); };
const kindOf = (kind) => typeof kind === "string" && KIND.test(kind) ? kind : invalid("kind");
const formatOf = (format) => format === undefined ? "md" : FORMATS.includes(format) ? format : invalid("format", { allowed: FORMATS });

function starters(ctx) {
  let names;
  try { names = readdirSync(starterDir(ctx)); } catch { return []; }
  return names.map((n) => /^([a-z][a-z0-9-]{1,31})\.(md|html)$/.exec(n)).filter(Boolean).map((m) => ({ kind: m[1], format: m[2] }));
}
async function readPersonal(roots, kind, format) {
  try {
    const value = await readPrivateJson(personalPath(roots, kind, format), 65536);
    if (value?.schemaVersion !== 1 || value.kind !== kind || value.format !== format || !Array.isArray(value.headings)) throw new DevtwinError("INTEGRITY", "Personal template invalid", { kind, format });
    return value;
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function personals(roots) {
  let names;
  try { names = readdirSync(personalDir(roots)); } catch { return []; }
  return names.map((n) => /^([a-z][a-z0-9-]{1,31})\.(md|html)\.json$/.exec(n)).filter(Boolean).map((m) => ({ kind: m[1], format: m[2] }));
}

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// A personal template as text: each heading with one placeholder line under it.
export function renderTemplate({ format, headings }) {
  if (format === "md") return headings.map((h) => "#".repeat(h.level) + " " + h.text + "\n\n" + (h.level === 1 ? "" : "<write this section>\n\n")).join("").trimEnd() + "\n";
  const body = headings.map((h) => "<h" + h.level + ">" + escapeHtml(h.text) + "</h" + h.level + ">" + (h.level === 1 ? "" : "\n<p>&lt;write this section&gt;</p>")).join("\n");
  const title = escapeHtml(headings.find((h) => h.level === 1)?.text ?? "<title>");
  return "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n<title>" + title + "</title>\n</head>\n<body>\n" + body + "\n</body>\n</html>\n";
}

export async function listOutputTemplates(roots, ctx = {}) {
  const mine = await personals(roots), all = new Map();
  for (const s of starters(ctx)) all.set(s.kind + "." + s.format, { kind: s.kind, format: s.format, source: "starter" });
  for (const p of mine) all.set(p.kind + "." + p.format, { kind: p.kind, format: p.format, source: "personal", replacesStarter: all.has(p.kind + "." + p.format) });
  return { templates: [...all.values()].sort((a, b) => (a.kind + a.format).localeCompare(b.kind + b.format)) };
}
// The personal template when there is one, else the starter.
export async function showOutputTemplate(roots, { kind, format }, ctx = {}) {
  kindOf(kind); format = formatOf(format);
  const personal = await readPersonal(roots, kind, format);
  if (personal) return { kind, format, source: "personal", headings: personal.headings, text: renderTemplate(personal) };
  if (!starters(ctx).some((s) => s.kind === kind && s.format === format)) throw new DevtwinError("NOT_FOUND", "No output template of this kind and format", { kind, format });
  return { kind, format, source: "starter", text: readFileSync(join(starterDir(ctx), kind + "." + format), "utf8") };
}

const decode = (text) => text.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const lineAt = (text, index) => text.slice(0, index).split("\n").length;
// The headings of a Markdown or HTML output, with their line numbers. Fenced code is skipped in Markdown.
export function extractHeadings(text, format) {
  const out = [];
  if (format === "md") {
    let fence = null;
    text.split("\n").forEach((line, i) => {
      const f = /^\s*(```|~~~)/.exec(line);
      if (f) { fence = fence === null ? f[1] : fence === f[1] ? null : fence; return; }
      const m = fence === null && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ level: m[1].length, text: m[2].trim(), line: i + 1 });
    });
  } else {
    for (const m of text.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi)) out.push({ level: Number(m[1]), text: decode(m[2]).replace(/\s+/g, " ").trim(), line: lineAt(text, m.index) });
  }
  return out.filter((h) => h.text);
}
// template from: preview, then --apply with the plan fingerprint. The source is a file inside the pilot inputs folder.
export async function planTemplateFrom(roots, pilot, { file, kind }, ctx = {}) {
  kindOf(kind);
  if (typeof file !== "string") invalid("file");
  const format = { ".md": "md", ".markdown": "md", ".html": "html", ".htm": "html" }[extname(file).toLowerCase()] ?? invalid("file", { reason: "format", allowed: FORMATS });
  assertInPilot(pilot, dirname(file), "inputsRoot");
  const read = await readApprovedSource(pilot.inputsRoot, relative(pilot.inputsRoot, file));
  if (read.skipped || Buffer.byteLength(read.text) > SOURCE_BYTES) invalid("file", { reason: read.skipped ?? "size" });
  const text = read.text;
  const found = scanSensitive(text);
  if (found.length) throw new DevtwinError("SENSITIVE_CONTENT", "Sensitive content refused", { types: [...new Set(found.map((x) => x.type))], line: lineAt(text, found[0].index) });
  const raw = extractHeadings(text, format);
  // One top-level heading alone is a title, not a structure.
  if (!raw.length || raw.every((h, i) => i === 0 && h.level === 1)) throw new DevtwinError("INVALID_INPUT", "The file has no headings to use as a structure", { field: "file", reason: "no-structure" });
  if (raw.length > MAX_HEADINGS) throw new DevtwinError("LIMIT", "Too many headings", { max: MAX_HEADINGS });
  let titled = false;
  const headings = raw.map((h) => {
    if (h.level === 1 && !titled) { titled = true; return { level: 1, text: "<title>" }; }
    if ([...h.text].length > HEADING_CHARS || UNSAFE.test(h.text)) invalid("file", { reason: "heading", line: h.line });
    return { level: h.level, text: h.text, line: h.line };
  });
  const terms = await isolationTerms(roots);
  for (const h of headings.slice(titled ? 1 : 0)) {
    const scopes = findScopeMentions(h.text, terms);
    if (scopes.length) throw new DevtwinError("ISOLATION", "A heading names a scope", { scopes, line: h.line });
  }
  const clean = headings.map(({ level, text: t }) => ({ level, text: t }));
  const existing = await readPersonal(roots, kind, format);
  return finalizePlan({ kind: "template-from", templateKind: kind, format, sourceSha256: sha256(text), headings: clean, replaces: existing ? "personal" : starters(ctx).some((s) => s.kind === kind && s.format === format) ? "starter" : null, preview: renderTemplate({ format, headings: clean }) });
}
export async function applyTemplateFrom(roots, pilot, input, { fingerprint, now = () => new Date(), ctx = {} } = {}) {
  const plan = await planTemplateFrom(roots, pilot, input, ctx);
  assertFingerprint(plan, fingerprint);
  const path = personalPath(roots, plan.templateKind, plan.format);
  assertWritable(roots, [path]);
  ensurePrivatePath(roots.dataRoot, ["templates", "outputs"]);
  await atomicReplace(path, canonicalJson({ schemaVersion: 1, kind: plan.templateKind, format: plan.format, headings: plan.headings, sourceSha256: plan.sourceSha256, createdAt: now().toISOString() }) + "\n");
  return { saved: true, kind: plan.templateKind, format: plan.format, replaces: plan.replaces, path };
}
