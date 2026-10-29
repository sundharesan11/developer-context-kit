import { readdirSync, realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DevtwinError } from "../errors.mjs";
import { checkLiveConfig, loadPilot, rootsFromPilot, recordApprovedDigest, approvedDigestPath, skillDirsFor, WRITE_CLASSES, STACK_WATCH_MAX_REQUESTS, APPROVAL_MODES } from "./pilot.mjs";
import { canonicalJson } from "../storage/canonical.mjs";
import { ensureRoots, validateRoot } from "./roots.mjs";
import { info, checkNode, ensurePrivateDir, writeNewFile, atomicReplace, fsyncDir } from "../storage/fsx.mjs";
import { finalizePlan, assertFingerprint } from "../storage/plan.mjs";
import { withPilotLock } from "../storage/lock.mjs";
import { identityOfKit, kitIdentity, kitFields, kitId, displayKitId, kitsFolder, DIGEST, VERSION } from "../kit/identity.mjs";
// The running kit. Tests inject ctx.kitRoot; production derives it from this file, as pilot.mjs does.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const AGENTS = ["claude", "codex"];
export const KEYS = ["schemaVersion", "pilotRoot", "configRoot", "dataRoot", "stateRoot", "inputsRoot", "agentHomes", "repos", "forbidden", "live", "writeClasses", "exceptions", "approval"];
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const KIT_FIELDS = ["kitCommit", "kitVersion", "kitDigest"];
// Stands in for the config ID while a new config is validated; apply draws the real ID once.
const PENDING_ID = "cfg_pending0000";
const invalid = (field) => { throw new DevtwinError("INVALID_INPUT", "Invalid live config input", { field }); };
const gate = (field, reason) => { throw new DevtwinError("GATE_REQUIRED", "Live config gate refused", { field, reason }); };
const sorted = (values) => [...new Set(values)].sort();
export const rawOf = (pilot) => Object.fromEntries(KEYS.map((key) => [key, pilot[key]]));
export const configText = (raw) => JSON.stringify(raw, null, 2) + "\n";
const lockPath = (roots) => join(roots.stateRoot, "locks", "live.lock");
const gateContext = (ctx, liveGate) => ({ home: ctx.home, env: ctx.env, kitRoot: ctx.kitRoot, ...(liveGate ? { liveGate } : {}) });
export function configPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) gate("pilot", "path");
  return path;
}
export function runningKit(ctx) {
  try { return realpathSync(ctx.kitRoot ?? KIT); } catch { return gate("live.kitRoot", "running-kit"); }
}
// U45 (KTD2): the running kit's identity, from small reads (a Git clone's HEAD, a package kit's manifest); the kit gate
// in checkLiveConfig then checks it in full. A folder that is neither is not a kit live mode can pin.
export function runningIdentity(kitRoot) {
  return identityOfKit(kitRoot) ?? gate("live.kitRoot", "not-top-level");
}
// A Git clone belongs at <config folder>/kit and a package kit directly in <home>/.devtwin/kits; anywhere else warns.
export const kitWarnings = (kitRoot, identity, dir, home) =>
  kitRoot === join(dir, "kit") || (identity.kind === "package" && [join(dir, "kits"), kitsFolder(home)].includes(dirname(kitRoot))) ? [] : [{ code: "KIT_NOT_SIBLING" }];
