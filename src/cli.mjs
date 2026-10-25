import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { DevtwinError, toJson } from "./errors.mjs";
import { loadPilot, rootsFromPilot } from "./config/pilot.mjs";
const ROOT_OPTIONS = {
  "config-root": { type: "string" }, "data-root": { type: "string" },
  "state-root": { type: "string" }, pilot: { type: "string" }
};
export const COMMANDS = {
  version: { rootFree: true, load: async () => ({ options: {}, run: () => ({ name: "devtwin", version: "0.0.0-local" }) }) },
  help: { rootFree: true, load: async () => ({ options: {}, run: () => ({ commands: listCommands() }) }) },
  "skill-sources catalog": { rootFree: true, rootOptions: false, load: async () => (await import("./skill-sources/commands.mjs")).catalogCommand },
  "skill-sources check": { rootFree: true, rootOptions: false, load: async () => (await import("./skill-sources/commands.mjs")).checkCommand },
  "skill-sources preview": { rootFree: true, rootOptions: false, load: async () => (await import("./skill-sources/acquisition-commands.mjs")).previewCommand },
  "skill-sources stage": { rootOptions: false, load: async () => (await import("./skill-sources/acquisition-commands.mjs")).stageCommand },
  "skill-sources inspect": { rootOptions: false, load: async () => (await import("./skill-sources/acquisition-commands.mjs")).inspectCommand },
  "skill-sources package-review": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).packageReviewCommand },
  "skill-sources content-approve": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).contentApproveCommand },
  "skill-sources local-plan": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).localPlanCommand },
  "skill-sources local-approve": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).localApproveCommand },
  "skill-sources local-apply": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).localApplyCommand },
  "skill-sources local-status": { rootOptions: false, load: async () => (await import("./skill-sources/installation-commands.mjs")).localStatusCommand },
  doctor: { load: async () => ({ options: {}, run: ({}, ctx) => import("./config/doctor.mjs").then((m) => m.runDoctor(ctx.roots)) }) },
  init: { load: async () => (await import("./config/commands.mjs")).initCommand },
  "scope add": { load: async () => (await import("./config/commands.mjs")).scopeAddCommand },
  "live init": { rootOptions: false, liveConfig: true, load: async () => (await import("./config/commands.mjs")).liveInitCommand },
  "live add-repo": { rootOptions: false, liveConfig: true, load: async () => (await import("./config/commands.mjs")).liveAddRepoCommand },
  "live set-kit": { rootOptions: false, liveConfig: true, load: async () => (await import("./config/commands.mjs")).liveSetKitCommand },
  "live write-classes": { rootOptions: false, liveConfig: true, load: async () => (await import("./config/commands.mjs")).liveWriteClassesCommand },
  "live migrate": { rootOptions: false, liveConfig: true, load: async () => (await import("./config/commands.mjs")).liveMigrateCommand },
  "record add": { load: async () => (await import("./records/commands.mjs")).recordAddCommand },
  "record supersede": { load: async () => (await import("./records/commands.mjs")).recordSupersedeCommand },
  "record propose": { load: async () => (await import("./records/commands.mjs")).recordProposeCommand },
  "record publish": { load: async () => (await import("./records/commands.mjs")).recordPublishCommand },
  "lesson match": { load: async () => (await import("./lessons/commands.mjs")).lessonMatchCommand },
  "lesson show": { load: async () => (await import("./lessons/commands.mjs")).lessonShowCommand },
  "lesson index": { load: async () => (await import("./lessons/commands.mjs")).lessonIndexCommand },
  "lesson propose": { load: async () => (await import("./lessons/commands.mjs")).lessonProposeCommand },
  "lesson proposals": { load: async () => (await import("./lessons/commands.mjs")).lessonProposalsCommand },
  "lesson edit": { load: async () => (await import("./lessons/commands.mjs")).lessonEditCommand },
  "lesson reject": { load: async () => (await import("./lessons/commands.mjs")).lessonRejectCommand },
  "lesson accept": { load: async () => (await import("./lessons/commands.mjs")).lessonAcceptCommand },
  "lesson copy": { load: async () => (await import("./lessons/commands.mjs")).lessonCopyCommand },
  "lesson supersede-propose": { load: async () => (await import("./lessons/commands.mjs")).lessonSupersedeProposeCommand },
  "lesson notices": { load: async () => (await import("./lessons/commands.mjs")).lessonNoticesCommand },
  // The agent hook route prints the agent's own JSON, not the CLI envelope, and skips the full pilot load (KTD6).
  hook: { hook: true, load: async () => import("./hooks/commands.mjs") },
  "hook verify": { load: async () => (await import("./hooks/commands.mjs")).hookVerifyCommand },
  "budget report": { load: async () => (await import("./hooks/commands.mjs")).budgetReportCommand },
  // The terminal loop writes its own text to a terminal instead of the JSON envelope; without one it refuses.
  setup: { interactive: true, load: async () => (await import("./setup/tty.mjs")).setupLoopCommand },
  "setup status": { load: async () => (await import("./setup/commands.mjs")).setupStatusCommand },
  "setup plan": { load: async () => (await import("./setup/commands.mjs")).setupPlanCommand },
  "setup apply": { load: async () => (await import("./setup/commands.mjs")).setupApplyCommand },
  "project onboard": { load: async () => (await import("./onboarding/commands.mjs")).projectOnboardCommand },
  "profile show": { load: async () => (await import("./profile/commands.mjs")).profileShowCommand },
  "profile plan": { load: async () => (await import("./profile/commands.mjs")).profilePlanCommand },
  "profile apply": { load: async () => (await import("./profile/commands.mjs")).profileApplyCommand },
  "profile export": { load: async () => (await import("./profile/commands.mjs")).profileExportCommand },
  "profile suggest-stack": { load: async () => (await import("./profile/commands.mjs")).profileSuggestStackCommand },
  "stack plan": { load: async () => (await import("./stack/commands.mjs")).stackPlanCommand },
  "stack approve": { load: async () => (await import("./stack/commands.mjs")).stackApproveCommand },
  "stack check": { load: async () => (await import("./stack/commands.mjs")).stackCheckCommand },
  "stack digest": { load: async () => (await import("./stack/commands.mjs")).stackDigestCommand },
  "draft save": { load: async () => (await import("./drafts/commands.mjs")).draftSaveCommand },
  "context resolve": { load: async () => (await import("./context/commands.mjs")).contextResolveCommand },
  "context brief": { load: async () => (await import("./context/commands.mjs")).contextBriefCommand },
  "handoff export": { rootOptions: false, load: async () => (await import("./handoff/commands.mjs")).handoffExportCommand },
  "agents install": { load: async () => (await import("./agents/commands.mjs")).agentsInstallCommand },
  "agents uninstall": { load: async () => (await import("./agents/commands.mjs")).agentsUninstallCommand },
  "agents status": { load: async () => (await import("./agents/commands.mjs")).agentsStatusCommand },
  "agents recover": { load: async () => (await import("./agents/commands.mjs")).agentsRecoverCommand },
  "agents rollback-check": { load: async () => (await import("./agents/commands.mjs")).agentsRollbackCheckCommand },
  "locks release": { load: async () => (await import("./storage/lock.mjs")).locksReleaseCommand },
  "note list": { load: async () => (await import("./notes/commands.mjs")).noteListCommand },
  "note revoke": { load: async () => (await import("./notes/commands.mjs")).noteRevokeCommand },
  "note consent": { load: async () => (await import("./notes/commands.mjs")).noteConsentCommand },
  "hub propose": { load: async () => (await import("./hubs/commands.mjs")).hubProposeCommand },
  "hub join": { load: async () => (await import("./hubs/commands.mjs")).hubJoinCommand },
  "hub sync": { load: async () => (await import("./hubs/commands.mjs")).hubSyncCommand },
  "hub leave": { load: async () => (await import("./hubs/commands.mjs")).hubLeaveCommand },
  "hub status": { load: async () => (await import("./hubs/commands.mjs")).hubStatusCommand },
  "hub schedule": { load: async () => (await import("./hubs/commands.mjs")).hubScheduleCommand },
  "published list": { load: async () => (await import("./hubs/commands.mjs")).publishedListCommand },
  "published delete": { load: async () => (await import("./hubs/commands.mjs")).publishedDeleteCommand },
  "skill workspace-create": { load: async () => (await import("./skill-builder/commands.mjs")).workspaceCreateCommand },
  "skill requirements-record": { load: async () => (await import("./skill-builder/commands.mjs")).requirementsRecordCommand },
  "skill design-record": { load: async () => (await import("./skill-builder/commands.mjs")).designRecordCommand },
  "skill design-approve": { load: async () => (await import("./skill-builder/commands.mjs")).designApproveCommand },
  "skill draft-create": { load: async () => (await import("./skill-builder/commands.mjs")).draftCreateCommand },
  "skill draft-validate": { load: async () => (await import("./skill-builder/commands.mjs")).draftValidateCommand },
  "skill content-approve": { load: async () => (await import("./skill-builder/commands.mjs")).contentApproveCommand },
  "skill local-plan": { load: async () => (await import("./skill-builder/commands.mjs")).localPlanCommand },
  "skill local-approve": { load: async () => (await import("./skill-builder/commands.mjs")).localApproveCommand },
  "skill local-apply": { load: async () => (await import("./skill-builder/commands.mjs")).localApplyCommand },
  "skill local-status": { load: async () => (await import("./skill-builder/commands.mjs")).localStatusCommand },
  "skill workspace-show": { load: async () => (await import("./skill-builder/commands.mjs")).workspaceShowCommand },
  "skill discover": { load: async () => (await import("./skill-builder/commands.mjs")).discoverCommand },
  "skill template-list": { rootFree: true, rootOptions: false, load: async () => (await import("./skill-builder/template-commands.mjs")).templateListCommand },
  "skill template-seed": { load: async () => (await import("./skill-builder/template-commands.mjs")).templateSeedCommand },
  "skill template-verify": { load: async () => (await import("./skill-builder/template-commands.mjs")).templateVerifyCommand }
};
export const listCommands = () => Object.keys(COMMANDS).sort();
export const isRootFree = (route) => COMMANDS[route]?.rootFree === true;
function routeFor(argv) {
  if (argv.length === 0 || argv[0].startsWith("-")) throw new DevtwinError("USAGE", "A command is required");
  const two = argv.slice(0, 2).join(" ");
  if (COMMANDS[two]) return { route: two, args: argv.slice(2) };
  if (COMMANDS[argv[0]]) return { route: argv[0], args: argv.slice(1) };
  throw new DevtwinError("USAGE", "Unknown command");
}
export async function main(argv, options = {}) {
  // kitRoot and templateRoot are test seams for the running kit; production leaves them undefined.
  // stackCatalog, resolvePublicRead, request and lookup are seams for the stack routes; routing will supply the real
  // resolver. Without request and lookup, stack check uses node:https pinned to the checked address (src/stack/fetch.mjs).
  // stdin carries the agent payload for the hook route: a stream in production, a string in tests.
  // ownerDialog and launchctl are seams for the owner dialog (src/owner/dialog.mjs) and launchd (src/schedule/launchd.mjs).
  const { stdout = process.stdout, stdin = process.stdin, now = () => new Date(), home = homedir(), env = process.env, kitRoot, templateRoot, ownerDialog, launchctl } = options;
  let command = argv.slice(0, 2).join(" ");
  try {
    const routed = routeFor(argv);
    command = routed.route;
    if (!isRootFree(command) && !routed.args.some((arg) => arg === "--pilot" || arg.startsWith("--pilot="))) throw new DevtwinError("GATE_REQUIRED", "v0 runs only inside a pilot fence");
    if (COMMANDS[command].hook === true) return (await COMMANDS[command].load()).runHook(routed.args, { stdin, stdout, now, kitRoot });
    const impl = await COMMANDS[command].load();
    let values;
    try {
      const parsed = parseArgs({
        args: routed.args,
        options: { ...(COMMANDS[command].rootOptions === false ? {} : ROOT_OPTIONS), ...impl.options },
        strict: true, allowPositionals: false,
        tokens: COMMANDS[command].rootOptions === false
      });
      values = parsed.values;
      if (COMMANDS[command].rootOptions === false) {
        const seen = new Set();
        for (const token of parsed.tokens) {
          if (token.kind !== "option") continue;
          if (seen.has(token.name) && impl.options[token.name]?.multiple !== true) throw new DevtwinError("USAGE", "Duplicate command option");
          seen.add(token.name);
        }
      }
    } catch {
      throw new DevtwinError("USAGE", "Invalid command options");
    }
    let pilot, roots;
    // Live config routes still require --pilot but load the live config themselves.
    if (!isRootFree(command) && COMMANDS[command].liveConfig !== true) {
      try {
        pilot = await loadPilot(values.pilot, { home, env, kitRoot });
        roots = rootsFromPilot(pilot);
      } catch (error) {
        if (command === "handoff export") throw (await import("./handoff/privacy.mjs")).handoffError(error);
        if (!command.startsWith("skill-sources ")) throw error;
        throw new DevtwinError(error instanceof DevtwinError ? error.code : "STORAGE_ERROR", "Acquisition pilot could not be loaded", {field: "pilot"});
      }
      for (const [flag, key] of [["config-root", "configRoot"], ["data-root", "dataRoot"], ["state-root", "stateRoot"]]) {
        if (values[flag] && values[flag] !== roots[key]) throw new DevtwinError("GATE_REQUIRED", "Root does not match pilot");
      }
    }
    const context = { roots, pilot, now, home, env, kitRoot, templateRoot, ownerDialog, launchctl };
    if (["skill-sources check", "skill-sources preview", "skill-sources stage"].includes(command)) context.request = options.request;
    // --body-file - reads the lesson body from stdin.
    if (command === "lesson propose" || command === "lesson edit" || command === "lesson supersede-propose") context.stdin = stdin;
    if (command.startsWith("stack ")) Object.assign(context, { stackCatalog: options.stackCatalog, resolvePublicRead: options.resolvePublicRead, request: options.request, lookup: options.lookup });
    if (COMMANDS[command].interactive === true) return await impl.run(values, { ...context, stdin, stdout });
    const result = await impl.run(values, context);
    stdout.write(JSON.stringify({ ok: true, command, result }) + "\n");
    return 0;
  } catch (error) {
    const err = toJson(error);
    stdout.write(JSON.stringify({ ok: false, command, error: err }) + "\n");
    return err.code === "DEVTWIN_USAGE" ? 2 : 1;
  }
}
