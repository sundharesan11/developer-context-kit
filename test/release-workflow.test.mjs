// U47 (KTD8, R6, R7): static checks on the release workflow and package metadata, the kit digest script against kit
// install for one packed tarball, and the local publish guard. No YAML library: the checks read the workflow by lines.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(import.meta.dirname, "..");
const workflowPath = join(root, ".github/workflows/release.yml");
const workflow = () => readFileSync(workflowPath, "utf8");
const pkg = () => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The text of each job under `jobs:`, keyed by job id. A job starts at a two-space key and ends at the next one.
function jobs(text) {
  const lines = text.split("\n"), start = lines.indexOf("jobs:"), out = {};
  let name = null;
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([a-z][a-z0-9-]*):$/.exec(line);
    if (key) { name = key[1]; out[name] = ""; continue; }
    if (/^\S/.test(line)) break;
    if (name) out[name] += line + "\n";
  }
  return out;
}
// The top-level block that starts at `key:` up to the next top-level key.
function block(text, key) {
  const lines = text.split("\n"), i = lines.indexOf(key + ":");
  if (i < 0) return null;
  const end = lines.findIndex((line, j) => j > i && /^\S/.test(line));
  return lines.slice(i, end < 0 ? undefined : end).join("\n").trimEnd();
}
function temp(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("release workflow triggers only on pushed v* tags", () => {
  const text = workflow();
  assert.equal(block(text, "on"), "on:\n  push:\n    tags:\n      - 'v*'");
  assert.doesNotMatch(text, /workflow_dispatch|pull_request|workflow_run|schedule:|branches:|repository_dispatch/);
});

test("release workflow grants id-token write only to the publish job, which needs the gate", () => {
  const text = workflow(), all = jobs(text);
  assert.deepEqual(Object.keys(all), ["gate", "publish"]);
  assert.equal(block(text, "permissions"), "permissions:\n  contents: read");
  assert.equal([...text.matchAll(/id-token(?=:)/g)].length, 1);
  assert.match(all.publish, /\n {4}permissions:\n {6}contents: write\n {6}id-token: write\n/);
  assert.doesNotMatch(all.gate, /permissions:|id-token|environment:/);
  assert.match(all.publish, /\n {4}needs: gate\n/);
  assert.match(all.publish, /\n {4}environment: npm-release\n/);
  assert.doesNotMatch(text, /write-all|secrets\.|pull_request_target|self-hosted|continue-on-error|NODE_AUTH_TOKEN|NPM_TOKEN/);
});

test("release gate checks the tag, runs every gate on macOS for both Node versions and outputs the kit digest", () => {
  const { gate } = jobs(workflow());
  assert.match(gate, /runs-on: macos-15\n/);
  assert.match(gate, /node: \['22\.13\.0', '26\.4\.0'\]/);
  assert.match(gate, /"\$TAG" != "v\$VERSION"/, "the tag must equal v + the package.json version");
  const order = ["\"$TAG\" != \"v$VERSION\"", "run: npm run check:package", "run: npm run check:writing", "run: npm test", "run: node scripts/pack-smoke.mjs", "node scripts/kit-digest.mjs"];
  const at = order.map((s) => gate.indexOf(s));
  assert.ok(at.every((i) => i > 0), JSON.stringify(at));
  assert.deepEqual([...at].sort((a, b) => a - b), at, "gates run in the plan's order");
  for (const out of ["version", "digest", "kit-id"]) assert.match(gate, new RegExp("\\n {6}" + out + ": \\$\\{\\{ steps\\.digest\\.outputs\\." + out + " \\}\\}"));
  // The workflow runs every step under bash with pipefail, as ci.yml does.
  assert.equal(block(workflow(), "defaults"), "defaults:\n  run:\n    shell: bash");
});

test("release publish job pins npm exactly, never writes the default dist-tag and drafts the GitHub release", () => {
  const text = workflow(), { publish } = jobs(text);
  assert.doesNotMatch(text, /latest/i);
  const pin = /NPM_VERSION: '([^']+)'/.exec(publish);
  assert.ok(pin, "npm version is pinned in the publish job");
  assert.match(pin[1], /^11\.(\d+)\.(\d+)$/, "an exact npm 11 version, no range");
  const [minor, patch] = pin[1].split(".").slice(1).map(Number);
  assert.ok(minor > 5 || (minor === 5 && patch >= 1), "trusted publishing needs npm 11.5.1 or later");
  assert.match(publish, /npm install --global --ignore-scripts --no-audit --no-fund "npm@\$NPM_VERSION"/);
  assert.match(publish, /test "\$\(npm --version\)" = "\$NPM_VERSION"/);
  // Trusted publishing needs Node 22.14.0 or later; the gate's 22.13.0 is not enough for the publish job.
  assert.match(publish, /node-version: '26\.4\.0'/);
  assert.match(publish, /npm publish "\$TARBALL" --provenance --access public --tag "\$DIST_TAG"/);
  assert.match(publish, /\*-\*\) DIST_TAG=alpha ;;\n\s+\*\) DIST_TAG=next ;;/);
  assert.match(publish, /"\$DIGEST" != "\$GATE_DIGEST"/, "the published tarball has the gate's digest");
  assert.match(publish, /gh release create "\$TAG" --repo "\$GITHUB_REPOSITORY" --draft --verify-tag/);
  assert.ok(publish.includes("GH_TOKEN: ${{ github.token }}"));
  assert.match(publish, /SOURCE_COMMIT: \$\{\{ github\.sha \}\}/);
  assert.ok(publish.indexOf("npm publish") < publish.indexOf("gh release create"));
});

