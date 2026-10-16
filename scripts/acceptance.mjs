import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir, lstat, readlink, symlink, realpath, chmod } from "node:fs/promises";
import { join, resolve, dirname, relative, isAbsolute } from "node:path";
import { tmpdir, homedir } from "node:os";
import { mkdtempSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { main } from "../src/cli.mjs";
import { loadPilot, rootsFromPilot } from "../src/config/pilot.mjs";
import { planOnboard, applyOnboard } from "../src/onboarding/onboard.mjs";
import { readRegistry } from "../src/config/registry.mjs";
import { readSnapshot, addRecord, proposeRecord, publishProposal } from "../src/records/store.mjs";
import { buildEnvelope, completionDraft } from "../src/agents/envelope.mjs";
import { buildBrief } from "../src/context/brief.mjs";
import { planInstall, applyInstall } from "../src/agents/install.mjs";
import { createConnector } from "../src/auth/connector.mjs";
import { createFakeProvider, fakeSecretResolver } from "../src/auth/fake-provider.mjs";
import { proposeHubLearning } from "../src/hubs/propose.mjs";
import { withPilotLock, scopeLockPath } from "../src/storage/lock.mjs";
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const pilotRoot = resolve(arg("--pilot-root") ?? "");
const reportPath = arg("--report");
if (!arg("--pilot-root") || !reportPath || existsSync(pilotRoot)) { process.stdout.write(JSON.stringify({ ok: false, error: "PILOT_ROOT_REQUIRED_AND_ABSENT" }) + "\n"); process.exit(1); }
const canonical = (path) => { try { return typeof path === "string" && isAbsolute(path) && resolve(path) === path && realpathSync(path) === path; } catch { return false; } };
const extraForbidden = args.flatMap((name, i) => name === "--forbidden" ? [args[i + 1]] : []);
if (!extraForbidden.every(canonical)) { process.stdout.write(JSON.stringify({ ok: false, error: "FORBIDDEN_PATH_INVALID" }) + "\n"); process.exit(1); }
const kit = resolve(import.meta.dirname, "..");
const pre = mkdtempSync(join(tmpdir(), "devctx-acc-preflight-"));
const pilotSpec = { schemaVersion: 1, pilotRoot, configRoot: join(pilotRoot, "config"), dataRoot: join(pilotRoot, "data"), stateRoot: join(pilotRoot, "state"), inputsRoot: join(pilotRoot, "inputs"), agentHomes: [join(pilotRoot, "homes/claude"), join(pilotRoot, "homes/codex")], repos: [join(pilotRoot, "repos/atlas"), join(pilotRoot, "repos/beacon")], forbidden: [kit, ...extraForbidden] };
const preflightFile = join(pre, "pilot.json");
await writeFile(preflightFile, JSON.stringify(pilotSpec), { mode: 0o600 });
try { await loadPilot(preflightFile, { home: homedir(), env: process.env }); }
catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: "PILOT_PREFLIGHT_REFUSED", code: error.code ?? null, details: error.details ?? null }) + "\n"); process.exit(1); }
await mkdir(pilotRoot, { mode: 0o700 });
const pilotFile = join(pilotRoot, "pilot.json");
await writeFile(pilotFile, JSON.stringify(pilotSpec), { mode: 0o600 });
for (const path of [pilotSpec.inputsRoot, ...pilotSpec.agentHomes, join(pilotRoot, "repos")]) await mkdir(path, { recursive: true, mode: 0o700 });
const pilot = await loadPilot(pilotFile, { home: homedir(), env: process.env }), roots = rootsFromPilot(pilot);
const now = () => new Date("2026-10-07T00:00:00.000Z");
function noDraft(scope, project, requestId, body, confirmed = false) {
  return { scope, project, requestId, recordedBy: { actor: "human", runId: "run_accept0001" }, draft: { kind: "fact", status: confirmed ? "confirmed" : "observed", title: "Synthetic fact", body, sources: [{ ref: "user:email:owner@example.com" }], applicability: { level: "project" }, review: confirmed ? { reviewer: "email:owner@example.com" } : null } };
}
const checks = [];
async function check(id, fn) {
  try { const detail = await fn(); checks.push({ id, status: "passed", detail: detail ?? "verified" }); }
  catch (error) { checks.push({ id, status: "failed", detail: String(error.code ?? error.message).slice(0, 160) }); }
}
async function rawCli(parts) {
  const chunks = [];
  const code = await main(parts, { stdout: { write(text) { chunks.push(text); return true; } }, now, home: homedir(), env: process.env });
  return { code, json: JSON.parse(chunks.join("")) };
}
async function cli(parts) {
  const result = await rawCli(parts);
  if (result.code !== 0) throw Object.assign(new Error(result.json.error.code), { code: result.json.error.code });
  return result.json.result;
}
function fixtureGit(cwd, words) {
  const env = { PATH: process.env.PATH, HOME: pilotRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...words], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error("fixture Git failed");
}
async function makeRepo(path, name) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await writeFile(join(path, "README.md"), "# " + name + "\nSynthetic project.\n");
  await writeFile(join(path, "package.json"), JSON.stringify({ name: name.toLowerCase(), scripts: { test: "node --test", postinstall: "touch SHOULD_NOT_RUN" } }));
  fixtureGit(path, ["init", "-q", "-b", "main"]); fixtureGit(path, ["add", "-A"]); fixtureGit(path, ["commit", "-q", "-m", "fixture"]);
  return realpath(path);
}
async function treeHash(path) {
  const rows = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const child = join(dir, name), st = await lstat(child);
      const row = [relative(path, child), st.mode, st.size, st.mtimeMs];
      if (st.isFile()) row.push(createHash("sha256").update(await readFile(child)).digest("hex"));
      if (st.isSymbolicLink()) row.push(await readlink(child));
      rows.push(row); if (st.isDirectory()) await walk(child);
    }
  }
  await walk(path);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}
