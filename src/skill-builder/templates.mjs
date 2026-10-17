import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevctxError } from "../errors.mjs";
import { PROJECT_ID } from "../identity/ids.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { loadScope } from "../config/store.mjs";
import { validateRoot } from "../config/roots.mjs";
import { info, checkNode, readPrivateJson } from "../storage/fsx.mjs";
import { sha256 } from "../storage/canonical.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { assertNoSensitive, findForbiddenFields } from "../records/redact.mjs";
import { parseFrontmatter, PACKAGE_LIMITS, SKILL_NAME } from "./validate.mjs";
import { workspacePath } from "./workspace.mjs";

// The running kit. Tests inject ctx.templateRoot or ctx.kitRoot; production derives it from this file.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,31}$/, KEY = /^[a-z][a-z0-9-]{0,31}$/;
const RENDERED = ["candidate/SKILL.md", "design.json", "requirements.json"];
const MARKER = /\{\{dck:([^{}]*)\}\}/g;
const invalid = (message, details) => { throw new DevctxError("INVALID_INPUT", message, details); };
const unsafe = (message, details) => { throw new DevctxError("PATH_UNSAFE", message, details); };
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort());
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
export const templateRootFor = (ctx = {}) => ctx.templateRoot ?? join(ctx.kitRoot ?? KIT, "templates", "skills");
function bundledNames() { try { return readdirSync(join(KIT, "skills")).filter((name) => SKILL_NAME.test(name)); } catch { return []; } }

function readKitFile(path, rel) {
  const node = info(path);
  if (!node || node.isSymbolicLink() || !node.isFile() || node.nlink !== 1) unsafe("Unsafe template file", { path: rel });
  if (node.size > PACKAGE_LIMITS.fileBytes) invalid("Template file too large", { path: rel });
  const bytes = readFileSync(path), value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes) || value.includes("\0")) invalid("Template file is not UTF-8 text", { path: rel });
  return value;
}
function inventory(dir, name) {
  const found = [];
  for (const entry of readdirSync(dir).sort()) {
    const node = info(join(dir, entry));
    if (node.isSymbolicLink()) unsafe("Template symlink refused", { path: name + "/" + entry });
    if (entry === "candidate" && node.isDirectory()) { for (const inner of readdirSync(join(dir, entry)).sort()) found.push("candidate/" + inner); }
    else found.push(entry);
  }
  const known = ["template.json", ...RENDERED];
  const extra = found.find((rel) => !known.includes(rel)), missing = known.find((rel) => !found.includes(rel));
  if (extra) invalid("Unexpected template file", { path: name + "/" + extra });
  if (missing) invalid("Template file missing", { path: name + "/" + missing });
}
function checkMeta(meta, name) {
  if (!exact(meta, ["schemaVersion", "name", "description", "placeholders"]) || meta.schemaVersion !== 1 || meta.name !== name || !text(meta.description, 1024) || !Array.isArray(meta.placeholders) || meta.placeholders.length > 32) invalid("Invalid template metadata", { template: name });
  const keys = new Set();
  for (const p of meta.placeholders) {
    const ok = exact(p, ["key", "description", "kind", "required", "default"]) && KEY.test(p.key ?? "") && !keys.has(p.key) && text(p.description, 512) && ["generic", "scope"].includes(p.kind) && typeof p.required === "boolean" && (p.required ? p.default === null : typeof p.default === "string" && p.default.length <= 256);
    if (!ok) invalid("Invalid template placeholder", { template: name, key: typeof p?.key === "string" ? p.key : null });
    keys.add(p.key);
  }
}
export function loadTemplate(root, name) {
  if (typeof name !== "string" || !TEMPLATE_NAME.test(name)) invalid("Invalid template name");
  const dir = join(root, name), node = info(dir);
  if (!node) throw new DevctxError("NOT_FOUND", "Template unavailable", { template: name });
  if (node.isSymbolicLink() || !node.isDirectory()) unsafe("Unsafe template folder", { path: name });
  inventory(dir, name);
  let meta; try { meta = JSON.parse(readKitFile(join(dir, "template.json"), name + "/template.json")); } catch (error) { if (error instanceof DevctxError) throw error; invalid("Invalid template metadata", { template: name }); }
  checkMeta(meta, name);
  const files = {}, declared = new Set(meta.placeholders.map((p) => p.key)), used = new Set();
  for (const rel of RENDERED) {
    files[rel] = readKitFile(join(dir, ...rel.split("/")), name + "/" + rel);
    for (const [, key] of files[rel].matchAll(MARKER)) { if (!declared.has(key)) invalid("Undeclared template placeholder", { template: name, key }); used.add(key); }
    if (files[rel].replace(MARKER, "").includes("{{dck:")) invalid("Malformed template placeholder", { template: name, path: rel });
  }
  const unused = [...declared].find((key) => !used.has(key));
  if (unused) invalid("Unused template placeholder", { template: name, key: unused });
  return { meta, files };
}
export function listTemplates(root) {
  const node = info(root);
  if (!node) return [];
  if (node.isSymbolicLink() || !node.isDirectory()) unsafe("Unsafe template root");
  return readdirSync(root).sort().map((name) => {
    const { meta } = loadTemplate(root, name);
    return { name: meta.name, description: meta.description, placeholders: meta.placeholders.map(({ key, description, kind, required, default: fallback }) => ({ key, description, kind, required, default: fallback })) };
  });
}

