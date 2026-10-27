import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../storage/canonical.mjs";
import { isWithin, overlaps, info, readPrivateJson, ensurePrivatePath, atomicReplace } from "../storage/fsx.mjs";
import { gitQuery } from "../identity/git.mjs";
import { validateRoot, deepestExisting } from "./roots.mjs";
import { DevtwinError } from "../errors.mjs";
import { LEGACY_SKILL_PREFIX, LEGACY_DEFAULT_ROOTS } from "./legacy.mjs";
// The running kit. Tests inject context.kitRoot; production derives it from this file.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const members = ["configRoot", "dataRoot", "stateRoot", "inputsRoot"];
const keys = ["schemaVersion", "pilotRoot", ...members, "agentHomes", "repos", "forbidden", "live", "writeClasses", "exceptions", "approval"];
const liveKeys = ["configId", "home", "skillDirs", "kitRoot", "kitCommit"];
// Skill folders sit inside these protected homes; only the exact named folder is carved out, never the home.
const SKILL_PARENTS = ["real-claude-home", "real-agents-home", "CLAUDE_CONFIG_DIR"];
// Write classes are the reviewed fence exceptions outside the store. Each lists exact paths; the folder classes
// (hubRoot, and U24's backupTargets for backup archives and restores) list folders.
export const WRITE_CLASSES = ["hubRoot", "instructionTargets", "hookTargets", "launchAgents", "backupTargets"];
export const FOLDER_CLASSES = Object.freeze(["hubRoot", "backupTargets"]);
const MAX_CLASS_PATHS = 16;
// U18 (KTD16): live-mode exceptions that are not file paths. stackWatch lets the stack watch and the radar fetch from
// the listed hosts only, unauthenticated, with at most maxRequests requests in one run. GitHub allows 60
// unauthenticated requests an hour, so the cap stays below that.
export const EXCEPTIONS = ["stackWatch"];
export const STACK_WATCH_MAX_REQUESTS = 50;
// U26 (KTD34): how the owner dialog may be answered. "dialog" (the default, also when the key is absent) needs the macOS
// dialog; "dialog-or-tty" also accepts a code typed on the controlling terminal when there is no GUI session.
export const APPROVAL_MODES = Object.freeze(["dialog", "dialog-or-tty"]);
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const OWNED_INSTRUCTIONS = /^devtwin[a-z0-9._-]{0,64}\.md$/;
const LAUNCH_AGENT = /^devtwin\.[a-z0-9][a-z0-9.-]{0,95}\.plist$/;
const fail = (field, protectedLabel) => { throw new DevtwinError("GATE_REQUIRED", "Pilot fence refused path", { field, ...(protectedLabel ? { protected: protectedLabel } : {}) }); };
const gate = (field, reason) => { throw new DevtwinError("GATE_REQUIRED", "Live config gate refused", { field, reason }); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function comparable(path) {
  const absolute = resolve(path);
  const ancestor = deepestExisting(absolute);
  const canonical = join(realpathSync.native(ancestor), relative(ancestor, absolute));
  return process.platform === "darwin" ? canonical.toLowerCase() : canonical;
}
const touches = (a, b) => overlaps(comparable(a), comparable(b));
export function protectedPaths({ home = homedir(), env = process.env, kitRoot = KIT } = {}) {
  return [
    { label: "real-claude-home", path: join(home, ".claude") },
    { label: "real-codex-home", path: join(home, ".codex") },
    { label: "real-agents-home", path: join(home, ".agents") },
    { label: "real-gemini-home", path: join(home, ".gemini") },
    { label: "real-cursor-home", path: join(home, ".cursor") },
    { label: "real-commandcode-home", path: join(home, ".commandcode") },
    ...(env.CLAUDE_CONFIG_DIR ? [{ label: "CLAUDE_CONFIG_DIR", path: env.CLAUDE_CONFIG_DIR }] : []),
    ...(env.CODEX_HOME ? [{ label: "CODEX_HOME", path: env.CODEX_HOME }] : []),
    { label: "default-config", path: join(home, ".config/devtwin") },
    { label: "default-data", path: join(home, ".local/share/devtwin") },
    { label: "default-state", path: join(home, ".local/state/devtwin") },
    // The former devctx default roots stay protected for the transition.
    ...LEGACY_DEFAULT_ROOTS.map((rel) => ({ label: "legacy-" + rel.split("/").slice(-2).join("-"), path: join(home, rel) })),
    { label: "personal-os-state", path: join(home, ".local/state/personal-os") },
    { label: "kit-checkout", path: kitRoot }
  ];
}
export function skillDirsFor({ home = homedir(), env = process.env } = {}) {
  return { claude: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(home, ".claude/skills"), codex: join(home, ".agents/skills") };
}
// The agent folders whose user-level files devtwin may edit. Codex ignores CODEX_HOME in live mode, as for skills.
export function agentDirsFor({ home = homedir(), env = process.env } = {}) {
  return { claude: env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), codex: join(home, ".codex") };
}
// The exact shape each file class allows for one home. Every target must also sit inside that home.
function classShape(writeClass, path, home, env) {
  if (!isWithin(path, home) || path === home) return false;
  const dirs = agentDirsFor({ home, env }), name = basename(path), parent = dirname(path);
  if (writeClass === "instructionTargets") return path === join(dirs.claude, "CLAUDE.md") || path === join(dirs.codex, "AGENTS.md") || ([dirs.claude, dirs.codex].includes(parent) && OWNED_INSTRUCTIONS.test(name));
  if (writeClass === "hookTargets") return path === join(dirs.claude, "settings.json") || path === join(dirs.codex, "hooks.json");
  return parent === join(home, "Library/LaunchAgents") && LAUNCH_AGENT.test(name);
}
// A live config checks the classes against its home; a disposable pilot only against a listed fake agent home.
function validateClasses(pilot, context) {
  const classes = pilot.writeClasses;
  if (classes === undefined) return [];
  if (!isObject(classes) || Object.keys(classes).some((key) => !WRITE_CLASSES.includes(key))) fail("writeClasses");
  const homes = pilot.live ? [[pilot.live.home, context.env ?? process.env]] : pilot.agentHomes.map((home) => [home, {}]);
  const seen = new Set(), files = [];
  for (const writeClass of WRITE_CLASSES) {
    const paths = classes[writeClass] ?? [], field = "writeClasses." + writeClass;
    if (!Array.isArray(paths) || paths.length > MAX_CLASS_PATHS || paths.some((path) => typeof path !== "string")) fail(field);
    for (const path of paths) {
      const folder = FOLDER_CLASSES.includes(writeClass);
      validateRoot(path, field, !folder);
      if (seen.has(comparable(path))) fail(field);
      seen.add(comparable(path));
      if (folder) {
        if (pilot.live && (!isWithin(path, pilot.live.home) || path === pilot.live.home)) fail(field);
        continue;
      }
      if (!homes.some(([home, env]) => classShape(writeClass, path, home, env))) fail(field);
      const node = info(path);
      if (node && (!node.isFile() || node.isSymbolicLink())) fail(field);
      files.push([field, path]);
    }
  }
  return files;
}
function validateExceptions(pilot) {
  const exceptions = pilot.exceptions;
  if (exceptions === undefined) return;
  if (!pilot.live || !isObject(exceptions) || !Object.keys(exceptions).length || Object.keys(exceptions).some((key) => !EXCEPTIONS.includes(key))) fail("exceptions");
  const watch = exceptions.stackWatch;
  if (watch === undefined) return;
  if (!isObject(watch) || Object.keys(watch).sort().join(",") !== "hosts,maxRequests") fail("exceptions.stackWatch");
  const { hosts, maxRequests } = watch;
  if (!Array.isArray(hosts) || !hosts.length || hosts.length > 32 || new Set(hosts).size !== hosts.length || hosts.some((host) => typeof host !== "string" || !HOST.test(host))) fail("exceptions.stackWatch.hosts");
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > STACK_WATCH_MAX_REQUESTS) fail("exceptions.stackWatch.maxRequests");
}
function validateLive(pilot, context) {
  const live = pilot.live;
  if (!isObject(live) || Object.keys(live).some((key) => !liveKeys.includes(key))) fail("live");
  if (typeof live.configId !== "string" || !/^[a-z0-9][a-z0-9_-]{7,63}$/.test(live.configId)) fail("live");
  if (typeof live.kitCommit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(live.kitCommit)) fail("live");
  if (typeof live.home !== "string" || typeof live.kitRoot !== "string") fail("live");
  if (!isObject(live.skillDirs) || !Object.keys(live.skillDirs).length) fail("live.skillDirs");
  if (pilot.agentHomes.length) fail("agentHomes");
  validateRoot(live.home, "live.home");
  if (comparable(live.home) !== comparable(context.home ?? homedir())) fail("live.home");
  const expected = skillDirsFor({ home: live.home, env: context.env ?? process.env });
  const skills = Object.entries(live.skillDirs).map(([agent, path]) => ["live.skillDirs." + agent, path, Object.hasOwn(expected, agent) ? expected[agent] : null]);
  for (const [field, path, want] of skills) {
    if (typeof path !== "string" || path !== want) fail(field);
    validateRoot(path, field);
    const node = info(path);
    if (!node?.isDirectory() || node.isSymbolicLink()) fail(field);
  }
  validateRoot(live.kitRoot, "live.kitRoot");
  if (touches(live.kitRoot, pilot.pilotRoot)) fail("live.kitRoot");
  for (const forbidden of pilot.forbidden) if (touches(live.kitRoot, forbidden)) fail("live.kitRoot");
  return skills.map(([field, path]) => [field, path]);
}
const carved = (field, path, entry) => field.startsWith("live.skillDirs.") && SKILL_PARENTS.includes(entry.label) && comparable(path) !== comparable(entry.path) && isWithin(comparable(path), comparable(entry.path));
const outsideStore = (pilot, field) => pilot.live !== undefined && (field === "repos" || field.startsWith("live.skillDirs.") || FOLDER_CLASSES.some((name) => field === "writeClasses." + name));
function validate(pilot, context, allowInternal = false) {
  if (!isObject(pilot)) fail("pilot");
  for (const key of Object.keys(pilot)) if (!keys.includes(key) && !(allowInternal && ["path", "digest", "_context", "warnings"].includes(key))) fail(key);
  if (pilot.schemaVersion !== 1) fail("schemaVersion");
  for (const key of ["pilotRoot", ...members]) if (typeof pilot[key] !== "string") fail(key);
  for (const key of ["agentHomes", "repos", "forbidden"]) if (!Array.isArray(pilot[key]) || pilot[key].some((item) => typeof item !== "string")) fail(key);
  const skills = Object.hasOwn(pilot, "live") ? validateLive(pilot, context) : [];
  validateExceptions(pilot);
  if (pilot.approval !== undefined && (!pilot.live || !APPROVAL_MODES.includes(pilot.approval))) fail("approval");
  const files = validateClasses(pilot, context), hubs = FOLDER_CLASSES.flatMap((name) => (pilot.writeClasses?.[name] ?? []).map((path) => ["writeClasses." + name, path]));
  const ps = protectedPaths(context);
  validateRoot(pilot.pilotRoot, "pilotRoot");
  for (const entry of ps) if (touches(pilot.pilotRoot, entry.path)) fail("pilotRoot", entry.label);
  for (const path of pilot.forbidden) {
    validateRoot(path, "forbidden");
    if (touches(pilot.pilotRoot, path)) fail("pilotRoot");
  }
  const destinations = [...members.map((key) => [key, pilot[key]]), ...["agentHomes", "repos"].flatMap((key) => (pilot[key] ?? []).map((path) => [key, path])), ...skills, ...hubs];
  for (const [field, path] of destinations) {
    validateRoot(path, field);
    if (outsideStore(pilot, field) ? touches(path, pilot.pilotRoot) : !isWithin(comparable(path), comparable(pilot.pilotRoot)) || comparable(path) === comparable(pilot.pilotRoot)) fail(field);
    for (const entry of ps) if (touches(path, entry.path) && !carved(field, path, entry)) fail(field, entry.label);
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail(field);
  }
  const spans = skills.length ? [...destinations, ["live.kitRoot", pilot.live.kitRoot]] : destinations;
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if (touches(spans[i][1], spans[j][1])) fail(spans[j][0] === "live.kitRoot" ? spans[i][0] : spans[j][0]);
  // A file target sits inside a protected agent folder by design; it must still miss every other destination.
  for (const [field, path] of files) {
    if (!pilot.live) for (const entry of ps) if (touches(path, entry.path)) fail(field, entry.label);
    for (const [, other] of [...spans.filter(([key]) => key !== "agentHomes"), ...(pilot.live ? [["pilotRoot", pilot.pilotRoot]] : []), ...pilot.forbidden.map((p) => ["forbidden", p])]) if (touches(path, other)) fail(field);
  }
  return pilot;
}
// Kit paths whose files run or are installed; an untracked or ignored file under them makes the kit dirty.
const KIT_CODE = ["bin", "src", "skills", "scripts", "schemas", "catalog", "package.json"];
// Live Git checks run through the read-only, no-optional-locks gitQuery.
const inWorktree = (path) => !gitQuery(deepestExisting(path), ["rev-parse", "--git-dir"], { notRepo: true }).notRepo;
export function assertKit(kitRoot, kitCommit) {
  const top = gitQuery(kitRoot, ["rev-parse", "--show-toplevel"], { notRepo: true });
  if (top.notRepo || comparable(realpathSync(top.stdout.trim())) !== comparable(kitRoot)) gate("live.kitRoot", "not-top-level");
  const gitDir = realpathSync(gitQuery(kitRoot, ["rev-parse", "--absolute-git-dir"]).stdout.trim());
  if (comparable(gitDir) !== comparable(join(kitRoot, ".git"))) gate("live.kitRoot", "not-own-clone");
  if (inWorktree(dirname(kitRoot))) gate("live.kitRoot", "nested");
  // Tracked changes count anywhere. Untracked or ignored files count only where the kit runs code from, so a
  // stray file such as a Finder .DS_Store at the top level or under docs/ does not block live commands.
  if (gitQuery(kitRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=no"]).stdout) gate("live.kitCommit", "dirty");
  for (const ignored of [[], ["--ignored"]]) if (gitQuery(kitRoot, ["ls-files", "-z", "--others", ...ignored, "--exclude-standard", "--", ...KIT_CODE]).stdout) gate("live.kitCommit", "dirty");
  if (gitQuery(kitRoot, ["symbolic-ref", "--quiet", "HEAD"], { allow: [0, 1] }).status !== 1) gate("live.kitCommit", "attached");
  if (gitQuery(kitRoot, ["rev-parse", "--verify", "HEAD"]).stdout.trim() !== kitCommit) gate("live.kitCommit", "commit");
}
// context.liveGate.kit is the hook for a kit-change command: it runs from the new kit, which must match
// the requested { kitRoot, kitCommit } instead of the live config's. The CLI never sets it from arguments.
function assertRunningKit(pilot, context) {
  const expected = context.liveGate?.kit ?? pilot.live;
  let running;
  try { running = comparable(realpathSync(context.kitRoot ?? KIT)); } catch { gate("live.kitRoot", "running-kit"); }
  if (typeof expected.kitRoot !== "string" || running !== comparable(expected.kitRoot)) gate("live.kitRoot", "running-kit");
  assertKit(expected.kitRoot, expected.kitCommit);
}
export const approvedDigestPath = (pilot) => join(pilot.stateRoot, "live", "approved-config.json");
export async function readApprovedDigest(pilot) {
  try { return await readPrivateJson(approvedDigestPath(pilot)); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}
// Callers hold the pilot lock. Live config commands pass the newly approved config's ID and digest.
// A live config change first records the new digest with the current one as previousDigest, replaces the config,
// then records the new digest alone, so a crash between the two writes leaves whichever config is on disk approved.
export async function recordApprovedDigest(roots, { configId = roots?.pilot?.live?.configId, digest: value = roots?.pilot?.digest, previousDigest } = {}) {
  const pilot = roots?.pilot;
  if (!pilot?.live) fail("live");
  const path = approvedDigestPath(pilot);
  assertWritable(roots, [dirname(path), path]);
  ensurePrivatePath(pilot.stateRoot, ["live"]);
  await atomicReplace(path, JSON.stringify({ schemaVersion: 1, configId, digest: value, ...(previousDigest === undefined ? {} : { previousDigest }) }) + "\n");
}
async function assertApproved(pilot) {
  const approved = await readApprovedDigest(pilot);
  if (!approved) gate("live.approval", "unapproved");
  if (approved.schemaVersion !== 1 || approved.configId !== pilot.live.configId || (approved.digest !== pilot.digest && approved.previousDigest !== pilot.digest)) gate("live.approval", "changed");
}
async function readLiveConfig(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail("pilot"); }
  return isObject(raw) && Object.hasOwn(raw, "live") ? readPrivateJson(path) : raw;
}
// Every fence and live gate check except approval. Live config commands use it for a candidate config not yet on disk.
export function checkLiveConfig(raw, path, context = {}) {
  validate(raw, context);
  const live = Object.hasOwn(raw, "live");
  if (live) {
    if (inWorktree(raw.pilotRoot)) fail("pilotRoot");
    if (inWorktree(dirname(resolve(path)))) fail("pilot");
    assertRunningKit(raw, context);
  }
  const warnings = live && (context.env ?? process.env).CODEX_HOME ? [{ code: "CODEX_HOME_IGNORED" }] : [];
  return Object.freeze({ ...raw, path, _context: context, digest: pilotDigest(raw), warnings });
}
export async function loadPilot(path, context = {}) {
  const pilot = checkLiveConfig(await readLiveConfig(path), path, context);
  // context.liveGate.approval === false is for live config commands that approve a new config themselves.
  if (pilot.live && context.liveGate?.approval !== false) await assertApproved(pilot);
  return pilot;
}
export const pilotDigest = (pilot) => digest(Object.fromEntries(keys.map((key) => [key, pilot[key]])));
export function rootsFromPilot(pilot) { return Object.freeze({ configRoot: pilot.configRoot, dataRoot: pilot.dataRoot, stateRoot: pilot.stateRoot, pilot }); }
export function assertInPilot(pilot, path, field) {
  if (!isAbsolute(path)) fail(field);
  if (field === "inputsRoot" ? !isWithin(path, pilot.inputsRoot) : !pilot[field]?.includes(path)) fail(field);
  validateRoot(path, field);
}
// In live mode the target is a named skill folder, never itself a destination: only devtwin-* entries inside it,
// and legacy devctx-* entries, which the installer only ever removes.
function inTarget(pilot, target, path) {
  if (!isWithin(comparable(path), comparable(target))) return false;
  const top = relative(comparable(target), comparable(path)).split(sep)[0];
  return !pilot.live || top.startsWith("devtwin-") || top.startsWith(LEGACY_SKILL_PREFIX);
}
// A write class destination needs the caller to name its one class, as an installer names its one target home.
export const inClass = (pilot, writeClass, path) => writeClass !== undefined && (pilot.writeClasses?.[writeClass] ?? []).some((approved) => FOLDER_CLASSES.includes(writeClass) ? isWithin(comparable(path), comparable(approved)) : comparable(path) === comparable(approved));
// U24: the approved folder of a folder class that holds path, or null; samePath compares two paths as the fence does.
export const approvedFolder = (pilot, writeClass, path) => FOLDER_CLASSES.includes(writeClass) ? (pilot?.writeClasses?.[writeClass] ?? []).find((approved) => isWithin(comparable(path), comparable(approved))) ?? null : null;
export const samePath = (a, b) => comparable(a) === comparable(b);
export function assertWritable(roots, destinations, { targetHome, writeClass } = {}) {
  const pilot = roots?.pilot;
  if (!pilot || pilotDigest(pilot) !== pilot.digest || roots.configRoot !== pilot.configRoot || roots.dataRoot !== pilot.dataRoot || roots.stateRoot !== pilot.stateRoot) fail("pilot");
  validate(pilot, pilot._context, true);
  const targets = pilot.live ? Object.values(pilot.live.skillDirs) : pilot.agentHomes;
  if (targetHome !== undefined && (typeof targetHome !== "string" || !targets.includes(targetHome))) fail("targetHome");
  if (writeClass !== undefined && !WRITE_CLASSES.includes(writeClass)) fail("writeClass");
  const stores = [pilot.configRoot, pilot.dataRoot, pilot.stateRoot];
  for (const path of destinations) {
    validateRoot(path, "destination", true);
    if (!stores.some((root) => isWithin(comparable(path), comparable(root))) && !(targetHome !== undefined && inTarget(pilot, targetHome, path)) && !inClass(pilot, writeClass, path)) fail("destination");
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail("destination");
  }
}
