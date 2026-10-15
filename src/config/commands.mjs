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
// Live profile commands name the profile with --pilot and load it themselves (route flag `profile`):
// live init has no profile yet, and set-kit must pass the new kit through the running-kit gate.
const liveOptions = { pilot: { type: "string" }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" } };
const liveInput = (values, extra = {}) => ({ profilePath: values.pilot, fingerprint: values["plan-fingerprint"], ...extra });
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
