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
