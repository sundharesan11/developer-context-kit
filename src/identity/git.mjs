import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { DevtwinError } from "../errors.mjs";
export const GIT_LIMITS = Object.freeze({ timeoutMs: 30_000, maxBuffer: 16 << 20, maxRemotes: 16, maxUrlBytes: 2048 });
export function git(cwd, args, { timeoutMs = GIT_LIMITS.timeoutMs } = {}) {
  if (!Array.isArray(args)) throw new DevtwinError("INVALID_INPUT", "Git arguments must be an array");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.LC_ALL = "C"; env.GIT_TERMINAL_PROMPT = "0"; env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null"; env.GIT_CONFIG_NOSYSTEM = "1";
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-C", cwd, ...args], { env, encoding: "utf8", maxBuffer: GIT_LIMITS.maxBuffer, timeout: timeoutMs, killSignal: "SIGKILL" });
  if (r.error?.code === "ENOENT") throw new DevtwinError("GIT_UNAVAILABLE", "Git unavailable");
  if (r.error?.code === "ETIMEDOUT") throw new DevtwinError("GIT_QUERY_FAILED", "Git query timed out", { command: args[0], reason: "timeout" });
  if (r.error?.code === "ENOBUFS") throw new DevtwinError("LIMIT", "Git output too large", { command: args[0] });
  if (r.error) throw r.error;
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
// Strict query: only listed exit codes pass; "not a repository" is recognised only when asked for.
export function gitQuery(cwd, args, { allow = [0], notRepo = false, ...options } = {}) {
  const r = git(cwd, args, options);
  if (allow.includes(r.status)) return r;
  if (notRepo && r.status === 128 && /not a git repository/.test(r.stderr)) return { ...r, notRepo: true };
  throw new DevtwinError("GIT_QUERY_FAILED", "Git query failed", { command: args[0], status: r.status });
}
export function stripCredentials(url) {
  try {
    if (url.includes("://")) {
      const u = new URL(url);
      u.username = ""; u.password = ""; u.search = ""; u.hash = "";
      return u.toString().replace(/\/$/, "");
    }
    return url.split(/[?#]/, 1)[0].replace(/^[^@\s]+@(?=[^:]+:)/, "");
  } catch { return url.includes("://") ? "[invalid-remote-url]" : url.split(/[?#]/, 1)[0].replace(/^[^@\s]+@(?=[^:]+:)/, ""); }
}
export function normalizeRemote(url) { return stripCredentials(url).replace(/\.git$/, "").replace(/\/$/, ""); }
export async function locateWorktree(cwd) {
  const canonical = realpathSync(cwd);
  const bare = gitQuery(canonical, ["rev-parse", "--is-bare-repository"], { notRepo: true });
  if (bare.notRepo) return { git: false, cwd: canonical };
  if (bare.stdout.trim() === "true" || gitQuery(canonical, ["rev-parse", "--is-inside-git-dir"]).stdout.trim() === "true") throw new DevtwinError("PATH_UNSAFE", "Bare or internal Git directory unsupported");
  const top = gitQuery(canonical, ["rev-parse", "--show-toplevel"], { notRepo: true });
  if (top.notRepo) return { git: false, cwd: canonical };
  const root = realpathSync(top.stdout.trim());
  const absolute = (value) => isAbsolute(value) ? realpathSync(value) : realpathSync(resolve(canonical, value));
  const commonDir = absolute(gitQuery(canonical, ["rev-parse", "--git-common-dir"]).stdout.trim());
  const gitDir = absolute(gitQuery(canonical, ["rev-parse", "--git-dir"]).stdout.trim());
  const b = git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const h = git(canonical, ["rev-parse", "--verify", "HEAD"]);
  const branch = b.ok ? b.stdout.trim() : null, head = h.ok ? h.stdout.trim() : null;
  const filters = gitQuery(canonical, ["config", "--includes", "--name-only", "--get-regexp", "^(filter|diff)\\."], { allow: [0, 1] });
  if (filters.ok && filters.stdout.trim()) throw new DevtwinError("PATH_UNSAFE", "Repository filters require manual review");
  const dirty = Boolean(gitQuery(canonical, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]).stdout);
  const remotes = [];
  const names = gitQuery(canonical, ["remote"]).stdout.trim().split("\n").filter(Boolean);
  if (names.length > GIT_LIMITS.maxRemotes) throw new DevtwinError("LIMIT", "Too many Git remotes", { max: GIT_LIMITS.maxRemotes });
  for (const name of names) {
    const result = gitQuery(canonical, ["remote", "get-url", "--", name]);
    if (Buffer.byteLength(result.stdout.trim()) > GIT_LIMITS.maxUrlBytes) throw new DevtwinError("LIMIT", "Git remote URL too long", { max: GIT_LIMITS.maxUrlBytes });
    remotes.push({ name, url: stripCredentials(result.stdout.trim()) });
  }
  const warnings = [];
  if (dirty) warnings.push({ code: "DIRTY_WORKTREE" });
  if (!branch) warnings.push({ code: "DETACHED_HEAD" });
  if (!head) warnings.push({ code: "NO_COMMITS" });
  return { git: true, cwd: canonical, root, commonDir, gitDir, kind: gitDir === commonDir ? "main" : "linked-worktree", branch, head, dirty, remotes, warnings };
}
