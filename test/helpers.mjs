import { mkdtemp, realpath, rm, mkdir, writeFile, readdir, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { applyInit } from "../src/config/store.mjs";
import { applyScopeAdd, writeBindingVersion, writeManifest } from "../src/config/store.mjs";
import { readRegistry, publishRegistry } from "../src/config/registry.mjs";
import { withPilotLock, registryLockPath } from "../src/storage/lock.mjs";
import { operationIdFor } from "../src/identity/ids.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
export { sleep };
export const now = () => new Date("2026-10-07T00:00:00.000Z");

export async function stageSourceFixture(t, {p, version = 1, sourceId = "humanizer", skillRoot = "skills/example-skill", contents} = {}) {
  const {getSource, loadBundledCatalog} = await import("../src/skill-sources/catalog.mjs");
  const {gitBlobSha} = await import("../src/skill-sources/selection.mjs");
  const {previewAcquisition} = await import("../src/skill-sources/github-package.mjs");
  const {stageAcquisition} = await import("../src/skill-sources/staging.mjs");
  p ??= await makePilot(t);
  const prefix = skillRoot ? skillRoot + "/" : "";
  contents ??= {
    LICENSE: "Synthetic license bytes\r\n",
    NOTICE: "Synthetic notice bytes\n",
    [prefix + "SKILL.md"]: `---\nname: example-skill\ndescription: |\n  Synthetic example.\nlicense: MIT\nmetadata:\n  version: "${version}"\n---\n# Version ${version}\n[Guide](references/guide.md)\n`,
    [prefix + "references/guide.md"]: "Synthetic guide.\n",
    [prefix + "scripts/inert.mjs"]: "throw new Error('Acquired helper executed');\n"
  };
  const source = getSource(loadBundledCatalog(), sourceId);
  const pin = {sourceId, channel: "stable-release", tag: "v" + version, commit: String(version).repeat(40)};
  const tree = "b".repeat(40), nodes = new Map(), blobs = new Map();
  for (const [path, content] of Object.entries(contents)) {
    const bytes = Buffer.from(content), sha = gitBlobSha(bytes), parts = path.split("/");
    for (let i = 1; i < parts.length; i++) { const dir = parts.slice(0, i).join("/"); nodes.set(dir, {path: dir, type: "tree", mode: "040000", sha: tree}); }
    nodes.set(path, {path, type: "blob", mode: path.endsWith(".mjs") ? "100755" : "100644", sha, size: bytes.length});
    blobs.set(sha, {sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64")});
  }
  const request = async (url) => {
    const path = new URL(url).pathname;
    const body = path.includes("/commits/") ? {sha: pin.commit, tree: {sha: tree}} : path.includes("/trees/") ? {sha: tree, truncated: false, tree: [...nodes.values()]} : blobs.get(path.split("/").at(-1));
    assertFixtureBody(body);
    return new Response(JSON.stringify(body), {headers: {"content-type": "application/json"}});
  };
  const input = {pin, files: Object.keys(contents)};
  const preview = await previewAcquisition(source, input, {request});
  const staged = await stageAcquisition(p.roots, source, {...input, fingerprint: preview.fingerprint}, {request});
  const mapping = {schemaVersion: 1, name: "example-skill", skillRoot,
    files: Object.keys(contents).map((source) => ({source, target: prefix && source.startsWith(prefix) ? source.slice(prefix.length) : source})),
    requiredPaths: Object.keys(contents), licensePaths: ["LICENSE"], noticePaths: Object.hasOwn(contents, "NOTICE") ? ["NOTICE"] : [], dependencies: [],
    compatibility: {claude: "user-reviewed-sandbox", codex: "user-reviewed-sandbox"},
    review: {fileCompleteness: "user-reviewed", licensesAndNotices: "user-reviewed", dependencies: "user-reviewed"}};
  return {p, staged, mapping, contents, stageRunId: staged.runId, stagePath: join(p.dataRoot, "skill-sources/staging", staged.runId)};
}
function assertFixtureBody(body) { if (!body) throw new Error("Unexpected fixture request"); }
export async function sandbox(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "devtwin-t-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function runCli(args, { env = {}, home = tmpdir(), kitRoot, templateRoot } = {}) {
  const chunks = [];
  const stdout = { write(value) { chunks.push(value); return true; } };
  const code = await main(args, { stdout, now, home, env, kitRoot, templateRoot });
  return { code, json: JSON.parse(chunks.join("")) };
}
export async function makePilot(t, { env = {} } = {}) {
  const sb = await sandbox(t), fakeHome = join(sb, "home");
  const root = join(sb, "pilot"), forbidden = [join(sb, "outside-forbidden")];
  await mkdir(fakeHome);
  await mkdir(forbidden[0]);
  for (const rel of ["homes/claude", "homes/codex", "repos", "inputs"]) await mkdir(join(root, rel), { recursive: true });
  const obj = { schemaVersion: 1, pilotRoot: root, configRoot: join(root, "config"), dataRoot: join(root, "data"), stateRoot: join(root, "state"), inputsRoot: join(root, "inputs"), agentHomes: [join(root, "homes/claude"), join(root, "homes/codex")], repos: [join(root, "repos/atlas"), join(root, "repos/beacon")], forbidden };
  const path = join(sb, "pilot.json");
  await writeFile(path, JSON.stringify(obj));
  const pilot = await loadPilot(path, { home: fakeHome, kitRoot: "/nonexistent-kit", env });
  let n = 0;
  return { path, pilot, roots: rootsFromPilot(pilot), configRoot: obj.configRoot, dataRoot: obj.dataRoot, stateRoot: obj.stateRoot, inputsRoot: obj.inputsRoot, agentHomes: obj.agentHomes, reposDir: join(root, "repos"), fakeHome, forbidden, sandbox: sb, async with(patch) { const p = join(sb, "pilot-" + ++n + ".json"); await writeFile(p, JSON.stringify({ ...obj, ...patch })); return p; } };
}
export async function lockFile(t) { return join(await sandbox(t), "x.lock"); }
export async function fixtureGit(cwd, args) {
  const env = { PATH: process.env.PATH, HOME: tmpdir(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" };
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...args], { env, encoding: "utf8" });
}
export async function makeRepo(dir, files) {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "fixture"]);
  return realpath(dir);
}
export async function treeSnapshot(dir) {
  const rows = [];
  async function walk(path) {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), st = await lstat(child);
      const row = [relative(dir, child), st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file", st.mode, st.size, st.mtimeMs];
      if (st.isFile()) row.push(createHash("sha256").update(await readFile(child)).digest("hex"));
      rows.push(row);
      if (st.isDirectory()) await walk(child);
    }
  }
  await walk(dir);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
export async function initPilot(t) {
  const p = await makePilot(t);
  await applyInit(p.roots, { actorRefs: ["email:owner@example.com"], preferences: {}, now });
  return p;
}
export async function seedCommittedProject(t) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope: "acme", hubs: [], policies: [], now });
  const repo = await makeRepo(join(p.reposDir, "atlas"), { "README.md": "# Atlas\n" });
  const operationId = operationIdFor({ scope: "acme", project: "acme.atlas", requestId: "req_seed0001" });
  await withPilotLock(p.roots, registryLockPath(p.roots), { kind: "fixture-seed" }, async () => {
    const binding = { schemaVersion: 1, scope: "acme", project: "acme.atlas", version: 1, roots: [{ path: repo, commonDir: join(repo, ".git"), kind: "main" }], remotes: [], approvedSources: [], expectedRemotes: [], actorRefs: [], environments: [], createdAt: now().toISOString() };
    const bindingHash = await writeBindingVersion(p.roots, binding);
    const manifest = { schemaVersion: 1, operationId, kind: "onboard", requestId: "req_seed0001", requestHash: "sha256:" + "0".repeat(64), scope: "acme", project: "acme.atlas", bindingHash, planFingerprint: "sha256:" + "0".repeat(64), bundles: [] };
    const manifestHash = await writeManifest(p.roots, manifest);
    const { value } = await readRegistry(p.roots);
    await publishRegistry(p.roots, { ...value, generation: 1, bindings: [{ path: repo, commonDir: join(repo, ".git"), scope: "acme", project: "acme.atlas", bindingVersion: 1, bindingHash, operationId, manifestHash }], operations: [{ operationId, requestId: "req_seed0001", requestHash: manifest.requestHash, scope: "acme", project: "acme.atlas", manifestHash, planFingerprint: manifest.planFingerprint, generation: 1 }] }, { expectGeneration: 0 });
  }, { destinations: [p.configRoot, p.dataRoot] });
  return { ...p, repo, scope: "acme", project: "acme.atlas" };
}
export async function onboardFixture(t, { scope = "acme", project = "acme.atlas", repoName = "atlas", requestId = "req_onboard01", accept = "all" } = {}) {
  const p = await initPilot(t);
  await applyScopeAdd(p.roots, { scope, hubs: [], policies: [], now });
  const repo = await makeRepo(join(p.reposDir, repoName), { "README.md": "# Atlas\nBilling API.\n", "package.json": '{"name":"atlas","scripts":{"test":"node --test"}}' });
  const input = { scope, project, repo, approvedDocs: [], expectedRemotes: [], environments: ["staging"], actorRefs: [], accept, requestId };
  const plan = await planOnboard(p.roots, p.pilot, input);
  return { ...p, repo, input, plan };
}
export async function committedProject(t) {
  const s = await onboardFixture(t);
  await applyOnboard(s.roots, s.pilot, s.input, { fingerprint: s.plan.fingerprint, now });
  return { ...s, scope: s.input.scope, project: s.input.project };
}
export async function twoScopes(t) {
  const p = await initPilot(t);
  const result = { roots: p.roots, pilot: p.pilot, base: p.reposDir };
  for (const [scope, project, repoName] of [["acme", "acme.atlas", "atlas"], ["globex", "globex.beacon", "beacon"]]) {
    await applyScopeAdd(p.roots, { scope, hubs: [], policies: [], now });
    const repo = await makeRepo(join(p.reposDir, repoName), { "README.md": "# Atlas\nBilling API.\n", "package.json": '{"name":"atlas","scripts":{"test":"node --test"}}' });
    const input = { scope, project, repo, approvedDocs: [], expectedRemotes: [], environments: ["staging"], actorRefs: [], accept: "all", requestId: "req_" + repoName + "0001" };
    const plan = await planOnboard(p.roots, p.pilot, input);
    await applyOnboard(p.roots, p.pilot, input, { fingerprint: plan.fingerprint, now });
    result[repoName] = repo;
  }
  return result;
}
export function draftFor(scope, project, opts = {}) {
  return { scope, project, requestId: opts.requestId ?? "req_default01", recordedBy: { actor: "human", runId: "run_fixture01" }, draft: { kind: opts.kind ?? "fact", status: opts.status ?? "observed", title: "Fixture fact", body: opts.body ?? "Fixture body", sources: [{ ref: "user:email:owner@example.com" }], applicability: { level: "project" }, review: opts.review ?? null } };
}
export const draft = (opts = {}) => draftFor("acme", "acme.atlas", opts);
export function account(overrides = {}) {
  return { id: "acct1", provider: "fake", accountId: "acct-expected", workspaceId: "ws-1", actorRef: "email:dev@example.com", secretRef: "fake:a", ...overrides, policy: { read: false, draft: false, outbound: false, ...(overrides.policy ?? {}) } };
}
