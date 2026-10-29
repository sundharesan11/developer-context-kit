// U42: the pack smoke test. It packs the kit into a temporary folder, installs the tarball offline into a throwaway
// global prefix, then runs `devtwin --version` and `devtwin demo` from that install. It prints one JSON line and
// exits nonzero on any failure. The temporary folder is removed on success and kept for inspection on failure.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const temp = realpathSync(mkdtempSync(join(tmpdir(), "devtwin-pack-smoke-")));
const home = join(temp, "home"), prefix = join(temp, "prefix");
mkdirSync(home, { mode: 0o700 });
// npm gets an isolated HOME and cache, as in scripts/check-package.mjs, so no user npm config or token applies.
const npmEnv = { PATH: process.env.PATH, HOME: home, npm_config_cache: join(temp, "cache"), npm_config_logs_max: "0", npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
const steps = [];
const run = (step, command, args, env, timeout = 300000) => {
  const r = spawnSync(command, args, { cwd: temp, env, encoding: "utf8", timeout, maxBuffer: 16 << 20 });
  steps.push({ step, status: r.status });
  if (r.status !== 0) throw Object.assign(new Error(step + " failed"), { stderr: String(r.stderr).slice(-400) });
  return r.stdout;
};
const lastJson = (text) => JSON.parse(text.trim().split("\n").at(-1));
let out;
try {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const tarball = join(temp, JSON.parse(run("pack", "npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp, root], npmEnv))[0].filename);
  run("install", "npm", ["install", "-g", "--prefix", prefix, tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], npmEnv);
  const bin = join(prefix, "bin", "devtwin"), env = { PATH: process.env.PATH, HOME: home };
  const shown = lastJson(run("version", bin, ["--version"], env));
  if (shown.ok !== true || shown.result.version !== version || "commit" in shown.result) throw new Error("version mismatch");
  const demo = lastJson(run("demo", bin, ["demo", "--pilot-root", join(temp, "pilot"), "--report", join(temp, "report.json")], env));
  const skipped = demo.result.checks.filter((c) => c.status === "skipped").map((c) => c.id);
  if (demo.ok !== true || !skipped.includes("package-allowlist")) throw new Error("demo did not pass from the package");
  out = { ok: true, version: shown.result, tarball: tarball.split("/").at(-1), steps, demo: { checks: demo.result.checks.length, skipped } };
  rmSync(temp, { recursive: true, force: true });
} catch (error) {
  out = { ok: false, error: error.message, stderr: error.stderr ?? null, steps, temp };
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exitCode = out.ok ? 0 : 1;
