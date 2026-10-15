// Read-only repository snapshot (R16): proves a run left a client repository unchanged.
// Usage: node scripts/repo-snapshot.mjs --repo <path> --out <file>   writes a new 0600 JSON snapshot
//        node scripts/repo-snapshot.mjs --compare <a> <b>             exit 0 identical, 1 different
// Tracked and untracked files and .git (outside objects, logs and FETCH_HEAD) are hashed; ignored files
// are recorded by path, size and modification time only, a wholly ignored folder as one entry. Git runs only through gitQuery, which never
// refreshes the index or takes optional locks. The snapshot never writes inside the repository.
import { createReadStream, lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve, isAbsolute, basename, sep } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { gitQuery } from "../src/identity/git.mjs";
import { isWithin, writeNewFile } from "../src/storage/fsx.mjs";
import { DevctxError, toJson } from "../src/errors.mjs";
const list = (cwd, args) => gitQuery(cwd, ["ls-files", "-z", ...args]).stdout.split("\0").filter(Boolean);
const sha256File = (path) => new Promise((done, fail) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", fail).on("data", (chunk) => hash.update(chunk)).on("end", () => done(hash.digest("hex")));
});
function located(repo) {
  const root = realpathSync(repo);
  const top = gitQuery(root, ["rev-parse", "--show-toplevel"], { notRepo: true });
  if (top.notRepo || realpathSync(top.stdout.trim()) !== root) throw new DevctxError("INVALID_INPUT", "Repository root required");
  const common = gitQuery(root, ["rev-parse", "--git-common-dir"]).stdout.trim();
  return { root, commonDir: realpathSync(isAbsolute(common) ? common : resolve(root, common)) };
}
async function hashed(path, cls) {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return { class: cls, type: "missing" };
  if (st.isSymbolicLink()) return { class: cls, type: "link", sha256: createHash("sha256").update(readlinkSync(path)).digest("hex") };
  if (st.isDirectory()) return { class: cls, type: "dir" };
  if (!st.isFile()) return { class: cls, type: "other" };
  return { class: cls, type: "file", mode: st.mode & 0o777, size: st.size, sha256: await sha256File(path) };
}
// .git outside objects, logs and FETCH_HEAD, including each linked worktree's own logs and FETCH_HEAD.
function skipGit(rel) {
  const parts = rel.split(sep);
  if (["objects", "logs", "FETCH_HEAD"].includes(parts[0])) return true;
  return parts[0] === "worktrees" && ["logs", "FETCH_HEAD"].includes(parts[2]);
}
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name), rel = relative(base, path);
    if (skipGit(rel)) continue;
    out.push(rel);
    if (lstatSync(path).isDirectory()) walk(path, base, out);
  }
  return out;
}
export async function snapshotRepo(repo) {
  const { root, commonDir } = located(repo);
  const entries = {};
  for (const rel of list(root, ["--cached"])) entries[rel] = await hashed(join(root, rel), "tracked");
  for (const rel of list(root, ["--others", "--exclude-standard"])) entries[rel] = await hashed(join(root, rel), "untracked");
  // --directory collapses a wholly ignored folder (such as node_modules) to one entry, keeping
  // the listing inside gitQuery's output limit on large repositories.
  for (const rel of list(root, ["--others", "--ignored", "--exclude-standard", "--directory"])) {
    const st = lstatSync(join(root, rel), { throwIfNoEntry: false });
    entries[rel] = !st ? { class: "ignored", type: "missing" } : st.isDirectory() ? { class: "ignored", type: "dir", mtimeMs: st.mtimeMs } : { class: "ignored", size: st.size, mtimeMs: st.mtimeMs };
  }
  const dotGit = join(root, ".git");
  const prefix = commonDir === dotGit ? ".git" : "git-common-dir";
  if (prefix !== ".git") entries[".git"] = await hashed(dotGit, "git");
  for (const rel of walk(commonDir)) entries[prefix + "/" + rel.split(sep).join("/")] = await hashed(join(commonDir, rel), "git");
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]]));
  return { schemaVersion: 1, repo: root, entries: sorted };
}
export function compareSnapshots(a, b) {
  const paths = [...new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])].sort();
  const differences = [];
  for (const path of paths) {
    const before = a.entries[path], after = b.entries[path];
    if (!before) differences.push({ path, change: "added" });
    else if (!after) differences.push({ path, change: "removed" });
    else if (JSON.stringify(before) !== JSON.stringify(after)) differences.push({ path, change: "modified" });
  }
  return differences;
}
export async function writeSnapshot(repo, out) {
  const { root, commonDir } = located(repo);
  const parent = realpathSync(dirname(resolve(out)));
  if (isWithin(parent, root) || isWithin(parent, commonDir)) throw new DevctxError("PATH_UNSAFE", "Snapshot output must be outside the repository");
  const snapshot = await snapshotRepo(root);
  await writeNewFile(join(parent, basename(out)), JSON.stringify(snapshot, null, 2) + "\n");
  return snapshot;
}
async function cli(argv) {
  let values, positionals;
  try { ({ values, positionals } = parseArgs({ args: argv, options: { repo: { type: "string" }, out: { type: "string" }, compare: { type: "boolean" } }, allowPositionals: true, strict: true })); }
  catch { return [2, { ok: false, error: { code: "DEVCTX_USAGE" } }]; }
  if (values.compare && positionals.length === 2 && !values.repo && !values.out) {
    const [a, b] = await Promise.all(positionals.map(async (p) => JSON.parse(await readFile(p, "utf8"))));
    const differences = compareSnapshots(a, b);
    return [differences.length ? 1 : 0, { ok: true, identical: differences.length === 0, differences }];
  }
  if (!values.compare && values.repo && values.out && positionals.length === 0) {
    const snapshot = await writeSnapshot(values.repo, values.out);
    return [0, { ok: true, out: resolve(values.out), entries: Object.keys(snapshot.entries).length }];
  }
  return [2, { ok: false, error: { code: "DEVCTX_USAGE" } }];
}
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [code, body] = await cli(process.argv.slice(2)).catch((error) => [1, { ok: false, error: toJson(error) }]);
  process.stdout.write(JSON.stringify(body) + "\n");
  process.exitCode = code;
}
