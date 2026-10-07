import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { DevctxError } from "../errors.mjs";
export function git(cwd, args) {
  if (!Array.isArray(args)) throw new DevctxError("INVALID_INPUT", "Git arguments must be an array");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.LC_ALL = "C"; env.GIT_TERMINAL_PROMPT = "0"; env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_CONFIG_GLOBAL = "/dev/null"; env.GIT_CONFIG_NOSYSTEM = "1";
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.untrackedCache=false", "-C", cwd, ...args], { env, encoding: "utf8", maxBuffer: 16 << 20 });
  if (r.error?.code === "ENOENT") throw new DevctxError("GIT_UNAVAILABLE", "Git unavailable");
  if (r.error) throw r.error;
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
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
  if (git(canonical, ["rev-parse", "--is-bare-repository"]).stdout.trim() === "true" || git(canonical, ["rev-parse", "--is-inside-git-dir"]).stdout.trim() === "true") throw new DevctxError("PATH_UNSAFE", "Bare or internal Git directory unsupported");
  const top = git(canonical, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { git: false, cwd: canonical };
  const root = realpathSync(top.stdout.trim());
  const absolute = (value) => isAbsolute(value) ? realpathSync(value) : realpathSync(resolve(canonical, value));
  const commonDir = absolute(git(canonical, ["rev-parse", "--git-common-dir"]).stdout.trim());
  const gitDir = absolute(git(canonical, ["rev-parse", "--git-dir"]).stdout.trim());
  const b = git(canonical, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const h = git(canonical, ["rev-parse", "--verify", "HEAD"]);
  const branch = b.ok ? b.stdout.trim() : null, head = h.ok ? h.stdout.trim() : null;
  const filters = git(canonical, ["config", "--includes", "--name-only", "--get-regexp", "^(filter|diff)\\."]);
  if (filters.ok && filters.stdout.trim()) throw new DevctxError("PATH_UNSAFE", "Repository filters require manual review");
  const dirty = Boolean(git(canonical, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--ignore-submodules=all"]).stdout);
  const remotes = [];
  const list = git(canonical, ["remote"]);
  if (list.ok) for (const name of list.stdout.trim().split("\n").filter(Boolean)) {
    const result = git(canonical, ["remote", "get-url", name]);
    if (result.ok) remotes.push({ name, url: stripCredentials(result.stdout.trim()) });
  }
  const warnings = [];
  if (dirty) warnings.push({ code: "DIRTY_WORKTREE" });
  if (!branch) warnings.push({ code: "DETACHED_HEAD" });
  if (!head) warnings.push({ code: "NO_COMMITS" });
  return { git: true, cwd: canonical, root, commonDir, gitDir, kind: gitDir === commonDir ? "main" : "linked-worktree", branch, head, dirty, remotes, warnings };
}
