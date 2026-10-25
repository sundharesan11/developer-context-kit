import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyAllowlist, checkMarkdown } from "../src/writing/ste.mjs";
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(value("--root", "."));
const allowlistPath = resolve(value("--allowlist", join(root, "scripts/writing-allowlist.json")));
const findings = [];
// R38 scope: repository docs, README.md and bundled skills. Plans and research are dated design history and keep
// their original wording; the landing site has its own content pipeline.
const walk = (dir) => existsSync(join(root, dir)) ? readdirSync(join(root, dir), { recursive: true }).map((f) => join(dir, f).split("\\").join("/")) : [];
const files = [
  ...(existsSync(join(root, "README.md")) ? ["README.md"] : []),
  ...walk("docs").filter((f) => f.endsWith(".md") && !/^docs\/(?:plans|research)\//.test(f)),
  ...walk("skills").filter((f) => /(?:^|\/)SKILL\.md$/.test(f)),
].sort();
for (const file of files) for (const f of checkMarkdown(readFileSync(join(root, file), "utf8"))) findings.push({ file, ...f });
// The allowlist is reviewed: every entry names the file, rule and exact excerpt, and gives a non-empty reason.
// A missing file means no exceptions.
let entries = [];
if (existsSync(allowlistPath)) {
  try {
    entries = JSON.parse(readFileSync(allowlistPath, "utf8"));
    if (!Array.isArray(entries) || !entries.every((e) => e && ["file", "rule", "excerpt", "reason"].every((k) => typeof e[k] === "string" && e[k].trim()))) throw new Error();
  } catch { entries = []; findings.push({ file: "scripts/writing-allowlist.json", rule: "allowlist-invalid", message: "each entry needs file, rule, excerpt and reason" }); }
}
const result = applyAllowlist(findings, entries);
const out = result.findings.concat(result.stale.map(({ file, excerpt }) => ({ file, rule: "stale-allowlist", excerpt, message: "allowlist entry no longer matches a finding" })));
process.stdout.write(JSON.stringify({ ok: out.length === 0, files: files.length, findings: out }) + "\n");
process.exitCode = out.length ? 1 : 0;