test("release workflow pins every action by full commit SHA and keeps credentials out of the checkout", () => {
  const text = workflow();
  const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 4);
  for (const action of uses) assert.match(action, /^actions\/(?:checkout|setup-node)@[a-f0-9]{40}$/);
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  for (const action of uses) assert.ok(ci.includes(action), "same pinned SHA as ci.yml: " + action);
  assert.equal([...text.matchAll(/persist-credentials: false/g)].length, 2);
  assert.equal([...text.matchAll(/package-manager-cache: false/g)].length, 2);
});

test("package metadata allows publishing from the release workflow only", () => {
  const p = pkg();
  assert.equal("private" in p, false);
  assert.deepEqual(p.repository, { type: "git", url: "git+https://github.com/sundharesan11/devtwin.git" });
  assert.deepEqual(p.publishConfig, { access: "public", provenance: true });
  assert.equal(p.scripts.prepublishOnly, "node scripts/publish-guard.mjs");
  assert.equal(p.homepage, "https://sundharesan11.github.io/devtwin/");
  assert.deepEqual(p.bugs, { url: "https://github.com/sundharesan11/devtwin/issues" });
});

test("publish guard refuses outside GitHub Actions and allows the explicit override", () => {
  const guard = (env) => spawnSync(process.execPath, [join(root, "scripts/publish-guard.mjs")], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  for (const env of [{}, { GITHUB_ACTIONS: "false" }, { GITHUB_ACTIONS: "1" }, { DEVTWIN_ALLOW_LOCAL_PUBLISH: "true" }, { DEVTWIN_ALLOW_LOCAL_PUBLISH: "" }]) {
    const r = guard(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.deepEqual(JSON.parse(r.stdout).error, "LOCAL_PUBLISH_REFUSED");
    assert.match(r.stderr, /release workflow/);
  }
  for (const env of [{ GITHUB_ACTIONS: "true" }, { DEVTWIN_ALLOW_LOCAL_PUBLISH: "1" }]) {
    const r = guard(env);
    assert.equal(r.status, 0, JSON.stringify(env));
    assert.equal(JSON.parse(r.stdout).ok, true);
  }
});

test("kit digest script refuses a missing or malformed tarball", (t) => {
  const dir = temp(t, "devtwin-kit-digest-bad-");
  const run = (args) => spawnSync(process.execPath, [join(root, "scripts/kit-digest.mjs"), ...args], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  for (const args of [[], [join(dir, "missing.tgz")], [join(dir, "a.tgz"), "extra"]]) {
    const r = run(args);
    assert.equal(r.status, 1, JSON.stringify(args));
    assert.equal(JSON.parse(r.stdout).ok, false);
  }
  // A tarball whose root is not package/ is refused.
  mkdirSync(join(dir, "src/other"), { recursive: true });
  assert.equal(spawnSync("tar", ["-czf", join(dir, "other.tgz"), "-C", join(dir, "src"), "other"]).status, 0);
  const other = run([join(dir, "other.tgz")]);
  assert.equal(other.status, 1);
  assert.equal(JSON.parse(other.stdout).error, "tarball root is not package/");
});

test("kit digest of the packed tarball equals the digest kit install computes for the same package", (t) => {
  const dir = temp(t, "devtwin-kit-digest-"), home = join(dir, "home"), prefix = join(dir, "prefix");
  mkdirSync(join(home, ".devtwin"), { recursive: true, mode: 0o700 });
  const npmEnv = { PATH: process.env.PATH, HOME: home, npm_config_cache: join(dir, "cache"), npm_config_logs_max: "0", npm_config_update_notifier: "false", npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false" };
  const npm = (args) => { const r = spawnSync("npm", args, { cwd: dir, env: npmEnv, encoding: "utf8", maxBuffer: 16 << 20 }); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const tarball = join(dir, JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", dir, root]))[0].filename);
  npm(["install", "-g", "--prefix", prefix, tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const script = spawnSync(process.execPath, [join(root, "scripts/kit-digest.mjs"), tarball], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(script.status, 0, script.stdout + script.stderr);
  const printed = JSON.parse(script.stdout);
  const install = spawnSync(join(prefix, "bin/devtwin"), ["kit", "install"], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(install.status, 0, install.stdout + install.stderr);
  const plan = JSON.parse(install.stdout.trim().split("\n").at(-1)).result;
  assert.deepEqual(printed, { ok: true, version: pkg().version, digest: plan.digest, kitId: plan.kitId });
  assert.equal(plan.kitId, "npm:" + pkg().version + "+sha256:" + plan.digest);
  assert.equal(existsSync(join(home, ".devtwin/kits")), false, "the kit install plan writes nothing");
});
