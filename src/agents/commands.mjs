import { DevtwinError } from "../errors.mjs";
import { randomBytes } from "node:crypto";
import { planInstall, applyInstall, installStatus, planRecovery, applyRecovery } from "./install.mjs";
import { rollbackCheck } from "./inventory.mjs";
import { planHooks, applyHooks, hookStatus } from "./hooks-install.mjs";
import { envNotes } from "../config/legacy.mjs";
const options = { home: { type: "string" }, agent: { type: "string", multiple: true }, apply: { type: "boolean" }, "plan-fingerprint": { type: "string" }, "run-id": { type: "string" }, hooks: { type: "boolean" } };
const agents = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
// --hooks selects devtwin's hook entries in the agent settings files instead of the bundled skills. Without it the
// command is unchanged. Each target has its own preview, fingerprint and journal.
const hooksCommand = async (values, ctx, mode) => {
  const input = { targetHome: values.home, agents: agents(values.agent), mode, kitRoot: ctx.kitRoot };
  if (!values.apply) return planHooks(ctx.pilot, input);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyHooks(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], runId: values["run-id"] ?? "run_" + randomBytes(12).toString("hex"), now: ctx.now() });
};
const command = (mode) => ({ options, async run(values, ctx) {
  if (values.hooks) return hooksCommand(values, ctx, mode);
  const input = { targetHome: values.home, agents: agents(values.agent), mode };
  if (!values.apply) return planInstall(ctx.pilot, input);
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyInstall(ctx.roots, ctx.pilot, input, { fingerprint: values["plan-fingerprint"], runId: values["run-id"] ?? "run_" + randomBytes(12).toString("hex") });
} });
export const agentsInstallCommand = command("install");
export const agentsUninstallCommand = command("uninstall");
// Status also reports a legacy DEVCTX_KIT in the environment, as notes, so the owner can update the shell profile.
// hooks reports each agent's hook entries, the kit receipt, the Codex /hooks trust step and roots bound in two scopes.
export const agentsStatusCommand = { options: { home: { type: "string" } }, async run(values, ctx) {
  const status = await installStatus(ctx.roots, ctx.pilot, { targetHome: values.home }), notes = envNotes(ctx.env ?? process.env);
  const hooks = await hookStatus(ctx.pilot, { targetHome: values.home, kitRoot: ctx.kitRoot, now: ctx.now() });
  return notes.length ? { ...status, hooks, notes } : { ...status, hooks };
} };
// Previews recovery of interrupted bundled installs; --apply with the previewed fingerprint is the approval.
// --release also closes runs whose entries are held or whose journal is unreadable, leaving their files in place.
export const agentsRecoverCommand = { options: { apply: { type: "boolean" }, release: { type: "boolean" }, "plan-fingerprint": { type: "string" } }, async run(values, ctx) {
  const release = values.release === true;
  if (!values.apply) return planRecovery(ctx.roots, ctx.pilot, { release });
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return applyRecovery(ctx.roots, ctx.pilot, { fingerprint: values["plan-fingerprint"], release });
} };
// Read-only: compares the skill folders now with an install run's pre-apply inventory.
export const agentsRollbackCheckCommand = { options: { "run-id": { type: "string" } }, run: (values, ctx) => rollbackCheck(ctx.roots, ctx.pilot, { runId: values["run-id"] }) };
// U16: instructions plan previews the managed instruction block and each target file; instructions apply writes it
// with the plan fingerprint, after the owner dialog. --remove takes the block out. apply is an owner action.
const instructionOptions = { home: { type: "string" }, agent: { type: "string", multiple: true }, remove: { type: "boolean" } };
const instructionInput = (values, ctx) => ({ targetHome: values.home, agents: values.agent === undefined ? ["claude", "codex"] : agents(values.agent), remove: values.remove === true, kitRoot: ctx.kitRoot });
export const instructionsPlanCommand = { options: instructionOptions, run: async (values, ctx) => (await import("./instructions.mjs")).planInstructions(ctx.roots, ctx.pilot, instructionInput(values, ctx)) };
export const instructionsApplyCommand = { options: { ...instructionOptions, "plan-fingerprint": { type: "string" }, "run-id": { type: "string" } }, async run(values, ctx) {
  if (!values["plan-fingerprint"]) throw new DevtwinError("PLAN_REQUIRED", "Plan fingerprint required");
  return (await import("./instructions.mjs")).applyInstructions(ctx.roots, ctx.pilot, instructionInput(values, ctx), { fingerprint: values["plan-fingerprint"], runId: values["run-id"] ?? "run_" + randomBytes(12).toString("hex"), ctx });
} };
