import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../storage/canonical.mjs";
import { isWithin, overlaps } from "../storage/fsx.mjs";
import { validateRoot } from "./roots.mjs";
import { DevctxError } from "../errors.mjs";
const KIT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const members = ["configRoot", "dataRoot", "stateRoot", "inputsRoot"];
const fail = (field, protectedLabel) => { throw new DevctxError("GATE_REQUIRED", "Pilot fence refused path", { field, ...(protectedLabel ? { protected: protectedLabel } : {}) }); };
export function protectedPaths({ home = homedir(), env = process.env, kitRoot = KIT } = {}) {
  return [
    { label: "real-claude-home", path: join(home, ".claude") },
    { label: "real-codex-home", path: join(home, ".codex") },
    { label: "real-agents-home", path: join(home, ".agents") },
    ...(env.CLAUDE_CONFIG_DIR ? [{ label: "CLAUDE_CONFIG_DIR", path: env.CLAUDE_CONFIG_DIR }] : []),
    ...(env.CODEX_HOME ? [{ label: "CODEX_HOME", path: env.CODEX_HOME }] : []),
    { label: "default-config", path: join(home, ".config/devctx") },
    { label: "default-data", path: join(home, ".local/share/devctx") },
    { label: "default-state", path: join(home, ".local/state/devctx") },
    { label: "personal-os-state", path: join(home, ".local/state/personal-os") },
    { label: "kit-checkout", path: kitRoot }
  ];
}
function validate(pilot, context) {
  const ps = protectedPaths(context);
  validateRoot(pilot.pilotRoot, "pilotRoot");
  for (const entry of ps) if (overlaps(pilot.pilotRoot, entry.path)) fail("pilotRoot", entry.label);
  if (!Array.isArray(pilot.forbidden)) fail("forbidden");
  for (const path of pilot.forbidden) {
    validateRoot(path, "forbidden");
    if (overlaps(pilot.pilotRoot, path)) fail("pilotRoot");
  }
  const destinations = [...members.map((key) => [key, pilot[key]]), ...["agentHomes", "repos"].flatMap((key) => (pilot[key] ?? []).map((path) => [key, path]))];
  if (!Array.isArray(pilot.agentHomes) || !Array.isArray(pilot.repos)) fail("agentHomes");
  for (const [field, path] of destinations) {
    validateRoot(path, field);
    if (!isWithin(path, pilot.pilotRoot) || path === pilot.pilotRoot) fail(field);
    for (const entry of ps) if (overlaps(path, entry.path)) fail(field, entry.label);
    for (const forbidden of pilot.forbidden) if (overlaps(path, forbidden)) fail(field);
  }
  for (let i = 0; i < destinations.length; i++) for (let j = i + 1; j < destinations.length; j++) if (overlaps(destinations[i][1], destinations[j][1])) fail(destinations[j][0]);
  if (pilot.schemaVersion !== 1) fail("schemaVersion");
  return pilot;
}
export async function loadPilot(path, context = {}) {
  let raw;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { fail("pilot"); }
  validate(raw, context);
  const pilot = { ...raw, path, _context: context, digest: digest(raw) };
  return Object.freeze(pilot);
}
export const pilotDigest = (pilot) => digest(Object.fromEntries(["schemaVersion", "pilotRoot", ...members, "agentHomes", "repos", "forbidden"].map((key) => [key, pilot[key]])));
export function rootsFromPilot(pilot) { return Object.freeze({ configRoot: pilot.configRoot, dataRoot: pilot.dataRoot, stateRoot: pilot.stateRoot, pilot }); }
export function assertInPilot(pilot, path, field) {
  if (!isAbsolute(path)) fail(field);
  if (field === "inputsRoot" ? !isWithin(path, pilot.inputsRoot) : !pilot[field]?.includes(path)) fail(field);
  validateRoot(path, field);
}
export function assertWritable(roots, destinations) {
  const pilot = roots?.pilot;
  if (!pilot || pilotDigest(pilot) !== pilot.digest || roots.configRoot !== pilot.configRoot || roots.dataRoot !== pilot.dataRoot || roots.stateRoot !== pilot.stateRoot) fail("pilot");
  validate(pilot, pilot._context);
  for (const path of destinations) {
    validateRoot(path, "destination");
    if (![pilot.configRoot, pilot.dataRoot, pilot.stateRoot, ...pilot.agentHomes].some((root) => isWithin(path, root))) fail("destination");
    for (const forbidden of pilot.forbidden) if (overlaps(path, forbidden)) fail("destination");
  }
}