// Seeding reads, it never writes: the workspace must already exist (the flow starts with skill workspace-create).
async function existingWorkspace(roots, selection) {
  if (!["personal", "company"].includes(selection.audience) || selection.project) invalid("Template audience must be personal or company");
  const path = workspacePath(roots, selection);
  if (selection.audience === "company") await loadScope(roots, selection.scope);
  validateRoot(path, "workspace");
  const node = info(path);
  if (!node) throw new DevctxError("NOT_FOUND", "Skill workspace unavailable");
  checkNode(node, path, { directory: true });
  const meta = await readPrivateJson(join(path, "workspace.json"));
  if (meta?.schemaVersion !== 1 || meta.audience !== selection.audience || meta.scope !== (selection.scope ?? null) || meta.project !== null || meta.workspace !== selection.workspace) throw new DevctxError("INTEGRITY", "Workspace scope mismatch");
}
export function parseSets(sets = []) {
  const values = {};
  for (const item of sets) {
    const at = typeof item === "string" ? item.indexOf("=") : -1, key = at > 0 ? item.slice(0, at) : null;
    if (!key || !KEY.test(key)) invalid("Placeholder values use key=value");
    if (Object.hasOwn(values, key)) invalid("Placeholder value set twice", { key });
    values[key] = item.slice(at + 1);
  }
  return values;
}
function fill(meta, { audience, scope }, values) {
  for (const key of Object.keys(values)) if (!meta.placeholders.some((p) => p.key === key)) invalid("Unknown template placeholder", { key });
  const scoped = meta.placeholders.some((p) => p.kind === "scope");
  if (scoped && (audience !== "company" || !scope)) invalid("Template with scope placeholders requires --audience company --scope", { template: meta.name });
  const filled = {};
  for (const p of meta.placeholders) {
    const value = Object.hasOwn(values, p.key) ? values[p.key] : p.required ? invalid("Placeholder value required", { key: p.key }) : p.default;
    if (value.length > 256 || (p.required && !value.trim()) || /[\u0000-\u001f\u007f]/.test(value) || value.includes("{{dck:")) invalid("Invalid placeholder value", { key: p.key });
    if (p.kind === "scope" && !(value === scope || (value.startsWith(scope + ".") && value.length <= 96 && PROJECT_ID.test(value)))) invalid("Scope placeholder must name the workspace scope or a name inside it", { key: p.key });
    assertNoSensitive(value);
    filled[p.key] = value;
  }
  return filled;
}
function render({ meta, files }, filled) {
  const out = [];
  for (const rel of RENDERED) {
    const json = rel.endsWith(".json");
    const content = files[rel].replace(MARKER, (_, key) => json ? JSON.stringify(filled[key]).slice(1, -1) : filled[key]);
    if (json) {
      let value; try { value = JSON.parse(content); } catch { invalid("Rendered template JSON is invalid", { path: rel }); }
      if (findForbiddenFields(value).length) invalid("Forbidden metadata field", { path: rel });
    }
    assertNoSensitive(content);
    out.push({ path: rel, content, sha256: sha256(content) });
  }
  const name = JSON.parse(out.find((f) => f.path === "design.json").content).name;
  if (typeof name !== "string" || !SKILL_NAME.test(name) || name.length > 64) invalid("Invalid skill name", { template: meta.name });
  if (name.startsWith("devctx-") || bundledNames().includes(name)) invalid("Reserved skill name", { name });
  if (parseFrontmatter(out.find((f) => f.path === "candidate/SKILL.md").content, { nameOnly: true }).meta.name !== name) invalid("Candidate name differs from design name", { template: meta.name });
  return out;
}
async function renderFor(roots, root, selection, template, values) {
  await existingWorkspace(roots, selection);
  const loaded = loadTemplate(root, template);
  const files = render(loaded, fill(loaded.meta, selection, values));
  const plan = finalizePlan({ kind: "skill-template-render", template, audience: selection.audience, scope: selection.scope ?? null, workspace: selection.workspace, files: files.map(({ path, sha256: hash }) => ({ path, sha256: hash })) });
  return { plan, files };
}
export async function seedTemplate(roots, root, selection, template, values) {
  const { plan, files } = await renderFor(roots, root, selection, template, values);
  return { template, audience: plan.audience, scope: plan.scope, workspace: plan.workspace, layout: files.map((f) => f.path), files, renderDigest: plan.fingerprint };
}

