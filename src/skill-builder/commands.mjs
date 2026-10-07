import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DevctxError } from "../errors.mjs";
import { assertInPilot } from "../config/pilot.mjs";
import { readApprovedSource } from "../storage/source-read.mjs";
import { createWorkspace, recordRequirements, recordDesign, approveDesign, createDraft, validateDraft, showWorkspace } from "./workspace.mjs";
import { parseFrontmatter, SKILL_NAME } from "./validate.mjs";

const common = { audience: { type: "string" }, scope: { type: "string" }, project: { type: "string" }, workspace: { type: "string" } };
const requirements = { requirements: { type: "string" } }, design = { design: { type: "string" } }, decision = { decision: { type: "string" } }, revision = { revision: { type: "string" } };
const selection = (v) => ({ audience: v.audience, scope: v.scope, project: v.project, workspace: v.workspace });
export const workspaceCreateCommand = { options: common, run: (v, ctx) => createWorkspace(ctx.roots, selection(v)) };
export const requirementsRecordCommand = { options: { ...common, ...requirements, input: { type: "string" } }, run: (v, ctx) => recordRequirements(ctx.roots, selection(v), v.requirements, v.input) };
export const designRecordCommand = { options: { ...common, ...requirements, ...design, input: { type: "string" } }, run: (v, ctx) => recordDesign(ctx.roots, selection(v), v.requirements, v.design, v.input) };
export const designApproveCommand = { options: { ...common, ...design, ...decision, "interaction-ref": { type: "string" }, response: { type: "string" } }, run: (v, ctx) => approveDesign(ctx.roots, selection(v), v.design, v.decision, v["interaction-ref"], v.response) };
export const draftCreateCommand = { options: { ...common, ...requirements, ...design, ...decision, ...revision, candidate: { type: "string" } }, run: (v, ctx) => createDraft(ctx.roots, selection(v), { requirementsId: v.requirements, designId: v.design, decisionId: v.decision, revisionId: v.revision, candidate: v.candidate }) };
export const draftValidateCommand = { options: { ...common, ...revision }, run: (v, ctx) => validateDraft(ctx.roots, selection(v), v.revision) };
export const workspaceShowCommand = { options: common, run: (v, ctx) => showWorkspace(ctx.roots, selection(v)) };

const bundled = ["devctx-onboard", "devctx-record", "devctx-resume"];
export const discoverCommand = { options: { fixture: { type: "string" } }, async run(v, ctx) {
  const found = [];
  for (const name of bundled) {
    const path = "skills/" + name + "/SKILL.md";
    const body = readFileSync(fileURLToPath(new URL("../../" + path, import.meta.url)), "utf8");
    found.push({ name, description: /^description:\s*(.+)$/m.exec(body)?.[1] ?? "", origin: "bundled", path });
  }
  if (v.fixture) {
    assertInPilot(ctx.pilot, v.fixture, "inputsRoot");
    const read = await readApprovedSource(ctx.pilot.inputsRoot, relative(ctx.pilot.inputsRoot, join(v.fixture, "SKILL.md")));
    if (read.skipped || !read.utf8Valid) throw new DevctxError("INVALID_INPUT", "Fixture skill unavailable");
    const name = parseFrontmatter(read.text, { nameOnly: true }).meta.name;
    if (!SKILL_NAME.test(name) || name.length > 64) throw new DevctxError("INVALID_INPUT", "Fixture name unavailable");
    found.push({ name, description: /^description:\s*(.+)$/m.exec(read.text)?.[1] ?? "", origin: "fixture", path: relative(ctx.pilot.inputsRoot, v.fixture) + "/SKILL.md" });
  }
  return { sources: found };
} };
