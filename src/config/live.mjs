import { readdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevctxError } from "../errors.mjs";
import { checkProfile, loadPilot, rootsFromPilot, recordApprovedDigest, approvedDigestPath, skillDirsFor } from "./pilot.mjs";
import { ensureRoots, validateRoot } from "./roots.mjs";
import { info, checkNode, ensurePrivateDir, writeNewFile, atomicReplace, fsyncDir } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { gitQuery } from "../identity/git.mjs";
// The running kit. Tests inject ctx.kitRoot; production derives it from this file, as pilot.mjs does.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS = ["claude", "codex"];
const KEYS = ["schemaVersion", "pilotRoot", "configRoot", "dataRoot", "stateRoot", "inputsRoot", "agentHomes", "repos", "forbidden", "live"];
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// Stands in for the profile ID while a new profile is validated; apply draws the real ID once.
const PENDING_ID = "prof_pending0000";
const invalid = (field) => { throw new DevctxError("INVALID_INPUT", "Invalid live profile input", { field }); };
const gate = (field, reason) => { throw new DevctxError("GATE_REQUIRED", "Live profile gate refused", { field, reason }); };
const sorted = (values) => [...new Set(values)].sort();
const rawOf = (pilot) => Object.fromEntries(KEYS.map((key) => [key, pilot[key]]));
const profileText = (raw) => JSON.stringify(raw, null, 2) + "\n";
const lockPath = (roots) => join(roots.stateRoot, "locks", "live.lock");
const gateContext = (ctx, liveGate) => ({ home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot, ...(liveGate ? { liveGate } : {}) });
function profilePath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) gate("pilot", "path");
  return path;
}
function runningKit(ctx) {
  try { return realpathSync(ctx.kitRoot ?? KIT); } catch { return gate("live.kitRoot", "running-kit"); }
}
// The profile folder (~/.devctx) is created by the owner at 0700 and is never created or chmodded here.
function assertProfileDir(dir) {
  const node = info(dir);
  if (!node) throw new DevctxError("PATH_UNSAFE", "Live profile folder must exist and be private", { field: "profileDir" });
  validateRoot(dir, "profileDir");
  if (!node.isDirectory() || node.uid !== process.getuid() || (node.mode & 0o077)) throw new DevctxError("PATH_UNSAFE", "Live profile folder must exist and be private", { field: "profileDir" });
}
function storeLayout(dir) {
  const pilotRoot = join(dir, "store");
  return { pilotRoot, configRoot: join(pilotRoot, "config"), dataRoot: join(pilotRoot, "data"), stateRoot: join(pilotRoot, "state"), inputsRoot: join(pilotRoot, "inputs") };
}
// What a failed live init can leave behind: the empty layout folders, the empty lock folder and an approval with
// no profile, which a retry overwrites. null marks a file; an object lists the only entries a folder may hold.
const RETRY_LAYOUT = { config: {}, data: {}, inputs: {}, state: { locks: {}, live: { "approved-profile.json": null } } };
function assertLeftover(dir, allowed) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), node = info(path), want = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
    if (want === undefined || !node || (want === null ? !node.isFile() : !node.isDirectory())) throw new DevctxError("CONFLICT", "Live store exists without a profile", { field: "pilotRoot" });
    checkNode(node, path, { directory: want !== null });
    if (want) assertLeftover(path, want);
  }
}
function assertFreshStore(pilotRoot) {
  const node = info(pilotRoot);
  if (!node) return;
  checkNode(node, pilotRoot, { directory: true });
  assertLeftover(pilotRoot, RETRY_LAYOUT);
}
export function planLiveInit(input, ctx) {
  const path = profilePath(input.profilePath), dir = dirname(path);
  assertProfileDir(dir);
  if (info(path)) throw new DevctxError("CONFLICT", "Live profile already exists", { field: "pilot" });
  const layout = storeLayout(dir);
  assertFreshStore(layout.pilotRoot);
  const agents = sorted(input.agents ?? []);
  if (!agents.length || agents.some((agent) => !AGENTS.includes(agent))) invalid("agent");
  const home = ctx.home, all = skillDirsFor({ home, env: ctx.env ?? process.env });
  const kitRoot = runningKit(ctx);
  const head = gitQuery(kitRoot, ["rev-parse", "--verify", "HEAD"], { notRepo: true });
  if (head.notRepo) gate("live.kitRoot", "not-top-level");
  const profile = { schemaVersion: 1, ...layout, agentHomes: [], repos: sorted(input.repos ?? []), forbidden: [], live: { profileId: PENDING_ID, home, skillDirs: Object.fromEntries(agents.map((agent) => [agent, all[agent]])), kitRoot, kitCommit: head.stdout.trim() } };
  const checked = checkProfile(profile, path, gateContext(ctx));
  return finalizePlan({ kind: "live-init", profile: { ...profile, live: { ...profile.live, profileId: null } }, layout: { profile: path, ...layout, kitRoot }, warnings: [...checked.warnings, ...(kitRoot === join(dir, "kit") ? [] : [{ code: "KIT_NOT_SIBLING" }])] });
}
// faults.afterRoots and faults.afterApproval are test seams for a crash before the profile is written.
export async function applyLiveInit(input, ctx, { faults = {} } = {}) {
  const plan = planLiveInit(input, ctx);
  assertFingerprint(plan, input.fingerprint);
  const path = plan.layout.profile;
  const profile = { ...plan.profile, live: { ...plan.profile.live, profileId: "prof_" + randomBytes(8).toString("hex") } };
  const pilot = checkProfile(profile, path, gateContext(ctx)), roots = rootsFromPilot(pilot);
  // Only the store folder and the lock folder exist before the lock; a failure after either leaves a store a retry accepts.
  ensurePrivateDir(pilot.pilotRoot);
  // The approval is recorded before the profile appears, so a profile on disk is always an approved one.
  return withPilotLock(roots, lockPath(roots), { kind: "live-init" }, async () => {
    if (info(path)) throw new DevctxError("CONFLICT", "Live profile already exists", { field: "pilot" });
    ensureRoots(roots);
    ensurePrivateDir(pilot.inputsRoot);
    await faults.afterRoots?.();
    await recordApprovedDigest(roots, { profileId: profile.live.profileId, digest: pilot.digest });
    await faults.afterApproval?.();
    await writeNewFile(path, profileText(profile));
    fsyncDir(dirname(path));
    return { applied: true, profile: path, profileId: profile.live.profileId, digest: pilot.digest };
  }, { destinations: [approvedDigestPath(pilot)] });
}
// Shared preview for a change to an approved profile. The current profile must load with its approval intact.
async function planChange(kind, input, ctx, change, liveGate) {
  const path = profilePath(input.profilePath);
  const pilot = await loadPilot(path, gateContext(ctx, liveGate));
  if (!pilot.live) gate("live", "not-live");
  const before = rawOf(pilot), { after, details } = change(before, pilot);
  const next = checkProfile(after, path, gateContext(ctx));
  return { pilot, next, plan: finalizePlan({ kind, profile: path, profileId: pilot.live.profileId, digest: { from: pilot.digest, to: next.digest }, ...details }) };
}
// faults.afterApproval and faults.afterReplace are test seams for a crash on either side of the profile replace.
async function applyChange(kind, input, ctx, change, liveGate, { faults = {} } = {}) {
  const first = await planChange(kind, input, ctx, change, liveGate);
  assertFingerprint(first.plan, input.fingerprint);
  const roots = rootsFromPilot(first.pilot);
  return withPilotLock(roots, lockPath(roots), { kind }, async () => {
    const { pilot, next, plan } = await planChange(kind, input, ctx, change, liveGate);
    assertFingerprint(plan, input.fingerprint);
    // Both profiles stay approved until the replace is done, so a crash between the writes never strands the profile.
    const nextRoots = rootsFromPilot(next), approval = { profileId: next.live.profileId, digest: next.digest };
    await recordApprovedDigest(nextRoots, { ...approval, previousDigest: pilot.digest });
    await faults.afterApproval?.();
    await atomicReplace(next.path, profileText(rawOf(next)));
    await faults.afterReplace?.();
    await recordApprovedDigest(nextRoots, approval);
    return { applied: true, profile: next.path, profileId: next.live.profileId, digest: next.digest };
  }, { destinations: [approvedDigestPath(first.pilot)] });
}
const addRepo = (repo) => (before) => {
  if (typeof repo !== "string" || before.repos.includes(repo)) invalid("repo");
  const repos = sorted([...before.repos, repo]);
  return { after: { ...before, repos }, details: { repo, repos: { from: before.repos, to: repos } } };
};
function setKit(input, ctx) {
  if (typeof input.commit !== "string" || !COMMIT.test(input.commit)) invalid("commit");
  const kitRoot = runningKit(ctx), kitCommit = input.commit;
  const change = (before) => {
    if (before.live.kitRoot === kitRoot && before.live.kitCommit === kitCommit) invalid("commit");
    return { after: { ...before, live: { ...before.live, kitRoot, kitCommit } }, details: { kit: { from: { kitRoot: before.live.kitRoot, kitCommit: before.live.kitCommit }, to: { kitRoot, kitCommit } } } };
  };
  // set-kit runs from the new kit, which must be a clean detached checkout of the requested commit.
  return [change, { kit: { kitRoot, kitCommit } }];
}
const preview = async (promise) => ({ preview: true, ...(await promise) });
export const planLiveAddRepo = (input, ctx) => preview(planChange("live-add-repo", input, ctx, addRepo(input.repo)).then((r) => r.plan));
export const applyLiveAddRepo = (input, ctx, options) => applyChange("live-add-repo", input, ctx, addRepo(input.repo), undefined, options);
export const planLiveSetKit = (input, ctx) => preview(planChange("live-set-kit", input, ctx, ...setKit(input, ctx)).then((r) => r.plan));
export const applyLiveSetKit = (input, ctx, options) => applyChange("live-set-kit", input, ctx, ...setKit(input, ctx), options);
export const previewLiveInit = (input, ctx) => ({ preview: true, ...planLiveInit(input, ctx) });