// The live block with the given kit: kitRoot plus exactly one kind's fields, so a switch of kind leaves no stale field.
export function withKit(live, kitRoot, identity) {
  const rest = Object.fromEntries(Object.entries(live).filter(([key]) => !KIT_FIELDS.includes(key)));
  return { ...rest, kitRoot, ...kitFields(identity) };
}
// The live config folder (~/.devtwin) is created by the owner at 0700 and is never created or chmodded here.
export function assertConfigDir(dir) {
  const node = info(dir);
  if (!node) throw new DevtwinError("PATH_UNSAFE", "Live config folder must exist and be private", { field: "configDir" });
  validateRoot(dir, "configDir");
  if (!node.isDirectory() || node.uid !== process.getuid() || (node.mode & 0o077)) throw new DevtwinError("PATH_UNSAFE", "Live config folder must exist and be private", { field: "configDir" });
}
export function storeLayout(dir) {
  const pilotRoot = join(dir, "store");
  return { pilotRoot, configRoot: join(pilotRoot, "config"), dataRoot: join(pilotRoot, "data"), stateRoot: join(pilotRoot, "state"), inputsRoot: join(pilotRoot, "inputs") };
}
// What a failed live init can leave behind: the empty layout folders, the empty lock folder and an approval with
// no live config, which a retry overwrites. null marks a file; an object lists the only entries a folder may hold.
const RETRY_LAYOUT = { config: {}, data: {}, inputs: {}, state: { locks: {}, live: { "approved-config.json": null } } };
function assertLeftover(dir, allowed) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name), node = info(path), want = Object.hasOwn(allowed, name) ? allowed[name] : undefined;
    if (want === undefined || !node || (want === null ? !node.isFile() : !node.isDirectory())) throw new DevtwinError("CONFLICT", "Live store exists without a live config", { field: "pilotRoot" });
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
  const path = configPath(input.configPath), dir = dirname(path);
  assertConfigDir(dir);
  if (info(path)) throw new DevtwinError("CONFLICT", "Live config already exists", { field: "pilot" });
  const layout = storeLayout(dir);
  assertFreshStore(layout.pilotRoot);
  const agents = sorted(input.agents ?? []);
  if (!agents.length || agents.some((agent) => !AGENTS.includes(agent))) invalid("agent");
  const home = ctx.home, all = skillDirsFor({ home, env: ctx.env ?? process.env });
  const kitRoot = runningKit(ctx), identity = runningIdentity(kitRoot);
  // U46: an optional --kit names the package kit init must run from (src/kit/forward.mjs forwards to it).
  if (input.kit !== undefined && kitId(requestedKit({ kit: input.kit })) !== kitId(identity)) gate("kit", "running-kit");
  const config = { schemaVersion: 1, ...layout, agentHomes: [], repos: sorted(input.repos ?? []), forbidden: [], live: withKit({ configId: PENDING_ID, home, skillDirs: Object.fromEntries(agents.map((agent) => [agent, all[agent]])) }, kitRoot, identity) };
  const checked = checkLiveConfig(config, path, gateContext(ctx));
  return finalizePlan({ kind: "live-init", config: { ...config, live: { ...config.live, configId: null } }, layout: { config: path, ...layout, kitRoot }, warnings: [...checked.warnings, ...kitWarnings(kitRoot, identity, dir, home)] });
}
// faults.afterRoots and faults.afterApproval are test seams for a crash before the config is written.
export async function applyLiveInit(input, ctx, { faults = {} } = {}) {
  const plan = planLiveInit(input, ctx);
  assertFingerprint(plan, input.fingerprint);
  const path = plan.layout.config;
  const config = { ...plan.config, live: { ...plan.config.live, configId: "cfg_" + randomBytes(8).toString("hex") } };
  const pilot = checkLiveConfig(config, path, gateContext(ctx)), roots = rootsFromPilot(pilot);
  // Only the store folder and the lock folder exist before the lock; a failure after either leaves a store a retry accepts.
  ensurePrivateDir(pilot.pilotRoot);
  // The approval is recorded before the config appears, so a config on disk is always an approved one.
  return withPilotLock(roots, lockPath(roots), { kind: "live-init" }, async () => {
    if (info(path)) throw new DevtwinError("CONFLICT", "Live config already exists", { field: "pilot" });
    ensureRoots(roots);
    ensurePrivateDir(pilot.inputsRoot);
    await faults.afterRoots?.();
    await recordApprovedDigest(roots, { configId: config.live.configId, digest: pilot.digest });
    await faults.afterApproval?.();
    await writeNewFile(path, configText(config));
    fsyncDir(dirname(path));
    return { applied: true, config: path, configId: config.live.configId, digest: pilot.digest };
  }, { destinations: [approvedDigestPath(pilot)] });
}
// Shared preview for a change to an approved config. The current config must load with its approval intact.
async function planChange(kind, input, ctx, change, liveGate) {
  const path = configPath(input.configPath);
  const pilot = await loadPilot(path, gateContext(ctx, liveGate));
  if (!pilot.live) gate("live", "not-live");
  const before = rawOf(pilot), { after, details } = change(before, pilot);
  const next = checkLiveConfig(after, path, gateContext(ctx));
  return { pilot, next, plan: finalizePlan({ kind, config: path, configId: pilot.live.configId, digest: { from: pilot.digest, to: next.digest }, ...details }) };
}
// faults.afterApproval and faults.afterReplace are test seams for a crash on either side of the config replace.
async function applyChange(kind, input, ctx, change, liveGate, { faults = {} } = {}) {
  const first = await planChange(kind, input, ctx, change, liveGate);
  assertFingerprint(first.plan, input.fingerprint);
  const roots = rootsFromPilot(first.pilot);
  return withPilotLock(roots, lockPath(roots), { kind }, async () => {
    const { pilot, next, plan } = await planChange(kind, input, ctx, change, liveGate);
    assertFingerprint(plan, input.fingerprint);
    // Both configs stay approved until the replace is done, so a crash between the writes never strands the config.
    const nextRoots = rootsFromPilot(next), approval = { configId: next.live.configId, digest: next.digest };
    await recordApprovedDigest(nextRoots, { ...approval, previousDigest: pilot.digest });
    await faults.afterApproval?.();
    await atomicReplace(next.path, configText(rawOf(next)));
    await faults.afterReplace?.();
    await recordApprovedDigest(nextRoots, approval);
    return { applied: true, config: next.path, configId: next.live.configId, digest: next.digest };
  }, { destinations: [approvedDigestPath(first.pilot)] });
}
const addRepo = (repo) => (before) => {
  if (typeof repo !== "string" || before.repos.includes(repo)) invalid("repo");
  const repos = sorted([...before.repos, repo]);
  return { after: { ...before, repos }, details: { repo, repos: { from: before.repos, to: repos } } };
};
// U45: --commit <sha> names a Git kit and --kit <version>+<64 hex> a package kit; exactly one of the two.
function requestedKit(input) {
  if ((input.commit === undefined) === (input.kit === undefined)) invalid("kit");
  if (input.commit !== undefined) return typeof input.commit === "string" && COMMIT.test(input.commit) ? { kind: "git", commit: input.commit } : invalid("commit");
  const parts = typeof input.kit === "string" ? input.kit.split("+") : [];
  if (parts.length !== 2 || !VERSION.test(parts[0]) || !DIGEST.test(parts[1])) invalid("kit");
  return { kind: "package", version: parts[0], digest: parts[1] };
}
const kitEnd = (kitRoot, identity) => ({ kitRoot, ...kitFields(identity), kitId: kitId(identity) });
function setKit(input, ctx) {
  const identity = requestedKit(input), kitRoot = runningKit(ctx);
  const change = (before) => {
    const from = kitIdentity(before.live);
    if (before.live.kitRoot === kitRoot && kitId(from) === kitId(identity)) invalid(identity.kind === "git" ? "commit" : "kit");
    return { after: { ...before, live: withKit(before.live, kitRoot, identity) }, details: { kit: { from: kitEnd(before.live.kitRoot, from), to: kitEnd(kitRoot, identity) } } };
  };
  // set-kit runs from the new kit, which must be the requested one: a clean detached checkout of the commit, or the
  // locked package kit folder whose files match the version and digest.
  return [change, { kit: { kitRoot, ...kitFields(identity) } }];
}
// KTD5: the owner dialog names both kits in full; for a package kit the owner checks the digest against the release.
function kitDialog({ from, to }) {
  const end = (label, kit) => [label + ": " + displayKitId(kit.kitId), kit.kitId, kit.kitRoot, ""];
  const release = to.kitVersion ? ["Compare the digest with the one published in the GitHub release for " + to.kitVersion + " before you approve: " + to.kitDigest, ""] : [];
  return { title: "Change the kit devtwin runs", body: [...end("From", from), ...end("To", to), ...release, "Hooks, jobs and skills move to this kit with the next setup batch."].join("\n") };
}
// Replaces the approved write classes as a whole; the new config passes every fence check before it is approved.
const setWriteClasses = (writeClasses) => (before) => {
  if (writeClasses !== undefined && (!writeClasses || typeof writeClasses !== "object" || Array.isArray(writeClasses))) invalid("writeClasses");
  return { after: { ...before, writeClasses }, details: { writeClasses: { from: before.writeClasses ?? null, to: writeClasses ?? null } } };
};
// The CLI edit (live write-classes): each named class is replaced by its listed paths, each cleared class is removed,
// and every other class is kept. The result goes through setWriteClasses, so the same fence checks and approval apply.
const editWriteClasses = ({ set, clear }) => (before, pilot) => {
  if (!set || typeof set !== "object" || Array.isArray(set) || !Array.isArray(clear)) invalid("writeClasses");
  const names = [...Object.keys(set), ...clear];
  if (!names.length || new Set(names).size !== names.length || names.some((name) => !WRITE_CLASSES.includes(name))) invalid("writeClasses");
  const next = { ...(before.writeClasses ?? {}) };
  for (const name of clear) delete next[name];
  for (const [name, paths] of Object.entries(set)) {
    if (!Array.isArray(paths) || !paths.length || paths.some((path) => typeof path !== "string")) invalid("writeClasses." + name);
    next[name] = [...new Set(paths)];
  }
  const ordered = Object.fromEntries(WRITE_CLASSES.filter((name) => Object.hasOwn(next, name)).map((name) => [name, next[name]]));
  const writeClasses = Object.keys(ordered).length ? ordered : undefined;
  if (canonicalJson(writeClasses ?? null) === canonicalJson(before.writeClasses ?? null)) invalid("writeClasses");
  return setWriteClasses(writeClasses)(before, pilot);
};
// U18: the stack-watch exception. --host names each host the watch may reach; --off removes the exception.
export const STACK_WATCH_DEFAULT_REQUESTS = 30;
export const STACK_WATCH_NOTE = "With this exception, stack check, stack digest and the radar jobs run in live mode. They reach only these hosts, send no credential and make at most the listed number of requests in one run.";
const setStackWatch = ({ hosts = [], maxRequests, off = false }) => (before) => {
  const from = before.exceptions?.stackWatch ?? null;
  let to = null;
  if (off) { if (!from || hosts.length || maxRequests !== undefined) invalid("stackWatch"); }
  else {
    const cap = maxRequests === undefined ? STACK_WATCH_DEFAULT_REQUESTS : /^[0-9]{1,3}$/.test(String(maxRequests)) ? Number(maxRequests) : NaN;
    if (!Number.isInteger(cap) || cap < 1 || cap > STACK_WATCH_MAX_REQUESTS) invalid("max-requests");
    if (!hosts.length) invalid("host");
    to = { hosts: sorted(hosts.map((host) => String(host).toLowerCase())), maxRequests: cap };
    if (canonicalJson(to) === canonicalJson(from)) invalid("stackWatch");
  }
  const rest = { ...(before.exceptions ?? {}) };
  delete rest.stackWatch;
  const exceptions = to ? { ...rest, stackWatch: to } : Object.keys(rest).length ? rest : undefined;
  return { after: { ...before, exceptions }, details: { stackWatch: { from, to }, note: STACK_WATCH_NOTE } };
};
// U26 (KTD34): the owner-answer mode. "dialog" removes the key, so the config is the one it was before the opt-in.
export const APPROVAL_NOTE = "With dialog-or-tty, an always-ask prompt in a session with no macOS GUI, such as SSH, asks for a six-letter code on the terminal instead of the dialog. With a GUI session the dialog is still required, and agent shells are still denied.";
const setApproval = (mode) => (before) => {
  if (!APPROVAL_MODES.includes(mode)) invalid("mode");
  const from = before.approval ?? "dialog";
  if (from === mode) invalid("mode");
  return { after: { ...before, approval: mode === "dialog" ? undefined : mode }, details: { approval: { from, to: mode }, note: APPROVAL_NOTE } };
};
const preview = async (promise) => ({ preview: true, ...(await promise) });
export const planLiveAddRepo = (input, ctx) => preview(planChange("live-add-repo", input, ctx, addRepo(input.repo)).then((r) => r.plan));
export const applyLiveAddRepo = (input, ctx, options) => applyChange("live-add-repo", input, ctx, addRepo(input.repo), undefined, options);
export const planLiveSetKit = (input, ctx) => preview(planChange("live-set-kit", input, ctx, ...setKit(input, ctx)).then((r) => r.plan));
// Upgrade fix: after the kit change, the new kit rebuilds the derived state (lesson indexes and session summaries), so
// a store that an older kit wrote works with the hook at once.
// KTD5: the apply shows the owner dialog before the change is approved. It is never batched (src/setup/batch.mjs).
export async function applyLiveSetKit(input, ctx, options) {
  const { pilot, plan } = await planChange("live-set-kit", input, ctx, ...setKit(input, ctx));
  assertFingerprint(plan, input.fingerprint);
  await (await import("../owner/dialog.mjs")).requireOwnerApproval({ ...ctx, pilot }, kitDialog(plan.kit));
  const result = await applyChange("live-set-kit", input, ctx, ...setKit(input, ctx), options);
  let derived;
  try { derived = await (await import("../lessons/index.mjs")).rebuildDerived(rootsFromPilot(await loadPilot(result.config, gateContext(ctx)))); }
  catch (error) { derived = [{ scope: null, problem: error.code ?? "DEVTWIN_INTERNAL" }]; }
  return { ...result, derived };
}
export const previewLiveInit = (input, ctx) => ({ preview: true, ...planLiveInit(input, ctx) });
export const planLiveSetWriteClasses = (input, ctx) => preview(planChange("live-set-write-classes", input, ctx, setWriteClasses(input.writeClasses)).then((r) => r.plan));
export const applyLiveSetWriteClasses = (input, ctx, options) => applyChange("live-set-write-classes", input, ctx, setWriteClasses(input.writeClasses), undefined, options);
// U9 (one approval): the config a write-classes edit would give, and the exact bytes its apply writes, with nothing
// written. A setup batch plans the steps after the config change against them (src/setup/batch.mjs).
export async function projectLiveEditWriteClasses(input, ctx) {
  const { next, plan } = await planChange("live-set-write-classes", input, ctx, editWriteClasses(input));
  return { plan: { preview: true, ...plan }, pilot: next, bytes: Buffer.from(configText(rawOf(next))) };
}
export const planLiveEditWriteClasses = (input, ctx) => preview(planChange("live-set-write-classes", input, ctx, editWriteClasses(input)).then((r) => r.plan));
export const applyLiveEditWriteClasses = (input, ctx, options) => applyChange("live-set-write-classes", input, ctx, editWriteClasses(input), undefined, options);
export const planLiveStackWatch = (input, ctx) => preview(planChange("live-stack-watch", input, ctx, setStackWatch(input)).then((r) => r.plan));
export const applyLiveStackWatch = (input, ctx, options) => applyChange("live-stack-watch", input, ctx, setStackWatch(input), undefined, options);
export const planLiveApproval = (input, ctx) => preview(planChange("live-approval", input, ctx, setApproval(input.mode)).then((r) => r.plan));
// The apply shows the owner dialog, in the mode the current config allows, before the change is approved.
export async function applyLiveApproval(input, ctx, options) {
  const { pilot, plan } = await planChange("live-approval", input, ctx, setApproval(input.mode));
  assertFingerprint(plan, input.fingerprint);
  await (await import("../owner/dialog.mjs")).requireOwnerApproval({ ...ctx, pilot }, { title: "Change how devtwin asks you", body: "Approval mode: " + plan.approval.from + " -> " + plan.approval.to + "\n\n" + APPROVAL_NOTE });
  return applyChange("live-approval", input, ctx, setApproval(input.mode), undefined, options);
}
