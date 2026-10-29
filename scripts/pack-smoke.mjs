// U42: the pack smoke test. It packs the kit into a temporary folder, installs the tarball offline into a throwaway
// global prefix, then runs `devtwin --version` and `devtwin demo` from that install. U48: under a temporary HOME with a
// private ~/.devtwin it then copies the installed package into a kit folder (kit install, plan then apply), checks
// that kit list calls it ok, and runs the kit's own bin. It prints one JSON line and exits nonzero on any failure. The
// temporary folder is removed on success and kept for inspection on failure.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
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
// Kit folders are read-only (0500 and 0400): give each folder its owner write bit back before the removal.
const unlock = (dir) => { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name)); };
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
  if (demo.ok !== true || !skipped.includes("package-allowlist") || !skipped.includes("npm-install")) throw new Error("demo did not pass from the package");
  // The owner's kit install from the installed package, in a HOME of its own with a private ~/.devtwin.
  const kitHome = join(temp, "kit-home"), kitEnv = { PATH: process.env.PATH, HOME: kitHome };
  mkdirSync(join(kitHome, ".devtwin"), { recursive: true, mode: 0o700 });
  chmodSync(join(kitHome, ".devtwin"), 0o700);
  const plan = lastJson(run("kit-plan", bin, ["kit", "install"], kitEnv)).result;
  const applied = lastJson(run("kit-apply", bin, ["kit", "install", "--apply"], kitEnv)).result;
  if (plan.version !== version || applied.status !== "installed" || applied.digest !== plan.digest || applied.kitRoot !== plan.kitRoot) throw new Error("kit install did not install the planned kit");
  const kits = lastJson(run("kit-list", bin, ["kit", "list"], kitEnv)).result.kits;
  if (kits.length !== 1 || kits[0].kitRoot !== applied.kitRoot || kits[0].status !== "ok" || kits[0].kitId !== plan.kitId) throw new Error("kit list does not show the kit as ok");
  const kitShown = lastJson(run("kit-version", process.execPath, [join(applied.kitRoot, "bin", "devtwin.mjs"), "--version"], kitEnv)).result;
  if (kitShown.version !== version || kitShown.digest !== plan.digest.slice(0, 12)) throw new Error("the kit's own bin reports another version or digest");
  out = { ok: true, version: shown.result, tarball: tarball.split("/").at(-1), steps, demo: { checks: demo.result.checks.length, skipped }, kit: { kitId: plan.kitId, version: kitShown } };
  unlock(temp);
  rmSync(temp, { recursive: true, force: true });
} catch (error) {
  out = { ok: false, error: error.message, stderr: error.stderr ?? null, steps, temp };
}
process.stdout.write(JSON.stringify(out) + "\n");
process.exitCode = out.ok ? 0 : 1;
