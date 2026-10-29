import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scanSensitive } from "../src/records/redact.mjs";
import { isWithin } from "../src/storage/fsx.mjs";
import { RUNTIME_ENTRIES, scanRuntime } from "../src/kit/runtime-files.mjs";
const args = process.argv.slice(2);
const value = (flag, fallback) => { const i = args.indexOf(flag); return i < 0 ? fallback : args[i + 1]; };
const root = resolve(value("--root", "."));
const allowlist = resolve(value("--allowlist", join(root, "scripts/package-allowlist.json")));
const denylist = args.includes("--denylist") ? resolve(value("--denylist")) : null;
const noPack = args.includes("--no-pack");
const findings = [];
// Instance data at the root or under a private root, optionally below scopes/<scope>/. Applied to the tracked and
// untracked-but-not-ignored file list and to pack entries. Kit source such as src/profile/ and templates/skills/ is not
// anchored here and stays allowed; the home-path, email and denylist scans remain the personal-identifier gate.
const PRIVATE_STATE = /^(?:(?:data|state|config|inputs|\.local|private)\/)?(?:scopes\/[^/]+\/)?(?:records|operations|proposals|staging|runs|locks|profile|digests|drafts|stack|skill-templates)(\/|$)|(^|\/)registry\.json$|\.lock$/;
const gitEnv = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
const listed = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { env: gitEnv, encoding: "utf8" });
const files = listed.status === 0 ? [...new Set(listed.stdout.split("\0").filter(Boolean))].sort() : [];
if (listed.status !== 0) findings.push({ file: ".", type: "git-list-failed" });
let allowed = [];
try { allowed = JSON.parse(readFileSync(allowlist, "utf8")); if (!Array.isArray(allowed)) throw new Error(); } catch { findings.push({ file: "scripts/package-allowlist.json", type: "allowlist-invalid" }); }
const allow = new Set(allowed);
for (const file of files) if (!allow.has(file)) findings.push({ file, type: "extra" });
for (const file of allowed) if (!files.includes(file)) findings.push({ file, type: "missing" });
let terms = [];
if (denylist) {
  if (isWithin(denylist, root)) findings.push({ file: ".", type: "denylist-inside-root" });
  else try { terms = readFileSync(denylist, "utf8").split(/\r?\n/).filter(Boolean); } catch { findings.push({ file: ".", type: "denylist-unreadable" }); }
}
for (const file of files) {
  if (/\.handoff\.md$/i.test(file)) findings.push({ file, type: "generated-handoff-packet" });
  if (PRIVATE_STATE.test(file)) findings.push({ file, type: "private-state" });
  let body;
  try { body = readFileSync(join(root, file), "utf8"); } catch { findings.push({ file, type: "unreadable" }); continue; }
  for (const hit of scanSensitive(body)) findings.push({ file, type: "sensitive:" + hit.type });
  if (/\/(?:Users|home)\/[^/\s"'<>]+/.test(body)) findings.push({ file, type: "absolute-home-path" });
  for (const match of body.matchAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi)) if (!/@example\.(?:com|invalid)$/i.test(match[0])) findings.push({ file, type: "private-email" });
  terms.forEach((term, index) => { if (body.toLowerCase().includes(term.toLowerCase())) findings.push({ file, type: "term #" + (index + 1) }); });
}
// KTD7: a packed file must not point at a docs/ path of the kit that the pack leaves out. Whole-line comments in
// source are for contributors reading the Git clone and are not scanned; a published URL is not a kit path.
const DOC_REF = /(?<![\w/.:-])(?:\.\.?\/)*(docs\/[\w./-]*[\w/])/g;
function docRefs(file, packed) {
  let text;
  try { text = readFileSync(join(root, file), "utf8"); } catch { return []; }
  if (file.endsWith(".mjs")) text = text.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  const refs = new Set([...text.matchAll(DOC_REF)].map((m) => m[1].replace(/\/$/, "")));
  return [...refs].filter((ref) => !packed.has(ref) && ![...packed].some((p) => p.startsWith(ref + "/")) && existsSync(join(root, ref)));
}
let pack = noPack ? "not-run" : "run", packed = [];
if (!noPack && listed.status === 0) {
  const temp = mkdtempSync(join(tmpdir(), "devtwin-pack-"));
  const env = { PATH: process.env.PATH, HOME: temp, npm_config_cache: join(temp, "cache"), npm_config_logs_max: "0", npm_config_update_notifier: "false", npm_config_offline: "true" };
  const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, env, encoding: "utf8", maxBuffer: 16 << 20 });
  if (result.status !== 0) findings.push({ file: ".", type: "pack-failed" });
  else {
    try {
      const entries = JSON.parse(result.stdout)[0].files.map((x) => x.path).sort();
      packed = entries;
      // U42 (KTD3, KTD7): the pack is exactly the runtime set that src/kit/runtime-files.mjs defines.
      let declared = null;
      try { declared = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files; } catch {}
      if (JSON.stringify(declared) !== JSON.stringify(RUNTIME_ENTRIES)) findings.push({ file: "package.json", type: "files-mismatch" });
      const runtime = scanRuntime(root), runtimeSet = new Set(runtime.files), packSet = new Set(entries);
      for (const item of runtime.refused) findings.push({ file: item.path, type: "runtime-" + item.reason });
      for (const file of runtime.files) if (!packSet.has(file)) findings.push({ file, type: "pack-missing" });
      for (const file of entries) {
        if (/\.handoff\.md$/i.test(file)) findings.push({ file, type: "generated-handoff-packet-in-pack" });
        if (!allow.has(file) || !runtimeSet.has(file)) findings.push({ file, type: "pack-extra" });
        if (PRIVATE_STATE.test(file)) findings.push({ file, type: "private-state-in-pack" });
        for (const ref of docRefs(file, packSet)) findings.push({ file, type: "pack-docs-ref", ref });
      }
    } catch { findings.push({ file: ".", type: "pack-json-invalid" }); }
  }
}
const out = { ok: findings.length === 0, files, pack, packed, findings };
process.stdout.write(JSON.stringify(out) + "\n");
process.exitCode = out.ok ? 0 : 1;
