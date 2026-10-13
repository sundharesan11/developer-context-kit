import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../storage/canonical.mjs";
import { isWithin, overlaps } from "../storage/fsx.mjs";
import { validateRoot, deepestExisting } from "./roots.mjs";
import { DevctxError } from "../errors.mjs";
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const members = ["configRoot", "dataRoot", "stateRoot", "inputsRoot"];
const keys = ["schemaVersion", "pilotRoot", ...members, "agentHomes", "repos", "forbidden"];
const fail = (field, protectedLabel) => { throw new DevctxError("GATE_REQUIRED", "Pilot fence refused path", { field, ...(protectedLabel ? { protected: protectedLabel } : {}) }); };
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
function validate(pilot, context, allowInternal = false) {
  if (!pilot || typeof pilot !== "object" || Array.isArray(pilot)) fail("pilot");
  for (const key of Object.keys(pilot)) if (!keys.includes(key) && !(allowInternal && ["path", "digest", "_context"].includes(key))) fail(key);
  if (pilot.schemaVersion !== 1) fail("schemaVersion");
  for (const key of ["pilotRoot", ...members]) if (typeof pilot[key] !== "string") fail(key);
  for (const key of ["agentHomes", "repos", "forbidden"]) if (!Array.isArray(pilot[key]) || pilot[key].some((item) => typeof item !== "string")) fail(key);
  const ps = protectedPaths(context);
  validateRoot(pilot.pilotRoot, "pilotRoot");
  for (const entry of ps) if (touches(pilot.pilotRoot, entry.path)) fail("pilotRoot", entry.label);
  for (const path of pilot.forbidden) {
    validateRoot(path, "forbidden");
    if (touches(pilot.pilotRoot, path)) fail("pilotRoot");
  }
  const destinations = [...members.map((key) => [key, pilot[key]]), ...["agentHomes", "repos"].flatMap((key) => (pilot[key] ?? []).map((path) => [key, path]))];
  for (const [field, path] of destinations) {
    validateRoot(path, field);
    if (!isWithin(comparable(path), comparable(pilot.pilotRoot)) || comparable(path) === comparable(pilot.pilotRoot)) fail(field);
    for (const entry of ps) if (touches(path, entry.path)) fail(field, entry.label);
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail(field);
  }
  for (let i = 0; i < destinations.length; i++) for (let j = i + 1; j < destinations.length; j++) if (touches(destinations[i][1], destinations[j][1])) fail(destinations[j][0]);
  return pilot;
}
export async function loadPilot(path, context = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail("pilot"); }
  validate(raw, context);
  const pilot = { ...raw, path, _context: context, digest: pilotDigest(raw) };
  return Object.freeze(pilot);
}
export const pilotDigest = (pilot) => digest(Object.fromEntries(keys.map((key) => [key, pilot[key]])));
export function rootsFromPilot(pilot) { return Object.freeze({ configRoot: pilot.configRoot, dataRoot: pilot.dataRoot, stateRoot: pilot.stateRoot, pilot }); }
export function assertInPilot(pilot, path, field) {
  if (!isAbsolute(path)) fail(field);
  if (field === "inputsRoot" ? !isWithin(path, pilot.inputsRoot) : !pilot[field]?.includes(path)) fail(field);
  validateRoot(path, field);
}
export function assertWritable(roots, destinations, { targetHome } = {}) {
  const pilot = roots?.pilot;
  if (!pilot || pilotDigest(pilot) !== pilot.digest || roots.configRoot !== pilot.configRoot || roots.dataRoot !== pilot.dataRoot || roots.stateRoot !== pilot.stateRoot) fail("pilot");
  validate(pilot, pilot._context, true);
  if (targetHome !== undefined && (typeof targetHome !== "string" || !pilot.agentHomes.includes(targetHome))) fail("targetHome");
  const allowed = [pilot.configRoot, pilot.dataRoot, pilot.stateRoot, ...(targetHome === undefined ? [] : [targetHome])];
  for (const path of destinations) {
    validateRoot(path, "destination", true);
    if (!allowed.some((root) => isWithin(comparable(path), comparable(root)))) fail("destination");
    for (const forbidden of pilot.forbidden) if (touches(path, forbidden)) fail("destination");
  }
}
