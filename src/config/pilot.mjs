import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../storage/canonical.mjs";
import { isWithin, overlaps, info, readPrivateJson, ensurePrivatePath, atomicReplace } from "../storage/fsx.mjs";
import { gitQuery } from "../identity/git.mjs";
import { validateRoot, deepestExisting } from "./roots.mjs";
import { DevctxError } from "../errors.mjs";
// The running kit. Tests inject context.kitRoot; production derives it from this file.
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const members = ["configRoot", "dataRoot", "stateRoot", "inputsRoot"];
const keys = ["schemaVersion", "pilotRoot", ...members, "agentHomes", "repos", "forbidden", "live"];
const liveKeys = ["profileId", "home", "skillDirs", "kitRoot", "kitCommit"];
// Skill folders sit inside these protected homes; only the exact named folder is carved out, never the home.
const SKILL_PARENTS = ["real-claude-home", "real-agents-home", "CLAUDE_CONFIG_DIR"];
const fail = (field, protectedLabel) => { throw new DevctxError("GATE_REQUIRED", "Pilot fence refused path", { field, ...(protectedLabel ? { protected: protectedLabel } : {}) }); };
const gate = (field, reason) => { throw new DevctxError("GATE_REQUIRED", "Live profile gate refused", { field, reason }); };
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
    { label: "default-config", path: join(home, ".config/devctx") },
    { label: "default-data", path: join(home, ".local/share/devctx") },
    { label: "default-state", path: join(home, ".local/state/devctx") },
    { label: "personal-os-state", path: join(home, ".local/state/personal-os") },
    { label: "kit-checkout", path: kitRoot }
  ];
}
export function skillDirsFor({ home = homedir(), env = process.env } = {}) {
  return { claude: env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, "skills") : join(home, ".claude/skills"), codex: join(home, ".agents/skills") };
}
function validateLive(pilot, context) {
  const live = pilot.live;
  if (!isObject(live) || Object.keys(live).some((key) => !liveKeys.includes(key))) fail("live");
  if (typeof live.profileId !== "string" || !/^[a-z0-9][a-z0-9_-]{7,63}$/.test(live.profileId)) fail("live");
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
const outsideStore = (pilot, field) => pilot.live !== undefined && (field === "repos" || field.startsWith("live.skillDirs."));
function validate(pilot, context, allowInternal = false) {
  if (!isObject(pilot)) fail("pilot");
  for (const key of Object.keys(pilot)) if (!keys.includes(key) && !(allowInternal && ["path", "digest", "_context", "warnings"].includes(key))) fail(key);
  if (pilot.schemaVersion !== 1) fail("schemaVersion");
  for (const key of ["pilotRoot", ...members]) if (typeof pilot[key] !== "string") fail(key);
  for (const key of ["agentHomes", "repos", "forbidden"]) if (!Array.isArray(pilot[key]) || pilot[key].some((item) => typeof item !== "string")) fail(key);
  const skills = Object.hasOwn(pilot, "live") ? validateLive(pilot, context) : [];
  const ps = protectedPaths(context);
  validateRoot(pilot.pilotRoot, "pilotRoot");
  for (const entry of ps) if (touches(pilot.pilotRoot, entry.path)) fail("pilotRoot", entry.label);
  for (const path of pilot.forbidden) {
    validateRoot(path, "forbidden");
    if (touches(pilot.pilotRoot, path)) fail("pilotRoot");
  }
  const destinations = [...members.map((key) => [key, pilot[key]]), ...["agentHomes", "repos"].flatMap((key) => (pilot[key] ?? []).map((path) => [key, path])), ...skills];
  for (const [field, path] of destinations) {
    validateRoot(path, field);
    if (outsideStore(pilot, field) ? touches(path, pilot.pilotRoot) : !isWithin(comparable(path), comparable(pilot.pilotRoot)) || comparable(path) === comparable(pilot.pilotRoot)) fail(field);
    for (const entry of ps) if (touches(path, entry.path) && !carved(field, path, entry)) fail(field, entry.label);
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail(field);
  }
  const spans = skills.length ? [...destinations, ["live.kitRoot", pilot.live.kitRoot]] : destinations;
  for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) if (touches(spans[i][1], spans[j][1])) fail(spans[j][0] === "live.kitRoot" ? spans[i][0] : spans[j][0]);
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
// the requested { kitRoot, kitCommit } instead of the profile's. The CLI never sets it from arguments.
function assertRunningKit(pilot, context) {
  const expected = context.liveGate?.kit ?? pilot.live;
  let running;
  try { running = comparable(realpathSync(context.kitRoot ?? KIT)); } catch { gate("live.kitRoot", "running-kit"); }
  if (typeof expected.kitRoot !== "string" || running !== comparable(expected.kitRoot)) gate("live.kitRoot", "running-kit");
  assertKit(expected.kitRoot, expected.kitCommit);
}
export const approvedDigestPath = (pilot) => join(pilot.stateRoot, "live", "approved-profile.json");
export async function readApprovedDigest(pilot) {
  try { return await readPrivateJson(approvedDigestPath(pilot)); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
}
// Callers hold the pilot lock. Profile commands pass the newly approved profile's ID and digest.
// A profile change first records the new digest with the current one as previousDigest, replaces the profile,
// then records the new digest alone, so a crash between the two writes leaves whichever profile is on disk approved.
export async function recordApprovedDigest(roots, { profileId = roots?.pilot?.live?.profileId, digest: value = roots?.pilot?.digest, previousDigest } = {}) {
  const pilot = roots?.pilot;
  if (!pilot?.live) fail("live");
  const path = approvedDigestPath(pilot);
  assertWritable(roots, [dirname(path), path]);
  ensurePrivatePath(pilot.stateRoot, ["live"]);
  await atomicReplace(path, JSON.stringify({ schemaVersion: 1, profileId, digest: value, ...(previousDigest === undefined ? {} : { previousDigest }) }) + "\n");
}
async function assertApproved(pilot) {
  const approved = await readApprovedDigest(pilot);
  if (!approved) gate("live.approval", "unapproved");
  if (approved.schemaVersion !== 1 || approved.profileId !== pilot.live.profileId || (approved.digest !== pilot.digest && approved.previousDigest !== pilot.digest)) gate("live.approval", "changed");
}
async function readProfile(path) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail("pilot"); }
  return isObject(raw) && Object.hasOwn(raw, "live") ? readPrivateJson(path) : raw;
}
// Every fence and live gate check except approval. Profile commands use it for a candidate profile not yet on disk.
export function checkProfile(raw, path, context = {}) {
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
  const pilot = checkProfile(await readProfile(path), path, context);
  // context.liveGate.approval === false is for profile commands that approve a new profile themselves.
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
// In live mode the target is a named skill folder, never itself a destination: only devctx-* entries inside it.
function inTarget(pilot, target, path) {
  if (!isWithin(comparable(path), comparable(target))) return false;
  return !pilot.live || relative(comparable(target), comparable(path)).split(sep)[0].startsWith("devctx-");
}
export function assertWritable(roots, destinations, { targetHome } = {}) {
  const pilot = roots?.pilot;
  if (!pilot || pilotDigest(pilot) !== pilot.digest || roots.configRoot !== pilot.configRoot || roots.dataRoot !== pilot.dataRoot || roots.stateRoot !== pilot.stateRoot) fail("pilot");
  validate(pilot, pilot._context, true);
  const targets = pilot.live ? Object.values(pilot.live.skillDirs) : pilot.agentHomes;
  if (targetHome !== undefined && (typeof targetHome !== "string" || !targets.includes(targetHome))) fail("targetHome");
  const stores = [pilot.configRoot, pilot.dataRoot, pilot.stateRoot];
  for (const path of destinations) {
    validateRoot(path, "destination", true);
    if (!stores.some((root) => isWithin(comparable(path), comparable(root))) && !(targetHome !== undefined && inTarget(pilot, targetHome, path))) fail("destination");
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail("destination");
  }
}
