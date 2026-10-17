import { listTemplates, seedTemplate, verifyTemplate, templateRootFor, parseSets } from "./templates.mjs";

const seedOptions = { template: { type: "string" }, audience: { type: "string" }, scope: { type: "string" }, workspace: { type: "string" }, set: { type: "string", multiple: true } };
const selection = (v) => ({ audience: v.audience, scope: v.scope, workspace: v.workspace });
export const templateListCommand = { options: {}, run: (v, ctx) => ({ templates: listTemplates(templateRootFor(ctx)) }) };
export const templateSeedCommand = { options: seedOptions, run: (v, ctx) => seedTemplate(ctx.roots, templateRootFor(ctx), selection(v), v.template, parseSets(v.set)) };
export const templateVerifyCommand = { options: { ...seedOptions, dir: { type: "string" }, "render-digest": { type: "string" } }, run: (v, ctx) => verifyTemplate(ctx.roots, templateRootFor(ctx), selection(v), v.template, parseSets(v.set), v.dir, v["render-digest"]) };
