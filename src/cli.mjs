import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { DevctxError, toJson } from "./errors.mjs";
import { loadPilot, rootsFromPilot } from "./config/pilot.mjs";
const ROOT_OPTIONS = {
  "config-root": { type: "string" }, "data-root": { type: "string" },
  "state-root": { type: "string" }, pilot: { type: "string" }
};
export const COMMANDS = {
  version: { rootFree: true, load: async () => ({ options: {}, run: () => ({ name: "devctx", version: "0.0.0-local" }) }) },
  help: { rootFree: true, load: async () => ({ options: {}, run: () => ({ commands: listCommands() }) }) },
  doctor: { load: async () => ({ options: {}, run: ({}, ctx) => import("./config/doctor.mjs").then((m) => m.runDoctor(ctx.roots)) }) },
  init: { load: async () => (await import("./config/commands.mjs")).initCommand },
  "scope add": { load: async () => (await import("./config/commands.mjs")).scopeAddCommand },
  "record add": { load: async () => (await import("./records/commands.mjs")).recordAddCommand },
  "record supersede": { load: async () => (await import("./records/commands.mjs")).recordSupersedeCommand },
  "record propose": { load: async () => (await import("./records/commands.mjs")).recordProposeCommand },
  "record publish": { load: async () => (await import("./records/commands.mjs")).recordPublishCommand },
  "project onboard": { load: async () => (await import("./onboarding/commands.mjs")).projectOnboardCommand },
  "context resolve": { load: async () => (await import("./context/commands.mjs")).contextResolveCommand },
  "context brief": { load: async () => (await import("./context/commands.mjs")).contextBriefCommand },
  "agents install": { load: async () => (await import("./agents/commands.mjs")).agentsInstallCommand },
  "agents uninstall": { load: async () => (await import("./agents/commands.mjs")).agentsUninstallCommand },
  "agents status": { load: async () => (await import("./agents/commands.mjs")).agentsStatusCommand },
  "hub propose": { load: async () => (await import("./hubs/commands.mjs")).hubProposeCommand }
};
export const listCommands = () => Object.keys(COMMANDS).sort();
export const isRootFree = (route) => COMMANDS[route]?.rootFree === true;
function routeFor(argv) {
  if (argv.length === 0 || argv[0].startsWith("-")) throw new DevctxError("USAGE", "A command is required");
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { route: two, args: argv.slice(2) };
  if (COMMANDS[argv[0]]) return { route: argv[0], args: argv.slice(1) };
  throw new DevctxError("USAGE", "Unknown command");
}
export async function main(argv, options = {}) {
  const { stdout = process.stdout, now = () => new Date(), home = homedir(), env = process.env } = options;
  let command = argv.slice(0, 2).join(" ");
  try {
    const routed = routeFor(argv);
    command = routed.route;
    if (!isRootFree(command) && !routed.args.some((arg) => arg === "--pilot" || arg.startsWith("--pilot="))) throw new DevctxError("GATE_REQUIRED", "v0 runs only inside a pilot fence");
    const impl = await COMMANDS[command].load();
    let values;
    try {
      ({ values } = parseArgs({ args: routed.args, options: { ...ROOT_OPTIONS, ...impl.options }, strict: true, allowPositionals: false }));
    } catch {
      throw new DevctxError("USAGE", "Invalid command options");
    }
    let pilot, roots;
    if (!isRootFree(command)) {
      pilot = await loadPilot(values.pilot, { home, env });
      roots = rootsFromPilot(pilot);
      for (const [flag, key] of [["config-root", "configRoot"], ["data-root", "dataRoot"], ["state-root", "stateRoot"]]) {
        if (values[flag] && values[flag] !== roots[key]) throw new DevctxError("GATE_REQUIRED", "Root does not match pilot");
      }
    }
    const result = await impl.run(values, { roots, pilot, now, home, env });
    stdout.write(JSON.stringify({ ok: true, command, result }) + "\n");
    return 0;
  } catch (error) {
    const err = toJson(error);
    stdout.write(JSON.stringify({ ok: false, command, error: err }) + "\n");
    return err.code === "DEVCTX_USAGE" ? 2 : 1;
  }
}
