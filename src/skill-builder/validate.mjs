import { DevctxError } from "../errors.mjs";
import { assertSourceRel, isDeniedRel } from "../storage/source-read.mjs";
import { posix } from "node:path";

export const VALIDATOR_VERSION = "v1";
export const PACKAGE_LIMITS = Object.freeze({ files: 24, fileBytes: 131072, totalBytes: 262144, depth: 4 });
export const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function assertPackageRel(rel) {
  assertSourceRel(rel);
  if (isDeniedRel(rel)) throw new DevctxError("INVALID_INPUT", "Denied package path");
  const parts = rel.split("/");
  if (parts.length > PACKAGE_LIMITS.depth || !(rel === "SKILL.md" || (parts.length >= 2 && ["references", "scripts", "assets"].includes(parts[0])))) throw new DevctxError("INVALID_INPUT", "Unsupported package path");
  if (parts.slice(0, -1).some((part) => !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(part))) throw new DevctxError("INVALID_INPUT", "Unsafe package directory");
  return rel;
}

function parseFrontmatter(text) {
  if (text.charCodeAt(0) === 0xfeff || text.includes("\0")) throw new DevctxError("INVALID_INPUT", "Unsupported skill text");
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0] !== "---") throw new DevctxError("INVALID_INPUT", "Skill frontmatter required");
  const end = lines.indexOf("---", 1);
  if (end < 2 || lines.slice(end + 1).some((line) => line === "---")) throw new DevctxError("INVALID_INPUT", "Invalid frontmatter delimiter");
  const meta = {};
  for (const line of lines.slice(1, end)) {
    const match = /^(name|description): ([^\s].*)$/.exec(line);
    if (!match || Object.hasOwn(meta, match[1]) || !/^[A-Za-z0-9][A-Za-z0-9 .,!?'()/_-]*$/.test(match[2])) throw new DevctxError("INVALID_INPUT", "Unsupported frontmatter syntax");
    meta[match[1]] = match[2].trim();
  }
  if (Object.keys(meta).length !== 2 || !lines.slice(end + 1).join("\n").trim()) throw new DevctxError("INVALID_INPUT", "Incomplete skill");
  return { meta, body: lines.slice(end + 1).join("\n") };
}

export function validatePackage(files, expectedName) {
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new DevctxError("INVALID_INPUT", "Package files required");
  const paths = Object.keys(files).sort();
  if (!paths.includes("SKILL.md") || paths.length > PACKAGE_LIMITS.files) throw new DevctxError("INVALID_INPUT", "Package file limit or SKILL.md missing");
  let total = 0;
  for (const rel of paths) {
    assertPackageRel(rel);
    if (typeof files[rel] !== "string") throw new DevctxError("INVALID_INPUT", "Package text required");
    const bytes = Buffer.byteLength(files[rel]); total += bytes;
    if (bytes > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes || files[rel].includes("\0")) throw new DevctxError("LIMIT", "Package size or binary content refused");
  }
  const { meta } = parseFrontmatter(files["SKILL.md"]);
  if (!SKILL_NAME.test(meta.name) || meta.name.length > 64 || meta.name !== expectedName || !meta.description || meta.description.length > 1024) throw new DevctxError("INVALID_INPUT", "Invalid skill metadata");
  const missing = [], unchecked = [];
  for (const rel of paths.filter((p) => p.endsWith(".md"))) {
    const content = rel === "SKILL.md" ? parseFrontmatter(files[rel]).body : files[rel];
    for (const match of content.matchAll(/\[[^\]\n]+\]\(([^)]+)\)/g)) {
      const target = match[1].split("#", 1)[0];
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      const resolved = posix.join(posix.dirname(rel), target);
      try { assertSourceRel(target); assertPackageRel(resolved); if (!paths.includes(resolved)) missing.push(resolved); }
      catch { missing.push(target); }
    }
    if (/\[[^\]]+\]\[[^\]]*\]|<a\s/i.test(content)) unchecked.push(rel);
  }
  return { valid: missing.length === 0, name: meta.name, files: paths.length, missing, unchecked, helpers: paths.some((p) => p.startsWith("scripts/")) ? "unverified" : "none" };
}