function seededInventory(dir) {
  const found = [];
  function visit(path, rel, depth) {
    const node = info(path);
    if (!node) throw new DevctxError("NOT_FOUND", "Seeded directory unavailable");
    if (node.isSymbolicLink()) unsafe("Seeded symlink refused", { path: rel || "." });
    if (node.isDirectory()) {
      if (depth > 2) throw new DevctxError("INTEGRITY", "Unexpected seeded file", { path: rel });
      for (const name of readdirSync(path).sort()) { if (found.length >= PACKAGE_LIMITS.files) throw new DevctxError("LIMIT", "Seeded file limit exceeded"); visit(join(path, name), rel ? rel + "/" + name : name, depth + 1); }
    } else if (node.isFile()) { if (node.nlink !== 1) unsafe("Linked seeded file refused", { path: rel }); found.push(rel); }
    else unsafe("Non-regular seeded entry", { path: rel });
  }
  visit(dir, "", 0);
  return found;
}
export async function verifyTemplate(roots, root, selection, template, values, dir, renderDigest) {
  const pilot = roots.pilot;
  if (typeof dir !== "string") invalid("Seeded directory required");
  assertInPilot(pilot, dir, "inputsRoot");
  const { plan, files } = await renderFor(roots, root, selection, template, values);
  assertFingerprint(plan, renderDigest);
  const found = seededInventory(dir), expected = new Map(files.map((f) => [f.path, f]));
  for (const rel of [...new Set([...found, ...expected.keys()])].sort()) {
    if (!expected.has(rel)) throw new DevctxError("INTEGRITY", "Unexpected seeded file", { path: rel });
    if (!found.includes(rel)) throw new DevctxError("INTEGRITY", "Seeded file missing", { path: rel });
    const read = await readApprovedSource(pilot.inputsRoot, relative(pilot.inputsRoot, join(dir, ...rel.split("/"))));
    if (read.skipped === "symlink") unsafe("Seeded symlink refused", { path: rel });
    if (read.skipped || !read.utf8Valid || info(join(dir, ...rel.split("/")))?.nlink !== 1) unsafe("Seeded file unavailable", { path: rel });
    if (read.text !== expected.get(rel).content) throw new DevctxError("INTEGRITY", "Seeded file differs from the render", { path: rel });
  }
  return { verified: true, template, audience: plan.audience, scope: plan.scope, workspace: plan.workspace, renderDigest: plan.fingerprint, files: files.map(({ path, sha256: hash }) => ({ path, sha256: hash })) };
}
