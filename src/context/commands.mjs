import { resolveContext } from "./resolve.mjs";
import { buildBrief } from "./brief.mjs";
const options = { scope: { type: "string" }, cwd: { type: "string" } };
export const contextResolveCommand = { options, run: (values, ctx) => resolveContext(ctx.roots, { scope: values.scope, cwd: values.cwd }) };
export const contextBriefCommand = { options, run: (values, ctx) => buildBrief(ctx.roots, ctx.pilot, { scope: values.scope, cwd: values.cwd }) };