async function expectCliCode(parts, code) { const r = await rawCli(parts); assert.equal(r.json.error?.code, code); return r; }
await cli(["init", "--apply", "--pilot", pilotFile]);
await cli(["scope", "add", "--apply", "--pilot", pilotFile, "--scope", "acme"]);
await cli(["scope", "add", "--apply", "--pilot", pilotFile, "--scope", "globex"]);
await cli(["scope", "add", "--apply", "--pilot", pilotFile, "--scope", "lockcase"]);
const atlas = await makeRepo(pilotSpec.repos[0], "Atlas"), beacon = await makeRepo(pilotSpec.repos[1], "Beacon");
const aInput = { scope: "acme", project: "acme.atlas", repo: atlas, approvedDocs: [], expectedRemotes: [], environments: ["staging"], actorRefs: [], accept: "all", requestId: "req_acceptacme01" };
const bInput = { scope: "globex", project: "globex.beacon", repo: beacon, approvedDocs: [], expectedRemotes: [], environments: [], actorRefs: [], accept: "all", requestId: "req_acceptbeacon01" };
const onboardArgs = (x) => ["project", "onboard", "--pilot", pilotFile, "--scope", x.scope, "--project", x.project, "--repo", x.repo, "--request-id", x.requestId, "--accept", x.accept, ...x.environments.flatMap((e) => ["--environment", e])];
let aPlan, bPlan, aReceipt;
await check("onboard-acme-zero-diff", async () => { const before = await treeHash(atlas); aPlan = await cli(onboardArgs(aInput)); aReceipt = await cli([...onboardArgs(aInput), "--apply", "--plan-fingerprint", aPlan.fingerprint]); assert.equal(await treeHash(atlas), before); return { bundles: aReceipt.bundles.length }; });
await check("onboard-globex-zero-diff", async () => { const before = await treeHash(beacon); bPlan = await cli(onboardArgs(bInput)); await cli([...onboardArgs(bInput), "--apply", "--plan-fingerprint", bPlan.fingerprint]); assert.equal(await treeHash(beacon), before); });
await check("scripts-hooks-fsmonitor-not-run", async () => { assert.equal(existsSync(join(atlas, "SHOULD_NOT_RUN")), false); const canary = join(pilotRoot, "FSMONITOR_RAN"), script = join(pilotRoot, "fsmonitor-canary.sh"); await writeFile(script, "#!/bin/sh\ntouch " + JSON.stringify(canary) + "\n", { mode: 0o700 }); await chmod(script, 0o700); fixtureGit(atlas, ["config", "core.fsmonitor", script]); const before = await treeHash(atlas); await cli(["context", "resolve", "--pilot", pilotFile, "--scope", "acme", "--cwd", atlas]); assert.equal(existsSync(canary), false); assert.equal(await treeHash(atlas), before); });
await check("resolve-exact", async () => { const r = await cli(["context", "resolve", "--pilot", pilotFile, "--scope", "acme", "--cwd", atlas]); assert.equal(r.project, "acme.atlas"); });
await check("wrong-scope-rejected", async () => { await expectCliCode(["context", "resolve", "--pilot", pilotFile, "--scope", "globex", "--cwd", atlas], "DEVCTX_PROJECT_UNBOUND"); });
await check("symlink-cwd-rejected", async () => { const alias = join(pilotRoot, "atlas-alias"); await symlink(atlas, alias); await expectCliCode(["context", "resolve", "--pilot", pilotFile, "--scope", "acme", "--cwd", alias], "DEVCTX_PATH_UNSAFE"); });
await check("unconfirmed-worktree-rejected", async () => { const wt = join(pilotRoot, "atlas-linked"); fixtureGit(atlas, ["worktree", "add", "-q", "-b", "feature", wt]); const r = await expectCliCode(["context", "resolve", "--pilot", pilotFile, "--scope", "acme", "--cwd", wt], "DEVCTX_PROJECT_UNBOUND"); assert.equal(r.json.error.details.reason, "worktree-not-confirmed"); });
await check("duplicate-binding-rejected", async () => { await expectCliCode(["project", "onboard", "--pilot", pilotFile, "--scope", "globex", "--project", "globex.atlas", "--repo", atlas, "--request-id", "req_duplicate01"], "DEVCTX_BINDING_CONFLICT"); });
await check("source-change-stale-plan", async () => { const input = { ...aInput, requestId: "req_staleacc01" }; const plan = await cli(onboardArgs(input)); await writeFile(join(atlas, "README.md"), "# Atlas\nChanged.\n"); const before = (await readRegistry(roots)).value.operations.length; await expectCliCode([...onboardArgs(input), "--apply", "--plan-fingerprint", plan.fingerprint], "DEVCTX_PLAN_MISMATCH"); assert.equal((await readRegistry(roots)).value.operations.length, before); });
let firstRecord;
await check("provenance-and-supersession", async () => { firstRecord = await cli(["record", "add", "--pilot", pilotFile, "--scope", "acme", "--project", "acme.atlas", "--kind", "fact", "--title", "Synthetic fact", "--body", "Observed", "--request-id", "req_accfact001", "--apply"]); await cli(["record", "supersede", "--pilot", pilotFile, "--scope", "acme", "--project", "acme.atlas", "--kind", "fact", "--title", "Reviewed fact", "--body", "Confirmed", "--status", "confirmed", "--reviewer", "email:owner@example.com", "--request-id", "req_accfact002", "--target", firstRecord.recordId, "--expect-hash", firstRecord.recordHash, "--apply"]); const snap = await readSnapshot(roots, "acme", "acme.atlas"); assert.equal(snap.records.find((r) => r.id === firstRecord.recordId).effective, "superseded"); });
await check("handoff-claude-to-codex", async () => { const env = await buildEnvelope(roots, { scope: "acme", cwd: atlas, taskId: "task-accept", runId: "run_acceptclaude01", parentRunId: "run_acceptparent01", deliverable: "handoff", verificationCommands: [], allowedOutputPaths: [join(atlas, "src")], allowedOperations: ["read"], constraints: [] }, { now }); const d = completionDraft(env, { actor: "claude", lastVerifiedResult: "synthetic check", evidence: ["commit:" + env.worktree.head], changedFiles: [], nextAction: "review", blockers: [] }); const prop = await proposeRecord(roots, { ...d, requestId: "req_acchandoff01" }, { now }); await publishProposal(roots, { scope: "acme", project: "acme.atlas", proposalId: prop.proposalId }, { controller: "human", now }); const brief = await buildBrief(roots, pilot, { scope: "acme", cwd: atlas }); assert.ok(brief.records.some((r) => r.kind === "handoff")); });
await check("idempotent-retry", async () => { const r = await cli([...onboardArgs(aInput), "--apply", "--plan-fingerprint", aPlan.fingerprint]); assert.equal(r.replayed, true); });
await check("reused-request-conflict", async () => { const changed = { ...aInput, environments: ["prod"] }; await expectCliCode([...onboardArgs(changed), "--apply", "--plan-fingerprint", aPlan.fingerprint], "DEVCTX_CONFLICT"); });
await check("stale-hash-rejected", async () => { await expectCliCode([...onboardArgs(aInput), "--apply", "--plan-fingerprint", "sha256:" + "0".repeat(64)], "DEVCTX_PLAN_MISMATCH"); });
await check("crash-recovery-onboard", async () => { const input = { ...aInput, requestId: "req_accafterreg01" }; const plan = await planOnboard(roots, pilot, input); await assert.rejects(applyOnboard(roots, pilot, input, { fingerprint: plan.fingerprint, now, faults: { afterRegistry: () => { throw new Error("crash"); } } })); const generation = (await readRegistry(roots)).value.generation; const replay = await applyOnboard(roots, pilot, input, { fingerprint: plan.fingerprint, now }); assert.equal(replay.replayed, true); assert.equal((await readRegistry(roots)).value.generation, generation); });
await check("lock-busy-not-broken", async () => { const lock = scopeLockPath(roots, "lockcase"); const holder = JSON.stringify({ pid: 999999, host: "elsewhere" }); await writeFile(lock, holder, { flag: "wx", mode: 0o600 }); await assert.rejects(withPilotLock(roots, lock, {}, async () => 1, { destinations: [roots.dataRoot], waitMs: 100 }), { code: "DEVCTX_BUSY" }); assert.equal(await readFile(lock, "utf8"), holder); });
await check("no-cross-scope-canary", async () => { await addRecord(roots, noDraft("globex", "globex.beacon", "req_accanary001", "CANARY-GLOBEX-7731"), { now }); const brief = await buildBrief(roots, pilot, { scope: "acme", cwd: atlas }); assert.ok(!JSON.stringify(brief).includes("CANARY-GLOBEX")); });
await check("install-preview-apply-idempotent-conflict-uninstall", async () => { const home = pilot.agentHomes[0], foreign = join(home, ".agents/skills/devctx-record/SKILL.md"); await mkdir(dirname(foreign), { recursive: true, mode: 0o700 }); await writeFile(foreign, "foreign"); const plan = await planInstall(pilot, { targetHome: home, agents: ["claude", "codex"], mode: "install" }); assert.equal(plan.actions.find((a) => a.agent === "codex" && a.skill === "devctx-record").status, "conflict"); await applyInstall(roots, pilot, { targetHome: home, agents: ["claude", "codex"], mode: "install" }, { fingerprint: plan.fingerprint, runId: "run_accinstall01" }); assert.equal(await readFile(foreign, "utf8"), "foreign"); assert.ok((await planInstall(pilot, { targetHome: home, agents: ["claude"], mode: "install" })).actions.every((a) => a.status === "installed")); const file = join(home, ".claude/skills/devctx-record/SKILL.md"); await writeFile(file, "user edited"); const uninstall = await planInstall(pilot, { targetHome: home, agents: ["claude"], mode: "uninstall" }); assert.equal(uninstall.actions.find((a) => a.skill === "devctx-record").status, "modified"); await applyInstall(roots, pilot, { targetHome: home, agents: ["claude"], mode: "uninstall" }, { fingerprint: uninstall.fingerprint, runId: "run_accuninstall01" }); assert.equal(await readFile(file, "utf8"), "user edited"); assert.equal(await readFile(foreign, "utf8"), "foreign"); });
await check("real-home-refused", async () => { await expectCliCode(["agents", "install", "--pilot", pilotFile, "--home", homedir(), "--agent", "claude"], "DEVCTX_GATE_REQUIRED"); });
await check("fake-auth-wrong-actor", async () => { const provider = createFakeProvider({ accountId: "a", workspaceId: "w", actorRef: "email:wrong@example.com" }); const c = createConnector({ account: { id: "a", provider: "fake", accountId: "a", workspaceId: "w", actorRef: "email:right@example.com", secretRef: "fake:a", policy: { read: true, draft: false, outbound: false } }, provider, ["resolve" + "Secret"]: fakeSecretResolver({}) }); await assert.rejects(c.read({}), { code: "DEVCTX_AUTH_MISMATCH" }); assert.deepEqual(provider.calls.map((x) => x[0]), ["whoami"]); });
await check("hub-proposal-no-write", async () => { const hub = join(pilot.inputsRoot, "hub"); await mkdir(hub); await writeFile(join(hub, "README.md"), "Hub\n"); const scopeFile = join(roots.configRoot, "scopes/acme.json"); const config = JSON.parse(await readFile(scopeFile, "utf8")); await writeFile(scopeFile, JSON.stringify({ ...config, hubs: [{ id: "eng", kind: "local-dir", path: hub, purposes: ["learning"] }] })); const r = await addRecord(roots, noDraft("acme", "acme.atlas", "req_acchubfact01", "Small reviewed change", true), { now }); const before = await treeHash(hub); const proposal = await proposeHubLearning(roots, { scope: "acme", project: "acme.atlas", recordIds: [r.recordId], hubId: "eng" }, { now, apply: true }); assert.equal(await treeHash(hub), before); assert.equal(JSON.parse(await readFile(proposal.path, "utf8")).publicExport, "not-approved"); });
await check("doctor-readonly", async () => { const before = await treeHash(pilotRoot); const doctor = await cli(["doctor", "--pilot", pilotFile]); assert.ok(doctor.checks.some((x) => x.id === "orphan-staging")); assert.equal(await treeHash(pilotRoot), before); });
await check("handoff-export-portable", async () => {
  const fact = await addRecord(roots, noDraft("acme", "acme.atlas", "req_accexportfact01", "Synthetic documentation evidence only."), { now });
  const handoffDraft = noDraft("acme", "acme.atlas", "req_accexporthandoff01", "Last verified result: fixture documentation inspected.\nNext action: review documented commands.\nApplication tests and deployment: unknown.");
  handoffDraft.draft.kind = "handoff";
  const handoff = await addRecord(roots, handoffDraft, { now });
  const parent = join(roots.dataRoot, "exports/handoffs/acme/acme.atlas");
  const out = join(parent, "acceptance.handoff.md"), second = join(parent, "repeat.handoff.md");
  const flags = ["handoff", "export", "--pilot", pilotFile, "--scope", "acme", "--cwd", atlas,
    "--record", fact.recordId, "--record", handoff.recordId, "--as-of", "2026-10-09T00:00:00.000Z"];
  const before = await treeHash(atlas);
  const first = await cli([...flags, "--out", out]), repeated = await cli([...flags, "--out", second]);
  const bytes = await readFile(out), text = bytes.toString("utf8");
  assert.deepEqual(bytes, await readFile(second));
  assert.equal(first.fileHash, repeated.fileHash);
  assert.equal(first.fileHash, "sha256:" + createHash("sha256").update(bytes).digest("hex"));
  const footer = `\nPacket SHA-256 (all preceding bytes): ${first.packetHash}\n`;
  assert.ok(text.endsWith(footer));
  assert.equal(first.packetHash, "sha256:" + createHash("sha256").update(text.slice(0, -footer.length)).digest("hex"));
  assert.equal((await lstat(out)).mode & 0o777, 0o600);
  for (const phrase of [fact.recordId, handoff.recordId, "Unknowns and disputes", "Exclusions", "documented, not executed"]) assert.ok(text.includes(phrase));
  assert.ok(!text.includes(pilotRoot) && !text.includes("CANARY-GLOBEX") && !text.includes("email:"));
  await expectCliCode([...flags, "--out", join(pilot.inputsRoot, "refused.handoff.md")], "DEVCTX_GATE_REQUIRED");
  assert.equal(existsSync(join(pilot.inputsRoot, "refused.handoff.md")), false);
  const big = await addRecord(roots, noDraft("acme", "acme.atlas", "req_accexportlimit01", "x".repeat(32768)), { now });
  const overflow = join(parent, "overflow.handoff.md");
  await expectCliCode(["handoff", "export", "--pilot", pilotFile, "--scope", "acme", "--cwd", atlas, "--record", big.recordId, "--as-of", "2026-10-09T00:00:00.000Z", "--out", overflow], "DEVCTX_LIMIT");
  assert.equal(existsSync(overflow), false);
  assert.equal(await treeHash(atlas), before);
  return { output: first.output, fileHash: first.fileHash, packetHash: first.packetHash, bytes: first.bytes, publication: first.publication };
});
await check("package-allowlist", async () => { const r = spawnSync(process.execPath, [join(kit, "scripts/check-package.mjs")], { cwd: kit, encoding: "utf8", env: { PATH: process.env.PATH } }); const out = JSON.parse(r.stdout); assert.equal(r.status, 0); assert.equal(out.pack, "run"); });
// Live mode against a fake home inside the acceptance root. The CLI runs from a detached clone of the committed kit,
// so the running kit is clean and pinned as on the owner's machine. Uncommitted changes are not exercised here.
const liveRoot = join(await realpath(pilotRoot), "live"), liveHome = join(liveRoot, "home"), devctxDir = join(liveHome, ".devctx");
const liveKit = join(devctxDir, "kit"), liveConfig = join(devctxDir, "live.json"), liveInstallRun = "run_acclive0001";
const liveDirs = { claude: join(liveHome, ".claude/skills"), codex: join(liveHome, ".agents/skills") };
const liveForeign = join(liveDirs.codex, "devctx-record/SKILL.md"), liveOther = join(liveDirs.claude, "someone-else/SKILL.md");
let liveHead = null, bareKit = null;
function gitOut(cwd, words) {
  const env = { PATH: process.env.PATH, HOME: liveRoot, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" };
  const result = spawnSync("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-C", cwd, ...words], { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error("live fixture Git failed: " + words[0] + ": " + String(result.stderr).trim().slice(0, 100));
  return result.stdout.trim();
}
async function pinnedClone(dest) { gitOut(devctxDir, ["clone", "-q", "--no-hardlinks", kit, dest]); gitOut(dest, ["checkout", "-q", "--detach", liveHead]); return realpath(dest); }
function liveCli(parts, kitRoot = liveKit) {
  const r = spawnSync(process.execPath, [join(kitRoot, "bin/devctx.mjs"), ...parts], { cwd: liveRoot, encoding: "utf8", env: { PATH: process.env.PATH, HOME: liveHome }, timeout: 120000 });
  let json; try { json = JSON.parse(r.stdout); } catch { throw new Error("live CLI output unreadable: " + String(r.stderr).slice(0, 100)); }
  if (!json.ok) throw Object.assign(new Error(json.error?.code ?? "live CLI failed"), { code: json.error?.code + " " + JSON.stringify(json.error?.details ?? null) });
  return json.result;
}
const devctxEntries = async (dir) => (await readdir(dir)).filter((name) => name.startsWith("devctx-")).sort();
await check("live-init-preview-apply", async () => {
  for (const dir of Object.values(liveDirs)) await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(devctxDir, { mode: 0o700 }); await chmod(devctxDir, 0o700);
  liveHead = gitOut(kit, ["rev-parse", "--verify", "HEAD"]);
  await pinnedClone(liveKit);
  const before = await treeHash(liveHome), parts = ["live", "init", "--pilot", liveConfig, "--agent", "claude", "--agent", "codex"];
  const preview = liveCli(parts);
  assert.equal(await treeHash(liveHome), before);
  assert.equal(preview.preview, true);
  assert.equal(preview.config.live.kitCommit, liveHead);
  assert.deepEqual(preview.config.live.skillDirs, liveDirs);
  const applied = liveCli([...parts, "--apply", "--plan-fingerprint", preview.fingerprint]);
  assert.match(applied.configId, /^cfg_[0-9a-f]{16}$/);
  assert.equal((await lstat(liveConfig)).mode & 0o777, 0o600);
  assert.equal((await lstat(devctxDir)).mode & 0o777, 0o700);
  for (const dir of ["store", "store/config", "store/data", "store/state", "store/inputs"]) assert.equal((await lstat(join(devctxDir, dir))).mode & 0o777, 0o700, dir);
  liveCli(["doctor", "--pilot", liveConfig]);
  return { kitCommit: liveHead, configId: applied.configId };
});
await check("live-install-foreign-conflict-blocks-one-agent", async () => {
  await mkdir(dirname(liveForeign), { recursive: true }); await writeFile(liveForeign, "foreign codex record\n");
  await mkdir(dirname(liveOther), { recursive: true }); await writeFile(liveOther, "someone else\n");
  const foreignBefore = await treeHash(dirname(liveForeign)), foreignBytes = await readFile(liveForeign);
  const parts = ["agents", "install", "--pilot", liveConfig, "--agent", "claude", "--agent", "codex"];
  const plan = liveCli(parts), codex = plan.actions.filter((a) => a.agent === "codex"), claude = plan.actions.filter((a) => a.agent === "claude");
  assert.equal(codex.find((a) => a.skill === "devctx-record").status, "conflict");
  assert.ok(codex.filter((a) => a.skill !== "devctx-record").every((a) => a.status === "blocked" && a.reason === "agent-conflict"));
  assert.ok(claude.length > 0 && claude.every((a) => a.status === "create"));
  const applied = liveCli([...parts, "--apply", "--plan-fingerprint", plan.fingerprint, "--run-id", liveInstallRun]);
  assert.equal(applied.runId, liveInstallRun);
  assert.deepEqual(await devctxEntries(liveDirs.claude), claude.map((a) => a.skill).sort());
  assert.deepEqual(await devctxEntries(liveDirs.codex), ["devctx-record"]);
  assert.deepEqual(await readFile(liveForeign), foreignBytes);
  assert.equal(await treeHash(dirname(liveForeign)), foreignBefore);
  assert.equal(await readFile(liveOther, "utf8"), "someone else\n");
  return { runId: liveInstallRun, installed: claude.length, blocked: codex.length };
});
await check("live-uninstall-from-receipts", async () => {
  // A second pinned kit with no skills/ folder, so uninstall can rely only on receipts and journals.
  bareKit = await pinnedClone(join(devctxDir, "kit-bare"));
  gitOut(bareKit, ["rm", "-r", "-q", "skills"]); gitOut(bareKit, ["commit", "-q", "-m", "acceptance: drop bundled skills"]);
  const bareCommit = gitOut(bareKit, ["rev-parse", "--verify", "HEAD"]), setKit = ["live", "set-kit", "--pilot", liveConfig, "--commit", bareCommit];
  assert.equal(existsSync(join(bareKit, "skills")), false);
  liveCli([...setKit, "--apply", "--plan-fingerprint", liveCli(setKit, bareKit).fingerprint], bareKit);
  const foreignBytes = await readFile(liveForeign), parts = ["agents", "uninstall", "--pilot", liveConfig, "--agent", "claude", "--agent", "codex"];
  const plan = liveCli(parts, bareKit), removed = plan.actions.filter((a) => a.status === "remove");
  assert.ok(plan.actions.filter((a) => a.agent === "claude").every((a) => a.status === "remove"));
  assert.ok(removed.every((a) => a.agent === "claude") && removed.length > 0);
  liveCli([...parts, "--apply", "--plan-fingerprint", plan.fingerprint, "--run-id", "run_accliveun01"], bareKit);
  assert.deepEqual(await devctxEntries(liveDirs.claude), []);
  assert.deepEqual(await devctxEntries(liveDirs.codex), ["devctx-record"]);
  assert.deepEqual(await readFile(liveForeign), foreignBytes);
  assert.equal(await readFile(liveOther, "utf8"), "someone else\n");
  return { kitCommit: bareCommit, removed: removed.length };
});
await check("live-rollback-check-after-uninstall", async () => {
  const result = liveCli(["agents", "rollback-check", "--pilot", liveConfig, "--run-id", liveInstallRun], bareKit);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.folders.map((f) => f.agent).sort(), ["claude", "codex"]);
  assert.ok(result.folders.every((f) => f.devctx.length === 0 && f.foreign.length === 0));
  return { runId: liveInstallRun, folders: result.folders.length };
});
checks.push({ id: "fresh-agent-smoke", status: "deferred", detail: "needs real-home activation, P3" });
const required = ["onboard-acme-zero-diff", "onboard-globex-zero-diff", "scripts-hooks-fsmonitor-not-run", "resolve-exact", "wrong-scope-rejected", "symlink-cwd-rejected", "unconfirmed-worktree-rejected", "duplicate-binding-rejected", "source-change-stale-plan", "provenance-and-supersession", "handoff-claude-to-codex", "idempotent-retry", "reused-request-conflict", "stale-hash-rejected", "crash-recovery-onboard", "lock-busy-not-broken", "no-cross-scope-canary", "install-preview-apply-idempotent-conflict-uninstall", "real-home-refused", "fake-auth-wrong-actor", "hub-proposal-no-write", "doctor-readonly", "handoff-export-portable", "package-allowlist", "live-init-preview-apply", "live-install-foreign-conflict-blocks-one-agent", "live-uninstall-from-receipts", "live-rollback-check-after-uninstall", "fresh-agent-smoke"];
const ids = new Set(checks.map((c) => c.id));
const ok = required.every((id) => ids.has(id)) && checks.every((c) => c.status === "passed" || c.id === "fresh-agent-smoke" && c.status === "deferred");
const report = { schemaVersion: 1, ok, pilotRoot, forbidden: pilotSpec.forbidden, checks };
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
process.stdout.write(JSON.stringify({ ok, checks: checks.map(({ id, status }) => ({ id, status })), report: reportPath }) + "\n");
process.exitCode = ok ? 0 : 1;
