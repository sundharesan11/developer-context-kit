import { applyInit, planInit, applyScopeAdd, planScopeAdd, parseHub, parsePolicy } from "./store.mjs";
const asList = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
export const initCommand = {
  options: { actor: { type: "string", multiple: true }, preference: { type: "string", multiple: true }, apply: { type: "boolean" } },
  async run(values, ctx) {
    const preferences = Object.fromEntries(asList(values.preference).map((item) => item.split("=")));
    const input = { actorRefs: asList(values.actor), preferences, now: ctx.now };
    return values.apply ? applyInit(ctx.roots, input) : planInit(ctx.roots, input);
  }
};
export const scopeAddCommand = {
  options: { scope: { type: "string" }, "display-name": { type: "string" }, hub: { type: "string", multiple: true }, policy: { type: "string", multiple: true }, apply: { type: "boolean" } },
  async run(values, ctx) {
    const input = { scope: values.scope, displayName: values["display-name"], hubs: asList(values.hub).map((x) => parseHub(x, ctx.pilot)), policies: asList(values.policy).map(parsePolicy), now: ctx.now };
    return values.apply ? applyScopeAdd(ctx.roots, input) : planScopeAdd(ctx.roots, input);
  }
};
// Live config commands name the live config with --pilot and load it themselves (route flag `liveConfig`):
// live init has no live config yet, and set-kit must pass the new kit through the running-kit gate.
const liveOptions = { pilot: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const liveInput = (values, extra = {}) => ({ configPath: values.pilot, fingerprint: values["plan-fingerprint"], ...extra });
const live = () => import("./live.mjs");
export const liveInitCommand = {
  options: { ...liveOptions, agent: { type: "string", multiple: true }, repo: { type: "string", multiple: true } },
  async run(values, ctx) {
    const input = liveInput(values, { agents: asList(values.agent), repos: asList(values.repo) });
    return values.apply ? (await live()).applyLiveInit(input, ctx) : (await live()).previewLiveInit(input, ctx);
  }
};
export const liveAddRepoCommand = {
  options: { ...liveOptions, repo: { type: "string" } },
  async run(values, ctx) {
    const input = liveInput(values, { repo: values.repo });
    return values.apply ? (await live()).applyLiveAddRepo(input, ctx) : (await live()).planLiveAddRepo(input, ctx);
  }
};
export const liveSetKitCommand = {
  options: { ...liveOptions, commit: { type: "string" } },
  async run(values, ctx) {
    const input = liveInput(values, { commit: values.commit });
    return values.apply ? (await live()).applyLiveSetKit(input, ctx) : (await live()).planLiveSetKit(input, ctx);
  }
};
// Sets the approved write classes (KTD7). Each class flag replaces that class's paths; --clear removes a class; classes
// not named stay as they are. The preview shows the classes before and after; --apply with its fingerprint approves.
const CLASS_FLAGS = [["hub-root", "hubRoot"], ["instruction-target", "instructionTargets"], ["hook-target", "hookTargets"], ["launch-agent", "launchAgents"], ["backup-target", "backupTargets"]];
export const liveWriteClassesCommand = {
  options: { ...liveOptions, ...Object.fromEntries(CLASS_FLAGS.map(([flag]) => [flag, { type: "string", multiple: true }])), clear: { type: "string", multiple: true } },
  async run(values, ctx) {
    const set = Object.fromEntries(CLASS_FLAGS.filter(([flag]) => values[flag] !== undefined).map(([flag, key]) => [key, asList(values[flag])]));
    const input = liveInput(values, { set, clear: asList(values.clear) });
    return values.apply ? (await live()).applyLiveEditWriteClasses(input, ctx) : (await live()).planLiveEditWriteClasses(input, ctx);
  }
};
// U18: the stack-watch live-mode exception (docs/LIVE.md). Preview, then --apply with the plan fingerprint.
export const liveStackWatchCommand = {
  options: { ...liveOptions, host: { type: "string", multiple: true }, "max-requests": { type: "string" }, off: { type: "boolean" } },
  async run(values, ctx) {
    const input = liveInput(values, { hosts: asList(values.host), maxRequests: values["max-requests"], off: values.off === true });
    return values.apply ? (await live()).applyLiveStackWatch(input, ctx) : (await live()).planLiveStackWatch(input, ctx);
  }
};
// U26 (KTD34): the owner-answer mode. Preview, then --apply with the plan fingerprint after the owner dialog.
export const liveApprovalCommand = {
  options: { ...liveOptions, mode: { type: "string" } },
  async run(values, ctx) {
    const input = liveInput(values, { mode: values.mode });
    return values.apply ? (await live()).applyLiveApproval(input, ctx) : (await live()).planLiveApproval(input, ctx);
  }
};
// Copies a live setup made under the former devctx name to a new live config folder. --pilot names the new live config,
// --from the legacy one. It runs from the new kit; see docs/MIGRATING.md.
export const liveMigrateCommand = {
  options: { ...liveOptions, from: { type: "string" } },
  async run(values, ctx) {
    const input = liveInput(values, { from: values.from });
    const migrate = await import("./migrate.mjs");
    return values.apply ? migrate.applyLiveMigrate(input, ctx) : migrate.previewLiveMigrate(input, ctx);
  }
};
